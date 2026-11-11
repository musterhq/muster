/**
 * Code plugin manifests (`muster.plugin.json`): read and checked cold, never
 * by importing the plugin. A code plugin is an ES module whose
 * `register(ctx)` adds tools, hooks and chat commands; it runs in its own
 * host process (plugin-host.ts) and may only do what its manifest declares.
 *
 * Permission grammar:
 *   tools                  add tools the agent can call
 *   commands               add chat slash commands
 *   hooks:<event>          see (and block) one hook event
 *   net:<host>[:<port>]    ctx.fetch to that host (`*.example.com` for subdomains)
 *   env:<NAME>             receive that environment variable
 *   fs:read[:<path>]       read the workspace (or a workspace-relative path)
 *   fs:write[:<path>]      write the workspace (or a workspace-relative path)
 */
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { HookName } from "./hooks.js";

export const CODE_PLUGIN_MANIFEST = "muster.plugin.json";

export const PLUGIN_HOOK_EVENTS: readonly HookName[] = [
  "prompt.build", "turn.start", "turn.end", "tool.before", "tool.after", "outbound.before", "compaction.before", "session.start", "session.end",
];

const HOOK_WORDS: Readonly<Record<HookName, string>> = {
  "prompt.build": "may see prompts as they are built",
  "turn.start": "may see and block each prompt before a turn starts",
  "turn.end": "may see each turn's reply when it ends",
  "tool.before": "may see and block each tool call or command before it runs",
  "tool.after": "may see each tool call's result after it runs",
  "outbound.before": "may see and block outgoing channel messages",
  "compaction.before": "may see conversations before they are compacted",
  "session.start": "may see when a session starts",
  "session.end": "may see when a session ends",
};

export interface CodePluginManifest {
  readonly id: string;
  readonly version: string;
  /** Relative to the plugin root. */
  readonly entry: string;
  readonly description?: string;
  readonly permissions: readonly string[];
  readonly configSchema?: Record<string, unknown>;
  /** Per-call budget for tools and commands; hooks always get 2 s. */
  readonly timeoutMs?: number;
  /** A hook that throws or times out blocks instead of passing. */
  readonly failClosed?: boolean;
}

export interface ManifestFinding {
  readonly field: string;
  readonly message: string;
}

export interface CodePluginManifestReport {
  readonly root: string;
  readonly manifest?: CodePluginManifest;
  /** Raw id/version, for reporting even when the manifest is invalid. */
  readonly id?: string;
  readonly version?: string;
  readonly errors: readonly ManifestFinding[];
}

export type ParsedPermission =
  | { readonly kind: "tools" }
  | { readonly kind: "commands" }
  | { readonly kind: "hooks"; readonly event: HookName }
  | { readonly kind: "net"; readonly host: string; readonly port?: number }
  | { readonly kind: "env"; readonly name: string }
  | { readonly kind: "fs"; readonly mode: "read" | "write"; readonly path?: string };

const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const HOST_PATTERN = /^(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;
const ENV_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
/** Names the host sets itself, or that would change how Node starts (NODE_OPTIONS could lift the permission model). */
const RESERVED_ENV = /^(PATH|HOME|NODE_.*|LD_.*|DYLD_.*|UV_.*|MUSTER_PLUGIN_.*)$/i;

/** Parse one permission string; undefined when it is not part of the grammar. */
export function parsePermission(value: string): ParsedPermission | { readonly error: string } | undefined {
  if (value === "tools") return { kind: "tools" };
  if (value === "commands") return { kind: "commands" };
  const colon = value.indexOf(":");
  if (colon < 0) return undefined;
  const kind = value.slice(0, colon);
  const rest = value.slice(colon + 1);
  if (kind === "hooks") {
    return (PLUGIN_HOOK_EVENTS as readonly string[]).includes(rest) ? { kind: "hooks", event: rest as HookName } : { error: `unknown hook event "${rest}" (one of ${PLUGIN_HOOK_EVENTS.join(", ")})` };
  }
  if (kind === "net") {
    const match = rest.toLowerCase().match(/^(\[[0-9a-f:.]+\]|[^:]+)(?::(\d{1,5}))?$/);
    const host = match?.[1];
    const port = match?.[2] ? Number(match[2]) : undefined;
    const ipv4 = host !== undefined && /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
    const ipv6 = host !== undefined && host.startsWith("[");
    if (!host || !(ipv4 || ipv6 || HOST_PATTERN.test(host)) || host === "*" || (port !== undefined && (port < 1 || port > 65535))) return { error: `"${value}" is not a host name (net:<host> or net:<host>:<port>)` };
    return { kind: "net", host: ipv6 ? host.slice(1, -1) : host, ...(port !== undefined ? { port } : {}) };
  }
  if (kind === "env") {
    if (!ENV_PATTERN.test(rest)) return { error: `"${rest}" is not an environment variable name` };
    if (RESERVED_ENV.test(rest)) return { error: `env:${rest} is reserved (PATH and HOME are always set; NODE_*, LD_*, DYLD_* and UV_* would change how the host starts)` };
    return { kind: "env", name: rest };
  }
  if (kind === "fs") {
    const [mode, ...pathParts] = rest.split(":");
    if (mode !== "read" && mode !== "write") return { error: `"${value}" must be fs:read or fs:write` };
    const path = pathParts.join(":");
    if (!path) return { kind: "fs", mode };
    if (isAbsolute(path) || path.split(/[\\/]/).includes("..")) return { error: `"${value}" must name a path inside the workspace` };
    return { kind: "fs", mode, path };
  }
  return undefined;
}

/** A permission in plain words, as shown by inspect and install. */
export function describePermission(value: string): string {
  const parsed = parsePermission(value);
  if (!parsed || "error" in parsed) return `unknown permission "${value}"`;
  switch (parsed.kind) {
    case "tools": return "may add tools the agent can call";
    case "commands": return "may add chat commands";
    case "hooks": return HOOK_WORDS[parsed.event];
    case "net": return `may make network requests to ${parsed.host}${parsed.port ? ` (port ${parsed.port})` : ""}`;
    case "env": return `may read the environment variable ${parsed.name}`;
    case "fs": return `may ${parsed.mode} files in ${parsed.path ? `${parsed.path} (inside the workspace)` : "the workspace"}`;
  }
}

export function parsedPermissions(permissions: readonly string[]): ParsedPermission[] {
  return permissions.map(parsePermission).filter((item): item is ParsedPermission => Boolean(item) && !("error" in (item as object)));
}

/** True when a `net:` permission covers this URL's host (and port, when the permission names one). */
export function netPermissionCovers(permissions: readonly string[], url: URL): string | undefined {
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
  for (const permission of parsedPermissions(permissions)) {
    if (permission.kind !== "net") continue;
    const hostMatches = permission.host.startsWith("*.") ? host.endsWith(permission.host.slice(1)) && host.length > permission.host.length - 1 : host === permission.host;
    if (hostMatches && (permission.port === undefined || permission.port === port)) return `net:${permission.host}${permission.port ? `:${permission.port}` : ""}`;
  }
  return undefined;
}

export async function isCodePlugin(dir: string): Promise<boolean> {
  return lstat(join(dir, CODE_PLUGIN_MANIFEST)).then((info) => info.isFile(), () => false);
}

/** Read and check `muster.plugin.json`. Never imports or runs anything in the folder. */
export async function readCodePluginManifest(dir: string): Promise<CodePluginManifestReport> {
  const root = resolve(dir);
  const errors: ManifestFinding[] = [];
  let raw: Record<string, unknown>;
  try {
    const parsed = JSON.parse(await readFile(join(root, CODE_PLUGIN_MANIFEST), "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { root, errors: [{ field: "manifest", message: `${CODE_PLUGIN_MANIFEST} must be a JSON object` }] };
    raw = parsed as Record<string, unknown>;
  } catch (error) {
    return { root, errors: [{ field: "manifest", message: `${CODE_PLUGIN_MANIFEST} is not readable JSON: ${(error as Error).message}` }] };
  }
  const id = typeof raw.id === "string" ? raw.id : undefined;
  const version = typeof raw.version === "string" ? raw.version : undefined;
  if (!id) errors.push({ field: "id", message: "is required" });
  else if (!ID_PATTERN.test(id)) errors.push({ field: "id", message: `"${id}" must be lowercase letters, digits, - or _ (at most 64)` });
  if (!version) errors.push({ field: "version", message: "is required" });

  const entry = typeof raw.entry === "string" && raw.entry.trim() ? raw.entry.trim() : undefined;
  if (!entry) errors.push({ field: "entry", message: "is required (the module that exports register)" });
  else {
    const target = resolve(root, entry);
    if (isAbsolute(entry) || !isWithin(root, target)) errors.push({ field: "entry", message: `"${entry}" points outside the plugin folder` });
    else if (!/\.(m?js|cjs)$/.test(entry)) errors.push({ field: "entry", message: `"${entry}" must be a .js, .mjs or .cjs file` });
    else {
      const info = await lstat(target).catch(() => undefined);
      if (!info) errors.push({ field: "entry", message: `"${entry}" does not exist` });
      else if (!info.isFile()) errors.push({ field: "entry", message: `"${entry}" must be a regular file (not a link or folder)` });
      else {
        // A parent folder that is a link could still lead outside.
        const real = await realpath(target).catch(() => target);
        if (!isWithin(await realpath(root).catch(() => root), real)) errors.push({ field: "entry", message: `"${entry}" points outside the plugin folder` });
      }
    }
  }

  const permissions: string[] = [];
  if (raw.permissions !== undefined && !Array.isArray(raw.permissions)) errors.push({ field: "permissions", message: "must be a list of strings" });
  for (const value of Array.isArray(raw.permissions) ? raw.permissions : []) {
    if (typeof value !== "string") {
      errors.push({ field: "permissions", message: `${JSON.stringify(value)} is not a string` });
      continue;
    }
    const parsed = parsePermission(value);
    if (!parsed) errors.push({ field: "permissions", message: `unknown permission "${value}"` });
    else if ("error" in parsed) errors.push({ field: "permissions", message: parsed.error });
    else if (!permissions.includes(value)) permissions.push(value);
  }
  if (raw.description !== undefined && typeof raw.description !== "string") errors.push({ field: "description", message: "must be a string" });
  if (raw.configSchema !== undefined && (typeof raw.configSchema !== "object" || raw.configSchema === null || Array.isArray(raw.configSchema))) errors.push({ field: "configSchema", message: "must be a JSON Schema object" });
  if (raw.timeoutMs !== undefined && !(Number.isInteger(raw.timeoutMs) && (raw.timeoutMs as number) >= 100 && (raw.timeoutMs as number) <= 600_000)) errors.push({ field: "timeoutMs", message: "must be a whole number of milliseconds from 100 to 600000" });
  if (raw.failClosed !== undefined && typeof raw.failClosed !== "boolean") errors.push({ field: "failClosed", message: "must be true or false" });

  if (errors.length || !id || !version || !entry) return { root, ...(id ? { id } : {}), ...(version ? { version } : {}), errors };
  return {
    root,
    id,
    version,
    errors,
    manifest: {
      id,
      version,
      entry,
      ...(typeof raw.description === "string" ? { description: raw.description } : {}),
      permissions,
      ...(raw.configSchema ? { configSchema: raw.configSchema as Record<string, unknown> } : {}),
      ...(typeof raw.timeoutMs === "number" ? { timeoutMs: raw.timeoutMs } : {}),
      ...(typeof raw.failClosed === "boolean" ? { failClosed: raw.failClosed } : {}),
    },
  };
}

function isWithin(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(target));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}
