/**
 * The Claude Code-grade chat idiom, snapshotted ANSI-stripped.
 *
 * The owner's verdict on the previous TUI was "functional but noisy": every
 * message wore a frame, chrome was scattered across header, status and
 * transcript, and an action looked like prose. These tests pin the REPLACEMENT
 * grammar — `>` for the user, `●` for a message block, `⏺`/`⎿` for an action
 * and its result, one status row at the bottom — and, just as importantly,
 * pin that nothing was LOST in the restyle: counts, latencies, receipts,
 * tokens and cost all still appear.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ASSISTANT_BULLET,
  createMusterChatHarness,
  createNarrationPainter,
  formatAssistantBlock,
  formatStatusLine,
  formatToolLine,
  formatToolResultLines,
  formatToolSummary,
  formatUserLine,
  isUserTranscriptLine,
  missionStatusGlyph,
  renderMissionCard,
  renderToolBlock,
  renderTranscriptWindow,
  shortReceipt,
  TOOL_RESULT_MAX_LINES,
} from "../src/chat-tui.js";

function stripAnsi(value: string): string {
  return value.replace(/\x1b\[[0-9;]*m/g, "");
}

function plain(lines: readonly string[]): string[] {
  return lines.map(stripAnsi);
}

/** Anything that would draw a frame around content. */
const BOX_DRAWING = /[╭╮╰╯┌┐└┘├┤┬┴┼─│═║]/u;

const commands = [
  { name: "help", usage: "/help", description: "show full chat help" },
  { name: "exit", usage: "/exit", description: "leave chat", aliases: ["quit", "q"] },
] as const;

/* ---------- 1. message idiom ---------- */

test("a turn renders as alternating `>` user lines and `●` assistant blocks", async () => {
  const harness = createMusterChatHarness({
    commands,
    toolsets: [],
    recentSessions: () => [],
    agents: async () => [],
    onSubmit: async (_text, sink) => {
      for (const line of formatAssistantBlock("Found it: the spool owns the delivery state machine.\nThe lease renews every 30 seconds.")) {
        sink.appendLine(line);
      }
      return true;
    },
  });

  harness.type("where is the ingress spool flushed?");
  await harness.submit();
  harness.type("thanks");
  await harness.submit();

  assert.deepEqual(plain(harness.transcript()), [
    "> where is the ingress spool flushed?",
    "● Found it: the spool owns the delivery state machine.",
    "  The lease renews every 30 seconds.",
    "> thanks",
    "● Found it: the spool owns the delivery state machine.",
    "  The lease renews every 30 seconds.",
  ]);
});

test("no plain message is wrapped in a frame — whitespace and gutters separate turns", () => {
  const transcript = [
    formatUserLine("restyle the transcript"),
    ...formatAssistantBlock("Rewriting the render model now."),
    ...renderToolBlock({ name: "Edit", target: "server.js", summary: formatToolSummary({ additions: 12, deletions: 2, durationMs: 86 }) }),
  ];
  for (const line of plain(transcript)) {
    assert.doesNotMatch(line, BOX_DRAWING, `a message must not be framed: ${JSON.stringify(line)}`);
  }
  // The window renderer must not reintroduce one either.
  for (const line of plain(renderTranscriptWindow(transcript, 80, 20))) {
    assert.doesNotMatch(line, BOX_DRAWING);
  }
});

test("a user line is recognised by its gutter, and a quoted markdown line is not", () => {
  assert.equal(stripAnsi(formatUserLine("ship it")), "> ship it");
  assert.equal(isUserTranscriptLine(formatUserLine("ship it")), true);
  // Assistant prose always carries a `●`/two-space gutter, so a blockquote the
  // model writes can never be mistaken for the user's own turn.
  assert.equal(isUserTranscriptLine(formatAssistantBlock("> quoted from the RFC")[0] ?? ""), false);
  assert.equal(isUserTranscriptLine("  > still assistant text"), false);
});

test("an assistant block wears exactly one bullet, continuations align under it", () => {
  const opening = plain(formatAssistantBlock("first paragraph\nsecond row"));
  assert.deepEqual(opening, [`${ASSISTANT_BULLET} first paragraph`, "  second row"]);
  assert.deepEqual(plain(formatAssistantBlock("more of the same", { continued: true })), ["  more of the same"]);
  assert.deepEqual(formatAssistantBlock("   \n\n"), [], "an empty block paints nothing at all");
});

/* ---------- 2. tool / action idiom ---------- */

test("an action is a headline with its result indented beneath an elbow", () => {
  const block = renderToolBlock({
    name: "Edit",
    target: "server.js",
    summary: formatToolSummary({ additions: 12, deletions: 2, durationMs: 86, receipt: "sha256:d3b9c1a2f0e4aa71" }),
    detail: ["@@ -14,6 +14,16 @@", "-  const token = req.token;", "+  const token = getBearerToken(req);"],
  });

  assert.deepEqual(plain(block), [
    "⏺ Edit(server.js)",
    "  ⎿ +12 −2 · 86ms · receipt d3b9c1a2…",
    "    @@ -14,6 +14,16 @@",
    "    -  const token = req.token;",
    "    +  const token = getBearerToken(req);",
  ]);
  assert.equal(stripAnsi(formatToolLine("Bash")), "⏺ Bash");
  assert.equal(shortReceipt("sha256:d3b9c1a2f0e4aa71"), "d3b9c1a2…");
  assert.equal(shortReceipt("abc123"), "abc123", "a short receipt is never padded or faked");
});

test("a result longer than six lines collapses to an honest count", () => {
  const detail = Array.from({ length: 13 }, (_, index) => `line ${index + 1}`);
  const lines = plain(formatToolResultLines("13 matches · 42ms", { detail }));

  assert.equal(lines.length, 1 + TOOL_RESULT_MAX_LINES + 1);
  assert.equal(lines[0], "  ⎿ 13 matches · 42ms");
  assert.equal(lines[1], "    line 1");
  assert.equal(lines[TOOL_RESULT_MAX_LINES], "    line 6");
  assert.equal(lines.at(-1), "    … +7 lines", "the hidden rows are counted, never silently dropped");
  assert.equal(lines.some((line) => line.includes("line 7")), false);
});

test("exactly six result lines stay expanded, and an expand hook is advertised only when it exists", () => {
  const detail = Array.from({ length: 6 }, (_, index) => `row ${index + 1}`);
  const lines = plain(formatToolResultLines("6 rows", { detail }));
  assert.equal(lines.length, 7);
  assert.equal(lines.some((line) => line.includes("…")), false);

  // The chat screen has no expand key today, so the default promises nothing.
  const collapsed = plain(formatToolResultLines("9 rows", { detail: [...detail, "row 7", "row 8", "row 9"] }));
  assert.equal(collapsed.at(-1), "    … +3 lines");
  const hooked = plain(formatToolResultLines("9 rows", { detail: [...detail, "row 7", "row 8", "row 9"], expandHint: "ctrl+o expands" }));
  assert.equal(hooked.at(-1), "    … +3 lines (ctrl+o expands)");
});

test("a tool summary keeps every fact it was given", () => {
  assert.equal(formatToolSummary({ additions: 0, deletions: 0 }), "+0 −0");
  assert.equal(
    formatToolSummary({ additions: 3, deletions: 1, durationMs: 12440, receipt: "sha256:aabbccddeeff", extra: ["binary"] }),
    "+3 −1 · binary · 12.4s · receipt aabbccdd…",
  );
  assert.equal(formatToolSummary({ extra: ["3 matches"] }), "3 matches");
});

test("a squeezed turn keeps the action headline with the result it owns", () => {
  const transcript = [
    formatUserLine("fix the bearer token lookup"),
    ...formatAssistantBlock("Reading the route table."),
    ...renderToolBlock({
      name: "Edit",
      target: "src/auth.ts",
      summary: formatToolSummary({ additions: 12, deletions: 2, durationMs: 86, receipt: "sha256:d3b9c1a2f0e4aa71" }),
      detail: ["@@ -38,3 +38,4 @@", "-  const token = req.token;", "+  const token = getBearerToken(req);"],
    }),
    ...formatAssistantBlock("Done."),
  ];

  const squeezed = plain(renderTranscriptWindow(transcript, 100, 5));
  const elbowAt = squeezed.findIndex((line) => line.startsWith("  ⎿ "));
  assert.ok(elbowAt > 0, "the receipt is still pinned when the turn overflows");
  assert.equal(
    squeezed[elbowAt - 1],
    "⏺ Edit(src/auth.ts)",
    "a pinned result keeps the action that names its file — +12 −2 alone is an orphan",
  );
  assert.equal(squeezed[0], "> fix the bearer token lookup");
  assert.equal(squeezed.at(-1), "● Done.");
  assert.equal(new Set(squeezed).size, squeezed.length, "no row is pinned and tailed twice");
});

test("when the pair cannot fit, the transcript pins nothing rather than an orphan elbow", () => {
  const transcript = [
    formatUserLine("go"),
    ...renderToolBlock({ name: "Edit", target: "src/auth.ts", summary: formatToolSummary({ additions: 1, deletions: 1 }) }),
    ...formatAssistantBlock("first"),
    ...formatAssistantBlock("second"),
  ];
  const squeezed = plain(renderTranscriptWindow(transcript, 100, 3));
  assert.equal(squeezed.length, 3);
  assert.equal(
    squeezed.some((line) => line.startsWith("  ⎿ ") && !squeezed.includes("⏺ Edit(src/auth.ts)")),
    false,
    "an elbow row never appears without its headline",
  );
});

/* ---------- 3. the single status row ---------- */

test("the status line carries model, session, tokens, cost and elapsed on one row", () => {
  const status = stripAnsi(formatStatusLine({
    model: "gpt-5.6-sol",
    session: "main",
    inputTokens: 25087,
    outputTokens: 512,
    costUsd: 0.0337,
    elapsedMs: 12440,
  }));

  assert.equal(status, "gpt-5.6-sol · main · 25.1k in / 512 out · $0.0337 · 12.4s");
  assert.equal(status.includes("\n"), false, "the status row is exactly one row");
});

test("the working sparkle rides the left edge of the status row and nothing else", () => {
  const frames = Array.from({ length: 6 }, (_, frame) => stripAnsi(formatStatusLine({
    model: "fable-5",
    session: "main",
    agentId: "review",
    frame,
    elapsedMs: 3000,
  })));

  assert.equal(new Set(frames).size, 1, "the working line keeps one calm identity");
  for (const frame of frames) {
    assert.match(frame, /^\S \@review · fable-5 · main · 3\.0s$/);
  }
  // Idle: the same row, no spinner column at all.
  assert.match(stripAnsi(formatStatusLine({ model: "fable-5", session: "main" })), /^fable-5 · main$/);
});

test("the status row carries the context the compact header no longer repeats", () => {
  const status = stripAnsi(formatStatusLine({
    model: "gpt-5.6-sol",
    session: "main",
    extra: ["codex/native", "speed fast", "scopes user:goblin", "/help"],
  }));
  assert.equal(status, "gpt-5.6-sol · main · codex/native · speed fast · scopes user:goblin · /help");
});

/* ---------- 4. mission / board cards ---------- */

test("mission cards use ◔/●/✖ glyphs and aligned columns", () => {
  const card = plain(renderMissionCard({
    title: "harden ragbot API",
    agents: 3,
    costUsd: 0.31,
    rows: [
      { id: "t4", title: "rate-limiter", status: "in_progress", agent: "fable-5", detail: "api/limiter.ts +84", tokens: 8200, elapsedMs: 41000 },
      { id: "t5", title: "tests", status: "done", agent: "gpt-5.5", detail: "12 passing", tokens: 1100, elapsedMs: 12000 },
      { id: "t7", title: "docs", status: "backlog" },
      { id: "t8", title: "bench", status: "blocked", agent: "fable-5", detail: "needs a gateway token" },
    ],
  }));

  assert.deepEqual(card, [
    "⏺ Tasks(harden ragbot API)",
    "  ⎿ 4 tasks · 3 agents · 1 running · $0.31",
    "    ◔ t4  rate-limiter  fable-5  api/limiter.ts +84     41.0s · 8.2k tok",
    "    ● t5  tests         gpt-5.5  12 passing             12.0s · 1.1k tok",
    "    ● t7  docs          —        —",
    "    ✖ t8  bench         fable-5  needs a gateway token",
  ]);

  assert.equal(missionStatusGlyph("review"), "◔");
  assert.equal(missionStatusGlyph("needs_intervention"), "✖");
  assert.equal(missionStatusGlyph("ready"), "●");
});

test("a mission card never collapses its own rows behind a count", () => {
  const rows = Array.from({ length: 9 }, (_, index) => ({ id: `t${index}`, title: `task ${index}`, status: "ready" }));
  const card = plain(renderMissionCard({ title: "big mission", rows }));
  assert.equal(card.length, 2 + rows.length, "every task stays visible; the board IS the content");
});

/* ---------- 5. streamed blocks and reasoning ---------- */

test("streamed deltas paint into ONE bullet instead of one bullet per chunk", () => {
  const painted: string[] = [];
  const painter = createNarrationPainter({ emit: (line) => painted.push(line), minChars: 8, maxChars: 40 });
  painter.delta("Reading the gateway config.\n");
  painter.delta("Found the spool owner.\n");
  painter.delta("Adding the backpressure counter.\n");
  painter.finish();

  const lines = plain(painted);
  assert.equal(lines.filter((line) => line.startsWith("● ")).length, 1, "one message block, one bullet");
  assert.ok(lines.slice(1).every((line) => line.startsWith("  ")), "continuations align under the bullet");
  assert.match(lines.join("\n"), /backpressure counter/, "no delta is lost to the styling");
});

test("a reasoning summary opens a NEW block below it and collapses to one row", () => {
  const painted: string[] = [];
  const painter = createNarrationPainter({ emit: (line) => painted.push(line), minChars: 8, maxChars: 400 });
  painter.delta("First answer paragraph.\n");
  painter.reasoning("Checking whether the spool lease is renewed.\nThen confirming the fencing token.\n");
  painter.delta("Second answer paragraph.\n");
  painter.finish();

  const lines = plain(painted);
  const reasoningAt = lines.findIndex((line) => line.startsWith("∴ "));
  assert.ok(reasoningAt > 0, "the summary lands between the two blocks");
  assert.equal(lines[reasoningAt], "∴ Checking whether the spool lease is renewed. Then confirming the fencing token.");
  assert.match(lines[reasoningAt + 1] ?? "", /^● Second answer paragraph\./, "the message it explains starts a fresh bullet below it");
});

test("/reasoning full paints every summary line; compact truncates with an ellipsis", () => {
  const full: string[] = [];
  createNarrationPainter({ emit: (line) => full.push(line), reasoningMode: "full", minChars: 4, maxChars: 400 })
    .reasoning("line one of the summary\nline two of the summary\n");
  assert.deepEqual(plain(full).slice(0, 2), ["∴ line one of the summary", "∴ line two of the summary"]);

  const compact: string[] = [];
  const painter = createNarrationPainter({ emit: (line) => compact.push(line), minChars: 4, maxChars: 4000 });
  painter.reasoning(`${"considering the lease renewal path ".repeat(8)}\n`);
  painter.finish();
  const row = plain(compact)[0] ?? "";
  assert.equal(compact.length, 1, "however long the summary, compact spends one row on it");
  assert.ok(row.endsWith("…"), "the truncation is visible, not silent");
  assert.ok(row.length <= 100, `compact reasoning stays on one row, saw ${row.length}`);
});

test("bullets can be turned off for plain streaming surfaces", () => {
  const painted: string[] = [];
  const painter = createNarrationPainter({ emit: (line) => painted.push(line), bullets: false, minChars: 8, maxChars: 40 });
  painter.delta("raw text for a non-TTY consumer\n");
  painter.finish();
  assert.deepEqual(painted.map((line) => stripAnsi(line).trim()), ["raw text for a non-TTY consumer"]);
  assert.equal(painted.some((line) => line.includes(ASSISTANT_BULLET)), false);
});
