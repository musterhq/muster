/**
 * MCP servers configured in Muster (`config.tools.mcp.servers`) handed to the
 * native runtimes for one turn. Codex gets them as per-thread config over the
 * app-server protocol and Claude Code as a private `--mcp-config` file, so a
 * server's env and headers never appear in a process argument list.
 */
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpServerConfig } from "./mcp.js";
import { readMcpOAuthToken } from "./mcp-oauth.js";
import type { MusterConfig } from "./types.js";

export interface RuntimeMcpServers {
  readonly servers: Readonly<Record<string, McpServerConfig>>;
  /** Servers left out of the turn, with what the user can do about it. */
  readonly skipped: readonly { readonly name: string; readonly reason: string }[];
}

const SERVER_NAME = /^[A-Za-z0-9_-]+$/;

function denied(config: MusterConfig, name: string): boolean {
  const deny = config.tools?.deny ?? [];
  return deny.includes(`mcp:${name}`) || deny.includes(name) || config.tools?.entries?.[name]?.enabled === false;
}

/** The servers a turn may use: policy-filtered, OAuth tokens attached, unsigned servers skipped. */
export async function resolveRuntimeMcpServers(config: MusterConfig, cwd = process.cwd()): Promise<RuntimeMcpServers> {
  const servers: Record<string, McpServerConfig> = {};
  const skipped: { name: string; reason: string }[] = [];
  for (const [name, server] of Object.entries(config.tools?.mcp?.servers ?? {})) {
    if (!SERVER_NAME.test(name)) {
      skipped.push({ name, reason: "server name must be letters, digits, - or _" });
      continue;
    }
    if (denied(config, name)) continue;
    if (server.auth === "oauth") {
      if (server.transport.kind !== "http") {
        skipped.push({ name, reason: "OAuth needs an http server" });
        continue;
      }
      const token = await readMcpOAuthToken(name, cwd);
      if (!token) {
        skipped.push({ name, reason: `not signed in; run: muster mcp login ${name}` });
        continue;
      }
      const scheme = !token.tokenType || /^bearer$/i.test(token.tokenType) ? "Bearer" : token.tokenType;
      servers[name] = {
        ...server,
        transport: { ...server.transport, headers: { ...(server.transport.headers ?? {}), Authorization: `${scheme} ${token.accessToken}` } },
      };
      continue;
    }
    if (server.origin?.plugin) {
      // Plugin bundles keep secrets as `${VAR}` references in config; they
      // resolve from the environment for this turn only.
      const missing = new Set<string>();
      const expanded = expandEnvReferences(server, missing);
      if (missing.size) {
        skipped.push({ name, reason: `needs ${[...missing].join(", ")} in the environment` });
        continue;
      }
      servers[name] = expanded;
      continue;
    }
    servers[name] = server;
  }
  return { servers, skipped };
}

const ENV_REFERENCE = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;

function expandEnvReferences(server: McpServerConfig, missing: Set<string>): McpServerConfig {
  const expand = (value: string) => value.replace(ENV_REFERENCE, (_match, name: string, fallback: string | undefined) => {
    const value = process.env[name];
    if (value !== undefined && value !== "") return value;
    if (fallback !== undefined) return fallback;
    missing.add(name);
    return "";
  });
  const map = (record: Record<string, string> | undefined) => record ? Object.fromEntries(Object.entries(record).map(([key, value]) => [key, expand(value)])) : undefined;
  const transport = server.transport;
  if (transport.kind === "stdio") {
    return {
      ...server,
      transport: {
        ...transport,
        command: expand(transport.command),
        ...(transport.args ? { args: transport.args.map(expand) } : {}),
        ...(transport.env ? { env: map(transport.env) } : {}),
        ...(transport.cwd ? { cwd: expand(transport.cwd) } : {}),
      },
    };
  }
  return { ...server, transport: { ...transport, url: expand(transport.url), ...(transport.headers ? { headers: map(transport.headers) } : {}) } };
}

/** Codex app-server `thread/start` / `thread/resume` `config` entries (`mcp_servers.<name>`). */
export function codexThreadMcpConfig(servers: Readonly<Record<string, McpServerConfig>>): Record<string, unknown> {
  const config: Record<string, unknown> = {};
  for (const [name, server] of Object.entries(servers)) {
    const transport = server.transport;
    const entry: Record<string, unknown> = transport.kind === "stdio"
      ? {
          command: transport.command,
          ...(transport.args?.length ? { args: [...transport.args] } : {}),
          ...(transport.env && Object.keys(transport.env).length ? { env: { ...transport.env } } : {}),
          ...(transport.cwd ? { cwd: transport.cwd } : {}),
        }
      : {
          url: transport.url,
          ...(transport.headers && Object.keys(transport.headers).length ? { http_headers: { ...transport.headers } } : {}),
        };
    // The user added this server explicitly (`muster mcp add-*`), which is the
    // consent; Codex threads run with approvalPolicy "never", so without this
    // every call fails with "requires approval, but approval policy is never".
    entry.default_tools_approval_mode = "approve";
    if (server.tools?.include?.length) entry.enabled_tools = [...server.tools.include];
    if (server.tools?.exclude?.length) entry.disabled_tools = [...server.tools.exclude];
    if (server.limits?.toolTimeoutMs) entry.tool_timeout_sec = Math.ceil(server.limits.toolTimeoutMs / 1000);
    config[`mcp_servers.${name}`] = entry;
  }
  return config;
}

/** Claude Code's `--mcp-config` document. */
export function claudeMcpConfigDocument(servers: Readonly<Record<string, McpServerConfig>>): { mcpServers: Record<string, unknown> } {
  const mcpServers: Record<string, unknown> = {};
  for (const [name, server] of Object.entries(servers)) {
    const transport = server.transport;
    mcpServers[name] = transport.kind === "stdio"
      ? {
          type: "stdio",
          command: transport.command,
          ...(transport.args?.length ? { args: [...transport.args] } : {}),
          ...(transport.env && Object.keys(transport.env).length ? { env: { ...transport.env } } : {}),
        }
      : {
          type: "http",
          url: transport.url,
          ...(transport.headers && Object.keys(transport.headers).length ? { headers: { ...transport.headers } } : {}),
        };
  }
  return { mcpServers };
}

/** Write the Claude config to a user-only (0600) file in a user-only directory; dispose() deletes both. */
export async function writeClaudeMcpConfig(servers: Readonly<Record<string, McpServerConfig>>): Promise<{ readonly path: string; dispose(): Promise<void> }> {
  const dir = join(tmpdir(), `muster-mcp-${randomUUID()}`);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, "mcp.json");
  await writeFile(path, JSON.stringify(claudeMcpConfigDocument(servers)), { mode: 0o600 });
  return { path, dispose: () => rm(dir, { recursive: true, force: true }) };
}
