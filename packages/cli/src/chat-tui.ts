import {
  Editor,
  ProcessTerminal,
  SelectList,
  SettingsList,
  TUI,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type AutocompleteItem,
  type AutocompleteProvider,
  type Component,
  type EditorTheme,
  type OverlayHandle,
  type SelectItem,
  type SelectListTheme,
  type SettingsListTheme,
  type Terminal,
} from "@earendil-works/pi-tui";
import { execFile } from "node:child_process";
import { appendFileSync, mkdirSync, realpathSync, renameSync, statSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createCoalescer, unwrapShellCommand } from "@musterhq/core";
import type { AgentToolEvent, ApprovalDecision, ApprovalRequest, BoardView, MessageRow } from "@musterhq/core";
import { effortDisplayLabel, modelDisplayLabel, modelProvider, type ComposerPickerSelection, type ComposerPickerState, type EffortValue } from "./model-catalog.js";
import { decodeCapabilitySelection, isCapabilityConfirmationText } from "./capabilities-overlay.js";
import { LiveFileOverlay, LiveFileTurnAccumulator, renderLiveFilePlain } from "./live-file-view.js";
import { BoardScreen, parseSgrMouseSequence, stripMouseSequences, type SgrMouseEvent } from "./board-screen.js";
import { openFileWithEditorGuard, TaskView } from "./task-view.js";
import { SettingsPanel, type SettingsChange } from "./settings-panel.js";
import {
  bandRow,
  bandUserRow,
  missionStatusGlyph as sharedMissionStatusGlyph,
  renderChip,
  renderActionBullet,
  renderMissionStatusGlyph,
  renderProse,
  renderReasoningLine,
} from "./prose-renderer.js";

export interface MusterChatCommand {
  readonly name: string;
  readonly usage: string;
  readonly description: string;
  readonly aliases?: readonly string[];
}

export interface MusterAutocompleteOptions {
  readonly commands: readonly MusterChatCommand[];
  readonly toolsets: readonly string[];
  readonly recentSessions: () => readonly string[];
  readonly catalog?: MusterCompletionCatalog;
  readonly providers?: () => readonly PickerOption[] | Promise<readonly PickerOption[]>;
  readonly models?: (context: { providerId?: string }) => readonly PickerOption[] | Promise<readonly PickerOption[]>;
  readonly runtimes?: () => readonly PickerOption[] | Promise<readonly PickerOption[]>;
  readonly clouds?: () => readonly PickerOption[] | Promise<readonly PickerOption[]>;
  readonly speeds?: () => readonly PickerOption[] | Promise<readonly PickerOption[]>;
  readonly capabilities?: () => readonly PickerOption[] | Promise<readonly PickerOption[]>;
  readonly skills?: () => readonly PickerOption[] | Promise<readonly PickerOption[]>;
  readonly plugins?: () => readonly PickerOption[] | Promise<readonly PickerOption[]>;
  readonly pluginReuseProviders?: () => readonly PickerOption[] | Promise<readonly PickerOption[]>;
  readonly mcpServers?: () => readonly PickerOption[] | Promise<readonly PickerOption[]>;
  readonly mcpTargets?: () => readonly PickerOption[] | Promise<readonly PickerOption[]>;
  readonly integrations?: () => readonly PickerOption[] | Promise<readonly PickerOption[]>;
  readonly integrationWorkflows?: () => readonly PickerOption[] | Promise<readonly PickerOption[]>;
  readonly agents: () => readonly string[] | Promise<readonly string[]>;
}

export type MusterCompletionKind =
  | "command"
  | "toolset"
  | "session"
  | "provider"
  | "provider-model"
  | "model"
  | "runtime"
  | "cloud"
  | "speed"
  | "capability"
  | "skill"
  | "plugin"
  | "plugin-reuse-provider"
  | "mcp"
  | "mcp-target"
  | "integration"
  | "integration-workflow"
  | "reasoning"
  | "agent";

export interface MusterCompletionRequest {
  readonly kind: MusterCompletionKind;
  readonly fragment: string;
  readonly providerId?: string;
}

export interface MusterCompletionCatalog {
  complete(request: MusterCompletionRequest): readonly PickerOption[] | Promise<readonly PickerOption[]>;
}

export interface PickerOption {
  readonly value: string;
  readonly label?: string;
  readonly description?: string;
}

export interface MusterChatSink {
  appendLine(line: string): void;
  /**
   * A transcript block that can change after it is painted (a tool cell going
   * from running to finished). The first call appends it; later calls with the
   * same id replace it in place. `render` is called again when Ctrl+O toggles
   * expanded output.
   */
  upsertBlock(id: string, render: (expanded: boolean) => string[]): void;
  /** Ctrl+O: expand or collapse every block's output. */
  toggleExpanded(): void;
  /** /rewind: grey out the transcript from the rewound prompt on, under a marker row. */
  markRewound(prompt: string): void;
  /** The status bar under the composer (one pre-styled row; empty hides it). */
  setFooter(line: string): void;
  /**
   * Show an approval card and wait for y (once), a (this session), n (deny)
   * or Esc (deny and stop). Every other key is held back while it waits.
   */
  requestApproval(request: ApprovalRequest): Promise<ApprovalDecision>;
  appendUser(text: string): void;
  clearTranscript(): void;
  setHeaderLines(lines: readonly string[]): void;
  setStatus(status: string): void;
  clearStatus(): void;
  openPicker(command: string): void;
  selectComposerSetting(state: ComposerPickerState): Promise<ComposerPickerSelection | undefined>;
  /** Arrow-driven list anchored at the composer; resolves the picked value, undefined on Esc. */
  selectFromList(title: string, options: readonly PickerOption[]): Promise<string | undefined>;
  /** Replace the Canvas data source at the start of a model turn. */
  setLiveDiffTurn(turn: LiveFileTurnAccumulator): void;
  /** Repaint an open Canvas after an observer patch. */
  updateLiveDiff(turn: LiveFileTurnAccumulator): void;
  /** Ctrl+D and /diff share this exact toggle. */
  toggleLiveDiff(): void;
  /** Replace chat with the full-screen task board. Returns false when no board is available. */
  openBoard(force?: boolean): Promise<boolean>;
  /** Replace chat with the full-screen settings panel; resolves when it closes. */
  openSettings(options: OpenSettingsOptions): Promise<void>;
  /** Rebuild the status bar now (after a change it shows, such as access). */
  refreshFooter?: (width?: number) => Promise<void>;
}

export interface OpenSettingsOptions {
  readonly cwd: string;
  /** Called after each saved change so the live session can follow it. */
  readonly onChange?: (change: SettingsChange) => void;
}

export interface BoardModeController {
  readonly cwd: string;
  loadView(): BoardView | Promise<BoardView>;
  loadMessages(sessionId: string): readonly MessageRow[] | Promise<readonly MessageRow[]>;
  diff(taskId: string): LiveFileTurnAccumulator;
  comment(taskId: string, text: string, anchor?: { readonly path: string; readonly line: number }): void | Promise<void>;
  approve(taskId: string): void | Promise<void>;
  retry(taskId: string): void | Promise<void>;
  cancel(taskId: string): void | Promise<void>;
}

export interface RunMusterChatTuiOptions extends MusterAutocompleteOptions {
  readonly headerLines?: readonly string[];
  /** Transcript rows present before the first frame, including resumed history. */
  readonly initialLines?: readonly string[];
  readonly statusLine: () => string | Promise<string>;
  readonly onSubmit: (text: string, sink: MusterChatSink) => Promise<boolean>;
  /** Interrupt the provider turn currently owned by onSubmit. */
  readonly onInterrupt?: () => boolean | Promise<boolean>;
  /** Inject text into the running turn; false when the runtime cannot steer (the text is queued instead). */
  readonly onSteer?: (text: string) => boolean | Promise<boolean>;
  /** The status bar under the composer; refreshed at start and after every turn. */
  readonly footerLine?: (width: number) => string | Promise<string>;
  /** Consume a raw key while index.ts owns a one-line pending decision. */
  readonly onDecisionKey?: (data: string, sink: MusterChatSink) => boolean;
  /** Printed to stdout after teardown when the session exits via /exit. */
  readonly farewell?: string;
  readonly board?: BoardModeController;
  /** Called once the screen is live; the returned function runs at teardown (e.g. the automations ticker). */
  readonly onReady?: (sink: MusterChatSink) => (() => void) | void;
}

export interface MusterChatHarness {
  input(data: string): void;
  type(text: string): void;
  submit(): Promise<void>;
  visible(width?: number): string[];
  text(): string;
  transcript(): readonly string[];
  openPicker(command: string): void;
  /** True once an exit command (/exit, /quit, /q) has been routed. */
  exited(): boolean;
  /** The single status row the spinner owns; never part of the transcript. */
  status(): string;
}

export function formatWorkingIndicator(agentId: string | undefined, frame: number): string {
  // A verb, alive — never a bare clock. Rotates slowly so long waits breathe.
  const verb = WORKING_VERBS[Math.floor(Math.abs(frame) / 16) % WORKING_VERBS.length]!;
  const label = agentId ? `@${agentId} ${verb}` : verb;
  return `${STATUS_SPINNER_FRAMES[Math.abs(frame) % STATUS_SPINNER_FRAMES.length]} ${label}`;
}

const WORKING_VERBS = ["Thinking", "Reading", "Weighing", "Connecting", "Shaping", "Composing"] as const;

const RESET = "\x1b[0m";
// Claude Code-calibre restraint: ONE warm coral accent (Anthropic book-cloth
// tone), warm amber for highlights, warm neutral grays for chrome. The old
// cyan/lime arcade palette was the reported "old blue" problem — cold colors
// belong nowhere in the chat surface.
const ACCENT_RGB = "217;119;87";
const HIGHLIGHT_RGB = "224;175;104";
const MUTED_RGB = "148;144;140";
const RED_RGB = "255;107;122";
const SELECTION_BG_RGB = "48;45;43";

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * TUI render model (docs/PRODUCT_MODES.md, "Parent-model streaming").
 *
 * The transcript renders TYPED EVENTS only. Anything the engine happens to
 * print — a run-record JSON line, a memory-recall diagnostic, a spinner
 * repaint — is classified before it can reach the screen: chips go to the
 * transcript, raw diagnostics go to a session log, spinner frames go to the
 * single status row. `routeEngineLine` is the one gate, so a new print site
 * anywhere in the engine cannot re-open defect #1 or #2.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/** The subset of a `TokenRecord` (core `tokens.ts`) the cost chip renders. */
export interface CostChipRecord {
  readonly runId?: string;
  readonly provider?: string;
  readonly model?: string;
  readonly inputTokens?: number;
  readonly cachedInputTokens?: number;
  readonly outputTokens?: number;
  readonly estimated?: boolean;
  readonly costUsd?: number;
  readonly durationMs?: number;
}

export type EngineLineRoute =
  /** Model/tool content: paint it. */
  | { readonly kind: "transcript"; readonly line: string }
  /** A spinner frame: it belongs to the status row, never to scrollback. */
  | { readonly kind: "status"; readonly line: string }
  /** A run record: transcript gets `chip`, the log file gets `log`. */
  | { readonly kind: "cost"; readonly chip: string; readonly log: string; readonly runId?: string }
  /** Debug output: `chip` (when present) is the only thing a human sees. */
  | { readonly kind: "diagnostic"; readonly chip?: string; readonly log: string };

/**
 * Classify one engine-emitted line for a TTY session. Non-TTY callers must NOT
 * use this: scripts keep the raw JSON/diagnostic lines they parse today.
 */
export function routeEngineLine(line: string): EngineLineRoute {
  const clean = stripAnsi(line);
  const trimmed = clean.trim();
  if (isWorkingStatusLine(trimmed)) return { kind: "status", line: trimmed };
  const record = parseRunRecordLine(trimmed);
  if (record) return { kind: "cost", chip: formatCostChip(record), log: trimmed, runId: record.runId };
  if (trimmed.startsWith("memory backend=")) {
    return { kind: "diagnostic", chip: formatRecallChip(trimmed), log: trimmed };
  }
  if (trimmed.startsWith("timings total=")) {
    return { kind: "diagnostic", chip: formatTimingsChip(trimmed), log: trimmed };
  }
  if (isRecallReceiptDetailLine(trimmed)) return { kind: "diagnostic", log: trimmed };
  // Provider stderr fragments (Rust tracing lines, module paths) belong in the
  // session log, never the transcript — a truncated "codex_core::session: faile"
  // above an error card was observed live and reads as breakage.
  if (/^\d{4}-\d{2}-\d{2}T[\d:.]+Z?\s+(ERROR|WARN|INFO|DEBUG)\b/.test(trimmed) || /^[a-z_]+(?:::[a-z_]+)+:/.test(trimmed)) {
    return { kind: "diagnostic", log: trimmed };
  }
  return { kind: "transcript", line };
}

/** A spinner frame — `✻ Verb` / `✻ @agent Verb` (legacy `working` included). */
const WORKING_STATUS_RE = new RegExp(
  `^(?:✻|[|/\\\\-])\\s+(?:@[A-Za-z0-9_.:-]+\\s+)?(?:working|${WORKING_VERBS.join("|")})$`,
);
export function isWorkingStatusLine(line: string): boolean {
  return WORKING_STATUS_RE.test(stripAnsi(line).trim());
}

function isRecallReceiptDetailLine(line: string): boolean {
  return /^\S+\s+score=\d+(?:\.\d+)?\s+\S/.test(line);
}

/**
 * Parse a raw run-record JSON line. Deliberately strict: a line only counts as
 * a run record when it carries a runId AND both token counts, so a model that
 * legitimately answers with JSON is never swallowed.
 */
export function parseRunRecordLine(line: string): CostChipRecord | undefined {
  const trimmed = stripAnsi(line).trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object") return undefined;
  const record = parsed as Record<string, unknown>;
  if (typeof record.runId !== "string") return undefined;
  if (typeof record.inputTokens !== "number" || typeof record.outputTokens !== "number") return undefined;
  return record as CostChipRecord;
}

/** `▸ gpt-5.6 · 25.1k in · 3.0k cached · 512 out · $0.0337 · 12.4s` */
export function formatCostChip(record: CostChipRecord): string {
  const estimated = record.estimated ? "~" : "";
  const parts: string[] = [record.model ?? record.provider ?? "model"];
  if (typeof record.inputTokens === "number") parts.push(`${compactCount(record.inputTokens)}${estimated} in`);
  if (typeof record.cachedInputTokens === "number" && record.cachedInputTokens > 0) {
    parts.push(`${compactCount(record.cachedInputTokens)} cached`);
  }
  if (typeof record.outputTokens === "number") parts.push(`${compactCount(record.outputTokens)}${estimated} out`);
  if (typeof record.costUsd === "number") parts.push(`$${record.costUsd.toFixed(4)}`);
  if (typeof record.durationMs === "number") parts.push(formatDuration(record.durationMs));
  return renderChip(`▸ ${parts.join(" · ")}`);
}

/** `memory backend=… recalled=2 …` → `▸ recalled 2 memories`; nothing when 0. */
export function formatRecallChip(line: string): string | undefined {
  const recalled = Number(stripAnsi(line).match(/\brecalled=(\d+)/)?.[1] ?? Number.NaN);
  if (!Number.isFinite(recalled) || recalled <= 0) return undefined;
  return renderChip(`▸ recalled ${recalled} ${recalled === 1 ? "memory" : "memories"}`);
}

/** `timings total=8335ms provider=8259ms …` → `▸ 8.3s total · 8.3s provider`. */
export function formatTimingsChip(line: string): string | undefined {
  const clean = stripAnsi(line);
  const total = Number(clean.match(/\btotal=(\d+)ms/)?.[1] ?? Number.NaN);
  if (!Number.isFinite(total)) return undefined;
  const parts = [`${formatDuration(total)} total`];
  const provider = Number(clean.match(/\bprovider=(\d+)ms/)?.[1] ?? Number.NaN);
  if (Number.isFinite(provider)) parts.push(`${formatDuration(provider)} provider`);
  const firstToken = Number(clean.match(/\bfirst_token_ms=(\d+)/)?.[1] ?? Number.NaN);
  if (Number.isFinite(firstToken)) parts.push(`first token ${formatDuration(firstToken)}`);
  return renderChip(`▸ ${parts.join(" · ")}`);
}

/** `732.1k in · 1.4k out` — a session's token totals at a glance. */
export function formatTokenPair(input: number, output: number): string {
  return `${compactCount(input)} in · ${compactCount(output)} out`;
}

export function compactCount(value: number): string {
  if (!Number.isFinite(value)) return "0";
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(Math.round(value));
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "0ms";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * TRANSCRIPT IDIOM (owner verdict 2026-08-27: "functional but noisy").
 *
 * The transcript is styling and hierarchy ONLY — every fact that reached the
 * screen before still reaches it. What changes is the frame:
 *
 *   > restyle the transcript                     ← user turn, dim "> " gutter
 *
 *   ● Reading the gateway config to find where   ← assistant prose, one bullet
 *     the ingress spool is flushed.                per block, continuations
 *                                                  align under the bullet
 *   ⏺ Edit(server.js)                            ← an action is a headline
 *     ⎿ +12 −2 · 86ms · receipt d3b9c1a2…        ← its result is a dim elbow
 *       @@ -1,4 +1,5 @@                            with the detail indented
 *       … +7 lines
 *
 * No box frames: whitespace and gutters do the separating. The composer is a
 * bare `❯ ` prompt; only transient suggestion overlays keep their own frame.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/** The dim gutter a user turn wears in scrollback (the composer keeps "›"). */
export const USER_PREFIX = "> ";
/** One bullet per assistant message block; continuations align beneath it. */
export const ASSISTANT_BULLET = "●";
/** An action headline: `⏺ Edit(server.js)`. */
export const TOOL_BULLET = "⏺";
/** The result elbow hanging under an action. */
export const RESULT_ELBOW = "⎿";
/** Result detail beyond this many rows collapses to a "… +n lines" count. */
export const TOOL_RESULT_MAX_LINES = 6;
/** Spinner frames for the single status row (never the transcript). */
export const STATUS_SPINNER_FRAMES = ["✻"] as const;

/** `> deploy the limiter` — the gutter is dim, the user's own words are not. */
export function formatUserLine(text: string): string {
  return `${dim(">")} ${text}`;
}

/**
 * True for a user turn in scrollback. Assistant prose can legitimately contain
 * a markdown blockquote, so the test is anchored at column 0 — every assistant
 * row carries a "● "/"  " gutter and therefore can never be mistaken for one.
 */
export function isUserTranscriptLine(line: string): boolean {
  return stripAnsi(line).startsWith(USER_PREFIX);
}

/**
 * One assistant message block: `● first line`, continuations indented two so
 * the prose reads as a single column. `continued` keeps a streaming block open
 * — deltas paint into the SAME bullet instead of sprouting one per chunk.
 */
export function formatAssistantBlock(text: string, options: { readonly continued?: boolean } = {}): string[] {
  // Owner-ruled: the transcript is near-monochrome like the reference —
  // the assistant marker is DEFAULT foreground, never accent-colored.
  return renderProse(text, {
    firstPrefix: `${ASSISTANT_BULLET} `,
    continuationPrefix: "  ",
    continued: options.continued,
  });
}

/** `⏺ Edit(server.js)` — the action, on its own line, above its result. */
export function formatToolLine(name: string, target?: string, status: "pending" | "success" | "failure" = "pending"): string {
  const label = target ? `${name}(${target})` : name;
  return `${renderActionBullet(status)} ${label}`;
}

export interface ToolResultOptions {
  /** Raw result rows (diff hunks, stdout, table rows). Never reordered. */
  readonly detail?: readonly string[];
  /** Rows shown before collapsing. Default TOOL_RESULT_MAX_LINES. */
  readonly maxLines?: number;
  /**
   * Hint appended to the collapse counter, e.g. "ctrl+o expands". Set it ONLY
   * where an expand hook actually exists: the chat screen has none today, so a
   * long result truncates with an honest count instead of promising a keypress
   * that does nothing.
   */
  readonly expandHint?: string;
}

/**
 * `  ⎿ +12 −2 · 86ms` plus indented detail, collapsed past `maxLines`. Returns
 * lines, never prints — same purity rule as live-diff.ts.
 */
export function formatToolResultLines(summary: string, options: ToolResultOptions = {}): string[] {
  const lines = [`  ${dim(`${RESULT_ELBOW} ${summary}`)}`];
  const detail = options.detail ?? [];
  const maxLines = Math.max(1, options.maxLines ?? TOOL_RESULT_MAX_LINES);
  for (const row of detail.slice(0, maxLines)) lines.push(`    ${row}`);
  const hidden = detail.length - Math.min(detail.length, maxLines);
  if (hidden > 0) lines.push(`    ${dim(`… +${hidden} lines${options.expandHint ? ` (${options.expandHint})` : ""}`)}`);
  return lines;
}

export interface ToolBlockOptions extends ToolResultOptions {
  readonly name: string;
  readonly target?: string;
  readonly summary: string;
}

/** The whole ⏺/⎿ frame for one action. */
export function renderToolBlock(options: ToolBlockOptions): string[] {
  return [formatToolLine(options.name, options.target, "success"), ...formatToolResultLines(options.summary, options)];
}

export interface ToolSummaryParts {
  readonly additions?: number;
  readonly deletions?: number;
  readonly durationMs?: number;
  /** Content-addressed receipt; rendered short (`d3b9c1a2…`), never dropped. */
  readonly receipt?: string;
  /** Anything else worth one segment (e.g. "binary", "3 matches"). */
  readonly extra?: readonly string[];
}

/** `+12 −2 · 86ms · receipt d3b9c1a2…` — the dim one-liner under an action. */
export function formatToolSummary(parts: ToolSummaryParts): string {
  const segments: string[] = [];
  if (parts.additions !== undefined || parts.deletions !== undefined) {
    segments.push(`+${parts.additions ?? 0} −${parts.deletions ?? 0}`);
  }
  for (const extra of parts.extra ?? []) segments.push(extra);
  if (parts.durationMs !== undefined && Number.isFinite(parts.durationMs)) {
    segments.push(formatDuration(Math.max(0, parts.durationMs)));
  }
  if (parts.receipt) segments.push(`receipt ${shortReceipt(parts.receipt)}`);
  return segments.join(" · ");
}

/** `sha256:d3b9c1a2f0…` → `d3b9c1a2…`; anything shorter passes through. */
export function shortReceipt(receipt: string): string {
  const value = receipt.includes(":") ? receipt.slice(receipt.lastIndexOf(":") + 1) : receipt;
  return value.length > 8 ? `${value.slice(0, 8)}…` : value;
}

export interface StatusLineInfo {
  readonly model: string;
  readonly session: string;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly costUsd?: number;
  readonly elapsedMs?: number;
  /** Routed turn: `@review` rides at the left with the spinner. */
  readonly agentId?: string;
  /** Live working verb ("Thinking") — shimmered, never `@`-prefixed. */
  readonly verb?: string;
  /** Present ⇒ working; the spinner paints at the left edge of THIS row. */
  readonly frame?: number;
  /** Extra trailing segments (scopes, tool counts) the header no longer shows. */
  readonly extra?: readonly string[];
}

/**
 * The single bottom row that replaces the scattered chrome:
 * `⠙ @review · gpt-5.6-sol · main · 25.1k in / 512 out · $0.0337 · 12.4s`.
 * The spinner lives HERE and only here — a frame in the transcript is defect #4.
 */
export function formatStatusLine(info: StatusLineInfo): string {
  const segments: string[] = [];
  if (info.agentId) segments.push(`@${info.agentId}`);
  segments.push(info.model);
  segments.push(info.session);
  if (info.inputTokens !== undefined || info.outputTokens !== undefined) {
    segments.push(`${compactCount(info.inputTokens ?? 0)} in / ${compactCount(info.outputTokens ?? 0)} out`);
  }
  // A subscription turn costs nothing per call: `$0.0000` reads as a broken meter.
  if (info.costUsd !== undefined && Number.isFinite(info.costUsd) && info.costUsd > 0) segments.push(`$${info.costUsd.toFixed(4)}`);
  if (info.elapsedMs !== undefined && Number.isFinite(info.elapsedMs)) segments.push(formatDuration(Math.max(0, info.elapsedMs)));
  for (const extra of info.extra ?? []) segments.push(extra);
  const body = segments.join(" · ");
  if (info.frame === undefined) return dim(body);
  const tick = Math.abs(Math.trunc(info.frame));
  const spinner = STATUS_SPINNER_FRAMES[tick % STATUS_SPINNER_FRAMES.length]!;
  const verb = info.verb ? `${shimmerText(info.verb, tick)}${dim(" · ")}` : "";
  return `${accent(spinner)} ${verb}${dim(body)}`;
}

/**
 * THE SHIMMER: a warm 3-char bright window sweeps the verb letter-by-letter,
 * one position per spinner tick, running off both edges so the glow breathes.
 */
export function shimmerText(text: string, tick: number): string {
  const chars = [...text];
  if (!chars.length) return text;
  const span = chars.length + 4;
  const pos = (((tick % span) + span) % span) - 2;
  return chars
    .map((ch, index) => {
      const distance = Math.abs(index - pos);
      if (distance === 0) return `\x1b[38;2;255;246;238m${ch}\x1b[0m`;
      if (distance === 1) return `\x1b[38;2;224;196;178m${ch}\x1b[0m`;
      return dim(ch);
    })
    .join("");
}

/** Repaint a `✻ Verb` status row with the shimmer for the current tick. */
export function paintWorkingRow(row: string, tick: number): string {
  const plain = stripAnsi(row).trim();
  const match = /^([✻|/\\-])\s+(.*)$/.exec(plain);
  if (!match) return row;
  return `${accent(match[1]!)} ${shimmerText(match[2]!, tick)}`;
}

/** The status row's verb while an approval card waits for the user. */
export const APPROVAL_WAIT_VERB = "Waiting for approval";

/** A turn's elapsed time that can stop while the user decides on an approval. */
export class TurnTimer {
  private readonly startedAt: number;
  private pausedAt: number | undefined;
  private pausedTotal = 0;

  constructor(private readonly now: () => number = Date.now) {
    this.startedAt = now();
  }

  get paused(): boolean {
    return this.pausedAt !== undefined;
  }

  pause(): void {
    if (this.pausedAt === undefined) this.pausedAt = this.now();
  }

  resume(): void {
    if (this.pausedAt === undefined) return;
    this.pausedTotal += this.now() - this.pausedAt;
    this.pausedAt = undefined;
  }

  elapsedMs(): number {
    return Math.max(0, (this.pausedAt ?? this.now()) - this.startedAt - this.pausedTotal);
  }
}

/** The running turn's status row: the rotating verb and live timer, or `Waiting for approval` with the timer held. */
export function formatTurnStatusLine(info: StatusLineInfo, timer: TurnTimer, frame: number): string {
  // Token and cost counts here would be the session's or the last turn's, not
  // this turn's (known only when it ends, on the summary row): leave them out.
  const { inputTokens: _input, outputTokens: _output, costUsd: _cost, ...turnInfo } = info;
  return formatStatusLine({ ...turnInfo, verb: timer.paused ? APPROVAL_WAIT_VERB : workingVerbForFrame(frame), frame, elapsedMs: timer.elapsedMs() });
}

/** The status row's live verb — rotates every ~4s of spinner frames. */
export function workingVerbForFrame(frame: number): string {
  return WORKING_VERBS[Math.floor(Math.abs(frame) / 16) % WORKING_VERBS.length]!;
}

/** Task statuses collapse to three glyphs: pending, live, ended. */
export const missionStatusGlyph = sharedMissionStatusGlyph;

export interface MissionCardRow {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  /** Model or agent driving the task. */
  readonly agent?: string;
  /** The task's own latest narration line (already truncated by the caller). */
  readonly detail?: string;
  readonly tokens?: number;
  readonly elapsedMs?: number;
}

export interface MissionCard {
  readonly title: string;
  readonly rows: readonly MissionCardRow[];
  readonly costUsd?: number;
  readonly agents?: number;
}

/**
 * Task cards wear the same ⏺/⎿ frame as any other action, with columns aligned
 * so a three-agent task run reads as a table, not a list.
 */
export function renderMissionCard(card: MissionCard): string[] {
  const summary: string[] = [`${card.rows.length} task${card.rows.length === 1 ? "" : "s"}`];
  if (card.agents !== undefined) summary.push(`${card.agents} agent${card.agents === 1 ? "" : "s"}`);
  const live = card.rows.filter((row) => missionStatusGlyph(row.status) === "◔").length;
  if (live > 0) summary.push(`${live} running`);
  if (card.costUsd !== undefined && Number.isFinite(card.costUsd)) summary.push(`$${card.costUsd.toFixed(2)}`);

  const columns = card.rows.map((row) => [
    row.id,
    row.title,
    row.agent ?? "—",
    row.detail ?? "—",
    missionRowMetrics(row),
  ]);
  const widths = [0, 1, 2, 3].map((index) => Math.max(...columns.map((cells) => visibleWidth(cells[index] ?? "")), 0));
  const detail = columns.map((cells, index) => {
    const glyph = renderMissionStatusGlyph(card.rows[index]!.status);
    const body = cells.slice(0, 4).map((cell, column) => padPlain(cell ?? "", widths[column] ?? 0)).join("  ");
    const metrics = cells[4] ?? "";
    // Trim BEFORE tinting: padding hidden inside an escape sequence would
    // stretch every short row to the width of the longest one.
    return metrics ? `${glyph} ${body}  ${dim(metrics)}` : `${glyph} ${body}`.trimEnd();
  });
  return renderToolBlock({
    name: "Tasks",
    target: card.title,
    summary: summary.join(" · "),
    detail,
    maxLines: Math.max(TOOL_RESULT_MAX_LINES, detail.length),
  });
}

function missionRowMetrics(row: MissionCardRow): string {
  const parts: string[] = [];
  if (row.elapsedMs !== undefined && Number.isFinite(row.elapsedMs)) parts.push(formatDuration(Math.max(0, row.elapsedMs)));
  if (row.tokens !== undefined && Number.isFinite(row.tokens)) parts.push(`${compactCount(row.tokens)} tok`);
  return parts.join(" · ");
}

function padPlain(value: string, width: number): string {
  return value + " ".repeat(Math.max(0, width - visibleWidth(value)));
}

/**
 * Streamed narration painter — the fix for the 66s silent spinner.
 *
 * Deltas from `onDelta`/`onReasoningDelta` are coalesced by the core
 * fence-aware Coalescer (`stream.ts`), so a markdown code block never splits
 * mid-fence, and each emitted block is painted into the transcript the moment
 * it lands. Reasoning summaries use their own buffer and are flushed BEFORE
 * the next message block so they always render above the message they explain.
 */
export type ReasoningMode = "compact" | "full";

export interface NarrationPainterOptions {
  readonly emit: (line: string) => void;
  /** Do not paint a block below this size unless flushed. Default 48. */
  readonly minChars?: number;
  /** Force a (fence-aware) split above this size. Default 320. */
  readonly maxChars?: number;
  readonly now?: () => number;
  /**
   * false ⇒ emit raw text (non-TTY / plain streaming). Default true: deltas
   * paint into ONE `●` block per message instead of one bullet per chunk.
   */
  readonly bullets?: boolean;
  /** "compact" (default) collapses each reasoning summary to a single row. */
  readonly reasoningMode?: ReasoningMode;
  /** Terminal columns; a tool title may use the row (default: 96 characters). */
  readonly width?: () => number;
  /** When set, tool cells are mutable blocks: painted running, then replaced in place when they finish. */
  readonly block?: (id: string, render: (expanded: boolean) => string[]) => void;
}

export interface NarrationPainter {
  /** Feed an assistant-message delta. */
  delta(text: string): void;
  /** Paint a tool start/end cell in order: pending narration is flushed above it. */
  tool(event: AgentToolEvent): void;
  /** A policy hook declined this request: its cell (if any) becomes the red Blocked card; one cell, not two. */
  blocked(request: ApprovalRequest, block: { readonly hookId?: string; readonly reason?: string }): void;
  /** An approval request for an open cell: `awaiting approval` while the card waits, `running…` once answered. */
  approval(request: ApprovalRequest, state: "waiting" | "answered"): void;
  /** Paint everything buffered now (before an out-of-band card such as a diff). */
  flush(): void;
  /** Feed a provider-approved reasoning summary delta. */
  reasoning(text: string): void;
  /** Flush both buffers at end of turn and close any cell still running (as interrupted, or as ended without a result). */
  finish(options?: { readonly interrupted?: boolean }): void;
  /** Characters of assistant narration painted so far. */
  readonly painted: number;
}

export function createNarrationPainter(options: NarrationPainterOptions): NarrationPainter {
  const minChars = options.minChars ?? 48;
  const maxChars = Math.max(options.maxChars ?? 320, minChars);
  const bullets = options.bullets ?? true;
  const reasoningMode = options.reasoningMode ?? "compact";
  const message = createCoalescer({ minChars, maxChars, breakPreference: "newline", now: options.now });
  const reasoning = createCoalescer({ minChars, maxChars, breakPreference: "newline", now: options.now });
  let painted = 0;
  let lastDelta = "";
  /** True while a `●` block is open, so the next delta continues it. */
  let blockOpen = false;
  /** True right after a tool card: the next narration row needs a gap above it. */
  let afterCard = false;
  const gapAfterCard = (): void => {
    if (!afterCard) return;
    afterCard = false;
    options.emit("");
  };

  const paintMessage = (text: string): void => {
    if (!text.trim()) return;
    painted += text.length;
    if (!bullets) {
      options.emit(text);
      return;
    }
    gapAfterCard();
    const lines = formatAssistantBlock(text, { continued: blockOpen });
    if (!lines.length) return;
    for (const line of lines) options.emit(line);
    blockOpen = true;
  };
  const paintReasoning = (text: string): void => {
    if (!text.trim()) return;
    // Reasoning explains the block BELOW it, so a summary always closes the
    // open bullet: the next message delta starts its own `●`.
    blockOpen = false;
    gapAfterCard();
    if (reasoningMode === "full") {
      for (const part of text.split(/\r?\n/)) {
        if (part.trim()) options.emit(formatReasoningLine(part));
      }
      return;
    }
    options.emit(formatReasoningLine(collapseToOneLine(text)));
  };
  const drainReasoning = (): void => {
    for (const event of reasoning.flush("message_end")) {
      if (event.type === "block") paintReasoning(event.text);
    }
  };

  const flushAll = (): void => {
    drainReasoning();
    for (const event of message.flush("message_end")) {
      if (event.type === "block") paintMessage(event.text);
    }
  };
  /** The tool whose headline is the last thing painted; its result hangs right under it. */
  let headlineToolId: string | undefined;
  /** Cells painted as running that have not had their end event yet. */
  const openCells = new Map<string, AgentToolEvent>();
  const closeOpenCells = (interrupted: boolean): void => {
    if (!options.block || !bullets) return;
    const label = interrupted ? "interrupted" : "no result (the turn ended)";
    for (const [id, event] of openCells) {
      const name = toolCellName(event);
      const title = titleOf(event);
      options.block(`tool:${id}`, () => ["", ...[formatToolLine(name, title, "failure"), `  ${dim(`${RESULT_ELBOW} ${label}`)}`].map((row) => cardRow(row))]);
    }
    openCells.clear();
  };
  const clock = options.now ?? Date.now;
  // The headline row is `⏺ Bash(` + title + `)` on a band: leave room for both.
  const titleOf = (event: AgentToolEvent): string => toolCellTitle(event, options.width ? Math.max(40, options.width() - 12) : undefined);
  /** When each tool started, so a cell can show a time the provider did not report (Codex sends 0 ms). */
  const startedAt = new Map<string, number>();
  const timed = (event: AgentToolEvent): AgentToolEvent => {
    const started = startedAt.get(event.id);
    if (event.phase === "start") {
      startedAt.set(event.id, clock());
      return event;
    }
    startedAt.delete(event.id);
    if ((event.durationMs ?? 0) > 0 || started === undefined) return event;
    return { ...event, durationMs: Math.max(0, clock() - started) };
  };
  const paintOpenCell = (event: AgentToolEvent, label: string): void => {
    options.block?.(`tool:${event.id}`, () => ["", ...[formatToolLine(toolCellName(event), titleOf(event), "pending"), `  ${dim(`${RESULT_ELBOW} ${label}`)}`].map((row) => cardRow(row))]);
  };
  /** The open cell an approval request is about: same item id, else the newest command with the same text. */
  const cellFor = (request: ApprovalRequest): AgentToolEvent | undefined => {
    const byId = openCells.get(request.id);
    if (byId) return byId;
    if (request.kind !== "command") return undefined;
    const wanted = unwrapShellCommand(request.title);
    const open = [...openCells.values()].filter((event) => event.kind === "command");
    return open.reverse().find((event) => unwrapShellCommand(event.title) === wanted) ?? open[0];
  };
  /** Cells a policy block took over: the provider's later `failed` end must not repaint them. */
  const blockedCells = new Set<string>();
  const paintTool = (raw: AgentToolEvent): void => {
    if (raw.phase === "end" && blockedCells.delete(raw.id)) return;
    const event = timed(raw);
    flushAll();
    blockOpen = false;
    if (options.block && bullets) {
      const name = toolCellName(event);
      const title = titleOf(event);
      // A card: one blank gap row, then the rows on a band (red-tinted on failure).
      if (event.phase === "start") {
        openCells.set(event.id, event);
        paintOpenCell(event, "running…");
      } else {
        openCells.delete(event.id);
        const tone: CardTone = event.failed ? "failure" : "tool";
        options.block(`tool:${event.id}`, (expanded) => ["", ...[
          formatToolLine(name, title, event.failed ? "failure" : "success"),
          ...formatToolEndLines(event, TOOL_RESULT_MAX_LINES, { expanded, expandable: true }),
        ].map((row) => cardRow(row, tone))]);
      }
      afterCard = true;
      return;
    }
    if (!bullets) {
      if (event.phase === "start") options.emit(`$ ${titleOf(event)}`);
      return;
    }
    if (event.phase === "start") {
      options.emit(formatToolLine(toolCellName(event), titleOf(event), "pending"));
      headlineToolId = event.id;
      return;
    }
    if (headlineToolId !== event.id) {
      options.emit(formatToolLine(toolCellName(event), titleOf(event), event.failed ? "failure" : "success"));
    }
    for (const line of formatToolEndLines(event)) options.emit(line);
    headlineToolId = undefined;
  };

  return {
    tool(event) {
      paintTool(event);
    },
    blocked(request, block) {
      flushAll();
      blockOpen = false;
      const cell = cellFor(request);
      const id = cell ? `tool:${cell.id}` : `policy:${request.id}`;
      if (cell) {
        openCells.delete(cell.id);
        blockedCells.add(cell.id);
      }
      if (options.block && bullets) {
        options.block(id, () => renderPolicyBlockCard(request, block));
        afterCard = true;
      } else options.emit(`${renderActionBullet("failure")} Blocked ${unwrapShellCommand(request.title)} — ${block.reason ?? "blocked by policy"}`);
    },
    approval(request, state) {
      if (!options.block || !bullets) return;
      const cell = cellFor(request);
      if (cell) paintOpenCell(cell, state === "waiting" ? "awaiting approval" : "running…");
    },
    flush() {
      flushAll();
      headlineToolId = undefined;
    },
    delta(text) {
      if (!text) return;
      headlineToolId = undefined;
      if (reasoning.pending) drainReasoning();
      // Provider item boundaries occasionally arrive without their separating
      // whitespace (ledger #9: "now.Tests"). This is intentionally a narrow
      // heuristic: terminal punctuation followed immediately by an uppercase
      // sentence start becomes a paragraph boundary. It runs before the
      // fence-aware coalescer, which still owns all fence splitting.
      const joined = /[.!?]["')\]]?$/.test(lastDelta) && /^[A-Z]/.test(text) ? `\n\n${text}` : text;
      lastDelta = text;
      for (const event of message.push(joined)) {
        if (event.type === "block") paintMessage(event.text);
      }
    },
    reasoning(text) {
      if (!text) return;
      // A blank line opens the next summary part: close the current row first
      // so "Finding pytest" and "Running tests" never paint as one phrase.
      text.split(/\n{2,}/).forEach((part, index) => {
        if (index > 0) drainReasoning();
        if (!part) return;
        for (const event of reasoning.push(part)) {
          if (event.type === "block") paintReasoning(event.text);
        }
      });
    },
    finish(finishOptions) {
      drainReasoning();
      for (const event of message.flush("message_end")) {
        if (event.type === "block") paintMessage(event.text);
      }
      blockOpen = false;
      closeOpenCells(Boolean(finishOptions?.interrupted));
    },
    get painted() {
      return painted;
    },
  };
}

/** `/bin/zsh -lc 'pytest -q'` → `pytest -q` (shared with core's policy hooks). */
export { unwrapShellCommand };

function toolCellName(event: AgentToolEvent): string {
  switch (event.kind) {
    case "command": return "Bash";
    case "mcp": return "MCP";
    case "web": return "Search";
    default: return "Tool";
  }
}

/** One row, bounded: multi-line commands show their first line plus an ellipsis. */
function toolCellTitle(event: AgentToolEvent, max = 96): string {
  const raw = event.kind === "command" ? unwrapShellCommand(event.title) : event.args ? `${event.title} · ${event.args}` : event.title;
  const lines = raw.split(/\r?\n/).filter((line) => line.trim());
  let title = (lines[0] ?? raw).trim();
  if (lines.length > 1) title += " …";
  return title.length > max ? `${title.slice(0, max - 1)}…` : title;
}

/** Result rows under a finished tool: `⎿ exit 1 · 1.2s`, then the output TAIL (errors live at the end). */
/** Card backgrounds: a quiet neutral band, and a red tint for a failed tool. */
export const CARD_BAND_RGB = "32;33;37";
export const CARD_FAILURE_BAND_RGB = "58;30;34";

export type CardTone = "tool" | "failure";
const CARD_MARK = /^\u0000band:(tool|failure)(:clip)?\u0000/;
/** A card row that is cut to the width with `…` instead of wrapping (collapsed tool output). */
const CLIP_MARK = "\u0000clip\u0000";

/** Mark a transcript row as part of a card; the screen paints it as a full-width band. */
export function cardRow(text: string, tone: CardTone = "tool"): string {
  if (text.startsWith(CLIP_MARK)) return `\u0000band:${tone}:clip\u0000${text.slice(CLIP_MARK.length)}`;
  return `\u0000band:${tone}\u0000${text}`;
}

/** The row without its card mark (what tests, logs and plain surfaces see). */
export function stripCardMark(line: string): string {
  return line.replace(CARD_MARK, "");
}

/**
 * One transcript line → wrapped screen rows. Card rows become full-width
 * bands; everything else wraps as before. Pure, so the band is testable.
 */
export function renderTranscriptLine(line: string, frameWidth: number, padTo: number): string[] {
  const mark = line.match(CARD_MARK);
  if (!mark) return wrapLine(line, frameWidth);
  const rgb = mark[1] === "failure" ? CARD_FAILURE_BAND_RGB : CARD_BAND_RGB;
  const body = line.slice(mark[0].length);
  if (mark[2]) return [bandRow(truncateToWidth(body, Math.max(10, frameWidth - 2), "…"), padTo, rgb)];
  return wrapLine(body, frameWidth).map((row) => bandRow(row, padTo, rgb));
}

/** Rows shown for one tool's output when Ctrl+O has expanded it; beyond this a count is shown. */
export const TOOL_RESULT_EXPANDED_MAX_LINES = 400;

export function formatToolEndLines(
  event: AgentToolEvent,
  maxLines = TOOL_RESULT_MAX_LINES,
  view: { readonly expanded?: boolean; readonly expandable?: boolean } = {},
): string[] {
  const segments: string[] = [];
  if (event.exitCode !== undefined) segments.push(`exit ${event.exitCode}`);
  else segments.push(event.failed ? "failed" : "done");
  // Codex reports 0 for commands it did not time; "0ms" reads as a lie.
  if (event.durationMs !== undefined && event.durationMs > 0) segments.push(formatDuration(event.durationMs));
  const head = `  ${dim(`${RESULT_ELBOW} ${segments.join(" · ")}`)}`;
  // A JSON result reads as its fields, not as the last lines of pretty-printed JSON.
  const summary = event.kind === "mcp" && !view.expanded ? jsonResultSummary(event.output) : undefined;
  if (summary) {
    const clip = view.expandable ? CLIP_MARK : "";
    const shown = summary.slice(0, Math.min(maxLines, 5));
    const more = summary.length - shown.length;
    return [
      head,
      ...shown.map((row) => `${clip}    ${dim(row)}`),
      ...(more > 0 ? [`    ${dim(`… +${more} more ${more === 1 ? "field" : "fields"}${view.expandable ? " (ctrl+o to expand)" : ""}`)}`] : []),
    ];
  }
  const rows = (event.output ?? "").replace(/\s+$/, "").split(/\r?\n/).filter((row, index, all) => row.trim() || index < all.length - 1);
  const output = rows.length === 1 && !rows[0]!.trim() ? [] : rows;
  const lines = [head];
  const limit = view.expanded ? TOOL_RESULT_EXPANDED_MAX_LINES : maxLines;
  const hidden = Math.max(0, output.length - limit);
  // The hint promises a key only where the key exists (block mode).
  const hint = view.expandable ? " (ctrl+o to expand)" : "";
  if (hidden > 0) lines.push(`    ${dim(`… +${hidden} lines${view.expanded ? "" : hint}`)}`);
  // Collapsed, each output row is one screen row, cut with `…` (a long path
  // line used to run past the edge); Ctrl+O shows it whole, wrapped.
  const clip = view.expandable && !view.expanded ? CLIP_MARK : "";
  for (const row of output.slice(hidden)) lines.push(`${clip}    ${dim(stripAnsi(row).slice(0, view.expanded ? 2000 : 200))}`);
  if (view.expanded && view.expandable && output.length > maxLines) lines.push(`    ${dim("ctrl+o to collapse")}`);
  return lines;
}

/** One `key: value` row per top-level field of a JSON object (one row per item of an array); undefined for non-JSON text. */
export function jsonResultSummary(output: string | undefined): string[] | undefined {
  const trimmed = output?.trim();
  if (!trimmed || !/^[[{]/.test(trimmed)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  const one = (value: unknown): string => JSON.stringify(value) ?? String(value);
  if (Array.isArray(parsed)) return parsed.length ? parsed.map(one) : ["[] (no items)"];
  if (!parsed || typeof parsed !== "object") return undefined;
  const entries = Object.entries(parsed as Record<string, unknown>);
  return entries.length ? entries.map(([key, value]) => `${key}: ${one(value)}`) : ["{} (empty)"];
}

/** Reasoning summaries render violet + italic so they never read as the answer. */
export function formatReasoningLine(text: string): string {
  return renderReasoningLine(text);
}

/** Longest single-row reasoning summary before "…" (compact mode). */
export const REASONING_COMPACT_WIDTH = 96;

/**
 * Compact reasoning: the whole summary block on ONE dim row. The full text is
 * one `/reasoning full` away — the default must not out-shout the answer.
 */
export function collapseToOneLine(text: string, width = REASONING_COMPACT_WIDTH): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= width) return flat;
  const cut = flat.slice(0, width);
  const space = cut.lastIndexOf(" ");
  return `${(space > width * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

export interface CompactHeaderInfo {
  readonly session: string;
  readonly cwd: string;
  readonly scopes: string;
  readonly model: string;
  readonly provider: string;
  readonly runtime: string;
  readonly speed: string;
  readonly backends?: string;
}

export interface FullHeaderLayout {
  readonly width: number;
  readonly leftWidth: number;
  readonly midWidth: number;
  readonly rightWidth: number;
  readonly gutter: number;
}

/** Column widths of the full (`/header full`) panel for a box `width` columns wide. */
export function fullHeaderLayout(width: number): FullHeaderLayout {
  const inner = width - 4;
  const gutter = 3;
  const leftWidth = Math.max(24, Math.min(34, Math.floor(inner * 0.2)));
  const midWidth = Math.max(42, Math.floor((inner - leftWidth - gutter * 2) * 0.48));
  const rightWidth = inner - leftWidth - midWidth - gutter * 2;
  return { width, leftWidth, midWidth, rightWidth, gutter };
}

/**
 * The full header panel: title in the top border, three columns, a summary
 * row. Every row is exactly `layout.width` wide; anything longer is cut with
 * `…` inside the border, never past it.
 */
export function renderFullHeaderPanel(input: {
  readonly layout: FullHeaderLayout;
  readonly title: string;
  readonly left: readonly string[];
  readonly middle: readonly string[];
  readonly right: readonly string[];
  readonly footer: string;
}): string[] {
  const { width, leftWidth, midWidth, rightWidth, gutter } = input.layout;
  const cell = (value: string, cellWidth: number): string => padAnsi(truncateToWidth(value, cellWidth, "…"), cellWidth);
  const title = ` ${input.title} `;
  const titleLeft = Math.max(1, Math.floor((width - 2 - visibleWidth(title)) / 2));
  const titleRight = Math.max(1, width - 2 - titleLeft - visibleWidth(title));
  const rows = [accent(`╭${"─".repeat(titleLeft)}${title}${"─".repeat(titleRight)}╮`)];
  const count = Math.max(input.left.length, input.middle.length, input.right.length);
  for (let index = 0; index < count; index += 1) {
    rows.push(`${accent("│ ")}${cell(input.left[index] ?? "", leftWidth)}${" ".repeat(gutter)}${cell(input.middle[index] ?? "", midWidth)}${" ".repeat(gutter)}${cell(input.right[index] ?? "", rightWidth)}${accent(" │")}`);
  }
  rows.push(accent(`├${"─".repeat(width - 2)}┤`));
  rows.push(`${accent("│ ")}${cell(accent(input.footer), width - 4)}${accent(" │")}`);
  rows.push(accent(`╰${"─".repeat(width - 2)}╯`));
  return rows;
}

/**
 * Compact launch header (defect #6): four lines instead of a ~20-line table.
 * `/header full` restores the full panel.
 */
export function buildCompactHeaderLines(info: CompactHeaderInfo): string[] {
  // ONE line of idle chrome. Model and folder live in the status bar under
  // the composer, so the header names only the session: nothing is stated twice.
  return [
    `${accent("MUSTER")} ${dim(`· ${info.session} · /help`)}`,
  ];
}

export function createMusterAutocompleteProvider(options: MusterAutocompleteOptions): AutocompleteProvider {
  const catalog = options.catalog ?? createCallbackCompletionCatalog(options);
  return {
    triggerCharacters: ["@", "/", " "],
    async getSuggestions(lines, cursorLine, cursorCol, { signal }) {
      if (signal.aborted) return null;
      const line = lines[cursorLine] ?? "";
      const beforeCursor = line.slice(0, cursorCol);
      const trimmed = beforeCursor.trimStart();
      if (trimmed !== beforeCursor && beforeCursor.slice(0, beforeCursor.length - trimmed.length).includes("\n")) return null;

      const slash = slashCompletionContext(trimmed);
      if (slash) {
        const choices = await catalog.complete({
          kind: slash.kind,
          fragment: slash.fragment,
          providerId: "providerId" in slash ? slash.providerId : undefined,
        });
        if (signal.aborted) return null;
        const items = pickerOptionsToItems(choices);
        return items.length ? { items, prefix: slash.prefix } : null;
      }

      const agentFragment = agentCompletionFragment(trimmed);
      if (agentFragment !== undefined) {
        const choices = await catalog.complete({ kind: "agent", fragment: agentFragment });
        if (signal.aborted) return null;
        const items = pickerOptionsToItems(choices);
        return items.length ? { items, prefix: `@${agentFragment}` } : null;
      }
      return null;
    },
    applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
      const line = lines[cursorLine] ?? "";
      const beforeCursor = line.slice(0, cursorCol);
      const afterCursor = line.slice(cursorCol);
      const replacement = completionReplacement(beforeCursor, item, prefix);
      const startCol = Math.max(0, cursorCol - prefix.length);
      const nextLine = `${line.slice(0, startCol)}${replacement}${afterCursor}`;
      const nextLines = [...lines];
      nextLines[cursorLine] = nextLine;
      return {
        lines: nextLines,
        cursorLine,
        cursorCol: startCol + replacement.length,
      };
    },
  };
}

export function createMusterChatEditor(tui: Pick<TUI, "terminal" | "requestRender">): Editor {
  const editor = new Editor(tui as TUI, musterEditorTheme(), { autocompleteMaxVisible: 14 });
  editor.setPaddingX(0);
  return editor;
}

/**
 * Alt-screen viewport math: the reference scrolls IN-APP (PgUp/PgDn/wheel)
 * because the alternate screen has no native scrollback. `scrollOffset`
 * counts rows lifted off the tail; the clamp keeps it inside the content.
 */
export function windowTranscript(rows: readonly string[], viewportRows: number, scrollOffset: number): { visible: readonly string[]; clamped: number } {
  const clamped = Math.max(0, Math.min(scrollOffset, Math.max(0, rows.length - viewportRows)));
  const end = rows.length - clamped;
  return { visible: rows.slice(Math.max(0, end - viewportRows), end), clamped };
}

/**
 * Transcript rows plus mutable blocks. Plain lines append; a block keeps its
 * position and is re-rendered in place. `dirtyFrom` tells a wrap cache the
 * first row index that changed so it re-wraps only from there.
 */
export class TranscriptStore {
  readonly lines: string[] = [];
  expanded = false;
  dirtyFrom = Number.POSITIVE_INFINITY;
  private readonly blocks = new Map<string, { start: number; count: number; render: (expanded: boolean) => string[] }>();

  push(...rows: string[]): void {
    this.lines.push(...rows);
  }

  upsert(id: string, render: (expanded: boolean) => string[]): void {
    const rows = render(this.expanded);
    const block = this.blocks.get(id);
    if (!block) {
      this.blocks.set(id, { start: this.lines.length, count: rows.length, render });
      this.lines.push(...rows);
      return;
    }
    this.replace(block, rows);
    block.render = render;
  }

  /**
   * Grey out a rewound stretch: from the latest user row that sent `prompt`
   * to the end, every row is repainted dim and a marker row goes above it.
   * Blocks in that stretch stop being live (a later Ctrl+O must not bring
   * the colour back). False when the prompt's row is not in the transcript.
   */
  markRewound(prompt: string, marker: string): boolean {
    const first = (prompt.split(/\r?\n/)[0] ?? "").trim();
    let at = -1;
    for (let index = this.lines.length - 1; index >= 0; index -= 1) {
      const line = this.lines[index]!;
      if (isUserTranscriptLine(line) && stripAnsi(line).slice(USER_PREFIX.length).trim() === first) {
        at = index;
        break;
      }
    }
    if (at < 0) return false;
    for (const [id, block] of this.blocks) if (block.start >= at) this.blocks.delete(id);
    for (let index = at; index < this.lines.length; index += 1) {
      const plain = stripAnsi(stripCardMark(this.lines[index]!));
      this.lines[index] = plain.trim() ? dim(plain) : plain;
    }
    this.lines.splice(at, 0, marker);
    this.dirtyFrom = Math.min(this.dirtyFrom, at);
    return true;
  }

  toggleExpanded(): void {
    this.expanded = !this.expanded;
    const ordered = [...this.blocks.values()].sort((a, b) => a.start - b.start);
    for (const block of ordered) this.replace(block, block.render(this.expanded));
  }

  clear(): void {
    this.lines.length = 0;
    this.blocks.clear();
    this.dirtyFrom = 0;
  }

  private replace(block: { start: number; count: number }, rows: string[]): void {
    this.lines.splice(block.start, block.count, ...rows);
    const delta = rows.length - block.count;
    if (delta) {
      for (const other of this.blocks.values()) if (other.start > block.start) other.start += delta;
    }
    block.count = rows.length;
    this.dirtyFrom = Math.min(this.dirtyFrom, block.start);
  }
}

export interface GitStatusSummary {
  readonly branch: string;
  /** Tracked files with staged or unstaged changes. */
  readonly changed: number;
  readonly untracked: number;
}

/** `git status --porcelain=v2 --branch`, summarised; undefined outside a repo. Never throws. */
export function readGitStatus(cwd: string): Promise<GitStatusSummary | undefined> {
  return new Promise((resolve) => {
    execFile("git", ["status", "--porcelain=v2", "--branch", "--untracked-files=normal"], { cwd, timeout: 1500, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      if (error) return resolve(undefined);
      let branch = "";
      let changed = 0;
      let untracked = 0;
      for (const line of stdout.split("\n")) {
        if (line.startsWith("# branch.head ")) branch = line.slice("# branch.head ".length).trim();
        else if (/^[12u] /.test(line)) changed += 1;
        else if (line.startsWith("? ")) untracked += 1;
      }
      resolve({ branch: branch === "(detached)" ? "detached" : branch || "?", changed, untracked });
    });
  });
}

export interface StatusBarInfo {
  readonly model: string;
  readonly effort?: string;
  readonly cwd: string;
  readonly git?: GitStatusSummary;
  readonly context?: { readonly usedTokens: number; readonly windowTokens: number };
  readonly sessionTokens?: number;
  readonly sessionCostUsd?: number;
  /** Shown only when it is not the default (auto-edit). */
  readonly access?: string;
}

/**
 * The bar under the composer: `model · effort │ ~/repo │ ⎇ main *1 ?1 │ ctx 25% │ 128.4k tok · $0.42`.
 * Segments drop from the right (spend first, the model never) so it never wraps.
 */
/**
 * The folder as the user's shell names it: `PWD` when it is the same folder as
 * the real cwd (macOS reports `/tmp/x` as `/private/tmp/x`), then `~` for home.
 */
export function displayFolder(cwd: string): string {
  let shown = cwd;
  const pwd = process.env.PWD;
  if (pwd && pwd !== cwd) {
    try {
      if (realpathSync(pwd) === realpathSync(cwd)) shown = pwd;
    } catch {
      // A vanished folder keeps its real path.
    }
  }
  const home = process.env.HOME;
  return home && (shown === home || shown.startsWith(`${home}/`)) ? `~${shown.slice(home.length)}` : shown;
}

export function formatStatusBar(info: StatusBarInfo, width: number): string {
  const folder = displayFolder(info.cwd);
  const shortFolder = folder.length > 32 ? `…${folder.slice(folder.length - 31)}` : folder;
  const segments: Array<{ text: string; styled: string }> = [];
  const model = info.effort ? `${info.model} · ${info.effort}` : info.model;
  segments.push({ text: model, styled: accent(model) });
  if (info.access && info.access !== "auto-edit") {
    const text = info.access === "full" ? "⚠ full access" : info.access;
    segments.push({ text, styled: info.access === "full" ? red(text) : highlight(text) });
  }
  segments.push({ text: shortFolder, styled: dim(shortFolder) });
  if (info.git) {
    const dirt = [info.git.changed ? `*${info.git.changed}` : "", info.git.untracked ? `?${info.git.untracked}` : ""].filter(Boolean).join(" ");
    const text = `⎇ ${info.git.branch}${dirt ? ` ${dirt}` : ""}`;
    segments.push({ text, styled: dim(text) });
  }
  if (info.context && info.context.windowTokens > 0) {
    const pct = Math.round((info.context.usedTokens / info.context.windowTokens) * 100);
    const text = `ctx ${pct}%`;
    const styled = pct >= 85 ? red(text) : pct >= 60 ? highlight(text) : dim(text);
    segments.push({ text, styled });
  }
  const spend = [
    info.sessionTokens ? `${compactCount(info.sessionTokens)} tok` : "",
    info.sessionCostUsd ? `$${info.sessionCostUsd.toFixed(2)}` : "",
  ].filter(Boolean).join(" · ");
  if (spend) segments.push({ text: spend, styled: dim(spend) });
  const separator = " │ ";
  while (segments.length > 1) {
    const length = segments.reduce((sum, segment) => sum + segment.text.length, 0) + separator.length * (segments.length - 1);
    if (length <= width) break;
    segments.pop();
  }
  const row = segments.map((segment) => segment.styled).join(dim(separator));
  return truncateToWidth(row, width, "…");
}

/**
 * The status bar, built for one width. The bar is rebuilt after each turn and
 * whenever the frame is painted at a different width (a resize), so segments
 * drop out whole instead of the old row being cut mid-segment.
 */
export class FooterSlot {
  line = "";
  private width = -1;

  constructor(private readonly source: (width: number) => string | Promise<string>) {}

  staleFor(width: number): boolean {
    return width !== this.width;
  }

  async refresh(width: number): Promise<boolean> {
    this.width = width;
    const line = await this.source(width);
    if (line === this.line) return false;
    this.line = line;
    return true;
  }
}

const APPROVAL_LABELS: Record<ApprovalDecision, string> = {
  accept: "approved once",
  acceptForSession: "approved for this session",
  decline: "denied",
  cancel: "denied · turn stopped",
};

/** A request title on one row: the first line, then `…` when more lines follow. */
function cardTitle(request: ApprovalRequest): string {
  const raw = request.kind === "command" ? unwrapShellCommand(request.title) : request.title;
  const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return lines.length > 1 ? `${lines[0]} …` : (lines[0] ?? raw);
}

const APPROVAL_COMMAND_MAX_LINES = 60;

/** A pending card lists a multi-line command in full: the user approves what they can see. */
function approvalCommandRows(request: ApprovalRequest): string[] {
  if (request.kind !== "command") return [];
  const lines = unwrapShellCommand(request.title).split(/\r?\n/).filter((line) => line.trim());
  if (lines.length < 2) return [];
  const shown = lines.slice(0, APPROVAL_COMMAND_MAX_LINES).map((line) => `    ${line}`);
  if (lines.length > shown.length) shown.push(`    ${dim(`… +${lines.length - shown.length} more lines`)}`);
  return shown;
}

/** The approval card: pending with its keys, or settled with the decision. */
export function renderApprovalCard(request: ApprovalRequest, decision?: ApprovalDecision): string[] {
  const verb = request.kind === "command" ? "Run" : request.kind === "edit" ? "Allow" : "Grant";
  const approved = decision === "accept" || decision === "acceptForSession";
  const glyph = decision ? renderActionBullet(approved ? "success" : "failure") : highlight("?");
  const rows = [`${glyph} ${verb} ${cardTitle(request)}?`];
  if (!decision) rows.push(...approvalCommandRows(request));
  if (request.reason) rows.push(`  ${dim(`${RESULT_ELBOW} ${request.reason}`)}`);
  rows.push(decision
    ? `  ${dim(APPROVAL_LABELS[decision])}`
    : `  ${highlight("y")} ${dim("once ·")} ${highlight("a")} ${dim("this session ·")} ${highlight("n")} ${dim("deny ·")} ${highlight("esc")} ${dim("stop")}`);
  return ["", ...rows.map((row) => cardRow(row, decision && !approved ? "failure" : "tool"))];
}

/** A tool request a policy hook declined: red card with the rule and its reason. */
export function renderPolicyBlockCard(request: ApprovalRequest, block: { readonly hookId?: string; readonly reason?: string }): string[] {
  const rows = [
    `${renderActionBullet("failure")} Blocked ${cardTitle(request)}`,
    `  ${dim(`${RESULT_ELBOW} ${block.reason ?? "blocked by policy"}${block.hookId ? ` · policy ${block.hookId}` : ""}`)}`,
  ];
  return ["", ...rows.map((row) => cardRow(row, "failure"))];
}

export const REWOUND_MARKER = "↺ rewound — the turns below were undone";

/** A `turn.start` hook refused the prompt: put it back in the composer to edit. True when it did. */
export function promptBackAfterHookBlock(error: unknown, prompt: string, sink: Pick<MusterChatSink, "openPicker"> | undefined): boolean {
  const message = error instanceof Error ? error.message : String(error);
  if (!sink || !/^Run blocked by hook\b/.test(message)) return false;
  sink.openPicker(prompt);
  return true;
}

/** A key while an approval card waits → its decision, or undefined to hold the key. */
export function approvalDecisionForKey(data: string): ApprovalDecision | undefined {
  if (data === "y" || data === "Y") return "accept";
  if (data === "a" || data === "A") return "acceptForSession";
  if (data === "n" || data === "N") return "decline";
  if (data === "\x1b") return "cancel";
  return undefined;
}

/** Pending approvals for one sink: cards in the transcript, answered in order. */
export class ApprovalQueue {
  private readonly waiting: Array<{ request: ApprovalRequest; resolve: (decision: ApprovalDecision) => void }> = [];

  constructor(private readonly upsert: (id: string, render: (expanded: boolean) => string[]) => void) {}

  get pending(): boolean {
    return this.waiting.length > 0;
  }

  request(request: ApprovalRequest): Promise<ApprovalDecision> {
    return new Promise((resolve) => {
      this.waiting.push({ request, resolve });
      this.upsert(`approval:${request.id}`, () => renderApprovalCard(request));
    });
  }

  /** Consume a key: true when an approval was waiting (the key never reaches the composer). */
  key(data: string): boolean {
    const head = this.waiting[0];
    if (!head) return false;
    const decision = approvalDecisionForKey(data);
    if (!decision) return true;
    this.waiting.shift();
    this.upsert(`approval:${head.request.id}`, () => renderApprovalCard(head.request, decision));
    head.resolve(decision);
    return true;
  }
}

/** Every key the chat answers to, for /shortcuts. */
export const CHAT_SHORTCUTS: ReadonlyArray<readonly [string, string]> = [
  ["Enter", "send; while a turn runs, steer it with the message"],
  ["Ctrl+Q / Alt+Enter", "queue the message to run after the current turn"],
  ["Alt+↑", "pull the last queued message back to edit"],
  ["Esc", "stop the running turn (queued messages come back to edit)"],
  ["Ctrl+C", "stop the turn or clear the draft; press twice to quit"],
  ["Ctrl+O", "expand or collapse tool output"],
  ["Ctrl+D", "toggle the current turn's full-file live view"],
  ["PgUp / PgDn", "scroll the transcript"],
  ["Tab", "complete slash commands, toolsets and session names"],
  ["\\ at line end", "continue on a new line"],
  ["@agent <task>", "route a turn to an agent"],
];

/**
 * Help rows as two columns: every description starts in the same column. A
 * label wider than the column keeps its own row and its description goes on
 * the next row, in that column.
 */
export function alignHelpRows(rows: ReadonlyArray<readonly [string, string]>, width: number, maxLabel = 28): string[] {
  const column = Math.min(maxLabel, Math.max(0, ...rows.map(([label]) => visibleWidth(label)).filter((size) => size <= maxLabel))) + 2;
  const out: string[] = [];
  for (const [label, description] of rows) {
    const size = visibleWidth(label);
    if (size + 2 > column) {
      out.push(highlight(label));
      out.push(`${" ".repeat(column)}${description}`);
      continue;
    }
    out.push(`${highlight(label)}${" ".repeat(column - size)}${description}`);
  }
  return out.map((row) => truncateToWidth(row, Math.max(20, width), "…"));
}

/** Ctrl+Q and Alt+Enter queue a follow-up instead of steering. */
export function isQueueFollowUpKey(data: string): boolean {
  return data === "\x11" || data === "\x1b\r" || data === "\x1b\n";
}

/**
 * Ctrl+C: the first press interrupts a running turn (like Esc) or clears a
 * draft; a second press within the window, or a press on an idle empty
 * composer, quits.
 */
export class CtrlCGate {
  static readonly WINDOW_MS = 2000;
  private lastPressAt = Number.NEGATIVE_INFINITY;

  press(state: { readonly running: boolean; readonly hasText: boolean }, now = Date.now()): "interrupt" | "clear" | "quit" {
    const repeat = now - this.lastPressAt <= CtrlCGate.WINDOW_MS;
    this.lastPressAt = now;
    if (repeat) return "quit";
    if (state.running) return "interrupt";
    if (state.hasText) return "clear";
    return "quit";
  }
}

export const CTRL_C_AGAIN_HINT = "ctrl+c again to quit";

/** Alt+Up pulls the newest queued follow-up back into the composer. */
export function isEditQueuedKey(data: string): boolean {
  return data === "\x1b[1;3A" || data === "\x1b\x1b[A" || matchesKey(data, "alt+up");
}

/**
 * What the composer does with input while a turn runs: Enter steers the live
 * turn when the runtime can take it, otherwise (and always on Ctrl+Q) the text
 * waits in a queue that runs, in order, once the turn ends.
 */
export class RunningTurnInput {
  readonly queued: string[] = [];

  constructor(private readonly onSteer?: (text: string) => boolean | Promise<boolean>) {}

  async route(value: string, mode: "steer" | "queue", appendLine: (line: string) => void): Promise<void> {
    if (mode === "steer" && this.onSteer) {
      let steered = false;
      try {
        steered = await this.onSteer(value);
      } catch {
        steered = false;
      }
      if (steered) {
        appendLine(formatUserLine(value));
        appendLine(`  ${dim(`${RESULT_ELBOW} sent to the running turn`)}`);
        return;
      }
    }
    this.queued.push(value);
  }

  takeNext(): string | undefined {
    return this.queued.shift();
  }

  takeLast(): string | undefined {
    return this.queued.pop();
  }

  drain(): string[] {
    return this.queued.splice(0);
  }
}

/** The band above the composer: one dim row per queued follow-up plus the keys that act on them. */
export function renderQueuedBand(queued: readonly string[], width: number): string[] {
  if (!queued.length) return [];
  const rows = queued.map((text) => truncateToWidth(dim(`  ↳ queued  ${text.replace(/\s+/g, " ").trim()}`), width, "…"));
  rows.push(truncateToWidth(dim("    alt+↑ edit · esc interrupts and returns them to the composer"), width, ""));
  return rows;
}

export function createMusterChatHarness(options: MusterAutocompleteOptions & {
  readonly onSubmit?: (text: string, sink: MusterChatSink) => Promise<boolean>;
  readonly onInterrupt?: () => boolean | Promise<boolean>;
  readonly onSteer?: (text: string) => boolean | Promise<boolean>;
  readonly initialLines?: readonly string[];
  readonly onDecisionKey?: (data: string, sink: MusterChatSink) => boolean;
  readonly onReady?: (sink: MusterChatSink) => (() => void) | void;
  readonly width?: number;
  readonly rows?: number;
}): MusterChatHarness {
  const tui = fakeHarnessTui(options.width ?? 120, options.rows ?? 40);
  const editor = createMusterChatEditor(tui);
  const sink = new HarnessSink(editor, options.onSubmit, options.onInterrupt, options.initialLines, options.onSteer, options.rows ?? 40);
  options.onReady?.(sink);
  editor.setAutocompleteProvider(createMusterAutocompleteProvider(options));
  editor.onSubmit = (text) => {
    void sink.submit(text);
  };
  const ctrlC = new CtrlCGate();
  return {
    input(data) {
      if (sink.settings) {
        sink.settings.handleInput(data);
        return;
      }
      if (sink.approvals.key(data)) return;
      if (options.onDecisionKey?.(data, sink)) return;
      if (data === "\x0f") {
        sink.toggleExpanded();
        return;
      }
      if (sink.running && isQueueFollowUpKey(data)) {
        const text = editor.getText().trim();
        editor.setText("");
        if (text) void sink.queueFollowUp(text);
        return;
      }
      if (isEditQueuedKey(data) && !editor.getText()) {
        const last = sink.followUps.takeLast();
        if (last !== undefined) editor.setText(last);
        return;
      }
      if (data === "\x04") {
        sink.toggleLiveDiff();
        return;
      }
      if (data === "\x03") {
        const action = ctrlC.press({ running: sink.running, hasText: Boolean(editor.getText()) });
        if (action === "quit") sink.exited = true;
        else {
          if (action === "interrupt") sink.interruptTurn();
          else editor.setText("");
          sink.appendLine(dim(`  ${CTRL_C_AGAIN_HINT}`));
        }
        return;
      }
      if (data === "\x1b" && sink.interruptTurn()) return;
      if ((matchesKey(data, "enter") || matchesKey(data, "return")) && isToolsOverlayInput(editor.getText())) {
        editor.handleInput("\t");
        return;
      }
      if (isClearComposerKey(data)) {
        editor.handleInput("\x1b");
        editor.setText("");
        return;
      }
      if (data === "\x1b" && isBareCompletionTrigger(editor.getText())) {
        editor.handleInput(data);
        editor.setText("");
        return;
      }
      if (data === "\x1b" && isCapabilityConfirmationText(editor.getText())) {
        editor.setText("");
        return;
      }
      editor.handleInput(data);
    },
    type(text) {
      if (sink.settings) {
        for (const char of text) sink.settings.handleInput(char);
        return;
      }
      if (sink.approvals.pending) return;
      for (const char of text) editor.handleInput(char);
    },
    async submit() {
      const text = editor.getText();
      editor.setText("");
      await sink.submit(text);
    },
    visible(width = options.width ?? 120) {
      if (sink.settings) return sink.settings.render(width);
      return [
        ...sink.transcriptLines,
        ...renderQueuedBand(sink.followUps.queued, width),
        ...renderMusterComposer(editor, width),
        ...(sink.footer ? [truncateToWidth(sink.footer, width, "")] : []),
      ];
    },
    text() {
      return editor.getText();
    },
    transcript() {
      return sink.transcriptLines;
    },
    openPicker(command) {
      sink.openPicker(command);
    },
    exited() {
      return sink.exited;
    },
    status() {
      return sink.statusRow;
    },
  };
}

export function renderMusterComposer(editor: Editor, width: number): string[] {
  const frameWidth = Math.max(32, Math.floor(width));
  const editorWidth = Math.max(8, frameWidth - 2);
  const rawLines = editor.render(editorWidth);
  const borderIndexes = rawLines
    .map((line, index) => ({ line: stripAnsi(line).trim(), index }))
    .filter(({ line }) => /^─+$/.test(line) || /^─── [↑↓] \d+ more/.test(line))
    .map(({ index }) => index);
  const firstBorder = borderIndexes[0] ?? -1;
  const secondBorder = borderIndexes.find((index) => index > firstBorder) ?? rawLines.length;
  const inputLines = rawLines.slice(firstBorder + 1, secondBorder);
  const completionLines = rawLines.slice(secondBorder + 1);
  const result: string[] = [];

  if (completionLines.length) {
    for (const rawLine of completionLines) {
      const plain = stripAnsi(rawLine).trim();
      const count = /^\(?(\d+\/\d+)\)?$/.exec(plain)?.[1];
      if (count) continue; // the reference shows no count row
      result.push(truncateToWidth(rawLine, frameWidth, ""));
    }
  }

  // The typing area, matched to the reference frame (owner, 2026-08-30):
  // a full-width dim rule above and below, a PLAIN default-color ❯ inside —
  // no box, no corners, no accent caret.
  result.push(dim("─".repeat(frameWidth)));
  if (!inputLines.length) {
    result.push("❯ ");
  } else {
    inputLines.forEach((line, index) => {
      result.push((index === 0 ? "❯ " : "  ") + line);
    });
  }
  result.push(dim("─".repeat(frameWidth)));

  return result.map((line) => padAnsi(line, frameWidth));
}

// Claude Code's picker palette, MEASURED live from its /model picker
// (2026-08-29): caret + selected label = palette index 153 (the theme-mapped
// blue-violet), current-value ✓ = index 114 (soft green), everything else
// gray. INDEXED codes on purpose — the owner's terminal theme remaps them
// exactly as it does for Claude Code, so the two are identical by construction.
function pickerSel(text: string): string {
  return process.env.NO_COLOR && !process.env.FORCE_COLOR ? text : `\x1b[38;2;176;184;248m${text}${RESET}`;
}
export function pickerOk(text: string): string {
  return process.env.NO_COLOR && !process.env.FORCE_COLOR ? text : `\x1b[38;5;114m${text}${RESET}`;
}

function composerPickerTheme(): { settings: SettingsListTheme; select: SelectListTheme } {
  return {
    settings: {
      label: (text, selected) => selected ? pickerSel(text) : text,
      value: (text, selected) => selected ? pickerSel(text) : dim(text),
      description: dim,
      cursor: pickerSel("› "),
      hint: dim,
    },
    select: {
      selectedPrefix: pickerSel,
      selectedText: pickerSel,
      description: dim,
      scrollInfo: dim,
      noMatch: dim,
    },
  };
}

function groupedModelSubmenu(
  state: ComposerPickerState,
  theme: SelectListTheme,
  onSelect: (value: string) => void,
  onCancel: () => void,
): SelectList {
  let previousProvider: string | undefined;
  const items: SelectItem[] = state.catalog.models.map((model) => {
    const startsGroup = model.provider !== previousProvider;
    previousProvider = model.provider;
    return {
      value: model.value,
      label: `${startsGroup ? model.provider.padEnd(8) : "".padEnd(8)}${model.label}${model.value === state.activeModel ? `  ${pickerOk("✓")}` : ""}`,
      description: startsGroup ? `${model.provider} models` : undefined,
    };
  });
  return selectSubmenu(items, items.findIndex((item) => item.value === state.activeModel), theme, onSelect, onCancel);
}

function selectSubmenu(
  items: SelectItem[],
  selectedIndex: number,
  theme: SelectListTheme,
  onSelect: (value: string) => void,
  onCancel: () => void,
): SelectList {
  const list = new SelectList(items, 12, theme, { minPrimaryColumnWidth: 24, maxPrimaryColumnWidth: 44 });
  if (selectedIndex >= 0) list.setSelectedIndex(selectedIndex);
  list.onSelect = (item) => onSelect(item.value);
  list.onCancel = onCancel;
  return list;
}

class SuspendableProcessTerminal implements Terminal {
  private readonly inner = new ProcessTerminal();
  private readonly frameLog = process.env.MUSTER_DEBUG_FRAMES === "1" ? new TerminalFrameLog() : undefined;
  private onInput: ((data: string) => void) | undefined;
  private onResize: (() => void) | undefined;
  private suspended = false;
  get columns(): number { return this.inner.columns; }
  get rows(): number { return this.inner.rows; }
  get kittyProtocolActive(): boolean { return this.inner.kittyProtocolActive; }
  start(onInput: (data: string) => void, onResize: () => void): void {
    this.onInput = onInput;
    this.onResize = onResize;
    this.suspended = false;
    // The reference's page semantics (owner, 2026-08-30): the chat opens on
    // the terminal's ALTERNATE SCREEN — a fresh page, the shell's prior
    // commands untouched underneath — and any exit (including Ctrl+C)
    // restores the shell with only the invocation line remaining.
    if (process.stdout.isTTY) process.stdout.write("\x1b[?1049h\x1b[H");
    this.inner.start(onInput, onResize);
  }
  stop(): void {
    this.suspended = false;
    this.inner.stop();
    if (process.stdout.isTTY) process.stdout.write("\x1b[?1049l");
  }
  async drainInput(maxMs?: number, idleMs?: number): Promise<void> { await this.inner.drainInput(maxMs, idleMs); }
  write(data: string): void { if (!this.suspended) { this.frameLog?.append(data); this.inner.write(data); } }
  moveBy(lines: number): void { if (!this.suspended) this.inner.moveBy(lines); }
  hideCursor(): void { if (!this.suspended) this.inner.hideCursor(); }
  showCursor(): void { if (!this.suspended) this.inner.showCursor(); }
  clearLine(): void { if (!this.suspended) this.inner.clearLine(); }
  clearFromCursor(): void { if (!this.suspended) this.inner.clearFromCursor(); }
  clearScreen(): void { if (!this.suspended) this.inner.clearScreen(); }
  setTitle(title: string): void { if (!this.suspended) this.inner.setTitle(title); }
  setProgress(active: boolean): void { if (!this.suspended) this.inner.setProgress(active); }
  suspend(): void {
    if (this.suspended) return;
    this.inner.stop();
    // External programs (editors) run on the NORMAL screen; re-enter on resume.
    if (process.stdout.isTTY) process.stdout.write("\x1b[?1049l");
    this.suspended = true;
  }
  resume(): void {
    if (!this.suspended || !this.onInput || !this.onResize) return;
    this.suspended = false;
    if (process.stdout.isTTY) process.stdout.write("\x1b[?1049h\x1b[H");
    this.inner.start(this.onInput, this.onResize);
  }
}

export class TerminalFrameLog {
  static readonly MAX_BYTES = 5 * 1024 * 1024;
  readonly path: string;
  constructor(path = join(homedir(), ".muster", "logs", "frames.log")) {
    this.path = path;
    mkdirSync(dirname(path), { recursive: true });
  }
  append(data: string): void {
    const encoded = data.split("\n").map((row) => `${JSON.stringify(row)}\n`);
    let payload = encoded.join("");
    const payloadBytes = Buffer.byteLength(payload);
    if (payloadBytes > TerminalFrameLog.MAX_BYTES) {
      let bytes = 0;
      const kept: string[] = [];
      for (let index = encoded.length - 1; index >= 0; index -= 1) {
        const row = encoded[index]!;
        const size = Buffer.byteLength(row);
        if (bytes + size > TerminalFrameLog.MAX_BYTES) break;
        kept.unshift(row);
        bytes += size;
      }
      payload = kept.join("");
    }
    let current = 0;
    try { current = statSync(this.path).size; } catch { /* first frame */ }
    if (current + Buffer.byteLength(payload) > TerminalFrameLog.MAX_BYTES) {
      const rotated = `${this.path}.1`;
      try { unlinkSync(rotated); } catch { /* no prior rotation */ }
      try { renameSync(this.path, rotated); } catch { /* no current log */ }
    }
    if (payload) appendFileSync(this.path, payload, "utf8");
  }
}

export async function runMusterChatTui(options: RunMusterChatTuiOptions): Promise<void> {
  const terminal = new SuspendableProcessTerminal();
  const tui = new TUI(terminal, true);
  const editor = createMusterChatEditor(tui);
  const screen = new MusterChatScreen(tui, editor, options.statusLine, options.headerLines ?? [], options.initialLines ?? [], options.onInterrupt, options.onSteer);
  const boardMode = options.board ? new BoardModeHost(tui, terminal, screen, editor, options.board) : undefined;
  screen.onOpenBoard = (force) => boardMode?.open(force) ?? Promise.resolve(false);
  editor.setAutocompleteProvider(createMusterAutocompleteProvider(options));
  editor.onSubmit = (text) => {
    void screen.submit(text, options.onSubmit);
  };
  tui.addChild(screen);
  tui.setFocus(editor);
  const ctrlC = new CtrlCGate();
  tui.addInputListener((data) => {
    // An approval card owns the keyboard until it is answered.
    if (screen.approvals.pending && !parseSgrMouseSequence(data)) {
      screen.approvals.key(data);
      tui.requestRender(true);
      return { consume: true };
    }
    // The settings panel owns every key while it is open.
    if (screen.settingsOpen) return undefined;
    const mouse = parseSgrMouseSequence(data);
    if (mouse && boardMode?.handleMouse(mouse)) return { consume: true };
    const stripped = stripMouseSequences(data);
    if (!stripped) return { consume: true };
    if (stripped !== data) return { data: stripped };
    if (boardMode?.active) return undefined;
    if (mouse && !mouse.release && (mouse.button === 64 || mouse.button === 65)) {
      if (screen.scrollTranscript(mouse.button === 64 ? 3 : -3)) return { consume: true };
    }
    if (matchesKey(stripped, "pageUp") && screen.scrollPage(1)) return { consume: true };
    if (matchesKey(stripped, "pageDown") && screen.scrollPage(-1)) return { consume: true };
    if (matchesKey(stripped, "f3")) {
      void screen.openBoard(false);
      return { consume: true };
    }
    if (options.onDecisionKey?.(data, screen)) {
      editor.setText("");
      tui.requestRender(true);
      return { consume: true };
    }
    if (screen.running && isQueueFollowUpKey(data)) {
      const text = editor.getText().trim();
      editor.setText("");
      if (text) void screen.queueFollowUp(text);
      tui.requestRender(true);
      return { consume: true };
    }
    if (isEditQueuedKey(data) && !editor.getText()) {
      const last = screen.followUps.takeLast();
      if (last !== undefined) {
        editor.setText(last);
        tui.requestRender(true);
        return { consume: true };
      }
    }
    if (data === "\x04") {
      screen.toggleLiveDiff();
      return { consume: true };
    }
    if (data === "\x0f") {
      screen.toggleExpanded();
      return { consume: true };
    }
    if (data === "\x03") {
      const action = ctrlC.press({ running: screen.running, hasText: Boolean(editor.getText()) });
      if (action === "quit") {
        screen.exited = true;
        screen.stop();
      } else {
        if (action === "interrupt") screen.interruptTurn();
        else editor.setText("");
        screen.appendLine(dim(`  ${CTRL_C_AGAIN_HINT}`));
        tui.requestRender(true);
      }
      return { consume: true };
    }
    if (matchesKey(data, "escape") && screen.closeLiveDiff(true)) return { consume: true };
    if (matchesKey(data, "escape") && screen.interruptTurn()) return { consume: true };
    if (isClearComposerKey(data)) {
      editor.handleInput("\x1b");
      editor.setText("");
      tui.requestRender(true);
      return { consume: true };
    }
    if ((matchesKey(data, "enter") || matchesKey(data, "return")) && isToolsOverlayInput(editor.getText())) {
      editor.handleInput("\t");
      tui.requestRender(true);
      return { consume: true };
    }
    if ((matchesKey(data, "enter") || matchesKey(data, "return")) && isExitCommand(editor.getText())) {
      const text = editor.getText();
      editor.setText("");
      void screen.submit(text, options.onSubmit);
      return { consume: true };
    }
    if (matchesKey(data, "escape") && isBareCompletionTrigger(editor.getText())) {
      editor.handleInput(data);
      editor.setText("");
      return { consume: true };
    }
    if (matchesKey(data, "escape") && isCapabilityConfirmationText(editor.getText())) {
      editor.setText("");
      tui.requestRender(true);
      return { consume: true };
    }
    return undefined;
  });
  await screen.refreshStatusLine();
  if (options.footerLine) {
    const slot = new FooterSlot(options.footerLine);
    screen.refreshFooter = async (width = Math.max(40, Math.min(terminal.columns || 120, 240))) => {
      try {
        await slot.refresh(width);
        screen.setFooter(slot.line);
      } catch {
        /* the bar is chrome; a probe failure never breaks the chat */
      }
    };
    screen.footerStaleFor = (width) => slot.staleFor(width);
    void screen.refreshFooter();
  }
  const rawEscapeHandler = (chunk: Buffer | string): void => {
    const data = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk;
    if (boardMode?.active || parseSgrMouseSequence(data)) return;
    if (screen.approvals.pending || screen.settingsOpen) return;
    if (data === "\x1b" && screen.consumeLiveDiffEscapeSuppression()) return;
    if (data === "\x1b" && screen.closeLiveDiff()) return;
    if (data === "\x1b" && screen.interruptTurn()) return;
    if (data === "\x1b" && isBareCompletionTrigger(editor.getText())) {
      editor.handleInput(data);
      editor.setText("");
      tui.requestRender(true);
    }
  };
  const ready: { dispose?: () => void } = {};
  await new Promise<void>((resolve) => {
    screen.onStop = resolve;
    tui.start();
    process.stdin.on("data", rawEscapeHandler);
    tui.requestRender(true);
    const dispose = options.onReady?.(screen);
    if (typeof dispose === "function") ready.dispose = dispose;
  });
  try { ready.dispose?.(); } catch { /* teardown hook must not block exit */ }
  process.stdin.off("data", rawEscapeHandler);
  boardMode?.dispose();
  tui.stop();
  await terminal.drainInput(150, 25).catch(() => {});
  // Printed AFTER the TUI tears down: anything written into the transcript at
  // exit time is erased with the alternate screen.
  if (screen.exited) process.stdout.write(`${dim(options.farewell ?? "bye")}\n`);
}

class BoardModeHost {
  private view: BoardView = { columns: { backlog: [], ready: [], running: [], review: [], done: [] }, cards: {} };
  private messages: readonly MessageRow[] = [];
  private board: BoardScreen | undefined;
  private task: TaskView | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private refreshing = false;
  get active(): boolean { return Boolean(this.board || this.task); }
  constructor(
    private readonly tui: TUI,
    private readonly terminal: SuspendableProcessTerminal,
    private readonly chat: MusterChatScreen,
    private readonly editor: Editor,
    private readonly controller: BoardModeController,
  ) {}
  async open(force = false): Promise<boolean> {
    this.view = await this.controller.loadView();
    if (!force && Object.keys(this.view.cards).length === 0) return false;
    if (this.active) return true;
    this.tui.removeChild(this.chat);
    this.board = new BoardScreen({
      view: () => this.view,
      rows: () => this.tui.terminal.rows,
      requestRender: () => this.tui.requestRender(),
      openTask: (taskId) => { void this.openTask(taskId); },
      close: () => this.close(),
    });
    this.tui.addChild(this.board);
    this.tui.setFocus(this.board);
    this.tui.terminal.write("\x1b[?1002h\x1b[?1006h");
    this.board.start();
    this.timer = setInterval(() => { void this.refresh(); }, 250);
    this.tui.requestRender(true);
    return true;
  }
  handleMouse(event: SgrMouseEvent): boolean {
    return this.board?.handleMouse(event) ?? Boolean(this.task);
  }
  dispose(): void { this.stopTimer(); this.board?.stop(); if (this.active) this.tui.terminal.write("\x1b[?1002l\x1b[?1006l"); }
  private async refresh(): Promise<void> {
    if (this.refreshing || !this.active) return;
    this.refreshing = true;
    try {
      this.view = await this.controller.loadView();
      const card = this.taskCard();
      if (card?.sessionId) this.messages = await this.controller.loadMessages(card.sessionId);
      this.tui.requestRender();
    } finally { this.refreshing = false; }
  }
  private taskId: string | undefined;
  private taskCard() { return this.taskId ? this.view.cards[this.taskId] : undefined; }
  private async openTask(taskId: string): Promise<void> {
    const card = this.view.cards[taskId];
    if (!card) return;
    this.taskId = taskId;
    this.messages = card.sessionId ? await this.controller.loadMessages(card.sessionId) : [];
    if (this.board) { this.board.stop(); this.tui.removeChild(this.board); }
    this.task = new TaskView({
      card: () => this.view.cards[taskId] ?? card,
      messages: () => this.messages,
      diff: () => this.controller.diff(taskId),
      rows: () => this.tui.terminal.rows,
      cwd: this.controller.cwd,
      requestRender: (force) => this.tui.requestRender(force),
      close: () => this.closeTask(),
      comment: (text, anchor) => this.controller.comment(taskId, text, anchor),
      approve: () => this.controller.approve(taskId),
      retry: () => this.controller.retry(taskId),
      cancel: () => this.controller.cancel(taskId),
      openEditor: async (path, line) => {
        this.tui.terminal.write("\x1b[?1002l\x1b[?1006l\x1b[?25h");
        this.terminal.suspend();
        try {
          await openFileWithEditorGuard(path, { cwd: this.controller.cwd, line, setRawMode: () => {}, write: () => {} });
        } finally {
          this.terminal.resume();
          this.tui.terminal.write("\x1b[?1002h\x1b[?1006h\x1b[?25l");
          this.tui.requestRender(true);
        }
      },
    });
    this.tui.addChild(this.task);
    this.tui.setFocus(this.task);
    this.tui.requestRender(true);
  }
  private closeTask(): void {
    if (!this.task || !this.board) return;
    this.tui.removeChild(this.task);
    this.task = undefined;
    this.taskId = undefined;
    this.tui.addChild(this.board);
    this.board.start();
    this.tui.setFocus(this.board);
    this.tui.requestRender(true);
  }
  private close(): void {
    this.stopTimer();
    this.board?.stop();
    if (this.task) this.tui.removeChild(this.task);
    if (this.board) this.tui.removeChild(this.board);
    this.task = undefined; this.board = undefined; this.taskId = undefined;
    this.tui.terminal.write("\x1b[?1002l\x1b[?1006l");
    this.tui.addChild(this.chat);
    this.tui.setFocus(this.editor);
    this.tui.requestRender(true);
  }
  private stopTimer(): void { if (this.timer) clearInterval(this.timer); this.timer = undefined; }
}

/**
 * Where a composer picker opens: flush-left, directly above the input box,
 * across EVERY column. One column short let the row behind it show a stray
 * `─` at the right edge.
 */
export function composerOverlayOptions(columns: number) {
  return {
    anchor: "bottom-left" as const,
    offsetY: -3,
    width: Math.max(72, columns),
    maxHeight: 22,
    margin: { left: 0, right: 0 },
  };
}

/** A picker under a dim rule, so it never reads as part of the transcript above it. */
export class RuledOverlay implements Component {
  constructor(private readonly inner: Component, private readonly frame: { readonly title?: string; readonly hint?: string } = {}) {}

  render(width: number): string[] {
    const cap = Math.max(1, width);
    return [
      dim("─".repeat(Math.max(0, width))),
      ...(this.frame.title ? [truncateToWidth(highlight(this.frame.title), cap, "…")] : []),
      ...this.inner.render(width),
      ...(this.frame.hint ? [truncateToWidth(dim(this.frame.hint), cap, "…")] : []),
    ];
  }

  handleInput(data: string): void {
    this.inner.handleInput?.(data);
  }

  invalidate(): void {
    this.inner.invalidate();
  }
}

class MusterChatScreen implements Component, MusterChatSink {
  private readonly store = new TranscriptStore();
  private get lines(): string[] {
    return this.store.lines;
  }
  private status = "";
  private statusTick = 0;
  private stopped = false;
  private turnRunning = false;
  private interruptRequested = false;
  private pickerOpen = false;
  private liveDiffTurn = new LiveFileTurnAccumulator();
  private liveDiffOverlay: LiveFileOverlay | undefined;
  private liveDiffHandle: OverlayHandle | undefined;
  private suppressRawLiveDiffEscape = false;
  readonly followUps: RunningTurnInput;
  exited = false;
  onStop?: () => void;
  onOpenBoard?: (force?: boolean) => Promise<boolean>;

  constructor(
    private readonly tui: TUI,
    private readonly editor: Editor,
    private readonly statusLine: () => string | Promise<string>,
    private headerLines: readonly string[],
    initialLines: readonly string[],
    private readonly onInterrupt?: () => boolean | Promise<boolean>,
    onSteer?: (text: string) => boolean | Promise<boolean>,
  ) {
    this.followUps = new RunningTurnInput(onSteer);
    this.store.push(...initialLines);
  }

  async refreshStatusLine(): Promise<void> {
    this.status = await this.statusLine();
  }

  appendLine(line: string): void {
    // Defect #4: a spinner frame owns the status row and nothing else. Even if
    // one reaches a transcript sink it is redirected, never appended.
    if (isWorkingStatusLine(line)) {
      this.setStatus(line);
      return;
    }
    for (const part of String(line).split(/\r?\n/)) {
      this.store.push(part);
    }
    this.trimTranscript();
    this.scrollOffset = 0; // new output always snaps the viewport back to live
    this.tui.requestRender();
  }

  appendUser(text: string): void {
    // Breathing room, the Claude Code rhythm: one blank row before each user
    // turn so blocks read as blocks, never as a stacked log.
    if (this.lines.length && stripAnsi(this.lines[this.lines.length - 1] ?? "").trim() !== "") this.appendLine("");
    this.appendLine(formatUserLine(text));
  }

  clearTranscript(): void {
    this.store.clear();
    this.tui.requestRender(true);
  }

  upsertBlock(id: string, render: (expanded: boolean) => string[]): void {
    this.store.upsert(id, render);
    this.scrollOffset = 0;
    this.tui.requestRender();
  }

  toggleExpanded(): void {
    this.store.toggleExpanded();
    this.tui.requestRender(true);
  }

  markRewound(prompt: string): void {
    if (this.store.markRewound(prompt, dim(REWOUND_MARKER))) this.tui.requestRender(true);
  }

  readonly approvals = new ApprovalQueue((id, render) => this.upsertBlock(id, render));

  requestApproval(request: ApprovalRequest): Promise<ApprovalDecision> {
    const decision = this.approvals.request(request);
    this.tui.requestRender(true);
    return decision;
  }

  private footer = "";
  /** Recomputes the bar; set by runMusterChatTui when a footer source exists. */
  refreshFooter?: (width?: number) => Promise<void>;
  /** True when the bar was built for another width (the window was resized). */
  footerStaleFor?: (width: number) => boolean;

  setFooter(line: string): void {
    if (line === this.footer) return;
    this.footer = line;
    // Full repaint: an incremental one after a tall turn left a stale bar row behind.
    this.tui.requestRender(true);
  }

  setHeaderLines(lines: readonly string[]): void {
    this.headerLines = lines;
    this.tui.requestRender(true);
  }

  setStatus(status: string): void {
    if (isWorkingStatusLine(status)) status = paintWorkingRow(status, this.statusTick += 1);
    this.status = status;
    this.tui.requestRender();
  }

  clearStatus(): void {
    void this.refreshStatusLine().finally(() => this.tui.requestRender());
  }

  openPicker(command: string): void {
    this.editor.setText("");
    for (const char of command) this.editor.handleInput(char);
    this.tui.requestRender(true);
  }

  selectFromList(title: string, options: readonly PickerOption[]): Promise<string | undefined> {
    return new Promise((resolve) => {
      let settled = false;
      let handle: ReturnType<TUI["showOverlay"]> | undefined;
      const finish = (value?: string): void => {
        if (settled) return;
        settled = true;
        this.pickerOpen = false;
        handle?.hide();
        this.tui.setFocus(this.editor);
        this.tui.requestRender(true);
        resolve(value);
      };
      const theme = composerPickerTheme();
      this.pickerOpen = true;
      const list = selectSubmenu(
        options.map((option) => ({ value: option.value, label: option.label ?? option.value, description: option.description })),
        0,
        theme.select,
        (value) => finish(value),
        () => finish(),
      );
      // The Codex app's placement: flush-left, DIRECTLY above the input box —
      // never centered in the void, never painting over the composer's frame.
      // Full width: overlay rows must be OPAQUE across the terminal so the
      // transcript can never bleed through beside them (owner-reported).
      handle = this.tui.showOverlay(new RuledOverlay(list, { title, hint: "↑↓ choose · enter select · esc cancel" }), composerOverlayOptions(this.tui.terminal.columns));
      this.tui.requestRender(true);
    });
  }

  selectComposerSetting(state: ComposerPickerState): Promise<ComposerPickerSelection | undefined> {
    return new Promise((resolve) => {
      let settled = false;
      let handle: ReturnType<TUI["showOverlay"]> | undefined;
      const finish = (selection?: ComposerPickerSelection): void => {
        if (settled) return;
        settled = true;
        this.pickerOpen = false;
        handle?.hide();
        this.tui.setFocus(this.editor);
        this.tui.requestRender(true);
        resolve(selection);
      };
      const pickerTheme = composerPickerTheme();
      this.pickerOpen = true;
      const settings = new SettingsList([
        {
          id: "model",
          label: "Model",
          currentValue: modelDisplayLabel(state.activeModel),
          description: `Current source: ${state.modelSource}`,
          submenu: () => groupedModelSubmenu(state, pickerTheme.select, (value) => finish({ kind: "model", value }), () => finish()),
        },
        modelProvider(state.activeModel) === "claude"
          ? {
              id: "extended-thinking",
              label: "Effort",
              currentValue: "Extended thinking — managed by the model",
              description: "Claude CLI exposes no verified thinking tier flag for these models.",
            }
          : {
              id: "effort",
              label: "Effort",
              currentValue: effortDisplayLabel(state.effort),
              description: `Current source: ${state.effortSource}`,
              submenu: () => selectSubmenu(
                state.catalog.efforts.map((option) => ({
                  value: option.value,
                  label: `${option.label}${option.value === state.effort ? `  ${pickerOk("✓")}` : ""}`,
                  description: option.hint,
                })),
                state.catalog.efforts.findIndex((option) => option.value === state.effort),
                pickerTheme.select,
                (value) => finish({ kind: "effort", value: value as EffortValue }),
                () => finish(),
              ),
            },
        {
          id: "speed",
          label: "Speed",
          currentValue: state.speed,
          description: state.speed === "fast" ? "Warm native session with ambient recall off" : "Full memory and skill context",
          values: state.speed === "fast" ? ["fast", "session"] : ["session", "fast"],
        },
      ], 6, pickerTheme.settings, (id, value) => {
        if (id === "speed") finish({ kind: "speed", value: value as "session" | "fast" });
      }, () => finish());
      // The Codex app's placement: flush-left, DIRECTLY above the input box —
      // never centered in the void, never painting over the composer's frame.
      // Full width for opacity — the transcript must never bleed through.
      handle = this.tui.showOverlay(new RuledOverlay(settings), composerOverlayOptions(this.tui.terminal.columns));
      this.tui.requestRender(true);
    });
  }

  setLiveDiffTurn(turn: LiveFileTurnAccumulator): void {
    this.liveDiffTurn = turn;
    this.liveDiffOverlay?.update(turn);
  }

  updateLiveDiff(turn: LiveFileTurnAccumulator): void {
    this.liveDiffTurn = turn;
    this.liveDiffOverlay?.update(turn);
  }

  toggleLiveDiff(): void {
    if (this.liveDiffHandle) {
      this.closeLiveDiff();
      return;
    }
    // pi-tui cannot give a useful full-file viewport this small. Keep the
    // command honest and readable by appending the cumulative plain delta.
    if (this.tui.terminal.rows < 20 || !process.stdout.isTTY) {
      for (const line of renderLiveFilePlain(this.liveDiffTurn)) this.appendLine(line);
      return;
    }
    const overlay = new LiveFileOverlay(this.liveDiffTurn, {
      terminalRows: () => this.tui.terminal.rows,
      requestRender: () => this.tui.requestRender(true),
      close: () => { this.closeLiveDiff(); },
    });
    this.liveDiffOverlay = overlay;
    this.liveDiffHandle = this.tui.showOverlay(overlay, {
      width: "90%",
      maxHeight: "85%",
      anchor: "center",
      margin: 1,
    });
    this.tui.requestRender(true);
  }

  openBoard(force = false): Promise<boolean> {
    return this.onOpenBoard?.(force) ?? Promise.resolve(false);
  }

  private settingsPanel: SettingsPanel | undefined;

  get settingsOpen(): boolean {
    return Boolean(this.settingsPanel);
  }

  /** Full screen, like the board: the chat component steps aside and comes back intact on Esc. */
  openSettings(options: OpenSettingsOptions): Promise<void> {
    if (this.settingsPanel) return Promise.resolve();
    return new Promise((resolve) => {
      const panel: SettingsPanel = new SettingsPanel({
        cwd: options.cwd,
        rows: () => this.tui.terminal.rows,
        onChange: options.onChange,
        requestRender: () => this.tui.requestRender(),
        onClose: () => {
          this.tui.removeChild(panel);
          this.settingsPanel = undefined;
          this.tui.addChild(this);
          this.tui.setFocus(this.editor);
          void this.refreshStatusLine().finally(() => this.tui.requestRender(true));
          resolve();
        },
      });
      this.settingsPanel = panel;
      this.tui.removeChild(this);
      this.tui.addChild(panel);
      this.tui.setFocus(panel);
      this.tui.requestRender(true);
    });
  }

  closeLiveDiff(suppressRawEscape = false): boolean {
    if (!this.liveDiffHandle) return false;
    this.suppressRawLiveDiffEscape = suppressRawEscape;
    this.liveDiffHandle.hide();
    this.liveDiffHandle = undefined;
    this.liveDiffOverlay = undefined;
    this.tui.setFocus(this.editor);
    this.tui.requestRender(true);
    return true;
  }

  consumeLiveDiffEscapeSuppression(): boolean {
    if (!this.suppressRawLiveDiffEscape) return false;
    this.suppressRawLiveDiffEscape = false;
    return true;
  }

  async submit(text: string, onSubmit: (text: string, sink: MusterChatSink) => Promise<boolean>): Promise<void> {
    const value = text.trim();
    if (!value || this.stopped) return;
    // Defect #5: /exit is routed by the TUI itself. Routing it through the
    // command handler worked only in the plain REPL — in TUI mode the farewell
    // landed in a transcript that the teardown then erased.
    if (isExitCommand(value)) {
      this.appendUser(value);
      this.exited = true;
      this.stop();
      return;
    }
    // The composer stays live during a turn: Enter steers the running turn
    // (or queues when the runtime cannot steer); Ctrl+Q always queues.
    if (this.turnRunning) {
      this.editor.addToHistory(value);
      await this.followUps.route(value, "steer", (line) => this.appendLine(line));
      this.tui.requestRender();
      return;
    }
    this.turnRunning = true;
    this.interruptRequested = false;
    this.editor.addToHistory(value);
    this.appendUser(value);
    let keepGoing = true;
    try {
      keepGoing = await onSubmit(value, this);
      if (!keepGoing) this.stop();
    } catch (error) {
      this.appendLine(red(error instanceof Error ? error.message : String(error)));
    } finally {
      this.turnRunning = false;
      this.clearStatus();
      if (this.interruptRequested) {
        // An interrupt is a change of mind: queued follow-ups come back for editing.
        const back = this.followUps.drain();
        if (back.length) this.editor.setText(back.join("\n"));
      } else if (keepGoing && !this.stopped) {
        const next = this.followUps.takeNext();
        if (next !== undefined) void this.submit(next, onSubmit);
      }
      void this.refreshFooter?.();
      this.tui.requestRender();
    }
  }

  get running(): boolean {
    return this.turnRunning;
  }

  async queueFollowUp(text: string): Promise<void> {
    await this.followUps.route(text, "queue", (line) => this.appendLine(line));
    this.tui.requestRender();
  }

  interruptTurn(): boolean {
    if (this.pickerOpen || !this.turnRunning || this.interruptRequested || !this.onInterrupt) return false;
    this.interruptRequested = true;
    void Promise.resolve(this.onInterrupt()).then((interrupted) => {
      if (interrupted) this.appendLine(dim("⎋ interrupted"));
      else this.interruptRequested = false;
    }).catch(() => { this.interruptRequested = false; });
    return true;
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.onStop?.();
  }

  invalidate(): void {
    this.editor.invalidate();
  }

  render(width: number): string[] {
    const frameWidth = Math.max(40, Math.min(width, 240));
    if (this.footerStaleFor?.(frameWidth)) void this.refreshFooter?.(frameWidth);
    const composer = [
      ...renderQueuedBand(this.followUps.queued, frameWidth),
      ...renderMusterComposer(this.editor, frameWidth),
      ...(this.footer ? [truncateToWidth(this.footer, frameWidth, "")] : []),
    ];
    // The status row arrives pre-styled (formatStatusLine owns spinner + dim);
    // re-wrapping it in dim() would reset the color half-way through the row.
    const status = this.status ? [truncateToWidth(this.status, frameWidth, "")] : [];
    const fittedHeader = fitLines(this.headerLines, frameWidth);
    // FLOW MODE — the Claude Code contract. The full transcript is handed to
    // pi-tui, whose differ repaints only the visible viewport and lets earlier
    // lines flow into the terminal's NATIVE scrollback: the user can scroll up
    // through the whole session. Windowing/truncation here (the old
    // renderTranscriptWindow budget) is what made running history vanish; it
    // must never come back. renderTranscriptWindow remains exported for
    // cramped non-interactive surfaces only.
    // Pad to the FULL terminal width, not the capped frame: on ultra-wide
    // terminals, cells beyond the frame otherwise keep stale glyphs from
    // earlier wide paints (observed as phantom "["/"]" at screen edges).
    const padTo = Math.max(frameWidth, this.tui.terminal.columns || frameWidth);
    const transcript = this.wrappedTranscript(frameWidth, padTo);
    // THE LAYOUT LAW: content and input travel together, composer at the
    // bottom. On the ALTERNATE SCREEN there is no native scrollback, so the
    // transcript renders through a viewport window scrolled in-app
    // (PgUp/PgDn/wheel), exactly like the reference.
    const termRows = Math.max(8, this.tui.terminal.rows || 24);
    const statusArea = this.scrollOffset > 0
      ? [dim(`… ${this.scrollOffset} rows below · PgDn to follow`)]
      : status;
    const chromeRows = fittedHeader.length + statusArea.length + composer.length;
    const viewportRows = Math.max(1, termRows - chromeRows - 1);
    const windowed = windowTranscript(transcript, viewportRows, this.scrollOffset);
    this.scrollOffset = windowed.clamped;
    const filler = Array.from({ length: Math.max(0, termRows - chromeRows - windowed.visible.length - 1) }, () => "");
    const rows = [...fittedHeader, ...windowed.visible, ...filler, ...statusArea, ...composer].map((line) => padAnsi(line, padTo));
    this.lastRenderedRows = rows.length;
    return rows;
  }

  /** Total content rows from the last paint — the composer sits at the tail. */
  private lastRenderedRows = 0;
  /** Rows lifted off the tail by PgUp/wheel; 0 = following live output. */
  private scrollOffset = 0;

  /** Returns false when an overlay owns paging keys (canvas, picker). */
  scrollTranscript(delta: number): boolean {
    if (this.pickerOpen || this.liveDiffOverlay) return false;
    const next = Math.max(0, this.scrollOffset + delta);
    if (next === this.scrollOffset) return delta > 0;
    this.scrollOffset = next;
    this.tui.requestRender(true);
    return true;
  }

  scrollPage(direction: 1 | -1): boolean {
    return this.scrollTranscript(direction * Math.max(1, (this.tui.terminal.rows || 24) - 8));
  }

  handleInput(data: string): void {
    this.editor.handleInput(data);
  }

  /**
   * Incremental wrap cache: transcripts are append-only, so each source line
   * wraps exactly once per width. This is what makes UNLIMITED scrollback
   * (owner-ruled 2026-08-30 — no row cap, the entire session reachable)
   * affordable: a repaint costs O(viewport), not O(session).
   */
  private wrapCache = { width: -1, padTo: -1, consumed: 0, rows: [] as string[], bandOpen: false, lineRows: [] as number[], bandAfter: [] as boolean[] };

  private wrappedTranscript(frameWidth: number, padTo: number): readonly string[] {
    const cache = this.wrapCache;
    if (cache.width !== frameWidth || cache.padTo !== padTo || cache.consumed > this.lines.length) {
      cache.width = frameWidth;
      cache.padTo = padTo;
      cache.consumed = 0;
      cache.rows = [];
      cache.bandOpen = false;
      cache.lineRows = [];
      cache.bandAfter = [];
    }
    // A block changed in place: drop the wrapped rows from its first line on.
    const dirty = this.store.dirtyFrom;
    this.store.dirtyFrom = Number.POSITIVE_INFINITY;
    if (dirty < cache.consumed) {
      let keep = 0;
      for (let index = 0; index < dirty; index += 1) keep += cache.lineRows[index] ?? 0;
      cache.rows.length = keep;
      cache.lineRows.length = dirty;
      cache.bandAfter.length = dirty;
      cache.bandOpen = dirty > 0 ? (cache.bandAfter[dirty - 1] ?? false) : false;
      cache.consumed = dirty;
    }
    while (cache.consumed < this.lines.length) {
      const line = this.lines[cache.consumed]!;
      const plain = stripAnsi(line);
      const wasUser = cache.bandOpen;
      if (isUserTranscriptLine(line)) cache.bandOpen = true;
      else if (!plain.startsWith("  ")) cache.bandOpen = false;
      const rows = CARD_MARK.test(line)
        ? renderTranscriptLine(line, frameWidth, padTo)
        : wrapLine(line, frameWidth).map((row) => cache.bandOpen ? bandUserRow(row, padTo) : row);
      // THE GAP, enforced at the renderer so no append site can regress it.
      if (wasUser && !cache.bandOpen && plain.trim() !== "") rows.unshift("");
      cache.rows.push(...rows);
      cache.lineRows.push(rows.length);
      cache.bandAfter.push(cache.bandOpen);
      cache.consumed += 1;
    }
    return cache.rows;
  }

  private trimTranscript(): void {
    // Owner-ruled: NO cap — the entire session stays scrollable. The wrap
    // cache keeps repaints O(viewport) regardless of session length.
  }
}

class HarnessSink implements MusterChatSink {
  private readonly store = new TranscriptStore();
  get transcriptLines(): string[] {
    return this.store.lines.map(stripCardMark);
  }
  exited = false;
  statusRow = "";
  private turnRunning = false;
  private interruptRequested = false;
  private liveDiffTurn = new LiveFileTurnAccumulator();

  constructor(
    private readonly editor: Editor,
    private readonly onSubmit?: (text: string, sink: MusterChatSink) => Promise<boolean>,
    private readonly onInterrupt?: () => boolean | Promise<boolean>,
    initialLines: readonly string[] = [],
    onSteer?: (text: string) => boolean | Promise<boolean>,
    private readonly rows = 40,
  ) {
    this.store.push(...initialLines);
    this.followUps = new RunningTurnInput(onSteer);
  }

  /** The open settings panel; harness input goes to it while it is open. */
  settings: SettingsPanel | undefined;

  openSettings(options: OpenSettingsOptions): Promise<void> {
    return new Promise((resolve) => {
      this.settings = new SettingsPanel({
        cwd: options.cwd,
        rows: () => this.rows,
        onChange: options.onChange,
        onClose: () => {
          this.settings = undefined;
          resolve();
        },
      });
    });
  }

  readonly followUps: RunningTurnInput;

  get running(): boolean {
    return this.turnRunning;
  }

  async queueFollowUp(text: string): Promise<void> {
    await this.followUps.route(text, "queue", (line) => this.appendLine(line));
  }

  appendLine(line: string): void {
    if (isWorkingStatusLine(line)) {
      this.setStatus(line);
      return;
    }
    for (const part of String(line).split(/\r?\n/)) this.store.push(part);
  }

  appendUser(text: string): void {
    this.appendLine(formatUserLine(text));
  }

  upsertBlock(id: string, render: (expanded: boolean) => string[]): void {
    this.store.upsert(id, render);
  }

  markRewound(prompt: string): void {
    this.store.markRewound(prompt, dim(REWOUND_MARKER));
  }

  toggleExpanded(): void {
    this.store.toggleExpanded();
  }

  footer = "";

  setFooter(line: string): void {
    this.footer = line;
  }

  readonly approvals = new ApprovalQueue((id, render) => this.upsertBlock(id, render));

  requestApproval(request: ApprovalRequest): Promise<ApprovalDecision> {
    return this.approvals.request(request);
  }

  clearTranscript(): void {
    this.store.clear();
  }

  setHeaderLines(_lines: readonly string[]): void {}

  setStatus(status: string): void {
    this.statusRow = status;
  }

  clearStatus(): void {
    this.statusRow = "";
  }

  openPicker(command: string): void {
    this.editor.setText("");
    for (const char of command) this.editor.handleInput(char);
  }

  async selectComposerSetting(_state: ComposerPickerState): Promise<ComposerPickerSelection | undefined> {
    return undefined;
  }

  async selectFromList(_title: string, _options: readonly PickerOption[]): Promise<string | undefined> {
    return undefined;
  }

  setLiveDiffTurn(turn: LiveFileTurnAccumulator): void {
    this.liveDiffTurn = turn;
  }

  updateLiveDiff(turn: LiveFileTurnAccumulator): void {
    this.liveDiffTurn = turn;
  }

  toggleLiveDiff(): void {
    for (const line of renderLiveFilePlain(this.liveDiffTurn)) this.appendLine(line);
  }

  openBoard(): Promise<boolean> { return Promise.resolve(false); }

  async submit(text: string): Promise<boolean> {
    const value = text.trim();
    if (!value) return true;
    if (this.turnRunning && !isExitCommand(value)) {
      this.editor.addToHistory(value);
      await this.followUps.route(value, "steer", (line) => this.appendLine(line));
      return true;
    }
    this.editor.addToHistory(value);
    this.appendUser(value);
    if (isExitCommand(value)) {
      this.exited = true;
      return false;
    }
    this.turnRunning = true;
    this.interruptRequested = false;
    let keepGoing = true;
    try {
      keepGoing = await (this.onSubmit?.(value, this) ?? Promise.resolve(true));
      return keepGoing;
    } finally {
      this.turnRunning = false;
      this.clearStatus();
      if (this.interruptRequested) {
        const back = this.followUps.drain();
        if (back.length) this.editor.setText(back.join("\n"));
      } else if (keepGoing) {
        const next = this.followUps.takeNext();
        if (next !== undefined) void this.submit(next);
      }
    }
  }

  interruptTurn(): boolean {
    if (!this.turnRunning || this.interruptRequested || !this.onInterrupt) return false;
    this.interruptRequested = true;
    void Promise.resolve(this.onInterrupt()).then((interrupted) => {
      if (interrupted) this.appendLine(dim("⎋ interrupted"));
      else this.interruptRequested = false;
    }).catch(() => { this.interruptRequested = false; });
    return true;
  }
}

function fakeHarnessTui(width: number, rows: number): Pick<TUI, "terminal" | "requestRender"> {
  return {
    terminal: { columns: width, rows },
    requestRender() {},
  } as Pick<TUI, "terminal" | "requestRender">;
}

export function renderTranscriptWindow(lines: readonly string[], width: number, budget: number): string[] {
  if (budget <= 0) return [];
  const latestUserIndex = findLatestUserLine(lines);
  if (latestUserIndex < 0) return lines.flatMap((line) => wrapLine(line, width)).slice(-budget);

  const before = lines.slice(0, latestUserIndex).flatMap((line) => wrapLine(line, width));
  const turn = lines.slice(latestUserIndex).flatMap((line) => wrapLine(line, width));
  if (turn.length <= budget) {
    return [...before.slice(-(budget - turn.length)), ...turn].slice(-budget);
  }

  const userLine = turn[0] ?? wrapLine(lines[latestUserIndex] ?? "", width)[0] ?? "";
  if (budget === 1) return [userLine];
  const groups = pinnedGroups(turn);
  if (budget >= 3 && groups.length) {
    // Two passes: the first sizes the tail, the second drops any group the tail
    // already shows, so a squeezed turn never prints the same receipt twice.
    const firstPass = takePinnedGroups(groups, budget - 2);
    const visibleFrom = turn.length - (budget - 1 - firstPass.length);
    const pinned = takePinnedGroups(groups.filter((group) => group.lastIndex < visibleFrom), budget - 2);
    if (pinned.length) {
      const tailBudget = budget - 1 - pinned.length;
      return [userLine, ...pinned, ...turn.slice(-tailBudget)].slice(0, budget);
    }
  }
  return [userLine, ...turn.slice(-(budget - 1))].slice(0, budget);
}

export function isClearComposerKey(data: string): boolean {
  return data === "\x15";
}

function isPinnedReceiptLine(line: string): boolean {
  const clean = stripAnsi(line).trimStart();
  // Raw receipts (non-TTY shape), their TTY chips, and the dim `⎿` result rows
  // under an action all stay visible when a long turn overflows the budget.
  return clean.startsWith("memory backend=")
    || clean.startsWith("timings total=")
    || clean.startsWith("▸ ")
    || clean.startsWith(`${RESULT_ELBOW} `);
}

/** `⏺ Edit(server.js)` — the headline an indented result hangs beneath. */
function isActionHeadline(line: string): boolean {
  return stripAnsi(line).startsWith(`${TOOL_BULLET} `);
}

interface PinnedGroup {
  /** The rows this pin occupies, headline first when it has one. */
  readonly lines: readonly string[];
  /** Index of the last row in the turn, used to detect tail overlap. */
  readonly lastIndex: number;
}

/**
 * Receipts worth pinning when a turn overflows, each carried WITH the action
 * that owns it. Pinning a bare `⎿ +12 −2 · receipt d3b9…` was a quiet data
 * loss: the numbers survived but the file they belonged to did not, so the row
 * read as an orphan. A result and its `⏺` headline are one unit or neither.
 */
function pinnedGroups(turn: readonly string[]): PinnedGroup[] {
  const groups: PinnedGroup[] = [];
  for (let index = 1; index < turn.length; index += 1) {
    const line = turn[index] ?? "";
    if (!isPinnedReceiptLine(line)) continue;
    const owner = turn[index - 1] ?? "";
    const withOwner = index - 1 >= 1 && isActionHeadline(owner);
    groups.push({ lines: withOwner ? [owner, line] : [line], lastIndex: index });
  }
  return groups;
}

/** Whole groups only, in order, until the next one would not fit. */
function takePinnedGroups(groups: readonly PinnedGroup[], budget: number): string[] {
  const rows: string[] = [];
  for (const group of groups) {
    if (rows.length + group.lines.length > budget) break;
    rows.push(...group.lines);
  }
  return rows;
}

export function renderHeaderWindow(lines: readonly string[], budget: number): string[] {
  if (budget <= 0) return [];
  if (lines.length <= budget) return [...lines];
  if (budget === 1) return [lines.at(-1) ?? ""];
  if (budget === 2) return [lines[0] ?? "", lines.at(-1) ?? ""];
  const headCount = Math.max(1, Math.floor((budget - 1) / 2));
  const tailCount = Math.max(1, budget - headCount - 1);
  const width = Math.max(80, visibleWidth(lines[0] ?? ""));
  return [
    ...lines.slice(0, headCount),
    truncateToWidth(dim("… header collapsed to keep chat visible"), width, ""),
    ...lines.slice(-tailCount),
  ];
}

function findLatestUserLine(lines: readonly string[]): number {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (isUserTranscriptLine(lines[index] ?? "")) return index;
  }
  return -1;
}

function slashCompletionContext(trimmed: string):
  | { kind: "command"; fragment: string; prefix: string }
  | { kind: "toolset"; fragment: string; prefix: string }
  | { kind: "session"; fragment: string; prefix: string }
  | { kind: "provider"; fragment: string; prefix: string }
  | { kind: "provider-model"; providerId: string; fragment: string; prefix: string }
  | { kind: "model"; fragment: string; prefix: string }
  | { kind: "runtime"; fragment: string; prefix: string }
  | { kind: "cloud"; fragment: string; prefix: string }
  | { kind: "speed"; fragment: string; prefix: string }
  | { kind: "capability"; fragment: string; prefix: string }
  | { kind: "skill"; fragment: string; prefix: string }
  | { kind: "plugin"; fragment: string; prefix: string }
  | { kind: "plugin-reuse-provider"; fragment: string; prefix: string }
  | { kind: "mcp"; fragment: string; prefix: string }
  | { kind: "mcp-target"; fragment: string; prefix: string }
  | { kind: "integration"; fragment: string; prefix: string }
  | { kind: "integration-workflow"; fragment: string; prefix: string }
  | { kind: "reasoning"; fragment: string; prefix: string }
  | undefined {
  switch (trimmed.toLowerCase()) {
    case "/tools":
      return { kind: "toolset", fragment: "", prefix: trimmed };
    case "/resume":
    case "/name":
      return { kind: "session", fragment: "", prefix: trimmed };
    case "/provider":
    case "/use-provider":
      return { kind: "provider", fragment: "", prefix: trimmed };
    case "/model":
      return { kind: "model", fragment: "", prefix: trimmed };
    case "/runtime":
      return { kind: "runtime", fragment: "", prefix: trimmed };
    case "/cloud":
      return { kind: "cloud", fragment: "", prefix: trimmed };
    case "/speed":
      return { kind: "speed", fragment: "", prefix: trimmed };
    case "/capability":
    case "/capabilities":
    case "/caps":
      return { kind: "capability", fragment: "", prefix: trimmed };
    case "/skill":
    case "/skills":
      return { kind: "skill", fragment: "", prefix: trimmed };
    case "/plugin":
    case "/plugins":
      return { kind: "plugin", fragment: "", prefix: trimmed };
    case "/mcp":
      return { kind: "mcp", fragment: "", prefix: trimmed };
    case "/reasoning":
      return { kind: "reasoning", fragment: "", prefix: trimmed };
    case "/integration":
    case "/integrations":
      return { kind: "integration", fragment: "", prefix: trimmed };
    case "/integration workflow":
    case "/integrations workflow":
    case "/integration setup":
    case "/integrations setup":
    case "/integration verify":
    case "/integrations verify":
    case "/integration enable":
    case "/integrations enable":
    case "/integration sample":
    case "/integrations sample":
      return { kind: "integration-workflow", fragment: "", prefix: trimmed };
  }
  if (/^\/[a-z-]*$/i.test(trimmed)) return { kind: "command", fragment: trimmed.slice(1), prefix: trimmed };
  const toolMatch = trimmed.match(/^\/tools\s+([^\s]*)$/i);
  if (toolMatch) return { kind: "toolset", fragment: toolMatch[1] ?? "", prefix: trimmed };
  const sessionMatch = trimmed.match(/^\/(?:resume|name)\s+([^\s]*)$/i);
  if (sessionMatch) return { kind: "session", fragment: sessionMatch[1] ?? "", prefix: trimmed };
  const providerModelMatch = trimmed.match(/^\/(?:provider|use-provider)\s+([^\s]+)\s+([^\s]*)$/i);
  if (providerModelMatch) return { kind: "provider-model", providerId: providerModelMatch[1] ?? "", fragment: providerModelMatch[2] ?? "", prefix: trimmed };
  const providerMatch = trimmed.match(/^\/(?:provider|use-provider)\s+([^\s]*)$/i);
  if (providerMatch) return { kind: "provider", fragment: providerMatch[1] ?? "", prefix: trimmed };
  const modelMatch = trimmed.match(/^\/model\s+([^\s]*)$/i);
  if (modelMatch) return { kind: "model", fragment: modelMatch[1] ?? "", prefix: trimmed };
  const runtimeMatch = trimmed.match(/^\/runtime\s+([^\s]*)$/i);
  if (runtimeMatch) return { kind: "runtime", fragment: runtimeMatch[1] ?? "", prefix: trimmed };
  const cloudMatch = trimmed.match(/^\/cloud\s+([^\s]*)$/i);
  if (cloudMatch) return { kind: "cloud", fragment: cloudMatch[1] ?? "", prefix: trimmed };
  const speedMatch = trimmed.match(/^\/speed\s+([^\s]*)$/i);
  if (speedMatch) return { kind: "speed", fragment: speedMatch[1] ?? "", prefix: trimmed };
  const reasoningMatch = trimmed.match(/^\/reasoning\s+([^\s]*)$/i);
  if (reasoningMatch) return { kind: "reasoning", fragment: reasoningMatch[1] ?? "", prefix: trimmed };
  const capabilityMatch = trimmed.match(/^\/(?:capabilities|capability|caps)\s+([^\s]*)$/i);
  if (capabilityMatch) return { kind: "capability", fragment: capabilityMatch[1] ?? "", prefix: trimmed };
  const skillMatch = trimmed.match(/^\/skills?\s+([^\s]*)$/i);
  if (skillMatch) return { kind: "skill", fragment: skillMatch[1] ?? "", prefix: trimmed };
  const pluginReuseMatch = trimmed.match(/^\/plugins?\s+reuse(?:\s+([^\s]*))?$/i);
  if (pluginReuseMatch) return { kind: "plugin-reuse-provider", fragment: pluginReuseMatch[1] ?? "", prefix: trimmed };
  const pluginMatch = trimmed.match(/^\/plugins?\s+([^\s]*)$/i);
  if (pluginMatch) return { kind: "plugin", fragment: pluginMatch[1] ?? "", prefix: trimmed };
  const mcpTargetMatch = trimmed.match(/^\/mcp\s+(?:login|remove|rm|test|install)\s+([^\s]*)$/i);
  if (mcpTargetMatch) return { kind: "mcp-target", fragment: mcpTargetMatch[1] ?? "", prefix: trimmed };
  const mcpMatch = trimmed.match(/^\/mcp\s+([^\s]*)$/i);
  if (mcpMatch) return { kind: "mcp", fragment: mcpMatch[1] ?? "", prefix: trimmed };
  const integrationWorkflowMatch = trimmed.match(/^\/integrations?\s+(?:workflow|setup|verify|enable|sample)\s+([^\s]*)$/i);
  if (integrationWorkflowMatch) return { kind: "integration-workflow", fragment: integrationWorkflowMatch[1] ?? "", prefix: trimmed };
  const integrationMatch = trimmed.match(/^\/integrations?\s+([^\s]*)$/i);
  if (integrationMatch) return { kind: "integration", fragment: integrationMatch[1] ?? "", prefix: trimmed };
  return undefined;
}

function filterPickerOptions(options: readonly PickerOption[], fragment: string): AutocompleteItem[] {
  const lower = fragment.toLowerCase();
  return options
    .map((option, index) => ({ option, index, rank: pickerMatchRank(option, lower) }))
    .filter((entry) => entry.rank < Number.POSITIVE_INFINITY)
    .sort((left, right) => left.rank - right.rank || left.index - right.index)
    .map((option) => ({
      value: option.option.value,
      label: option.option.label ?? option.option.value,
      description: option.option.description,
    }));
}

function pickerMatchRank(option: PickerOption, lowerFragment: string): number {
  if (!lowerFragment) return 0;
  const value = option.value.toLowerCase();
  const label = option.label?.toLowerCase() ?? "";
  const description = option.description?.toLowerCase() ?? "";
  if (value.startsWith(lowerFragment)) return 0;
  if (label.startsWith(lowerFragment)) return 1;
  if (value.includes(lowerFragment)) return 2;
  if (label.includes(lowerFragment)) return 3;
  if (description.includes(lowerFragment)) return 4;
  return Number.POSITIVE_INFINITY;
}

function pickerOptionsToItems(options: readonly PickerOption[]): AutocompleteItem[] {
  return options.map((option) => ({
    value: option.value,
    label: option.label ?? option.value,
    description: option.description ? dim(option.description) : undefined,
  }));
}

function createCallbackCompletionCatalog(options: MusterAutocompleteOptions): MusterCompletionCatalog {
  return {
    async complete(request) {
      switch (request.kind) {
        case "command":
          return options.commands
            .filter((command) => command.name.startsWith(request.fragment.toLowerCase()) || command.aliases?.some((alias) => alias.startsWith(request.fragment.toLowerCase())))
            .map((command) => ({ value: `/${command.name}`, label: pickerSel(command.usage), description: dim(command.description) }));
        case "toolset":
          return filterPickerOptions(options.toolsets.map((toolset) => ({ value: toolset, label: toolset, description: "toolset" })), request.fragment);
        case "session":
          return filterPickerOptions(options.recentSessions().map((name) => ({ value: name, label: name, description: "chat session" })), request.fragment);
        case "provider":
          return filterPickerOptions(await options.providers?.() ?? [], request.fragment);
        case "provider-model":
          return filterPickerOptions(await options.models?.({ providerId: request.providerId }) ?? [], request.fragment);
        case "model":
          return filterPickerOptions(await options.models?.({}) ?? [], request.fragment);
        case "runtime":
          return filterPickerOptions(await options.runtimes?.() ?? [], request.fragment);
        case "cloud":
          return filterPickerOptions(await options.clouds?.() ?? [], request.fragment);
        case "speed":
          return filterPickerOptions(await options.speeds?.() ?? [], request.fragment);
        case "reasoning":
          return filterPickerOptions([
            { value: "low", label: "Light", description: "Codex Effort" },
            { value: "medium", label: "Medium", description: "Codex Effort" },
            { value: "high", label: "High", description: "Codex Effort" },
            { value: "xhigh", label: "Extra High", description: "Codex Effort" },
            { value: "max", label: "Max", description: "Codex Effort" },
            { value: "ultra", label: "Ultra", description: "Consumes usage limits faster" },
            { value: "compact", label: "summaries: brief", description: "one dim line above each answer" },
            { value: "full", label: "summaries: full", description: "every provider-approved summary line" },
          ], request.fragment);
        case "capability": {
          const capabilities = await options.capabilities?.();
          return filterPickerOptions(capabilities ?? [
            ...((await options.skills?.()) ?? []),
            ...((await options.plugins?.()) ?? []),
            ...((await options.mcpServers?.()) ?? []),
          ], request.fragment);
        }
        case "skill":
          return filterPickerOptions(await options.skills?.() ?? [], request.fragment);
        case "plugin":
          return filterPickerOptions(await options.plugins?.() ?? [], request.fragment);
        case "plugin-reuse-provider":
          return filterPickerOptions(await options.pluginReuseProviders?.() ?? [], request.fragment);
        case "mcp":
          return filterPickerOptions(await options.mcpServers?.() ?? [], request.fragment);
        case "mcp-target":
          return filterPickerOptions(await options.mcpTargets?.() ?? await options.mcpServers?.() ?? [], request.fragment);
        case "integration":
          return filterPickerOptions(await options.integrations?.() ?? [], request.fragment);
        case "integration-workflow":
          return filterPickerOptions(await options.integrationWorkflows?.() ?? await options.integrations?.() ?? [], request.fragment);
        case "agent": {
          const fragment = request.fragment.toLowerCase();
          return [...new Set(await options.agents())]
            .filter((agent) => agent.toLowerCase().startsWith(fragment))
            .map((agent) => ({ value: `@${agent}`, label: `@${agent}`, description: "route this turn" }));
        }
      }
    },
  };
}

function agentCompletionFragment(trimmed: string): string | undefined {
  const match = trimmed.match(/^@([a-zA-Z0-9_.:-]*)$/);
  return match?.[1];
}

function completionReplacement(beforeCursor: string, item: AutocompleteItem, prefix: string): string {
  const trimmed = beforeCursor.trimStart();
  const capabilitySelection = decodeCapabilitySelection(item.value);
  if (/^\/tools(?:\s+\S*)?$/i.test(trimmed) && capabilitySelection !== undefined) return capabilitySelection;
  switch (trimmed.toLowerCase()) {
    case "/tools":
      return `/tools ${item.value}`;
    case "/resume":
      return `/resume ${item.value}`;
    case "/name":
      return `/name ${item.value}`;
    case "/provider":
    case "/use-provider":
      return `/provider ${item.value}`;
    case "/model":
      return `/model ${item.value}`;
    case "/runtime":
      return `/runtime ${item.value}`;
    case "/cloud":
      return `/cloud ${item.value}`;
    case "/speed":
      return `/speed ${item.value}`;
    case "/capability":
    case "/capabilities":
    case "/caps":
      return `/capabilities ${item.value}`;
    case "/skill":
    case "/skills":
      return `/skills ${item.value}`;
    case "/plugin":
    case "/plugins":
      return `/plugins ${item.value}`;
    case "/mcp":
      return `/mcp ${item.value}`;
    case "/integration":
    case "/integrations":
      return `/integrations ${item.value}`;
    case "/integration workflow":
    case "/integrations workflow":
      return `/integrations workflow ${item.value}`;
    case "/integration setup":
    case "/integrations setup":
      return `/integrations setup ${item.value}`;
    case "/integration verify":
    case "/integrations verify":
      return `/integrations verify ${item.value}`;
    case "/integration enable":
    case "/integrations enable":
      return `/integrations enable ${item.value}`;
    case "/integration sample":
    case "/integrations sample":
      return `/integrations sample ${item.value}`;
  }
  if (/^\/tools\s+/i.test(trimmed)) return `/tools ${item.value}`;
  if (/^\/resume\s+/i.test(trimmed)) return `/resume ${item.value}`;
  if (/^\/name\s+/i.test(trimmed)) return `/name ${item.value}`;
  const providerModel = trimmed.match(/^\/(?:provider|use-provider)\s+(\S+)\s+/i);
  if (providerModel) return `/provider ${providerModel[1]} ${item.value}`;
  if (/^\/(?:provider|use-provider)\s+/i.test(trimmed)) return `/provider ${item.value}`;
  if (/^\/model\s+/i.test(trimmed)) return `/model ${item.value}`;
  if (/^\/runtime\s+/i.test(trimmed)) return `/runtime ${item.value}`;
  if (/^\/cloud\s+/i.test(trimmed)) return `/cloud ${item.value}`;
  if (/^\/speed\s+/i.test(trimmed)) return `/speed ${item.value}`;
  if (/^\/(?:capabilities|capability|caps)\s+/i.test(trimmed)) return `/capabilities ${item.value}`;
  if (/^\/skills?\s+/i.test(trimmed)) return `/skills ${item.value}`;
  if (/^\/plugins?\s+reuse(?:\s+.*)?$/i.test(trimmed)) return `/plugins reuse ${item.value}`;
  if (/^\/plugins?\s+/i.test(trimmed)) return `/plugins ${item.value}`;
  const mcpTarget = trimmed.match(/^\/mcp\s+(login|remove|rm|test|install)\b/i);
  if (mcpTarget) return `/mcp ${mcpTarget[1]} ${item.value}`;
  if (/^\/mcp\s+/i.test(trimmed)) return `/mcp ${item.value}`;
  const integrationAction = trimmed.match(/^\/integrations?\s+(workflow|setup|verify|enable|sample)\s+/i);
  if (integrationAction) return `/integrations ${integrationAction[1]?.toLowerCase()} ${item.value}`;
  if (/^\/integrations?\s+/i.test(trimmed)) return `/integrations ${item.value}`;
  return item.value;
}

export function isBareCompletionTrigger(text: string): boolean {
  const trimmed = text.trim();
  return trimmed === "/" || trimmed === "@";
}

export function isToolsOverlayInput(text: string): boolean {
  return /^\/tools(?:\s+\S*)?$/i.test(text.trimStart());
}

export function isExitCommand(text: string): boolean {
  return /^\/(?:exit|quit|q)\s*$/i.test(text.trim());
}

function musterEditorTheme(): EditorTheme {
  // The reference's popup: NO background band — the selected row simply goes
  // periwinkle; everything structural is dim.
  return {
    borderColor: dim,
    selectList: {
      selectedPrefix: pickerSel,
      selectedText: pickerSel,
      description: dim,
      scrollInfo: dim,
      noMatch: dim,
    },
  };
}

function frameLine(content: string, innerWidth: number): string {
  const padded = padAnsi(content, innerWidth);
  return `${dim("│ ")}${padded}${RESET}${dim(" │")}`;
}

/**
 * Wrap one transcript row losslessly. `truncateToWidth` appends a reset
 * sequence, so slicing the remainder by the returned string's RAW length used
 * to eat four characters per wrap — a streamed sentence silently lost a word
 * every 78 columns. The chunk is stripped before it is used as a cursor, and
 * every character of the input ends up in exactly one chunk.
 */
function wrapLine(line: string, width: number): string[] {
  const cleanWidth = Math.max(10, width - 2);
  if (visibleWidth(line) <= cleanWidth) return [line];
  const plain = stripAnsi(line);
  const indent = hangingIndent(plain, cleanWidth);
  const chunks: string[] = [];
  let cursor = 0;
  for (;;) {
    const rest = plain.slice(cursor);
    // Continuations keep the row's own gutter column, so a wrapped `●` block
    // still reads as ONE block instead of restarting at column zero.
    const prefix = chunks.length ? indent : "";
    const limit = Math.max(1, cleanWidth - prefix.length);
    if (visibleWidth(rest) <= limit) {
      if (rest) chunks.push(prefix + sliceAnsiRange(line, cursor, plain.length));
      break;
    }
    const fitted = stripAnsi(truncateToWidth(rest, limit, ""));
    // A zero-width fit would loop forever; take one character and move on.
    const take = fitted.length > 0 ? wrapBreakPoint(rest, fitted.length) : 1;
    chunks.push(prefix + sliceAnsiRange(line, cursor, cursor + take));
    cursor += take;
  }
  return chunks.length ? chunks : [line];
}

/**
 * Slice by plain-text offsets while replaying the SGR state active at the
 * slice boundary. Semantic paint used to disappear as soon as prose wrapped;
 * keeping this here makes terminal width a layout concern, never a style gate.
 */
function sliceAnsiRange(value: string, start: number, end: number): string {
  const sgr = /\u001b\[[0-9;]*m/g;
  let plainAt = 0;
  let rawAt = 0;
  let active: string[] = [];
  let output = "";
  let started = false;
  for (;;) {
    sgr.lastIndex = rawAt;
    const match = sgr.exec(value);
    const nextEscape = match?.index ?? value.length;
    const text = value.slice(rawAt, nextEscape);
    const textStart = plainAt;
    const textEnd = plainAt + text.length;
    if (textEnd > start && textStart < end) {
      if (!started) { output += active.join(""); started = true; }
      output += text.slice(Math.max(0, start - textStart), Math.min(text.length, end - textStart));
    }
    plainAt = textEnd;
    if (!match || plainAt >= end) break;
    const code = match[0];
    if (code === RESET || code === "\x1b[m") active = [];
    else active.push(code);
    if (plainAt >= start && plainAt < end) {
      if (!started) { output += active.join(""); started = true; }
      else output += code;
    }
    rawAt = nextEscape + code.length;
  }
  return process.env.NO_COLOR || !output ? output : `${output}${RESET}`;
}

/**
 * The column a wrapped row resumes at: its own leading whitespace plus the
 * width of a gutter glyph (`●`, `⏺`, `⎿`, `>`, `✻`, `∴`) when it wears one. Clamped
 * so a deeply indented row can never wrap itself down to a one-character
 * column.
 */
function hangingIndent(clean: string, cleanWidth: number): string {
  const match = clean.match(/^( *)(?:([●⏺⎿>✻∴▸]) )?/u);
  const leading = match?.[1]?.length ?? 0;
  const glyph = match?.[2] ? 2 : 0;
  return " ".repeat(Math.max(0, Math.min(leading + glyph, cleanWidth - 10)));
}

/** Prefer the last space in the final quarter of the chunk so prose breaks between words. */
function wrapBreakPoint(text: string, limit: number): number {
  if (limit >= text.length) return limit;
  const space = text.lastIndexOf(" ", limit);
  // Prefer a word boundary whenever one exists in the latter 60% of the row —
  // a mid-word "wri/te" break is worse than a slightly ragged edge. Only a
  // genuinely over-long token gets hard-broken.
  return space > limit * 0.4 ? space + 1 : limit;
}

function fitLines(lines: readonly string[], width: number): string[] {
  return lines.map((line) => truncateToWidth(line, width, ""));
}

function padAnsi(value: string, width: number): string {
  return value + " ".repeat(Math.max(0, width - visibleWidth(value)));
}

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-9;]*m/g, "");
}

function accent(text: string): string {
  return color(text, ACCENT_RGB);
}

function highlight(text: string): string {
  return color(text, HIGHLIGHT_RGB);
}

function dim(text: string): string {
  return color(text, MUTED_RGB);
}

function red(text: string): string {
  return color(text, RED_RGB);
}

function color(text: string, rgb: string): string {
  if (process.env.NO_COLOR) return text;
  return `\x1b[38;2;${rgb}m${text}${RESET}`;
}
