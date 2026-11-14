import { spawn, type ChildProcess } from "node:child_process";
import { persistToolResult } from "./context-renderer.js";
import type { FlowToolRegistry } from "./flow.js";
import { mcpOAuthAuthorizationHeader } from "./mcp-oauth.js";

/**
 * Minimal MCP client — newline-delimited JSON-RPC 2.0 over stdio, plus a
 * single-shot HTTP transport. No SDK dependency. Designed around upstream
 * failure modes (hermes-agent): each server has its OWN supervision and
 * circuit breaker so one bad server can never take down the registry
 * (#34443); every result flows through the same size-cap + persistence
 * pipeline as built-in tools (#44172).
 */

export interface McpServerConfig {
  readonly transport:
    | { readonly kind: "stdio"; readonly command: string; readonly args?: string[]; readonly env?: Record<string, string>; readonly cwd?: string }
    | { readonly kind: "http"; readonly url: string; readonly headers?: Record<string, string> };
  readonly tools?: { readonly include?: string[]; readonly exclude?: string[] };
  readonly limits?: { readonly toolTimeoutMs?: number; readonly maxResultChars?: number; readonly maxCallsPerTurn?: number };
  readonly auth?: "oauth";
  /** Set when a plugin bundle added this server; `muster plugins remove` deletes exactly these. */
  readonly origin?: { readonly plugin: string };
  readonly oauth?: {
    readonly setupUrl?: string;
    readonly scope?: string;
    readonly clientName?: string;
    readonly authorizationUrl?: string;
    readonly tokenUrl?: string;
    readonly clientId?: string;
    readonly clientSecret?: string;
    readonly redirectPort?: number;
  };
}

export interface McpToolInfo {
  readonly server: string;
  readonly name: string;
  readonly namespaced: string;
  readonly description?: string;
  readonly inputSchema?: unknown;
}

interface Breaker {
  failures: number;
  openUntil: number;
}

const BREAKER_THRESHOLD = 3;
const BREAKER_COOLDOWN_MS = 60_000;
const DEFAULT_TOOL_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RESULT_CHARS = 8_000;

interface JsonRpcResponse {
  id?: number;
  result?: unknown;
  error?: { code: number; message: string };
}

class StdioTransport {
  private child: ChildProcess;
  private nextId = 1;
  private pending = new Map<number, { resolve: (value: JsonRpcResponse) => void; reject: (error: Error) => void }>();
  private buffer = "";
  private dead = false;
  private deadReason?: Error;

  constructor(command: string, args: string[], env: Record<string, string> | undefined, cwd: string, spawnCwd?: string) {
    const resolvedArgs = args.map((arg) => resolveMcpRuntimeTemplate(arg, { cwd }));
    const resolvedEnv = resolveMcpRuntimeEnv(env, cwd);
    this.child = spawn(command, resolvedArgs, {
      ...(spawnCwd ? { cwd: spawnCwd } : {}),
      stdio: ["pipe", "pipe", "ignore"],
      // filtered env: only what the server config declares, plus PATH — secrets never leak by default
      env: { PATH: process.env.PATH ?? "", ...resolvedEnv },
    });
    // An async spawn failure (ENOENT command-not-found, EACCES) emits 'error' on
    // the child; with NO listener Node rethrows it as an UNCAUGHT exception that
    // crashes the whole gateway host. Contain it to THIS one server so a single
    // bad MCP config can never take down every other server (#34443).
    this.child.on("error", (error: Error) => this.markDead(error));
    // Writing to a dead child's stdin raises EPIPE on the stream — the same
    // uncaught-crash hole without a listener.
    this.child.stdin?.on("error", (error: Error) => this.markDead(error));
    this.child.stdout!.on("data", (chunk: Buffer) => {
      this.buffer += chunk.toString();
      let newline = this.buffer.indexOf("\n");
      while (newline >= 0) {
        const line = this.buffer.slice(0, newline).trim();
        this.buffer = this.buffer.slice(newline + 1);
        if (line) this.dispatch(line);
        newline = this.buffer.indexOf("\n");
      }
    });
    this.child.on("exit", () => this.markDead(new Error("MCP server exited")));
  }

  /** Mark the transport dead once and reject every in-flight request with the cause. Idempotent. */
  private markDead(error: Error): void {
    if (!this.dead) {
      this.dead = true;
      this.deadReason = error;
    }
    for (const { reject } of this.pending.values()) reject(this.deadReason ?? error);
    this.pending.clear();
  }

  /** Whether the child has died (spawn failure, exit, or broken pipe) — for supervised respawn. */
  isDead(): boolean {
    return this.dead;
  }

  private dispatch(line: string): void {
    let message: JsonRpcResponse;
    try {
      message = JSON.parse(line);
    } catch {
      return; // non-JSON noise on stdout is ignored, never fatal
    }
    if (message.id !== undefined && this.pending.has(message.id)) {
      this.pending.get(message.id)!.resolve(message);
      this.pending.delete(message.id);
    }
  }

  request(method: string, params: unknown, timeoutMs: number): Promise<JsonRpcResponse> {
    if (this.dead) return Promise.reject(this.deadReason ?? new Error("MCP server is not running"));
    const id = this.nextId++;
    const payload = `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request timed out after ${timeoutMs}ms: ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      try {
        this.child.stdin!.write(payload);
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(error as Error);
      }
    });
  }

  notify(method: string, params: unknown): void {
    if (this.dead) return;
    try {
      this.child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
    } catch {
      // server is gone; a dropped notification is non-fatal
    }
  }

  close(): void {
    this.child.kill();
  }
}

function resolveMcpRuntimeEnv(env: Record<string, string> | undefined, cwd: string): Record<string, string> {
  if (!env) return {};
  return Object.fromEntries(
    Object.entries(env).map(([key, value]) => [key, resolveMcpRuntimeEnvValue(key, value, cwd)]),
  );
}

function resolveMcpRuntimeEnvValue(key: string, value: string, cwd: string): string {
  if (value === "${CWD}") return cwd;
  if (isEnvChoiceTemplate(value)) return resolveMcpRuntimeEnvChoice(value);
  if (isFullEnvTemplate(value)) return resolveRequiredRuntimeEnv(value.slice(2, -1));
  if (value === key && isEnvName(value)) return resolveRequiredRuntimeEnv(value);
  return resolveMcpRuntimeTemplate(value, { cwd });
}

function resolveMcpRuntimeTemplate(value: string, options: { readonly cwd: string }): string {
  return value.replace(/\$\{([A-Z_][A-Z0-9_]*|CWD)\}/g, (_match, name: string) => {
    if (name === "CWD") return options.cwd;
    return resolveRequiredRuntimeEnv(name);
  });
}

function resolveMcpRuntimeEnvChoice(value: string): string {
  for (const name of value.split("|")) {
    const candidate = process.env[name];
    if (candidate) return candidate;
  }
  throw new Error(`Missing required MCP environment variable: ${value}`);
}

function resolveRequiredRuntimeEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required MCP environment variable: ${name}`);
  return value;
}

function isFullEnvTemplate(value: string): boolean {
  return /^\$\{[A-Z_][A-Z0-9_]*\}$/.test(value);
}

function isEnvChoiceTemplate(value: string): boolean {
  return /^[A-Z_][A-Z0-9_]*(?:\|[A-Z_][A-Z0-9_]*)+$/.test(value);
}

function isEnvName(value: string): boolean {
  return /^[A-Z_][A-Z0-9_]*$/.test(value);
}

async function httpRequest(url: string, headers: Record<string, string>, method: string, params: unknown, timeoutMs: number): Promise<JsonRpcResponse> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json", ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`MCP HTTP ${response.status}`);
  return await response.json() as JsonRpcResponse;
}

export interface McpServerHandle {
  readonly name: string;
  readonly status: "ready" | "failed";
  readonly error?: string;
  readonly tools: McpToolInfo[];
  call(tool: string, args: unknown, cwd?: string): Promise<{ ok: boolean; content: string; error?: string }>;
  close(): void;
}

export async function connectMcpServer(name: string, config: McpServerConfig, cwd = process.cwd()): Promise<McpServerHandle> {
  const timeoutMs = config.limits?.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;
  const maxChars = config.limits?.maxResultChars ?? DEFAULT_MAX_RESULT_CHARS;
  const breaker: Breaker = { failures: 0, openUntil: 0 };
  let transport: StdioTransport | undefined;
  const send = async (method: string, params: unknown): Promise<JsonRpcResponse> => {
    if (config.transport.kind === "stdio") {
      transport ??= new StdioTransport(config.transport.command, config.transport.args ?? [], config.transport.env, cwd, config.transport.cwd);
      return transport.request(method, params, timeoutMs);
    }
    // Header values may reference env vars (`Bearer ${LINEAR_TOKEN}`), so a token never has to sit in config.
    const headers = Object.fromEntries(
      Object.entries(config.transport.headers ?? {}).map(([key, value]) => [key, resolveMcpRuntimeTemplate(value, { cwd })]),
    );
    if (config.auth === "oauth") {
      const authorization = await mcpOAuthAuthorizationHeader(name, cwd);
      if (!authorization) {
        throw new Error(`MCP server "${name}" requires OAuth login. Run: muster mcp oauth setup ${name}`);
      }
      headers.authorization = authorization;
    }
    return httpRequest(config.transport.url, headers, method, params, timeoutMs);
  };

  let tools: McpToolInfo[] = [];
  try {
    const init = await send("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "muster", version: "0.0.1" },
    });
    if (init.error) throw new Error(init.error.message);
    if (config.transport.kind === "stdio") transport!.notify("notifications/initialized", {});
    const listed = await send("tools/list", {});
    if (listed.error) throw new Error(listed.error.message);
    const raw = (listed.result as { tools?: Array<{ name: string; description?: string; inputSchema?: unknown }> })?.tools ?? [];
    tools = raw
      .filter((tool) => !config.tools?.include || config.tools.include.includes(tool.name))
      .filter((tool) => !config.tools?.exclude?.includes(tool.name))
      .map((tool) => ({ server: name, name: tool.name, namespaced: `${name}__${tool.name}`, description: tool.description, inputSchema: tool.inputSchema }));
  } catch (error) {
    transport?.close();
    // Loud, isolated failure: the handle reports failed; the registry stays alive.
    return {
      name,
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
      tools: [],
      call: async () => ({ ok: false, content: "", error: `MCP server "${name}" failed to initialize` }),
      close: () => {},
    };
  }

  return {
    name,
    status: "ready",
    tools,
    async call(tool, args, callCwd = cwd) {
      const now = Date.now();
      if (breaker.openUntil > now) {
        return { ok: false, content: "", error: `MCP server "${name}" circuit open (cooling down after ${BREAKER_THRESHOLD} failures)` };
      }
      try {
        const response = await send("tools/call", { name: tool, arguments: args });
        if (response.error) throw new Error(response.error.message);
        breaker.failures = 0;
        const blocks = (response.result as { content?: Array<{ type?: string; text?: string }> })?.content ?? [];
        let content = blocks.map((block) => block.text ?? "").join("\n").trim() || JSON.stringify(response.result);
        if (content.length > maxChars) {
          const persisted = await persistToolResult({ toolName: `${name}__${tool}`, ok: true, content }, callCwd);
          content = `${content.slice(0, 400)}\n${persisted.stub}`;
        }
        return { ok: true, content };
      } catch (error) {
        breaker.failures += 1;
        if (breaker.failures >= BREAKER_THRESHOLD) breaker.openUntil = Date.now() + BREAKER_COOLDOWN_MS;
        return { ok: false, content: "", error: error instanceof Error ? error.message : String(error) };
      }
    },
    close() {
      transport?.close();
    },
  };
}

/** Connect many servers with isolated lifecycles; expose tools to flows. */
export async function connectMcpServers(
  servers: Record<string, McpServerConfig>,
  cwd = process.cwd(),
): Promise<{ handles: McpServerHandle[]; registry: FlowToolRegistry; close(): void }> {
  const handles = await Promise.all(Object.entries(servers).map(([name, config]) => connectMcpServer(name, config, cwd)));
  const registry: FlowToolRegistry = {};
  for (const handle of handles) {
    for (const tool of handle.tools) {
      registry[tool.namespaced] = async (args: Record<string, unknown>) => {
        const result = await handle.call(tool.name, args, cwd);
        if (!result.ok) throw new Error(result.error ?? "MCP call failed");
        return result.content;
      };
    }
  }
  return { handles, registry, close: () => handles.forEach((handle) => handle.close()) };
}
