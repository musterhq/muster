/**
 * Pure terminal-output helpers for the CLI.
 *
 * They live outside index.ts because index.ts IS the entry point — importing it
 * runs `main()`. Everything here is a total function over strings so the guards
 * that keep a one-shot run readable (and keep `--help` from becoming a prompt)
 * can be tested without spawning a process or spending a token.
 */

/**
 * Drop an unbalanced trailing code fence from a final answer.
 *
 * Backends routinely stop a beat early and leave an opening ``` with nothing
 * inside it. A terminal has no markdown renderer, so that prints as a bare
 * fence line and reads as truncated output. Only an ODD number of fences —
 * i.e. one genuinely left open — with nothing after the last one is trimmed; a
 * well-formed answer is returned byte-identical.
 */
export function trimDanglingCodeFence(text: string): string {
  const fences = text.match(/^[ \t]*`{3,}.*$/gm);
  if (!fences || fences.length % 2 === 0) return text;
  return text.replace(/\n?[ \t]*`{3,}[^\n`]*\s*$/, "");
}

/**
 * Usage lines for one command, lifted from the master help text.
 *
 * Derived rather than duplicated: a command's help can never drift from the
 * table `muster --help` prints, because it IS that table, filtered.
 */
export function commandUsageLines(helpText: string, name: string): readonly string[] {
  const pattern = new RegExp(`^\\s+muster ${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\s|$)`);
  return helpText.split("\n").filter((line) => pattern.test(line));
}

/** One line of at most `max` characters: whole when it fits, else cut at the last word and ended with `…`. */
export function cutAtWord(value: string, max: number): string {
  const text = value.replace(/\s+/g, " ").trim();
  if (text.length <= max) return text;
  let cut = text.slice(0, max - 1);
  if (text[max - 1] !== " ") {
    const space = cut.lastIndexOf(" ");
    if (space > max / 2) cut = cut.slice(0, space);
  }
  return `${cut.trimEnd()}…`;
}

/**
 * A stored ISO time in the viewer's zone with a zone marker: `12:52:44 GMT+5:30`,
 * with the date in front when it is not today.
 */
export function formatLocalTimestamp(iso: string, options: { readonly timeZone?: string; readonly now?: number } = {}): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  const parts = (date: Date) => Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: options.timeZone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23", timeZoneName: "short",
  }).formatToParts(date).map((part) => [part.type, part.value]));
  const p = parts(at);
  const today = parts(new Date(options.now ?? Date.now()));
  const day = `${p.year}-${p.month}-${p.day}`;
  const time = `${p.hour}:${p.minute}:${p.second} ${p.timeZoneName}`;
  return day === `${today.year}-${today.month}-${today.day}` ? time : `${day} ${time}`;
}
