import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isPreDispatchSpawnError, runSubprocess } from "./subprocess.js";
import type { AgentToolEvent } from "./tool-events.js";

const execFileAsync = promisify(execFile);

export interface ClaudeCodeRunInput {
  readonly prompt: string;
  /**
   * Operating rules / recalled context to apply as the Claude CLI *system*
   * prompt (via --append-system-prompt) rather than inlining into the user
   * message — inlining makes the model narrate the rules back into its answer.
   */
  readonly systemPrompt?: string;
  readonly cwd?: string;
  readonly model?: string;
  readonly effort?: "low" | "medium" | "high" | "xhigh" | "max";
  readonly allowedTools?: readonly string[];
  readonly pluginDirs?: readonly string[];
  readonly timeoutMs?: number;
  readonly command?: string;
  /**
   * A muster-managed session id (UUID). When set, the session is persisted so a
   * follow-up turn can resume it — muster pins its OWN id (`--session-id`) rather
   * than parsing one out of Claude's output, keeping the text output format.
   */
  readonly sessionId?: string;
  readonly resume?: boolean;
  /** Path to a Claude Code MCP config JSON (`--mcp-config`), e.g. the host's browser tools. */
  readonly mcpConfig?: string;
  /** Claude Code `--permission-mode` (plan, default, acceptEdits, bypassPermissions). */
  readonly permissionMode?: string;
  /**
   * Live listeners. When either is set the turn runs with
   * `--output-format stream-json`, so text streams, tool calls become events
   * and usage is exact; without them the plain text mode is unchanged.
   */
  readonly onDelta?: (text: string) => void;
  readonly onToolEvent?: (event: AgentToolEvent) => void;
}

export interface ClaudeCodeUsage {
  /** Uncached + cache read + cache write: everything the model was sent. */
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly outputTokens: number;
  readonly costUsd?: number;
}

export interface ClaudeCodeRunResult {
  readonly status: "completed" | "failed";
  readonly command: string;
  readonly args: string[];
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
  readonly errorMessage?: string;
  readonly fallbackEligible?: boolean;
  /** Present when the turn ran in stream-json mode and Claude reported usage. */
  readonly usage?: ClaudeCodeUsage;
}

export async function inspectClaudeCode(command = "claude"): Promise<{ readonly available: boolean; readonly version?: string }> {
  try {
    const result = await execFileAsync(command, ["--version"], { timeout: 5000 });
    return { available: true, version: result.stdout.trim() || result.stderr.trim() };
  } catch {
    return { available: false };
  }
}

export async function runClaudeCode(input: ClaudeCodeRunInput): Promise<ClaudeCodeRunResult> {
  if (!input.prompt.trim()) throw new Error("Claude Code prompt is required.");
  const command = input.command ?? "claude";
  const stream = Boolean(input.onDelta || input.onToolEvent);
  const args = buildClaudeCodeArgs(input, { stream });
  const started = Date.now();
  const parser = stream ? new ClaudeStreamParser(input) : undefined;
  try {
    const result = await runSubprocess(command, args, {
      cwd: input.cwd ?? process.cwd(),
      timeoutMs: input.timeoutMs ?? 120_000,
      maxBuffer: 1024 * 1024 * 32,
      ...(parser ? { onStdoutLine: (line: string) => parser.line(line) } : {}),
    });
    const outcome = parser?.finish();
    return {
      status: outcome?.isError ? "failed" : "completed",
      command,
      args,
      stdout: outcome ? outcome.text : result.stdout.trim(),
      stderr: result.stderr.trim(),
      durationMs: Date.now() - started,
      ...(outcome?.isError ? { errorMessage: outcome.text || "claude reported an error" } : {}),
      ...(outcome?.usage ? { usage: outcome.usage } : {}),
    };
  } catch (error) {
    const detail = error as Error & { stdout?: string; stderr?: string };
    return {
      status: "failed",
      command,
      args,
      stdout: detail.stdout?.trim() ?? "",
      stderr: detail.stderr?.trim() ?? "",
      durationMs: Date.now() - started,
      errorMessage: detail.message,
      fallbackEligible: isPreDispatchSpawnError(error),
    };
  }
}

export function buildClaudeCodeArgs(input: ClaudeCodeRunInput, options: { readonly stream?: boolean } = {}): string[] {
  const args = options.stream
    ? ["--print", "--output-format", "stream-json", "--verbose", "--include-partial-messages"]
    : ["--print", "--output-format", "text"];
  // Persist the session only when muster is managing a session id; otherwise keep
  // the original stateless behaviour. Resume an existing session, or pin a fresh
  // one with the muster-generated id so the next turn can resume it.
  if (input.resume && input.sessionId) args.push("--resume", input.sessionId);
  else if (input.sessionId) args.push("--session-id", input.sessionId);
  else args.push("--no-session-persistence");
  if (input.model) args.push("--model", input.model);
  if (input.effort) args.push("--effort", input.effort);
  if (input.permissionMode) args.push("--permission-mode", input.permissionMode);
  if (input.allowedTools?.length) args.push("--allowedTools", input.allowedTools.join(","));
  for (const pluginDir of input.pluginDirs ?? []) args.push("--plugin-dir", pluginDir);
  if (input.mcpConfig) args.push("--mcp-config", input.mcpConfig);
  if (input.systemPrompt) args.push("--append-system-prompt", input.systemPrompt);
  // `--mcp-config` (and other list options) take several values: without the
  // separator the prompt is read as one more config file and the turn fails.
  args.push("--", input.prompt);
  return args;
}

function blockText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => (block && typeof block === "object" && typeof (block as { text?: unknown }).text === "string" ? (block as { text: string }).text : ""))
    .filter(Boolean)
    .join("\n");
}

function baseName(path: string): string {
  const parts = path.split("/");
  return parts[parts.length - 1] || path;
}

/** `Read calc.py`, `Edit src/a.ts`, `Grep TODO`, `WebFetch https://…`. */
function claudeToolTitle(name: string, input: Record<string, unknown>): string {
  const path = typeof input.file_path === "string" ? baseName(input.file_path) : typeof input.path === "string" ? input.path : undefined;
  const target = path ?? (typeof input.pattern === "string" ? input.pattern : undefined) ?? (typeof input.url === "string" ? input.url : undefined) ?? (typeof input.query === "string" ? input.query : undefined);
  return target ? `${name} ${target}` : name;
}

/**
 * Claude Code `--output-format stream-json` → deltas, tool events and the
 * final result. Lines that are not JSON (an older claude printing text) are
 * kept as the answer so the turn still completes.
 */
class ClaudeStreamParser {
  private readonly tools = new Map<string, { kind: AgentToolEvent["kind"]; title: string }>();
  private plain: string[] = [];
  private assistantText: string[] = [];
  private result: { text: string; isError: boolean; usage?: ClaudeCodeUsage } | undefined;
  private streamedText = false;
  private paragraphBreak = false;

  constructor(private readonly input: Pick<ClaudeCodeRunInput, "onDelta" | "onToolEvent">) {}

  line(raw: string): void {
    const trimmed = raw.trim();
    if (!trimmed) return;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      this.plain.push(raw);
      return;
    }
    if (!event || typeof event !== "object" || typeof event.type !== "string") {
      this.plain.push(raw);
      return;
    }
    switch (event.type) {
      case "stream_event": {
        const inner = event.event as { type?: string; delta?: { type?: string; text?: string } } | undefined;
        if (inner?.type === "content_block_delta" && inner.delta?.type === "text_delta" && inner.delta.text) {
          // A finished assistant message or a tool call sits between this text
          // and the previous text: it is a new paragraph, not a continuation.
          if (this.paragraphBreak) this.input.onDelta?.("\n\n");
          this.paragraphBreak = false;
          this.streamedText = true;
          this.input.onDelta?.(inner.delta.text);
        }
        return;
      }
      case "assistant": {
        if (this.streamedText) this.paragraphBreak = true;
        const content = (event.message as { content?: unknown[] } | undefined)?.content ?? [];
        for (const block of content as Array<Record<string, unknown>>) {
          if (block.type === "text" && typeof block.text === "string") {
            this.assistantText.push(block.text);
            if (!this.streamedText) this.input.onDelta?.(`${block.text}\n\n`);
          }
          if (block.type === "tool_use" && typeof block.id === "string") {
            const name = typeof block.name === "string" ? block.name : "tool";
            const args = (block.input && typeof block.input === "object" ? block.input : {}) as Record<string, unknown>;
            const kind: AgentToolEvent["kind"] = name === "Bash" ? "command" : name.startsWith("mcp__") ? "mcp" : name === "WebSearch" ? "web" : "tool";
            const title = kind === "command" && typeof args.command === "string" ? args.command : claudeToolTitle(name, args);
            this.tools.set(block.id, { kind, title });
            this.emitTool({ phase: "start", id: block.id, kind, title });
          }
        }
        return;
      }
      case "user": {
        const content = (event.message as { content?: unknown[] } | undefined)?.content ?? [];
        for (const block of content as Array<Record<string, unknown>>) {
          if (block.type !== "tool_result" || typeof block.tool_use_id !== "string") continue;
          const tool = this.tools.get(block.tool_use_id);
          if (!tool) continue;
          const output = blockText(block.content);
          const failed = block.is_error === true;
          const exitCode = tool.kind === "command" ? (failed ? Number(output.match(/exit code (\d+)/i)?.[1] ?? 1) : 0) : undefined;
          this.emitTool({
            phase: "end",
            id: block.tool_use_id,
            kind: tool.kind,
            title: tool.title,
            ...(exitCode !== undefined ? { exitCode } : {}),
            ...(output ? { output } : {}),
            failed,
          });
          this.tools.delete(block.tool_use_id);
        }
        return;
      }
      case "result": {
        const usage = event.usage as Record<string, unknown> | undefined;
        const n = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);
        this.result = {
          text: typeof event.result === "string" ? event.result : "",
          isError: event.is_error === true,
          ...(usage
            ? {
                usage: {
                  inputTokens: n(usage.input_tokens) + n(usage.cache_read_input_tokens) + n(usage.cache_creation_input_tokens),
                  cachedInputTokens: n(usage.cache_read_input_tokens),
                  outputTokens: n(usage.output_tokens),
                  ...(typeof event.total_cost_usd === "number" ? { costUsd: event.total_cost_usd } : {}),
                },
              }
            : {}),
        };
        return;
      }
      default:
        return;
    }
  }

  finish(): { text: string; isError: boolean; usage?: ClaudeCodeUsage } {
    if (this.result) return { ...this.result, text: this.result.text.trim() || this.assistantText.join("\n\n").trim() };
    const text = (this.assistantText.length ? this.assistantText.join("\n\n") : this.plain.join("\n")).trim();
    return { text, isError: false };
  }

  private emitTool(event: AgentToolEvent): void {
    try { this.input.onToolEvent?.(event); } catch { /* a surface bug never fails the turn */ }
  }
}
