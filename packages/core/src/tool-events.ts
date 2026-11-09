/**
 * Provider-neutral tool activity for a running turn: one `start` and one `end`
 * per tool item, in the order the provider ran them. Surfaces paint these as
 * transcript cells; file edits stay with the workspace observer, which reports
 * what actually hit disk.
 */
export type AgentToolKind = "command" | "mcp" | "web" | "tool";

export interface AgentToolEvent {
  readonly phase: "start" | "end";
  /** Provider item id; pairs a start with its end. */
  readonly id: string;
  readonly kind: AgentToolKind;
  /** What ran: the command line, `server.tool`, or the search query. */
  readonly title: string;
  readonly exitCode?: number;
  readonly output?: string;
  readonly durationMs?: number;
  /** True when the tool reported failure (non-zero exit, MCP error). */
  readonly failed?: boolean;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function commandText(value: unknown): string | undefined {
  if (Array.isArray(value)) return value.filter((part) => typeof part === "string").join(" ") || undefined;
  return text(value);
}

function mcpResultText(result: unknown): string | undefined {
  if (!result || typeof result !== "object") return text(result);
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) return undefined;
  const parts = content
    .map((block) => (block && typeof block === "object" ? text((block as { text?: unknown }).text) : undefined))
    .filter((part): part is string => Boolean(part));
  return parts.length ? parts.join("\n") : undefined;
}

/** Map a Codex app-server `item/started` / `item/completed` item to a tool event; undefined for non-tool items. */
export function codexItemToToolEvent(item: Record<string, unknown>, phase: "start" | "end"): AgentToolEvent | undefined {
  const id = text(item.id) ?? "";
  switch (item.type) {
    case "commandExecution": {
      const title = commandText(item.command) ?? "command";
      if (phase === "start") return { phase, id, kind: "command", title };
      const exitCode = num(item.exitCode);
      const status = text(item.status);
      return {
        phase,
        id,
        kind: "command",
        title,
        ...(exitCode !== undefined ? { exitCode } : {}),
        ...(text(item.aggregatedOutput) ? { output: text(item.aggregatedOutput) } : {}),
        ...(num(item.durationMs) !== undefined ? { durationMs: num(item.durationMs) } : {}),
        failed: (exitCode !== undefined && exitCode !== 0) || status === "failed" || status === "declined",
      };
    }
    case "mcpToolCall": {
      const title = [text(item.server), text(item.tool)].filter(Boolean).join(".") || "mcp";
      if (phase === "start") return { phase, id, kind: "mcp", title };
      const error = item.error && typeof item.error === "object" ? text((item.error as { message?: unknown }).message) : undefined;
      const output = error ?? mcpResultText(item.result);
      return {
        phase,
        id,
        kind: "mcp",
        title,
        ...(output ? { output } : {}),
        ...(num(item.durationMs) !== undefined ? { durationMs: num(item.durationMs) } : {}),
        failed: Boolean(error) || text(item.status) === "failed",
      };
    }
    case "webSearch": {
      const title = text(item.query) ?? "web search";
      return phase === "start" ? { phase, id, kind: "web", title } : { phase, id, kind: "web", title, failed: false };
    }
    default:
      return undefined;
  }
}
