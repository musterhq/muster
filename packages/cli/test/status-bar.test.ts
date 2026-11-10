import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { createMusterChatHarness, formatStatusBar, readGitStatus } from "../src/chat-tui.js";

const run = promisify(execFile);
const plain = (value: string) => value.replace(/\x1b\[[0-9;]*m/g, "");

// Spec: MUS-SPEC-09-1A (docs/spec/clauses/09-status-bar.md#mus-spec-09-1a--the-bar-shows-model-folder-git-state-context-and-spend)
test("the status bar shows model, folder, git state, context and spend, and fits the width", async () => {
  const repo = await mkdtemp(join(tmpdir(), "muster-bar-"));
  try {
    await run("git", ["init", "-q", "-b", "main"], { cwd: repo });
    await writeFile(join(repo, "a.txt"), "one\n");
    await run("git", ["add", "."], { cwd: repo });
    await run("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"], { cwd: repo });
    await writeFile(join(repo, "a.txt"), "two\n");
    await writeFile(join(repo, "new.txt"), "x\n");
    const git = await readGitStatus(repo);
    assert.deepEqual(git, { branch: "main", changed: 1, untracked: 1 });
    const info = { model: "gpt-6.1-terra", effort: "High", cwd: repo, git, context: { usedTokens: 50_000, windowTokens: 200_000 }, sessionTokens: 128_400, sessionCostUsd: 0.42 };
    const wide = plain(formatStatusBar(info, 120));
    for (const part of ["gpt-6.1-terra · High", "⎇ main *1 ?1", "ctx 25%", "128.4k tok", "$0.42"]) assert.ok(wide.includes(part), `${part} in: ${wide}`);
    assert.ok(wide.length <= 120);
    const narrow = plain(formatStatusBar(info, 60));
    assert.ok(narrow.length <= 60, narrow);
    assert.ok(narrow.includes("gpt-6.1-terra"), "the model always stays");
    assert.ok(!narrow.includes("\n"));
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

// Spec: MUS-SPEC-09-1C (docs/spec/clauses/09-status-bar.md#mus-spec-09-1c--the-bar-sits-under-the-composer)
test("the footer renders below the composer", async () => {
  let sinkRef: { setFooter(line: string): void } | undefined;
  const chat = createMusterChatHarness({ onSubmit: async (_text, sink) => { sinkRef = sink; return true; } });
  chat.type("hi");
  await chat.submit();
  sinkRef!.setFooter("gpt-6.1-terra · High │ ~/repo");
  const rows = chat.visible(100).map(plain);
  assert.equal(rows.at(-1)!.trim(), "gpt-6.1-terra · High │ ~/repo");
  assert.ok(rows.findIndex((row) => row.startsWith("❯")) < rows.length - 1, "composer above the bar");
});

// Spec: MUS-SPEC-09-1D (docs/spec/clauses/09-status-bar.md#mus-spec-09-1d--the-working-row-shows-this-turn-not-the-session)
test("the working row shows this turn's time, not session totals or a zero cost", async () => {
  const { formatTurnStatusLine, formatStatusLine, TurnTimer } = await import("../src/chat-tui.js");
  let now = 0;
  const timer = new TurnTimer(() => now);
  now = 10_800;
  const row = formatTurnStatusLine({ model: "gpt-6.1-terra · High", session: "qa-1", inputTokens: 91_800, outputTokens: 387, costUsd: 0 }, timer, 40).replace(/\x1b\[[0-9;]*m/g, "");
  assert.doesNotMatch(row, /in \/|out|\$/, row);
  assert.match(row, /10\.8s/);
  const idle = formatStatusLine({ model: "gpt", session: "s", inputTokens: 1000, outputTokens: 5, costUsd: 0 }).replace(/\x1b\[[0-9;]*m/g, "");
  assert.doesNotMatch(idle, /\$0\.0000/, "a subscription turn has no cost to show");
  assert.match(formatStatusLine({ model: "gpt", session: "s", costUsd: 0.0123 }).replace(/\x1b\[[0-9;]*m/g, ""), /\$0\.0123/);
});

// Spec: MUS-SPEC-09-1E (docs/spec/clauses/09-status-bar.md#mus-spec-09-1e--after-a-resize-the-bar-is-rebuilt-for-the-new-width)
test("after a resize the bar is rebuilt for the new width and the summary row keeps its indent", async () => {
  const { FooterSlot, renderTranscriptLine } = await import("../src/chat-tui.js");
  const info = { model: "gpt-6.1-terra", effort: "High", cwd: "/private/tmp/qa-nogit", context: { usedTokens: 14_000, windowTokens: 200_000 }, sessionTokens: 144_000, sessionCostUsd: 0 };
  const slot = new FooterSlot((width) => formatStatusBar(info, width));
  await slot.refresh(110);
  assert.match(plain(slot.line), /144\.0k tok/);
  assert.equal(slot.staleFor(110), false);
  assert.equal(slot.staleFor(60), true, "a new width asks for a new bar");
  await slot.refresh(60);
  const narrow = plain(slot.line);
  assert.ok(narrow.length <= 60, narrow);
  assert.doesNotMatch(narrow, /144\.$|tok…/, "segments drop whole, never cut mid-segment");
  const summary = renderTranscriptLine("▸ gpt-6.1-terra · 139.5k in · 118.0k cached · 185 out · $0.0123 · 11.1s", 60, 60).map(plain);
  assert.ok(summary.length > 1);
  assert.ok(summary.slice(1).every((row) => row.startsWith("  ")), summary.join("\n"));
});

// Spec: MUS-SPEC-09-2A (docs/spec/clauses/09-status-bar.md#mus-spec-09-2a--the-full-header-stays-inside-its-box)
test("the full header panel keeps every row inside its box", async () => {
  const { fullHeaderLayout, renderFullHeaderPanel } = await import("../src/chat-tui.js");
  const layout = fullHeaderLayout(108);
  const rows = renderFullHeaderPanel({
    layout,
    title: "Muster Agent · 2026-11-10",
    left: ["MUSTER", "agent harness", " ", "gpt-6.1-terra", "/private/tmp/qa-set", "Session: qa-8b", "0 here · 3 total"],
    middle: ["Available Tools", "workspace: read, edit, shell, git"],
    right: ["Commands", "/help commands and shortcuts"],
    footer: "gpt-6.1-terra · codex · native · speed fast · scopes user:dhairya · 8 tool groups · 0 skills · 0 plugins · 0 mcp · /help",
  }).map(plain);
  for (const row of rows) assert.equal(row.length, 108, `row fits the box: ${row}`);
  assert.match(rows[0]!, /^╭─+ Muster Agent · 2026-11-10 ─+╮$/, "the title sits in the top border");
  assert.ok(!rows.some((row) => row.startsWith("│─")), "no second border inside the box");
  const footer = rows.at(-2)!;
  assert.ok(footer.endsWith(" │"), footer);
  assert.match(footer, /…/);
  assert.ok(rows.some((row) => row.includes("Session: qa-8b ")) && rows.some((row) => row.includes("0 here · 3 total")), "session and counts each on a row, uncut");
});

// Spec: MUS-SPEC-09-3A (docs/spec/clauses/09-status-bar.md#mus-spec-09-3a--status-lines-up-its-keys-and-shows-readable-token-counts)
test("/status keys line up and token counts are compact", { timeout: 120_000 }, async () => {
  const { formatTokenPair } = await import("../src/chat-tui.js") as { formatTokenPair?: (input: number, output: number) => string };
  assert.equal(typeof formatTokenPair, "function", "chat-tui exports formatTokenPair");
  assert.equal(formatTokenPair!(732130, 1361), "732.1k in · 1.4k out");
  assert.equal(formatTokenPair!(0, 495), "0 in · 495 out");

  const cwd = await mkdtemp(join(tmpdir(), "muster-status-cmd-"));
  const cli = join(import.meta.dirname, "..", "src", "index.ts");
  const env = { ...process.env, NO_COLOR: "1", MUSTER_SKIP_ONBOARDING: "1", MUSTER_ONBOARDING_HOME: join(cwd, ".test-home") };
  try {
    await run("tsx", [cli, "init"], { cwd, env });
    const { stdout } = await run("tsx", [cli, "chat", "--session", "status-rows", "/status"], { cwd, env, timeout: 60_000 });
    const rows = plain(stdout).split("\n").filter((row) => /^ {2}[a-z]+ {2,}\S/.test(row));
    assert.ok(rows.some((row) => row.startsWith("  conversation ")), `conversation has a two-space gap:\n${stdout}`);
    const starts = rows.map((row) => row.search(/(?<=\S {2,})\S/));
    assert.ok(rows.length >= 10 && starts.every((start) => start === starts[0]), `values start in one column:\n${stdout}`);
    assert.match(stdout, /^ {2}tokens +0 in · 0 out$/m);
    assert.match(stdout, /muster sessions show sess_[0-9a-f-]{12}$/m);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
