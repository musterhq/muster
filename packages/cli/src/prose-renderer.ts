import { visibleWidth } from "@earendil-works/pi-tui";

/**
 * The shared semantic paint layer for every conversational surface.
 *
 * This is deliberately a small Markdown renderer rather than a Markdown
 * parser. Chat output needs a stable terminal grammar, no HTML semantics, and
 * no dependency-sized edge-case surface. The supported forms are the forms a
 * model commonly emits: headings, bullets, emphasis, inline code and fenced
 * blocks. Unclosed markup is left as prose instead of deleting user-visible
 * content.
 */

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const ITALIC = "\x1b[3m";
const UNDERLINE = "\x1b[4m";
const DIM = "\x1b[2m";
const ACCENT_RGB = "217;119;87";
const HIGHLIGHT_RGB = "224;175;104";
const MUTED_RGB = "148;144;140";
const VIOLET_RGB = "183;157;219";
const SUCCESS_RGB = "132;176;121";
const FAILURE_RGB = "255;107;122";
const CODE_BG_RGB = "42;40;38";
/**
 * The reference's inline-code purple, PIXEL-SAMPLED from the owner's own
 * Claude Code frame (2026-08-30): #B0B8F8. Truecolor on purpose — the owner's
 * terminal renders indexed 153 as stock sky-blue, which they rejected.
 */
const CODE_SPAN_SGR = "\x1b[38;2;176;184;248m";
/** CC's user-row band is NEUTRAL gray (their 48;5;237): zero warm tinge. */
export const USER_BAND_RGB = "58;58;58";

type BaseStyle = "plain" | "dim";

function enabled(): boolean { return !process.env.NO_COLOR; }
function fg(rgb: string): string { return `\x1b[38;2;${rgb}m`; }
function base(style: BaseStyle): string { return style === "dim" ? `${DIM}${fg(MUTED_RGB)}` : ""; }
function styled(text: string, open: string, restore: string): string {
  return enabled() ? `${open}${text}${RESET}${restore}` : text;
}

/**
 * CommonMark's rule for `_`: emphasis only at word boundaries, so
 * `test_calc.py`, `snake_case_names` and `__init__` stay literal.
 */
function underscoreEmphasis(text: string, index: number, marker: "_" | "__"): RegExpMatchArray | null {
  if (index > 0 && /[\p{L}\p{N}_]/u.test(text[index - 1]!)) return null;
  const pattern = marker === "__" ? /^__([^_\n]+)__/ : /^_([^_\n]+)_/;
  const match = text.slice(index).match(pattern);
  if (!match) return null;
  const after = text[index + match[0].length];
  if (after !== undefined && /[\p{L}\p{N}_]/u.test(after)) return null;
  if (/^\s|\s$/.test(match[1]!)) return null;
  // `__init__`, `__main__`: a dunder name is code, not bold.
  if (marker === "__" && /^\w+$/.test(match[1]!)) return null;
  return match;
}

export interface RenderInlineOptions { readonly base?: BaseStyle }

/** Render inline Markdown plus path, branch, command and URL semantics. */
export function renderInlineProse(text: string, options: RenderInlineOptions = {}): string {
  const baseStyle = options.base ?? "plain";
  if (!text) return text;
  const restore = base(baseStyle);
  let output = enabled() ? restore : "";
  let index = 0;
  while (index < text.length) {
    const rest = text.slice(index);
    let match: RegExpMatchArray | null;
    if ((match = rest.match(/^`([^`\n]+)`/))) {
      // The reference's inline-code identity: the measured indexed color,
      // no background — the ONE sanctioned color for important words.
      output += styled(match[1]!, CODE_SPAN_SGR, restore);
    } else if ((match = rest.match(/^\[([^\]\n]+)\]\(([^)\s]+)\)/))) {
      // [label](target): the label is the fact; the target (often a long
      // absolute path) is noise in a terminal row.
      output += styled(renderInlineProse(match[1]!, { base: baseStyle }), UNDERLINE, restore);
    } else if ((match = rest.match(/^\*\*([^*\n]+)\*\*/)) || (match = underscoreEmphasis(text, index, "__"))) {
      output += styled(renderInlineProse(match[1]!, { base: baseStyle }), BOLD, restore);
    } else if ((match = rest.match(/^\*([^*\n]+)\*/)) || (match = underscoreEmphasis(text, index, "_"))) {
      output += styled(renderInlineProse(match[1]!, { base: baseStyle }), ITALIC, restore);
    } else if ((match = rest.match(/^https?:\/\/[^\s<>()]+/i))) {
      // Owner-ruled 2026-08-29: prose keeps the default foreground. Links get
      // an underline only; paths, branches, and slash-tokens are NOT colored —
      // the old heuristics painted "create/update" and "hybrow/dev" orange.
      output += styled(match[0], UNDERLINE, restore);
    } else {
      output += rest[0];
      index += 1;
      continue;
    }
    index += match[0].length;
  }
  return enabled() ? `${output}${RESET}` : output;
}

export interface RenderProseOptions {
  readonly firstPrefix?: string;
  readonly continuationPrefix?: string;
  readonly continued?: boolean;
}

/** Render the supported Markdown block grammar into terminal rows. */
export function renderProse(text: string, options: RenderProseOptions = {}): string[] {
  const rows = String(text).split(/\r?\n/);
  while (rows.length && !rows[0]!.trim()) rows.shift();
  while (rows.length && !rows[rows.length - 1]!.trim()) rows.pop();
  if (!rows.length) return [];
  const firstPrefix = options.firstPrefix ?? "";
  const continuation = options.continuationPrefix ?? "";
  let first = !options.continued;
  let fence = false;
  const result: string[] = [];
  const put = (body: string): void => {
    result.push(`${first ? firstPrefix : continuation}${body}`);
    first = false;
  };
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const raw = rows[rowIndex]!;
    const fenceMatch = raw.match(/^\s*```\s*([\w.+-]*)\s*$/);
    if (fenceMatch) {
      // No language label row — the reference (Claude Code) marks a code
      // block by its background alone; a floating "text" line is noise.
      fence = !fence;
      continue;
    }
    if (fence) {
      const body = raw || " ";
      put(styled(body, `\x1b[48;2;${CODE_BG_RGB}m`, ""));
      continue;
    }
    // Internal provider directives must never reach a human transcript.
    if (/^:{1,3}codex-annotation\{[^}]*\}\s*$/.test(raw.trim())) continue;
    // Markdown table: a |-row whose next row is the |---|:---| separator.
    if (/^\s*\|.*\|\s*$/.test(raw) && /^\s*\|?[\s:|-]+\|?\s*$/.test(rows[rowIndex + 1] ?? "") && (rows[rowIndex + 1] ?? "").includes("-")) {
      const tableRows: string[] = [raw];
      let cursor = rowIndex + 1;
      while (cursor < rows.length && /^\s*\|.*\|?\s*$/.test(rows[cursor]!) && rows[cursor]!.includes("|")) {
        tableRows.push(rows[cursor]!);
        cursor += 1;
      }
      for (const line of renderProseTable(tableRows)) put(line);
      rowIndex = cursor - 1;
      continue;
    }
    const header = raw.match(/^\s{0,3}#{1,6}\s+(.+)$/);
    if (header) {
      put(styled(renderInlineProse(header[1]!), BOLD, ""));
      continue;
    }
    const bullet = raw.match(/^(\s*)(?:[-+*]|(\d+)\.)\s+(.+)$/);
    if (bullet) {
      // Measured from Claude Code live (2026-08-29): bullets are byte-plain —
      // the literal dash, default foreground, no substitution.
      const marker = bullet[2] ? `${bullet[2]}.` : "-";
      put(`${bullet[1]}${marker} ${renderInlineProse(bullet[3]!)}`);
      continue;
    }
    put(renderInlineProse(raw));
  }
  // A provider can be interrupted inside a fence. We suppress the raw fence
  // marker and retain every code row already received; the stream coalescer is
  // still responsible for never emitting a normally streaming half-fence.
  return result;
}

/**
 * Markdown table → aligned columns, the reference's own idiom: BOLD header
 * cells, a dim rule under them, two-space gutters, cells through the inline
 * renderer. No box glyphs — alignment is the design.
 */
export function renderProseTable(tableRows: readonly string[]): string[] {
  const stripCells = (row: string): string[] =>
    row.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
  const isSeparator = (row: string): boolean => /^\s*\|?[\s:|-]+\|?\s*$/.test(row) && row.includes("-");
  const parsed = tableRows.filter((row) => !isSeparator(row)).map(stripCells);
  if (!parsed.length) return [];
  const columns = Math.max(...parsed.map((cells) => cells.length));
  const plainWidth = (value: string): number => value.replace(/\x1b\[[0-9;]*m/g, "").length;
  const widths = Array.from({ length: columns }, (_, column) =>
    Math.max(...parsed.map((cells) => plainWidth(cells[column] ?? ""))));
  const renderRow = (cells: readonly string[], bold: boolean): string =>
    cells
      .map((cell, column) => {
        const painted = bold ? styled(renderInlineProse(cell), BOLD, "") : renderInlineProse(cell);
        return painted + " ".repeat(Math.max(0, (widths[column] ?? 0) - plainWidth(cell)));
      })
      .join("  ")
      .trimEnd();
  const out: string[] = [renderRow(parsed[0]!, true)];
  const ruleWidth = widths.reduce((sum, width) => sum + width, 0) + (columns - 1) * 2;
  out.push(styled("─".repeat(Math.max(3, ruleWidth)), `${DIM}${fg(MUTED_RGB)}`, ""));
  for (const cells of parsed.slice(1)) out.push(renderRow(cells, false));
  return out;
}

/** Chrome chips stay dim while meaningful tokens retain their semantic tint. */
export function renderChip(text: string): string {
  return renderInlineProse(text, { base: "dim" });
}

/** The one sanctioned violet identity, shared by live and replayed thinking. */
export function renderReasoningLine(text: string): string {
  const clean = text.trim().replace(/\*\*|__|`/g, "").replace(/(^|\s)\*(\S[^*]*\S|\S)\*(?=\s|$)/g, "$1$2");
  const body = `✻ ${clean}`;
  return enabled() ? `${ITALIC}${fg(VIOLET_RGB)}${body}${RESET}` : body;
}

export type MissionStatusTone = "pending" | "running" | "success" | "failure";

export function renderActionBullet(status: "pending" | "success" | "failure" = "pending"): string {
  if (!enabled()) return "⏺";
  const paint = status === "success" ? fg(SUCCESS_RGB) : status === "failure" ? fg(FAILURE_RGB) : `${DIM}${fg(MUTED_RGB)}`;
  return `${paint}⏺${RESET}`;
}

export function missionStatusTone(status: string): MissionStatusTone {
  switch (status) {
    case "in_progress": case "running": case "assigned": case "review": return "running";
    case "done": case "completed": return "success";
    case "blocked": case "failed": case "needs_intervention": case "cancelled": return "failure";
    default: return "pending";
  }
}

/** Cards and transcript task rows share these three glance-readable glyphs. */
export function missionStatusGlyph(status: string): "●" | "◔" | "✖" {
  const tone = missionStatusTone(status);
  return tone === "running" ? "◔" : tone === "failure" ? "✖" : "●";
}

export function renderMissionStatusGlyph(status: string): string {
  const glyph = missionStatusGlyph(status);
  const tone = missionStatusTone(status);
  if (!enabled()) return glyph;
  if (tone === "success") return `${fg(SUCCESS_RGB)}${glyph}${RESET}`;
  if (tone === "failure") return `${fg(FAILURE_RGB)}${glyph}${RESET}`;
  if (tone === "running") return `${fg(ACCENT_RGB)}${glyph}${RESET}`;
  return `${DIM}${fg(MUTED_RGB)}${glyph}${RESET}`;
}

export function formatBoardHeader(taskCount: number): string { return `tasks · ${taskCount}`; }
export const EMPTY_BOARD_COLUMNS = "Backlog · Ready · Running · Review — empty";

export interface HistoryProseRow { readonly role: string; readonly content: string }
export interface PrunedHistory {
  readonly rows: readonly HistoryProseRow[];
  readonly earlier: number;
  readonly trivial: number;
}

function isAssistantGreeting(row: HistoryProseRow): boolean {
  if (row.role !== "assistant") return false;
  const text = row.content.replace(/\s+/g, " ").trim();
  return text.length <= 180
    && /^(?:hi|hello|hey|good (?:morning|afternoon|evening))\b/i.test(text)
    && /(?:what would you like|how can i help|what can i help|ready when you are)/i.test(text);
}

/**
 * Resume is context, not a wall of transcript: retain the last 12 stored
 * messages and represent older or sub-four-character turns once. Selection is
 * done before trivial compaction so replay never silently reaches farther back.
 */
export function pruneHistory(rows: readonly HistoryProseRow[], limit = 12): PrunedHistory {
  const bounded = rows.slice(Math.max(0, rows.length - Math.max(0, limit)));
  const kept: HistoryProseRow[] = [];
  let trivial = 0;
  for (const row of bounded) {
    if (row.content.trim().length < 4) trivial += 1;
    else if (isAssistantGreeting(row) && isAssistantGreeting(kept.at(-1) ?? { role: "", content: "" })) kept[kept.length - 1] = row;
    else kept.push(row);
  }
  return { rows: kept, earlier: Math.max(0, rows.length - bounded.length), trivial };
}

export function formatEarlierHistoryLine(count: number): string {
  return `… ${Math.max(0, Math.trunc(count))} earlier messages — /history for all`;
}

/** Full-row user distinction. Width is visible terminal columns. */
export function bandUserRow(row: string, width: number): string {
  return bandRow(row, width, USER_BAND_RGB);
}

/** Paint one row's full width (padding included) with a background colour. */
export function bandRow(row: string, width: number, rgb: string): string {
  if (!enabled()) return row + " ".repeat(Math.max(0, width - visibleWidth(row)));
  const band = `\x1b[48;2;${rgb}m`;
  // Inline foreground spans reset SGR. Reapply the band after every reset so
  // the user's words and the row padding do not fall back to the terminal's
  // normal background halfway across the line.
  const painted = row.replace(/\x1b\[0m/g, `${RESET}${band}`);
  const padding = " ".repeat(Math.max(0, width - visibleLength(row)));
  return `${band}${painted}${padding}${RESET}`;
}

function stripAnsi(value: string): string { return value.replace(/\u001b\[[0-9;]*m/g, ""); }
function visibleLength(value: string): number { return visibleWidth(value); }
