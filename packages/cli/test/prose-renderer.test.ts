import assert from "node:assert/strict";
import test from "node:test";
import {
  EMPTY_BOARD_COLUMNS,
  bandUserRow,
  formatBoardHeader,
  formatEarlierHistoryLine,
  missionStatusGlyph,
  pruneHistory,
  renderInlineProse,
  renderProse,
  renderReasoningLine,
} from "../src/prose-renderer.js";

function plain(value: string | readonly string[]): string {
  return (Array.isArray(value) ? value.join("\n") : value).replace(/\x1b\[[0-9;]*m/g, "");
}

test("semantic prose renders markdown blocks without leaking source glyphs", () => {
  const rendered = renderProse([
    "## Release notes",
    "- **Fixed** *streaming* in `chat-tui.ts`",
    "```ts",
    "const ready = true;",
    "```",
  ].join("\n"), { firstPrefix: "● ", continuationPrefix: "  " });
  assert.deepEqual(plain(rendered).split("\n"), [
    "● Release notes",
    "  - Fixed streaming in chat-tui.ts",
    "  const ready = true;",
  ]);
  const ansi = rendered.join("\n");
  if (!process.env.NO_COLOR) {
    assert.match(ansi, /\x1b\[1m/, "headers and bold carry weight");
    assert.match(ansi, /48;2;42;40;38/, "fenced code carries the subtle code background");
    assert.equal(ansi.match(/217;119;87|224;175;104/g), null, "markers stay default — no accent, no amber (owner-ruled)");
  }
});

test("inline prose colors ONLY code spans; links underline; the rest stays default", () => {
  // Owner-ruled 2026-08-29: the old path/branch/command heuristics sprayed
  // orange over ordinary words ("create/update", "hybrow/dev"). Prose keeps
  // the default foreground; `code` keeps its tint; URLs get an underline only.
  const rendered = renderInlineProse("Edit packages/cli/src/chat-tui.ts on feature/polish with /history; see https://example.com and `pnpm test`.");
  assert.equal(plain(rendered), "Edit packages/cli/src/chat-tui.ts on feature/polish with /history; see https://example.com and pnpm test.");
  if (!process.env.NO_COLOR) {
    assert.match(rendered, /\x1b\[38;2;176;184;248mpnpm test/, "code spans carry the reference's pixel-sampled periwinkle (#B0B8F8)");
    assert.equal(rendered.match(/217;119;87|224;175;104/g), null, "no accent orange or amber anywhere in prose");
    assert.match(rendered, /\x1b\[4mhttps:\/\/example\.com/, "links underline without recoloring");
  }
  const spray = renderInlineProse("I will create/update the jobs on hybrow/dev and logs/CSV/JSON.");
  if (!process.env.NO_COLOR) {
    assert.equal(spray.match(/217;119;87|224;175;104/g), null, "slash words never trigger semantic paint");
  }
});

test("thinking owns the sole violet identity", () => {
  const line = renderReasoningLine("**Checking** `src/a.ts`");
  assert.equal(plain(line), "✻ Checking src/a.ts");
  if (!process.env.NO_COLOR) assert.match(line, /\x1b\[3m.*183;157;219/);
});

test("history replay keeps twelve messages and collapses trivial turns", () => {
  const rows = Array.from({ length: 21 }, (_, index) => ({ role: index % 2 ? "assistant" : "user", content: index === 10 || index === 19 ? "ok" : `message ${index}` }));
  const history = pruneHistory(rows);
  assert.equal(history.earlier, 9);
  assert.equal(history.trivial, 2);
  assert.equal(history.rows.length, 10);
  assert.equal(history.rows[0]?.content, "message 9", "selection is the actual last twelve before compaction");
  assert.equal(formatEarlierHistoryLine(history.earlier), "… 9 earlier messages — /history for all");
});

test("history replay collapses consecutive assistant-only greetings", () => {
  const history = pruneHistory([
    { role: "user", content: "start" },
    { role: "assistant", content: "Hi! What would you like to work on?" },
    { role: "assistant", content: "Hello! How can I help today?" },
    { role: "user", content: "fix resume" },
    { role: "assistant", content: "Hi! What would you like to work on?" },
  ]);
  assert.deepEqual(history.rows.map((row) => row.content), [
    "start",
    "Hello! How can I help today?",
    "fix resume",
    "Hi! What would you like to work on?",
  ]);
});

test("shared board polish has compact headers, empty copy, and only three status glyphs", () => {
  assert.equal(formatBoardHeader(4), "tasks · 4");
  assert.equal(EMPTY_BOARD_COLUMNS, "Backlog · Ready · Running · Review — empty");
  assert.deepEqual([missionStatusGlyph("ready"), missionStatusGlyph("running"), missionStatusGlyph("done"), missionStatusGlyph("failed")], ["●", "◔", "●", "✖"]);
});

test("user rows paint their subtle band through the requested width", () => {
  const row = bandUserRow("\x1b[2m>\x1b[0m hello", 20);
  assert.equal(plain(row).length, 20);
  if (!process.env.NO_COLOR) {
    assert.ok((row.match(/48;2;58;58;58/g) ?? []).length >= 2, "inline resets reapply the full-row band");
    assert.match(row, / +\x1b\[0m$/, "padding remains inside the band");
  }
});

test("markdown tables render as aligned columns with bold header and dim rule", () => {
  const rows = renderProse([
    "| Component | Gateway | Responsibility |",
    "|---|---:|---|",
    "| ossmgr | No | Produces contracts |",
    "| worker | Yes | Executes CLI operations |",
  ].join("\n"));
  const flat = rows.map(plain);
  assert.match(flat[0]!, /^Component\s{2,}Gateway\s{2,}Responsibility$/);
  assert.match(flat[1]!, /^─+$/);
  assert.match(flat[2]!, /^ossmgr\s{2,}No\s{2,}Produces contracts$/);
  assert.equal(flat.join("\n").includes("|"), false, "no raw pipes survive");
  if (!process.env.NO_COLOR) assert.match(rows[0]!, /\x1b\[1m/, "header cells are bold");
});

test("fences carry no language label and codex annotations never render", () => {
  const rows = renderProse(":codex-annotation{index=\"1\"}\n```text\nossmgr binary\n```");
  const flat = rows.map(plain);
  assert.equal(flat.some((line) => line.includes("codex-annotation")), false, "directive stripped");
  assert.equal(flat.some((line) => line.trim() === "text"), false, "no floating language label");
  assert.equal(flat.some((line) => line.includes("ossmgr binary")), true, "code body kept");
});

// Spec: MUS-SPEC-01-1F (docs/spec/clauses/01-chat-transcript.md#mus-spec-01-1f--markdown-links-and-snake_case-render-verbatim)
test("links render as their label and intraword underscores stay literal", () => {
  const rows = renderProse("Added [test_calc.py](/r/test_calc.py) for snake_case_names and __init__ files.", { firstPrefix: "● ", continuationPrefix: "  " });
  assert.deepEqual(plain(rows).split("\n"), ["● Added test_calc.py for snake_case_names and __init__ files."]);
  assert.doesNotMatch(rows.join(""), /\x1b\[3m/, "no italics leak from underscores");
  assert.match(renderInlineProse("see [docs](https://x.dev/a_b)"), /\x1b\[4mdocs/, "the link label is underlined");
  assert.match(plain(renderInlineProse("_really_ important")), /^really important$/, "standalone emphasis still works");
});
