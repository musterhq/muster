/**
 * Terminal live inline diff — the chat turn SHOWS every file change as it lands.
 *
 * docs/STRATEGY_V2.md §2.2 measured backend self-report firing ZERO
 * `item/fileChange/patchUpdated` events across three live Codex turns while all
 * three edits hit disk; §9 then proved `createWorkspaceObserver` catches the
 * same edits in 86ms with deterministic receipts. This module is the terminal
 * surface for that observer: each WorkspacePatchEvent becomes a diff card
 * appended to the live transcript WHILE the turn streams — not a summary
 * printed after it.
 *
 * THREE RULES, enforced everywhere below:
 *
 * 1. RENDERING IS PURE. `renderLiveDiffCard`/`renderLiveDiffSummary` take an
 *    event plus an elapsed number and return lines. No observer, no clock, no
 *    terminal, no process state beyond the NO_COLOR default. That is what makes
 *    the card snapshot-testable without a repo.
 *
 * 2. THE FEED NEVER FAILS A TURN. A non-git cwd, a missing git binary, a
 *    throwing sink, a listener that explodes mid-render — every one of them
 *    degrades to at most one dim notice line and the turn proceeds untouched.
 *    An audit surface that can block the work it audits does not ship.
 *
 * 3. LIVE MEANS DURING. Cards are emitted from `onPatch`, which the observer
 *    calls from its own detection cycle, so they interleave with the model's
 *    output. `finish()` only flushes the tail and totals.
 */

import {
  createWorkspaceObserver,
  matchesIgnore,
  WorkspaceObserverError,
  type IgnoreMatcher,
  type WorkspaceObserver,
  type WorkspaceObserverOptions,
  type WorkspacePatchEvent,
} from "@musterhq/core";
// Glyphs and the receipt shortener are owned by the transcript idiom so a diff
// card and a tool result can never drift apart (chat-tui.ts, "TRANSCRIPT IDIOM").
import { RESULT_ELBOW, TOOL_BULLET, shortReceipt } from "./chat-tui.js";

/* ---------- palette (banner.ts / chat-tui.ts, same dark-console values) ---------- */

const RESET = "\x1b[0m";
const ACCENT_RGB = "217;119;87";
const ADD_RGB = "138;154;91";
const DEL_RGB = "255;107;122";
const MUTED_RGB = "148;144;140";

/** Beyond this many rendered hunk lines a card truncates with "… n more lines". */
export const LIVE_DIFF_MAX_LINES = 40;

/**
 * The harness's own bookkeeping is never the turn's work. When the session cwd
 * contains a project-local `.muster/` data dir, every turn appends run records,
 * session handles, memory rows and logs under it — live-proven 2026-08-27: the
 * `.muster/data/tokens.jsonl` card leaked the raw `{"runId"…}` ledger line into
 * the transcript (re-opening defect #1 through the diff feed) and inflated the
 * summary to "8 file(s) changed" when the model touched two. Matching uses the
 * core `matchesIgnore` segment rule, so a nested `.muster` dir is skipped too.
 */
export const LIVE_DIFF_INTERNAL_IGNORE: readonly string[] = [".muster"];

/**
 * Build and tool caches that running code writes as a side effect. They are not
 * the agent's edits, so they never become cards even in a repo without a
 * .gitignore (a pytest run otherwise reported two .pyc "edits").
 */
export const LIVE_DIFF_ARTIFACT_IGNORE: readonly string[] = [
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  "node_modules",
  ".DS_Store",
];

function isBuildArtifact(path: string): boolean {
  return matchesIgnore(path, LIVE_DIFF_ARTIFACT_IGNORE) || /\.py[co]$/.test(path);
}

/** True when the feed must not render this event (harness-internal path or build artifact). */
export function isLiveDiffInternalPath(path: string | null | undefined): boolean {
  return typeof path === "string" && (matchesIgnore(path, LIVE_DIFF_INTERNAL_IGNORE) || isBuildArtifact(path));
}

export interface LiveDiffStat {
  readonly additions: number;
  readonly deletions: number;
}

export interface LiveDiffTotals extends LiveDiffStat {
  readonly files: number;
}

export interface LiveDiffRenderOptions {
  /** Hunk lines kept before truncation. Default LIVE_DIFF_MAX_LINES. */
  readonly maxLines?: number;
  /** ANSI on/off. Default: on unless NO_COLOR is set (chat-tui.ts convention). */
  readonly color?: boolean;
  /** Milliseconds from turn start to detection; omitted when unknown. */
  readonly elapsedMs?: number;
}

/* ---------- pure rendering ---------- */

/**
 * Counts a unified diff the way `git diff --numstat` does: `+`/`-` lines that
 * are not the `+++`/`---` file headers. `\ No newline at end of file` is
 * metadata, never a change.
 */
export function countDiffStat(diff: string | null | undefined): LiveDiffStat {
  if (!diff) return { additions: 0, deletions: 0 };
  let additions = 0;
  let deletions = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) additions += 1;
    else if (line.startsWith("-")) deletions += 1;
  }
  return { additions, deletions };
}

/** The path a card shows: renames read `old → new`, everything else is the path. */
export function liveDiffPathLabel(event: Pick<WorkspacePatchEvent, "path" | "previousPath" | "changeKind">): string {
  if (event.changeKind === "rename" && event.previousPath) return `${event.previousPath} → ${event.path}`;
  return event.path;
}

/**
 * One diff card in the transcript's action idiom (chat-tui.ts):
 *
 *   ⏺ Edit(src/run.ts)
 *     ⎿ +2 −1 · 86ms · receipt d3b9c1a2…
 *       @@ -1,4 +1,5 @@
 *
 * The BODY renderer is unchanged — the same hunk lines, the same colors, the
 * same truncation — only the frame is the shared ⏺/⎿ one, so a diff card and a
 * tool result read as the same kind of thing.
 */
export function renderLiveDiffCard(event: WorkspacePatchEvent, options: LiveDiffRenderOptions = {}): readonly string[] {
  const paint = colorEnabled(options.color);
  const maxLines = Math.max(1, options.maxLines ?? LIVE_DIFF_MAX_LINES);
  const stat = countDiffStat(event.diff);
  const lines = [renderLiveDiffHeader(event, stat, options), renderLiveDiffResult(event, stat, options)];

  if (event.diff === null || event.diff === undefined) {
    lines.push(tint(`    diff omitted: ${event.diffOmitted ?? "unavailable"}`, MUTED_RGB, paint));
    return lines;
  }

  const body = diffBodyLines(event.diff);
  if (!body.length) {
    lines.push(tint(`    ${changeKindNote(event.changeKind)}`, MUTED_RGB, paint));
    return lines;
  }

  const numbered = numberDiffRows(body);
  const gutter = Math.max(2, ...numbered.map((row) => String(row.number ?? "").length));
  for (const row of numbered.slice(0, maxLines)) lines.push(`    ${renderNumberedDiffRow(row, gutter, paint)}`);
  if (body.length > maxLines) lines.push(tint(`    … +${body.length - maxLines} lines`, MUTED_RGB, paint));
  return lines;
}

/** `⏺ Edit(src/run.ts)` — the action headline; the glyph is tinted by kind. */
export function renderLiveDiffHeader(
  event: Pick<WorkspacePatchEvent, "path" | "previousPath" | "changeKind">,
  _stat: LiveDiffStat,
  options: LiveDiffRenderOptions = {},
): string {
  const paint = colorEnabled(options.color);
  const marker = tint(TOOL_BULLET, markerRgb(event.changeKind), paint);
  return `${marker} ${liveDiffToolName(event.changeKind)}(${liveDiffPathLabel(event)})`;
}

/** `  ⎿ +2 −1 · 86ms · receipt d3b9c1a2…` — one dim row, every fact kept. */
export function renderLiveDiffResult(
  event: Pick<WorkspacePatchEvent, "receiptHash" | "binary">,
  stat: LiveDiffStat,
  options: LiveDiffRenderOptions = {},
): string {
  const paint = colorEnabled(options.color);
  const segments = [renderStatSegment(stat, paint)];
  if (event.binary) segments.push(tint("binary", MUTED_RGB, paint));
  if (options.elapsedMs !== undefined && Number.isFinite(options.elapsedMs)) {
    segments.push(tint(`${Math.max(0, Math.round(options.elapsedMs))}ms`, MUTED_RGB, paint));
  }
  if (event.receiptHash) segments.push(tint(`receipt ${shortReceipt(event.receiptHash)}`, MUTED_RGB, paint));
  return `  ${tint(RESULT_ELBOW, MUTED_RGB, paint)} ${segments.join(tint(" · ", MUTED_RGB, paint))}`;
}

/** Turn-end receipt: `▸ 2 files changed · +12 −4` (pinned when the turn overflows). */
export function renderLiveDiffSummary(totals: LiveDiffTotals, options: { readonly color?: boolean } = {}): string {
  const paint = colorEnabled(options.color);
  const label = `${totals.files} file${totals.files === 1 ? "" : "s"} changed`;
  return `${tint(`▸ ${label} · `, MUTED_RGB, paint)}${renderStatSegment(totals, paint)}`;
}

/** The verb a change kind reads as in the action headline. */
export function liveDiffToolName(kind: WorkspacePatchEvent["changeKind"]): string {
  switch (kind) {
    case "add":
      return "Create";
    case "delete":
      return "Delete";
    case "rename":
      return "Rename";
    default:
      return "Edit";
  }
}

/** The single dim line a degraded feed is allowed to print. */
export function renderLiveDiffNotice(reason: string, options: { readonly color?: boolean } = {}): string {
  return tint(`live diff off: ${reason}`, MUTED_RGB, colorEnabled(options.color));
}

/** Maps a start() failure onto a short human reason. Never throws. */
export function describeLiveDiffFailure(error: unknown): string {
  if (error instanceof WorkspaceObserverError) {
    switch (error.code) {
      case "not_a_git_repository":
        return "not a git repository";
      case "git_unavailable":
        return "git is unavailable";
      case "root_not_found":
      case "root_not_directory":
        return "workspace directory is unavailable";
      default:
        return error.message;
    }
  }
  if (error instanceof Error && error.message) return error.message;
  return "workspace observer unavailable";
}

/* ---------- live feed ---------- */

export interface LiveDiffFeedOptions {
  /** Session cwd. May be any directory inside the repo; event paths stay toplevel-relative. */
  readonly cwd: string;
  /** Sink for one rendered line. Wrapped in try/catch — a throwing sink cannot fail the turn. */
  readonly emit: (line: string) => void;
  /** false ⇒ fully inert and SILENT (the user asked for it off; no notice). Default true. */
  readonly enabled?: boolean;
  readonly maxLines?: number;
  readonly color?: boolean;
  /** Injectable clock (stream.ts precedent). Default Date.now. */
  readonly now?: () => number;
  /** Observer knobs for tests (pollMs: 0, watch: false give a deterministic feed). */
  readonly observerOptions?: Partial<Omit<WorkspaceObserverOptions, "root" | "onPatch">>;
  /** Seam for tests; defaults to the real createWorkspaceObserver. */
  readonly createObserver?: (options: WorkspaceObserverOptions) => WorkspaceObserver;
  /** Parallel consumer for Canvas state; failures never affect cards or turns. */
  readonly onPatch?: (event: WorkspacePatchEvent) => void;
}

export interface LiveDiffFeed {
  /** false ⇒ disabled or degraded; finish() is then a no-op returning zero totals. */
  readonly active: boolean;
  /** Flushes the tail (late edits still render), stops the observer, emits the summary. */
  finish(): Promise<LiveDiffTotals>;
}

const ZERO_TOTALS: LiveDiffTotals = { files: 0, additions: 0, deletions: 0 };

function inertFeed(): LiveDiffFeed {
  return { active: false, finish: async () => ZERO_TOTALS };
}

/**
 * Attaches the workspace observer for one chat turn. Resolves with a feed whose
 * `active` flag says whether cards will actually stream; it NEVER rejects.
 */
export async function startLiveDiffFeed(options: LiveDiffFeedOptions): Promise<LiveDiffFeed> {
  if (options.enabled === false) return inertFeed();
  const now = options.now ?? Date.now;
  const startedAt = now();
  const render: LiveDiffRenderOptions = { color: options.color, maxLines: options.maxLines };

  const emit = (line: string): void => {
    try {
      options.emit(line);
    } catch {
      /* a broken sink must never escalate into a failed turn */
    }
  };

  const touched = new Set<string>();
  let additions = 0;
  let deletions = 0;
  let finished = false;

  const onPatch = (event: WorkspacePatchEvent): void => {
    if (finished) return;
    // Guarded here as well as via the observer's ignore option so the rule
    // holds even for injected observers (createObserver seam) that never
    // consult observerOptions.ignore.
    if (isLiveDiffInternalPath(event.path) || isLiveDiffInternalPath(event.previousPath)) return;
    try {
      try {
        options.onPatch?.(event);
      } catch {
        /* Canvas is additive; its accumulator cannot break transcript cards. */
      }
      const stat = countDiffStat(event.diff);
      touched.add(event.path);
      additions += stat.additions;
      deletions += stat.deletions;
      for (const line of renderLiveDiffCard(event, { ...render, elapsedMs: detectionElapsedMs(event, startedAt, now) })) {
        emit(line);
      }
    } catch {
      /* rule 2: a render bug loses a card, never the turn */
    }
  };

  let observer: WorkspaceObserver | undefined;
  try {
    observer = (options.createObserver ?? createWorkspaceObserver)({
      ...(options.observerOptions ?? {}),
      ignore: mergeIgnoreMatchers((path: string) => isLiveDiffInternalPath(path), options.observerOptions?.ignore),
      root: options.cwd,
      onPatch,
    });
    await observer.start();
  } catch (error) {
    // A half-started observer still owns a shadow tree; hand it back before
    // walking away, then say so in exactly one line.
    finished = true;
    await observer?.stop().catch(() => {});
    emit(renderLiveDiffNotice(describeLiveDiffFailure(error), { color: options.color }));
    return inertFeed();
  }
  const attached = observer;

  return {
    active: true,
    async finish(): Promise<LiveDiffTotals> {
      if (finished) return { files: touched.size, additions, deletions };
      // Flush BEFORE latching `finished`: an edit that landed in the last
      // debounce window is still this turn's work and still deserves a card.
      try {
        await attached.flush();
      } catch {
        /* a flush failure costs the tail card, never the summary */
      }
      finished = true;
      try {
        await attached.stop();
      } catch {
        /* stop is idempotent and best-effort */
      }
      const totals: LiveDiffTotals = { files: touched.size, additions, deletions };
      if (totals.files > 0) emit(renderLiveDiffSummary(totals, { color: options.color }));
      return totals;
    },
  };
}

/* ---------- internals ---------- */

/** The feed's internal exclusions plus whatever the caller asked to skip. */
function mergeIgnoreMatchers(base: IgnoreMatcher, extra: IgnoreMatcher | undefined): IgnoreMatcher {
  if (!extra) return base;
  return (relPath) => matchesIgnore(relPath, base) || matchesIgnore(relPath, extra);
}

/**
 * The card's latency is turn-relative: how long after the turn started this
 * change became visible. `atIso` is the observer's own detection stamp, so the
 * number stays honest even if rendering is queued behind other output.
 */
function detectionElapsedMs(event: WorkspacePatchEvent, startedAt: number, now: () => number): number {
  const detected = Date.parse(event.atIso);
  const at = Number.isFinite(detected) ? detected : now();
  return Math.max(0, at - startedAt);
}

/**
 * Drops the `diff --git`/`index`/`---`/`+++` preamble: the card header already
 * names the file. A diff with no `@@` at all (a synthesized rename, a binary
 * marker) keeps only its meaningful metadata lines.
 */
function diffBodyLines(diff: string): readonly string[] {
  const lines = diff.split("\n");
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  const firstHunk = lines.findIndex((line) => line.startsWith("@@"));
  if (firstHunk >= 0) return lines.slice(firstHunk);
  return lines.filter(isMeaningfulMetaLine);
}

function isMeaningfulMetaLine(line: string): boolean {
  return line.startsWith("rename from ")
    || line.startsWith("rename to ")
    || line.startsWith("Binary files ")
    || line.startsWith("old mode ")
    || line.startsWith("new mode ");
}

interface NumberedDiffRow {
  readonly line: string;
  /** New-file number for context and additions, old-file number for removals; absent for headers and notes. */
  readonly number?: number;
}

/** Walk the hunks, numbering rows from each `@@ -a,b +c,d @@` header. */
function numberDiffRows(body: readonly string[]): NumberedDiffRow[] {
  let oldLine = 0;
  let newLine = 0;
  return body.map((line) => {
    const hunk = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      return { line };
    }
    if (line.startsWith("+")) return { line, number: newLine++ };
    if (line.startsWith("-")) return { line, number: oldLine++ };
    if (line.startsWith(" ")) {
      oldLine += 1;
      return { line, number: newLine++ };
    }
    return { line };
  });
}

/** `  10 + const added = 2;` — dim number, coloured sign and code. Headers and notes render as before. */
function renderNumberedDiffRow(row: NumberedDiffRow, gutter: number, paint: boolean): string {
  if (row.number === undefined) return paintDiffLine(row.line, paint);
  const sign = row.line[0] === " " ? " " : row.line[0]!;
  const code = row.line.slice(1);
  const number = tint(String(row.number).padStart(gutter), MUTED_RGB, paint);
  return `${number} ${paintDiffLine(`${sign} ${code}`, paint)}`;
}

function paintDiffLine(line: string, paint: boolean): string {
  if (line.startsWith("@@")) return tint(line, ACCENT_RGB, paint);
  if (line.startsWith("+")) return tint(line, ADD_RGB, paint);
  if (line.startsWith("-")) return tint(line, DEL_RGB, paint);
  if (line.startsWith("\\") || isMeaningfulMetaLine(line)) return tint(line, MUTED_RGB, paint);
  return line;
}

/** `+2 −1` — signed counts keep their colors; the frame around them is dim. */
function renderStatSegment(stat: LiveDiffStat, paint: boolean): string {
  const adds = tint(`+${stat.additions}`, ADD_RGB, paint);
  const dels = tint(`−${stat.deletions}`, DEL_RGB, paint);
  return `${adds} ${dels}`;
}

function markerRgb(kind: WorkspacePatchEvent["changeKind"]): string {
  if (kind === "add") return ADD_RGB;
  if (kind === "delete") return DEL_RGB;
  return ACCENT_RGB;
}

function changeKindNote(kind: WorkspacePatchEvent["changeKind"]): string {
  switch (kind) {
    case "add":
      return "new empty file";
    case "delete":
      return "file deleted";
    case "rename":
      return "renamed, contents unchanged";
    default:
      return "metadata only";
  }
}

function colorEnabled(explicit: boolean | undefined): boolean {
  if (explicit !== undefined) return explicit;
  return !process.env.NO_COLOR;
}

function tint(text: string, rgb: string, paint: boolean): string {
  if (!paint) return text;
  return `\x1b[38;2;${rgb}m${text}${RESET}`;
}
