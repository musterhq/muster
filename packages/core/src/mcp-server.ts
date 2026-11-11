/**
 * `muster mcp serve`: Muster's own abilities as an MCP server over stdio
 * (newline-delimited JSON-RPC 2.0). Every call goes through the tool registry,
 * so result caps, env checks and policy gates (memory.policy) apply unchanged.
 */
import readline from "node:readline";
import type { Readable, Writable } from "node:stream";
import { createToolRegistry, registerBuiltinTools, type ToolContext, type ToolRegistryV2 } from "./tool-registry.js";

/** What an outside runtime gets: memory, sessions, results, reminders and skills (read-only). No shell, no file writes; runtimes have their own. */
export const MCP_SERVE_TOOLS: readonly string[] = [
  "memory_search",
  "memory_get",
  "memory_write",
  "session_search",
  "session_status",
  "result_fetch",
  "schedule_manage",
  "skill_view",
];

export interface MusterMcpServerOptions {
  readonly cwd: string;
  readonly version: string;
  readonly tools?: readonly string[];
  readonly registry?: ToolRegistryV2;
  /** Scopes a memory tool uses when the client passes none (the user's own, as in chat). */
  readonly defaultScopes?: readonly string[];
  /** Tools served on top of `tools` that can change while serving (code plugin tools). */
  readonly extraTools?: () => Iterable<string>;
  /** Called before tools/list and tools/call, so plugins enabled or disabled meanwhile are seen. */
  readonly refresh?: () => Promise<unknown>;
}

type JsonRpcMessage = { readonly jsonrpc?: string; readonly id?: string | number | null; readonly method?: string; readonly params?: Record<string, unknown> };

export interface MusterMcpServer {
  /** Answer one message; undefined for notifications. */
  handle(message: JsonRpcMessage): Promise<Record<string, unknown> | undefined>;
}

export function createMusterMcpServer(options: MusterMcpServerOptions): MusterMcpServer {
  const registry = options.registry ?? (() => {
    const created = createToolRegistry();
    registerBuiltinTools(created);
    return created;
  })();
  const base = new Set(options.tools ?? MCP_SERVE_TOOLS);
  const isAllowed = (name: string): boolean => base.has(name) || [...(options.extraTools?.() ?? [])].includes(name);
  const refresh = async (): Promise<void> => { await options.refresh?.().catch(() => undefined); };
  const ctx: ToolContext = { cwd: options.cwd };
  const reply = (id: JsonRpcMessage["id"], result: unknown) => ({ jsonrpc: "2.0", id, result });
  const fail = (id: JsonRpcMessage["id"], code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });

  return {
    async handle(message) {
      const { id, method } = message;
      const isRequest = id !== undefined && id !== null;
      switch (method) {
        case "initialize":
          return reply(id, {
            protocolVersion: typeof message.params?.protocolVersion === "string" ? message.params.protocolVersion : "2025-06-18",
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: "muster", version: options.version },
            instructions: "Muster's durable memory, session history and reminders. Search memory before asking the user something they may have told you before; write memory only for durable facts. Use schedule_manage when the user asks to be reminded or wants something to run later or on a schedule. Read a listed skill with skill_view before relying on it.",
          });
        case "ping":
          return reply(id, {});
        case "tools/list":
          await refresh();
          return reply(id, {
            tools: registry.list().filter((entry) => isAllowed(entry.name)).map((entry) => ({
              name: entry.name,
              description: entry.description,
              inputSchema: entry.inputSchema ?? { type: "object", properties: {} },
            })),
          });
        case "tools/call": {
          const name = typeof message.params?.name === "string" ? message.params.name : "";
          if (!base.has(name)) await refresh();
          if (!isAllowed(name)) return fail(id, -32602, `Unknown tool: ${name}`);
          let args = (message.params?.arguments && typeof message.params.arguments === "object" ? message.params.arguments : {}) as Record<string, unknown>;
          const noScopes = !Array.isArray(args.scopes) || args.scopes.length === 0;
          if (name.startsWith("memory_") && noScopes && options.defaultScopes?.length) args = { ...args, scopes: [...options.defaultScopes] };
          const result = await registry.execute(name, args, ctx);
          return reply(id, result.ok
            ? { content: [{ type: "text", text: typeof result.data === "string" ? result.data : JSON.stringify(result.data, null, 2) }] }
            : { content: [{ type: "text", text: result.error }], isError: true });
        }
        default:
          return isRequest ? fail(id, -32601, `Method not found: ${method ?? ""}`) : undefined;
      }
    },
  };
}

/** Serve until stdin closes. Responses keep request order per line; stdout carries protocol only. */
export async function serveMcpOverStdio(server: MusterMcpServer, input: Readable = process.stdin, output: Writable = process.stdout): Promise<void> {
  const lines = readline.createInterface({ input });
  for await (const line of lines) {
    if (!line.trim()) continue;
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(line) as JsonRpcMessage;
    } catch {
      output.write(`${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } })}\n`);
      continue;
    }
    let response: Record<string, unknown> | undefined;
    try {
      response = await server.handle(message);
    } catch (error) {
      response = message.id === undefined ? undefined : { jsonrpc: "2.0", id: message.id, error: { code: -32603, message: error instanceof Error ? error.message : String(error) } };
    }
    if (response) output.write(`${JSON.stringify(response)}\n`);
  }
}
