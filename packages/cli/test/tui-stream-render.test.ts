import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildCompactHeaderLines,
  compactCount,
  createMusterChatHarness,
  createNarrationPainter,
  formatAssistantBlock,
  formatCostChip,
  formatDuration,
  formatReasoningLine,
  formatRecallChip,
  formatStatusLine,
  formatWorkingIndicator,
  isExitCommand,
  isWorkingStatusLine,
  parseRunRecordLine,
  renderTranscriptWindow,
  routeEngineLine,
  unwrapShellCommand,
} from "../src/chat-tui.js";
import { renderLiveDiffCard } from "../src/live-diff.js";

function stripAnsi(value: string): string {
  return value.replace(/\x1b\[[0-9;]*m/g, "");
}

function plain(lines: readonly string[]): string[] {
  return lines.map(stripAnsi);
}

const commands = [
  { name: "help", usage: "/help", description: "show full chat help" },
  { name: "exit", usage: "/exit", description: "leave chat", aliases: ["quit", "q"] },
] as const;

// A real record from packages/core/src/tokens.ts (buildTokenRecord output).
const RUN_RECORD = {
  runId: "run_01K9Z0V4E5",
  createdAt: "2026-08-27T09:14:02.118Z",
  provider: "codex",
  model: "gpt-5.6-sol",
  inputTokens: 25087,
  cachedInputTokens: 23040,
  outputTokens: 512,
  estimated: false,
  promptChars: 4820,
  recalledChars: 311,
  responseChars: 1902,
  sessionMode: "continue",
  sessionId: "thread_7712",
  durationMs: 12440,
  costUsd: 0.0337,
};

// ── Defect #3: streamed narration ───────────────────────────────────────────

test("narration painter paints assistant deltas incrementally instead of one lump", () => {
  const painted: string[] = [];
  const painter = createNarrationPainter({ emit: (line) => painted.push(line), minChars: 24, maxChars: 120 });

  const deltas = [
    "Reading the gateway config",
    " to find where the ingress spool is flushed.\n",
    "Found it: `ingress-spool.ts` owns the delivery state machine",
    " and the lease is renewed every 30s.\n",
    "Next I will add the backpressure counter.",
  ];

  const growth: number[] = [];
  for (const delta of deltas) {
    painter.delta(delta);
    growth.push(painted.length);
  }

  assert.ok(growth.at(-2)! > 0, "text must reach the transcript BEFORE the turn ends");
  assert.ok(growth[0] < growth.at(-1)!, "the transcript grows as deltas arrive");
  painter.finish();

  const transcript = plain(painted).join("\n");
  assert.match(transcript, /Reading the gateway config/);
  assert.match(transcript, /backpressure counter/);
  assert.equal(painter.painted > 0, true);
});

test("narration painter never splits a markdown code fence mid-block", () => {
  const painted: string[] = [];
  const painter = createNarrationPainter({ emit: (line) => painted.push(line), minChars: 16, maxChars: 48 });
  painter.delta("Here is the patch:\n\n```ts\n");
  painter.delta("const lease = renewLease(nodeId, fencingToken);\nawait spool.flush();\n");
  painter.delta("```\nThat closes the gap.\n");
  painter.finish();

  const transcript = plain(painted).join("\n");
  const fences = (transcript.match(/```/g) ?? []).length;
  assert.equal(fences % 2, 0, `code fences must stay balanced, saw ${fences}`);
  assert.match(transcript, /const lease = renewLease/);
});

test("narration painter heuristically separates sentence-start deltas after terminal punctuation", () => {
  const painted: string[] = [];
  const painter = createNarrationPainter({ emit: (line) => painted.push(line), minChars: 200, maxChars: 400 });
  painter.delta("The suite is green now.");
  painter.delta("Tests pass without a join.");
  painter.finish();
  const lines = plain(painted);
  assert.deepEqual(lines, ["● The suite is green now.", "  ", "  Tests pass without a join."]);
});

test("reasoning summaries render violet italic with a sparkle above the message they explain", () => {
  const painted: string[] = [];
  const painter = createNarrationPainter({ emit: (line) => painted.push(line), minChars: 8, maxChars: 64 });
  painter.reasoning("Checking whether the spool lease is renewed.\n");
  painter.delta("The lease renews every 30 seconds.\n");
  painter.finish();

  const reasoningIndex = painted.findIndex((line) => stripAnsi(line).includes("Checking whether"));
  const messageIndex = painted.findIndex((line) => stripAnsi(line).includes("The lease renews"));
  assert.ok(reasoningIndex >= 0 && messageIndex >= 0);
  assert.ok(reasoningIndex < messageIndex, "reasoning must render above the message");
  assert.match(stripAnsi(painted[reasoningIndex]), /^✻ /);
  if (!process.env.NO_COLOR) {
    assert.ok(painted[reasoningIndex].includes("\x1b[3m"), "reasoning renders italic");
    assert.ok(formatReasoningLine("x").includes("183;157;219"), "reasoning uses the sanctioned violet");
  }
});

// ── Defect #1: cost chip instead of raw run-record JSON ─────────────────────

test("cost chip formats a real token record as one line", () => {
  const chip = stripAnsi(formatCostChip(RUN_RECORD));
  assert.equal(chip.includes("\n"), false, "the cost chip is exactly one line");
  assert.match(chip, /^▸ gpt-5\.6-sol · 25\.1k in · 23\.0k cached · 512 out · \$0\.0337 · 12\.4s$/);
});

test("cost chip marks estimated counts and omits absent fields", () => {
  const chip = stripAnsi(formatCostChip({ model: "claude-fable-5", inputTokens: 900, outputTokens: 120, estimated: true, durationMs: 840 }));
  assert.equal(chip, "▸ claude-fable-5 · 900~ in · 120~ out · 840ms");
});

test("raw run-record JSON is routed to a cost chip, never printed verbatim", () => {
  const route = routeEngineLine(JSON.stringify(RUN_RECORD));
  assert.equal(route.kind, "cost");
  if (route.kind !== "cost") throw new Error("unreachable");
  assert.equal(route.runId, RUN_RECORD.runId);
  assert.equal(route.log, JSON.stringify(RUN_RECORD));
  assert.doesNotMatch(stripAnsi(route.chip), /runId|inputTokens|costUsd/);
});

test("run-record parsing stays strict so model JSON answers are still painted", () => {
  assert.equal(parseRunRecordLine('{"answer":"ok"}'), undefined);
  assert.equal(parseRunRecordLine('{"runId":"r1"}'), undefined);
  assert.equal(parseRunRecordLine("not json at all"), undefined);
  assert.equal(routeEngineLine('{"answer": 42, "note": "here is JSON you asked for"}').kind, "transcript");
});

// ── Defect #2: diagnostics leave the transcript ─────────────────────────────

test("memory diagnostics are suppressed in TTY mode and replaced by a recall chip", () => {
  const route = routeEngineLine("memory backend=sqlite-fts5 recalled=1 candidates=1 scopes=user:goblin,tenant:f2");
  assert.equal(route.kind, "diagnostic");
  if (route.kind !== "diagnostic") throw new Error("unreachable");
  assert.equal(stripAnsi(route.chip ?? ""), "▸ recalled 1 memory");
  assert.match(route.log, /^memory backend=sqlite-fts5/, "the raw line still reaches the session log");
});

test("a zero-recall diagnostic shows nothing at all", () => {
  const route = routeEngineLine("memory backend=sqlite-fts5 recalled=0 candidates=0 scopes=user:goblin");
  assert.equal(route.kind, "diagnostic");
  if (route.kind !== "diagnostic") throw new Error("unreachable");
  assert.equal(route.chip, undefined);
  assert.equal(stripAnsi(formatRecallChip("memory backend=x recalled=2 candidates=9") ?? ""), "▸ recalled 2 memories");
});

test("recall receipt detail lines and timing dumps never reach the transcript", () => {
  assert.equal(routeEngineLine("  mem_8f21 score=0.812 lexical+scope match").kind, "diagnostic");
  const timings = routeEngineLine("timings total=8335ms provider=8259ms transport=warm first_token_ms=180 recall=11ms");
  assert.equal(timings.kind, "diagnostic");
  if (timings.kind !== "diagnostic") throw new Error("unreachable");
  assert.equal(stripAnsi(timings.chip ?? ""), "▸ 8.3s total · 8.3s provider · first token 180ms");
});

test("ordinary assistant text is left exactly as written", () => {
  const line = "  const token = getBearerToken(req);";
  const route = routeEngineLine(line);
  assert.equal(route.kind, "transcript");
  if (route.kind !== "transcript") throw new Error("unreachable");
  assert.equal(route.line, line, "content passes through byte-for-byte");
});

// ── Defect #4: the spinner owns one row ─────────────────────────────────────

test("spinner frames are classified as status, never transcript", () => {
  for (let frame = 0; frame < 8; frame += 1) {
    assert.equal(routeEngineLine(formatWorkingIndicator(undefined, frame)).kind, "status");
    assert.equal(routeEngineLine(formatWorkingIndicator("review", frame)).kind, "status");
  }
  assert.equal(isWorkingStatusLine("| working"), true);
  assert.equal(isWorkingStatusLine("still working on the migration"), false);
});

test("a spinner frame appended to the transcript sink lands on the status row instead", async () => {
  let statusDuringTurn = "";
  const harness = createMusterChatHarness({
    commands,
    toolsets: [],
    recentSessions: () => [],
    agents: async () => [],
    onSubmit: async (_text, sink) => {
      for (let frame = 0; frame < 6; frame += 1) sink.appendLine(formatWorkingIndicator(undefined, frame));
      statusDuringTurn = stripAnsi(harness.status());
      sink.appendLine("done streaming the answer");
      return true;
    },
  });

  harness.type("edit the limiter");
  await harness.submit();

  const transcript = plain(harness.transcript());
  assert.equal(transcript.some((line) => line.includes("working")), false, "no spinner frame in scrollback");
  assert.ok(transcript.some((line) => line.includes("done streaming the answer")));
  assert.match(statusDuringTurn, /Thinking/, "the spinner lives on the single status row");
  assert.equal(harness.status(), "", "and it is cleared when the turn ends");
});

// ── Defect #5: /exit routing inside the TUI ─────────────────────────────────

test("exit commands are routed by the TUI itself", async () => {
  for (const text of ["/exit", "/quit", "/q", " /EXIT "]) {
    assert.equal(isExitCommand(text), true, `${text} should exit`);
  }
  assert.equal(isExitCommand("/exit-survey"), false);

  let submits = 0;
  const harness = createMusterChatHarness({
    commands,
    toolsets: [],
    recentSessions: () => [],
    agents: async () => [],
    onSubmit: async () => {
      submits += 1;
      return true; // A handler that never asks to stop must not trap the user.
    },
  });

  harness.type("/exit");
  await harness.submit();
  assert.equal(harness.exited(), true, "/exit must reach the bye path from the TUI");
  assert.equal(submits, 0, "exit is routed before the command handler");
});

// ── Defect #6: compact launch header ────────────────────────────────────────

test("compact launch header is ONE line: model once, session, path, help — nothing else", () => {
  const lines = buildCompactHeaderLines({
    session: "main",
    cwd: "~/code/muster",
    scopes: "user:goblin, tenant:f2",
    model: "gpt-5.6-sol",
    provider: "codex",
    runtime: "native",
    speed: "session",
  });

  assert.equal(lines.length, 1, `idle chrome is exactly one line, saw ${lines.length}`);
  const text = plain(lines).join("\n");
  assert.match(text, /MUSTER · gpt-5\.6-sol · main · ~\/code\/muster · \/help/);
  // The model is stated here and ONLY here while idle; provider/runtime/speed/
  // scopes belong to /status, and no second hint line exists.
  assert.doesNotMatch(text, /codex · native|speed session|scopes|@agent|\/header/);
});

// ── the transcript must show exactly what the model said ────────────────────

test("wrapping a streamed sentence never drops characters", () => {
  const sentence = "Looking at the gateway now. The spool owns a delivery state machine and renews its lease every 30 seconds without dropping a single queued message.";
  const rendered = plain(renderTranscriptWindow([sentence], 80, 20));

  assert.ok(rendered.length > 1, "the sentence must actually wrap");
  assert.equal(rendered.join(""), sentence, "every character survives the wrap");
  assert.equal(rendered.some((line) => line.includes("\x1b")), false, "no stray escape leaks into a wrapped row");
});

test("a wrapped block keeps its gutter column instead of restarting at column zero", () => {
  const block = formatAssistantBlock(
    "Rewriting the bearer-token lookup so the missing-token case is handled by the shared helper rather than by each route in turn.",
  );
  const rendered = plain(renderTranscriptWindow(block, 60, 20));

  assert.ok(rendered.length > 2, "the block must actually wrap");
  assert.match(rendered[0] ?? "", /^● Rewriting/);
  for (const row of rendered.slice(1)) {
    assert.match(row, /^ {2}\S/, `a continuation hangs under the bullet: ${JSON.stringify(row)}`);
  }
  assert.equal(
    rendered.map((row, index) => (index === 0 ? row.slice(2) : row.slice(2))).join(""),
    "Rewriting the bearer-token lookup so the missing-token case is handled by the shared helper rather than by each route in turn.",
    "the hanging indent is styling: not one character of the sentence is added or lost",
  );
});

test("an indented result row wraps into its own column, under the elbow", () => {
  const rendered = plain(renderTranscriptWindow(
    ["  ⎿ 3 matches · 42ms · receipt d3b9c1a2… · the summary keeps going well past the right edge of this window"],
    56,
    20,
  ));
  assert.match(rendered[0] ?? "", /^ {2}⎿ /);
  for (const row of rendered.slice(1)) assert.match(row, /^ {4}\S/, `result detail stays in the result column: ${JSON.stringify(row)}`);
});

test("wrapped narration breaks between words, not through them", () => {
  const rendered = plain(renderTranscriptWindow([
    "the fencing token rejects a stale writer before the lease is renewed by the replacement worker",
  ], 60, 20));
  assert.ok(rendered.length > 1);
  for (const line of rendered.slice(0, -1)) {
    assert.match(line, / $/, `wrapped rows end at a word boundary: ${JSON.stringify(line)}`);
  }
});

// ── the restyle: one grammar for a whole turn ───────────────────────────────

test("a streamed turn renders as > prompt, ● narration, ⏺/⎿ action — and nothing else", async () => {
  // The shape of a real turn: the user asks, narration streams in, the
  // workspace observer lands a diff card mid-stream, narration closes.
  const card = renderLiveDiffCard({
    schemaVersion: 1,
    source: "observer",
    sequence: 1,
    atIso: "2026-08-27T10:00:00.086Z",
    observerId: "observer-1",
    root: "/repo",
    path: "src/auth.ts",
    changeKind: "modify",
    beforeHash: "sha256:before",
    afterHash: "sha256:after",
    bytesBefore: 10,
    bytesAfter: 12,
    modeBefore: 100644,
    modeAfter: 100644,
    binary: false,
    diff: "@@ -38,3 +38,4 @@\n-  const token = req.token;\n+  const token = getBearerToken(req);",
    diffHash: null,
    diffContextLines: 3,
    detectedBy: "watch",
    receiptHash: "sha256:d3b9c1a2f0e4aa71",
    idempotencyKey: "key",
  }, { color: false, elapsedMs: 86 });

  const harness = createMusterChatHarness({
    commands,
    toolsets: [],
    recentSessions: () => [],
    agents: async () => [],
    onSubmit: async (_text, sink) => {
      const painter = createNarrationPainter({ emit: (line) => sink.appendLine(line), minChars: 8, maxChars: 200 });
      painter.delta("Rewriting the bearer-token lookup.\n");
      for (const line of card) sink.appendLine(line);
      painter.delta("Done — the helper handles the missing-token case.\n");
      painter.finish();
      return true;
    },
  });

  harness.type("fix the bearer token lookup");
  await harness.submit();

  assert.deepEqual(plain(harness.transcript()), [
    "> fix the bearer token lookup",
    "● Rewriting the bearer-token lookup.",
    "⏺ Edit(src/auth.ts)",
    "  ⎿ +1 −1 · 86ms · receipt d3b9c1a2…",
    "    @@ -38,3 +38,4 @@",
    "    38 -   const token = req.token;",
    "    38 +   const token = getBearerToken(req);",
    "  Done — the helper handles the missing-token case.",
  ]);
  for (const line of plain(harness.transcript())) {
    assert.doesNotMatch(line, /[╭╮╰╯┌┐└┘├┤─│]/u, `no frame belongs around a message: ${line}`);
  }
});

test("the bottom row is the only chrome: header stays compact and the spinner never scrolls", async () => {
  const header = buildCompactHeaderLines({
    session: "main",
    cwd: "~/code/muster",
    scopes: "user:goblin",
    model: "gpt-5.6-sol",
    provider: "codex",
    runtime: "native",
    speed: "fast",
  });
  assert.ok(header.length <= 5, "the compact header stays within five lines");
  for (const line of plain(header)) assert.doesNotMatch(line, /[╭╮╰╯┌┐└┘├┤│]/u, "the header is frameless");

  let workingRow = "";
  const harness = createMusterChatHarness({
    commands,
    toolsets: [],
    recentSessions: () => [],
    agents: async () => [],
    onSubmit: async (_text, sink) => {
      for (let frame = 0; frame < 4; frame += 1) {
        sink.setStatus(formatStatusLine({ model: "gpt-5.6-sol", session: "main", inputTokens: 25087, outputTokens: 512, costUsd: 0.0337, elapsedMs: 12440, frame }));
      }
      workingRow = stripAnsi(harness.status());
      for (const line of formatAssistantBlock("done")) sink.appendLine(line);
      return true;
    },
  });

  harness.type("go");
  await harness.submit();

  assert.match(workingRow, /^\S gpt-5\.6-sol · main · 25\.1k in \/ 512 out · \$0\.0337 · 12\.4s$/);
  assert.equal(plain(harness.transcript()).some((line) => /gpt-5\.6-sol · main/.test(line)), false, "the status row never enters scrollback");
  assert.deepEqual(plain(harness.transcript()), ["> go", "● done"]);
});

// ── formatting helpers ──────────────────────────────────────────────────────

test("compact counts and durations read like a chip, not a dump", () => {
  assert.equal(compactCount(512), "512");
  assert.equal(compactCount(25087), "25.1k");
  assert.equal(compactCount(1_250_000), "1.3M");
  assert.equal(formatDuration(840), "840ms");
  assert.equal(formatDuration(12440), "12.4s");
  assert.equal(formatDuration(65000), "1m 5s");
});

// Spec: MUS-SPEC-01-1B (docs/spec/clauses/01-chat-transcript.md#mus-spec-01-1b--a-command-renders-as-a-cell-with-status-and-output)
test("narration painter paints command cells in order with exit status and output tail", () => {
  const previous = process.env.NO_COLOR;
  process.env.NO_COLOR = "1";
  try {
    const lines: string[] = [];
    const painter = createNarrationPainter({ emit: (line) => lines.push(line) });
    painter.delta("Running the tests.");
    painter.tool({ phase: "start", id: "c1", kind: "command", title: "pytest -q" });
    const output = Array.from({ length: 9 }, (_, index) => `line ${index + 1}`).join("\n");
    painter.tool({ phase: "end", id: "c1", kind: "command", title: "pytest -q", exitCode: 1, durationMs: 1200, output });
    painter.delta("One test fails.");
    painter.finish();
    const text = plain(lines);
    assert.equal(text[0], "● Running the tests.");
    assert.equal(text[1], "⏺ Bash(pytest -q)");
    assert.equal(text[2], "  ⎿ exit 1 · 1.2s");
    assert.ok(text.includes("    line 9"), "the output tail is shown");
    assert.ok(text.some((row) => /… \+\d+ lines/.test(row)), "long output collapses with a count");
    assert.equal(text.at(-1), "● One test fails.", "narration after a command opens a new block");
  } finally {
    if (previous === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = previous;
  }
});

// Spec: MUS-SPEC-01-1C (docs/spec/clauses/01-chat-transcript.md#mus-spec-01-1c--separate-assistant-messages-never-glue-together)
test("narration painter gives each reasoning summary part its own row", () => {
  const previous = process.env.NO_COLOR;
  process.env.NO_COLOR = "1";
  try {
    const lines: string[] = [];
    const painter = createNarrationPainter({ emit: (line) => lines.push(line) });
    painter.reasoning("Finding pytest environment");
    painter.reasoning("\n\nRunning an isolated package");
    painter.finish();
    assert.deepEqual(plain(lines), ["✻ Finding pytest environment", "✻ Running an isolated package"]);
  } finally {
    if (previous === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = previous;
  }
});

// Spec: MUS-SPEC-01-1B (docs/spec/clauses/01-chat-transcript.md#mus-spec-01-1b--a-command-renders-as-a-cell-with-status-and-output)
test("command cells drop the shell wrapper, quoted or not", () => {
  assert.equal(unwrapShellCommand("/bin/zsh -lc 'pytest -q'"), "pytest -q");
  assert.equal(unwrapShellCommand("/bin/zsh -lc hostname"), "hostname");
  assert.equal(unwrapShellCommand("bash -c \"ls -la\""), "ls -la");
  assert.equal(unwrapShellCommand("git status"), "git status");
});
