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
  /** The call's arguments as `key: value` text (MCP calls), for the cell headline. */
  readonly args?: string;
}

/** `id: 4411, content: "QA lunch"`: an MCP call's arguments on one line. */
export function summarizeToolArguments(value: unknown): string | undefined {
  let parsed = value;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return parsed.trim() || undefined;
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return parsed === undefined || parsed === null ? undefined : JSON.stringify(parsed);
  const entries = Object.entries(parsed as Record<string, unknown>).map(([key, entry]) => `${key}: ${typeof entry === "string" ? JSON.stringify(entry) : JSON.stringify(entry) ?? String(entry)}`);
  const line = entries.join(", ");
  return line ? (line.length > 400 ? `${line.slice(0, 399)}…` : line) : undefined;
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
      const args = summarizeToolArguments(item.arguments);
      if (phase === "start") return { phase, id, kind: "mcp", title, ...(args ? { args } : {}) };
      const error = item.error && typeof item.error === "object" ? text((item.error as { message?: unknown }).message) : undefined;
      const output = error ?? mcpResultText(item.result);
      return {
        phase,
        id,
        kind: "mcp",
        title,
        ...(args ? { args } : {}),
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

function piResultText(result: unknown): string | undefined {
  if (typeof result === "string") return text(result);
  if (!result || typeof result !== "object") return undefined;
  const content = (result as { content?: unknown }).content;
  if (Array.isArray(content)) {
    const parts = content
      .map((block) => (block && typeof block === "object" ? text((block as { text?: unknown }).text) : undefined))
      .filter((part): part is string => Boolean(part));
    if (parts.length) return parts.join("\n");
  }
  return text((result as { message?: unknown }).message);
}

/** `write hello.txt`, `edit src/a.ts`, `grep TODO`: the tool and its main target. */
function piToolTitle(toolName: string, args: Record<string, unknown>): string {
  const target = text(args.path) ?? text(args.file_path) ?? text(args.pattern) ?? text(args.query) ?? text(args.url);
  return target ? `${toolName} ${target}` : toolName;
}

/**
 * Map pi AgentSession `tool_execution_start` / `tool_execution_end` to tool
 * events. `args` for an end event are the ones recorded at its start (pi only
 * sends them once). bash is a command; everything else is a generic tool.
 */
export function piToolEventToAgentToolEvent(
  event: { readonly type: string; readonly toolCallId?: string; readonly toolName?: string; readonly args?: unknown; readonly result?: unknown; readonly isError?: boolean },
  argsAtStart?: Record<string, unknown>,
): AgentToolEvent | undefined {
  if (event.type !== "tool_execution_start" && event.type !== "tool_execution_end") return undefined;
  const id = event.toolCallId ?? "";
  const toolName = event.toolName ?? "tool";
  const args = (argsAtStart ?? (event.args && typeof event.args === "object" ? event.args : {})) as Record<string, unknown>;
  const isCommand = toolName === "bash";
  const kind: AgentToolKind = isCommand ? "command" : "tool";
  const title = isCommand ? (commandText(args.command) ?? "bash") : piToolTitle(toolName, args);
  if (event.type === "tool_execution_start") return { phase: "start", id, kind, title };
  const output = piResultText(event.result);
  const failed = event.isError === true;
  const exitCode = isCommand ? (failed ? Number(output?.match(/exited with code (\d+)/)?.[1] ?? 1) : 0) : undefined;
  return {
    phase: "end",
    id,
    kind,
    title,
    ...(exitCode !== undefined ? { exitCode } : {}),
    ...(output ? { output } : {}),
    failed,
  };
}
