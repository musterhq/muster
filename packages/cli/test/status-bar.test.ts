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
