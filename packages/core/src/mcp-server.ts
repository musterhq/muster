/**
 * `muster mcp serve`: Muster's own abilities as an MCP server over stdio
 * (newline-delimited JSON-RPC 2.0). Every call goes through the tool registry,
 * so result caps, env checks and policy gates (memory.policy) apply unchanged.
 */
import readline from "node:readline";
import type { Readable, Writable } from "node:stream";
import { createToolRegistry, registerBuiltinTools, type ToolContext, type ToolRegistryV2 } from "./tool-registry.js";

/** What an outside runtime gets: memory, sessions and results. No shell, no file writes; runtimes have their own. */
export const MCP_SERVE_TOOLS: readonly string[] = [
  "memory_search",
  "memory_get",
  "memory_write",
  "session_search",
  "session_status",
  "result_fetch",
];

export interface MusterMcpServerOptions {
  readonly cwd: string;
  readonly version: string;
  readonly tools?: readonly string[];
  readonly registry?: ToolRegistryV2;
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
  const allowed = new Set(options.tools ?? MCP_SERVE_TOOLS);
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
            instructions: "Muster's durable memory and session history. Search memory before asking the user something they may have told you before; write memory only for durable facts.",
          });
        case "ping":
          return reply(id, {});
        case "tools/list":
          return reply(id, {
            tools: registry.list().filter((entry) => allowed.has(entry.name)).map((entry) => ({
              name: entry.name,
              description: entry.description,
              inputSchema: entry.inputSchema ?? { type: "object", properties: {} },
            })),
          });
        case "tools/call": {
          const name = typeof message.params?.name === "string" ? message.params.name : "";
          if (!allowed.has(name)) return fail(id, -32602, `Unknown tool: ${name}`);
          const args = (message.params?.arguments && typeof message.params.arguments === "object" ? message.params.arguments : {}) as Record<string, unknown>;
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
