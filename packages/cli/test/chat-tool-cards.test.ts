import assert from "node:assert/strict";
import { test } from "node:test";
import { createMusterChatHarness, createNarrationPainter, type MusterChatSink, type NarrationPainter } from "../src/chat-tui.js";

function plain(lines: readonly string[]): string[] {
  return lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));
}

/** A chat whose single turn hands the test a painter wired to the sink, exactly like runChatTurn. */
async function chatWithPainter(extra: Partial<Parameters<typeof createNarrationPainter>[0]> = {}) {
  let release!: () => void;
  let painter!: NarrationPainter;
  let ready!: () => void;
  const started = new Promise<void>((resolve) => { ready = resolve; });
  const chat = createMusterChatHarness({
    onSubmit: (_text: string, sink: MusterChatSink) => new Promise<boolean>((resolve) => {
      painter = createNarrationPainter({ emit: (line) => sink.appendLine(line), block: (id, render) => sink.upsertBlock(id, render), ...extra });
      release = () => resolve(true);
      ready();
    }),
  });
  chat.type("run the tests");
  const turn = chat.submit();
  await started;
  return { chat, painter: () => painter, finish: async () => { painter.finish(); release(); await turn; } };
}

function withNoColor<T>(body: () => Promise<T>): Promise<T> {
  const previous = process.env.NO_COLOR;
  process.env.NO_COLOR = "1";
  return body().finally(() => {
    if (previous === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = previous;
  });
}

// Spec: MUS-SPEC-01-2A (docs/spec/clauses/01-chat-transcript.md#mus-spec-01-2a--a-tool-cell-updates-in-place-from-running-to-finished)
test("a tool cell updates in place from running to finished", () => withNoColor(async () => {
  const { chat, painter, finish } = await chatWithPainter();
  painter().tool({ phase: "start", id: "c1", kind: "command", title: "pytest -q" });
  let text = plain(chat.transcript());
  const headline = text.indexOf("⏺ Bash(pytest -q)");
  assert.ok(headline >= 0, "the running cell is shown");
  assert.equal(text[headline + 1], "  ⎿ running…");
  painter().delta("While that runs, I am reading the config.\n\n");
  painter().flush();
  painter().tool({ phase: "end", id: "c1", kind: "command", title: "pytest -q", exitCode: 0, durationMs: 2000, output: "3 passed in 0.01s" });
  text = plain(chat.transcript());
  assert.equal(text.filter((row) => row.includes("Bash(pytest -q)")).length, 1, "one headline, updated in place");
  const at = text.indexOf("⏺ Bash(pytest -q)");
  assert.equal(at, headline, "the cell keeps its position");
  assert.equal(text[at + 1], "  ⎿ exit 0 · 2.0s");
  assert.equal(text[at + 2], "    3 passed in 0.01s");
  assert.ok(text.findIndex((row) => row.includes("reading the config")) > at + 2, "narration stays below the cell");
  await finish();
}));

// Spec: MUS-SPEC-01-2B (docs/spec/clauses/01-chat-transcript.md#mus-spec-01-2b--ctrlo-expands-and-collapses-tool-output)
test("ctrl+o expands every tool cell and collapses it again", () => withNoColor(async () => {
  const { chat, painter, finish } = await chatWithPainter();
  const output = Array.from({ length: 40 }, (_, index) => `line ${index + 1}`).join("\n");
  painter().tool({ phase: "start", id: "c2", kind: "command", title: "make test" });
  painter().tool({ phase: "end", id: "c2", kind: "command", title: "make test", exitCode: 1, output });
  await finish();
  const collapsed = plain(chat.transcript());
  assert.ok(collapsed.some((row) => /… \+\d+ lines \(ctrl\+o to expand\)/.test(row)));
  assert.ok(!collapsed.includes("    line 1"));
  assert.ok(collapsed.includes("    line 40"));
  chat.input("\x0f");
  const expanded = plain(chat.transcript());
  assert.ok(expanded.includes("    line 1") && expanded.includes("    line 40"), "all output is visible");
  assert.ok(expanded.some((row) => row.includes("ctrl+o to collapse")));
  chat.input("\x0f");
  assert.deepEqual(plain(chat.transcript()), collapsed, "a second press restores the collapsed view");
}));

// Spec: MUS-SPEC-01-3A (docs/spec/clauses/01-chat-transcript.md#mus-spec-01-3a--tool-and-diff-cards-sit-on-a-full-width-band-failures-are-tinted)
test("cards render as full-width bands, failures tinted, separated by a gap", async () => {
  const { renderTranscriptLine, cardRow, CARD_BAND_RGB, CARD_FAILURE_BAND_RGB } = await import("../src/chat-tui.js");
  const previous = process.env.NO_COLOR;
  delete process.env.NO_COLOR;
  try {
    const lines: string[] = [];
    const painter = createNarrationPainter({ emit: (line) => lines.push(line), block: (_id, render) => lines.push(...render(false)) });
    painter.tool({ phase: "end", id: "ok", kind: "command", title: "pytest -q", exitCode: 0, output: "1 passed" });
    painter.tool({ phase: "end", id: "bad", kind: "command", title: "make build", exitCode: 2, failed: true, output: "error: boom" });
    const rows = lines.flatMap((line) => renderTranscriptLine(line, 100, 100));
    const visible = (row: string) => row.replace(/\x1b\[[0-9;]*m/g, "");
    const okRows = rows.filter((_, index) => index >= 1 && index <= 3);
    for (const row of okRows) {
      assert.ok(row.includes(`48;2;${CARD_BAND_RGB}m`), `band on: ${visible(row)}`);
      assert.equal(visible(row).length, 100, "band covers the full width");
    }
    const failRows = rows.filter((row) => visible(row).includes("make build") || visible(row).includes("error: boom"));
    assert.equal(failRows.length, 2);
    for (const row of failRows) assert.ok(row.includes(`48;2;${CARD_FAILURE_BAND_RGB}m`));
    assert.ok(rows.some((row, index) => visible(row).trim() === "" && !row.includes("48;2;") && index > 0), "a gap separates the cards");
    assert.equal(visible(renderTranscriptLine(cardRow("  ⎿ exit 0", "tool"), 100, 100)[0]!).trimEnd(), "  ⎿ exit 0");
  } finally {
    if (previous !== undefined) process.env.NO_COLOR = previous;
  }
});

// Spec: MUS-SPEC-01-2C (docs/spec/clauses/01-chat-transcript.md#mus-spec-01-2c--a-turn-that-ends-with-a-cell-still-open-closes-the-cell)
test("a cell still running when the turn ends is closed as interrupted", () => withNoColor(async () => {
  const { chat, painter, finish } = await chatWithPainter();
  painter().tool({ phase: "start", id: "s1", kind: "command", title: "sleep 30; echo finished" });
  painter().tool({ phase: "start", id: "s2", kind: "command", title: "pytest -q" });
  painter().tool({ phase: "end", id: "s2", kind: "command", title: "pytest -q", exitCode: 0, durationMs: 1000 });
  painter().finish({ interrupted: true });
  let text = plain(chat.transcript());
  assert.equal(text.filter((row) => row.includes("Bash(sleep 30; echo finished)")).length, 1, "one cell, updated in place");
  const at = text.findIndex((row) => row.includes("Bash(sleep 30; echo finished)"));
  assert.equal(text[at + 1], "  ⎿ interrupted");
  assert.ok(!text.some((row) => row.includes("running…")), text.join("\n"));
  assert.ok(text.includes("  ⎿ exit 0 · 1.0s"), "a finished cell is left as it was");

  painter().tool({ phase: "start", id: "s3", kind: "command", title: "make" });
  painter().finish();
  text = plain(chat.transcript());
  const make = text.findIndex((row) => row.includes("Bash(make)"));
  assert.equal(text[make + 1], "  ⎿ no result (the turn ended)");
  await finish();
}));

// Spec: MUS-SPEC-01-2D (docs/spec/clauses/01-chat-transcript.md#mus-spec-01-2d--a-command-the-provider-did-not-time-still-shows-its-time)
test("a command the provider reports as 0 ms shows the time Muster measured", () => withNoColor(async () => {
  let clock = 10_000;
  const { chat, painter, finish } = await chatWithPainter({ now: () => clock });
  painter().tool({ phase: "start", id: "t1", kind: "command", title: "ls" });
  clock += 1_234;
  painter().tool({ phase: "end", id: "t1", kind: "command", title: "ls", exitCode: 0, durationMs: 0, output: "a.txt" });
  painter().tool({ phase: "start", id: "t2", kind: "command", title: "pytest -q" });
  clock += 50;
  painter().tool({ phase: "end", id: "t2", kind: "command", title: "pytest -q", exitCode: 0, durationMs: 19_900 });
  const text = plain(chat.transcript());
  const ls = text.findIndex((row) => row.includes("Bash(ls)"));
  assert.equal(text[ls + 1], "  ⎿ exit 0 · 1.2s", "measured start→end");
  const pytest = text.findIndex((row) => row.includes("Bash(pytest -q)"));
  assert.equal(text[pytest + 1], "  ⎿ exit 0 · 19.9s", "a provider time wins when it has one");
  await finish();
}));

// Spec: MUS-SPEC-01-2E (docs/spec/clauses/01-chat-transcript.md#mus-spec-01-2e--commands-read-as-the-shell-runs-them-and-use-the-terminal-width)
test("command titles drop the wrapper's quoting and use the terminal width", () => withNoColor(async () => {
  const { unwrapShellCommand } = await import("../src/chat-tui.js");
  assert.equal(unwrapShellCommand(String.raw`/bin/zsh -lc "printf 'hello\\n' > hello.txt"`), String.raw`printf 'hello\n' > hello.txt`);
  assert.equal(unwrapShellCommand(String.raw`/bin/zsh -lc "python3 -c 'p=Path(\"data.csv\")'"`), `python3 -c 'p=Path("data.csv")'`);
  assert.equal(unwrapShellCommand(String.raw`/bin/zsh -lc 'echo '\''hi'\'''`), `echo 'hi'`);
  const long = `grep -rn ${"needle".repeat(25)} src`;
  const { chat, painter, finish } = await chatWithPainter({ width: () => 200 });
  painter().tool({ phase: "start", id: "w1", kind: "command", title: `/bin/zsh -lc '${long}'` });
  const text = plain(chat.transcript());
  assert.ok(text.includes(`⏺ Bash(${long})`), "a 168-character command fits a 200-column terminal");
  await finish();
}));

// Spec: MUS-SPEC-01-3B (docs/spec/clauses/01-chat-transcript.md#mus-spec-01-3b--a-long-result-line-is-cut-to-the-width-with-an-ellipsis)
test("a long tool result line is cut to the terminal width with an ellipsis", () => withNoColor(async () => {
  const { renderTranscriptLine, cardRow, formatToolEndLines } = await import("../src/chat-tui.js");
  const output = "File created successfully at: /private/tmp/qafix-claude/note.txt (file state is current in your context — no need to Read it back)";
  const event = { phase: "end" as const, id: "r1", kind: "tool" as const, title: "Read notes", output };
  const collapsed = plain(formatToolEndLines(event, 6, { expandable: true }).flatMap((row) => renderTranscriptLine(cardRow(row), 80, 80)));
  assert.equal(collapsed.length, 2, "head row plus ONE output row");
  assert.ok(collapsed.every((row) => row.length <= 80), collapsed.join("\n"));
  assert.match(collapsed[1]!, /File created successfully at: .*…\s*$/);
  const expanded = formatToolEndLines(event, 6, { expanded: true, expandable: true }).flatMap((row) => renderTranscriptLine(cardRow(row), 80, 80));
  assert.ok(expanded.join(" ").replace(/\s+/g, " ").includes("no need to Read it back"), "ctrl+o shows the whole line, wrapped");
}));
