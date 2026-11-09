import assert from "node:assert/strict";
import { test } from "node:test";
import { createMusterChatHarness, createNarrationPainter, type MusterChatSink, type NarrationPainter } from "../src/chat-tui.js";

function plain(lines: readonly string[]): string[] {
  return lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));
}

/** A chat whose single turn hands the test a painter wired to the sink, exactly like runChatTurn. */
async function chatWithPainter() {
  let release!: () => void;
  let painter!: NarrationPainter;
  let ready!: () => void;
  const started = new Promise<void>((resolve) => { ready = resolve; });
  const chat = createMusterChatHarness({
    onSubmit: (_text: string, sink: MusterChatSink) => new Promise<boolean>((resolve) => {
      painter = createNarrationPainter({ emit: (line) => sink.appendLine(line), block: (id, render) => sink.upsertBlock(id, render) });
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
