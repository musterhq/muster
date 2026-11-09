import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { createMusterChatHarness, type MusterChatSink } from "../src/chat-tui.js";

const execFileAsync = promisify(execFile);
const cliPath = resolve(import.meta.dirname, "..", "src", "index.ts");
const plain = (rows: readonly string[]) => rows.map((row) => row.replace(/\x1b\[[0-9;]*m/g, ""));
const tick = () => new Promise((resolveTick) => setImmediate(resolveTick));

// Spec: MUS-SPEC-10-1C (docs/spec/clauses/10-access-approvals.md#mus-spec-10-1c--the-approval-card-in-chat)
test("the approval card shows the request, takes y/a/n/esc and records the decision in place", { timeout: 10_000 }, async () => {
  const decisions: string[] = [];
  let sinkRef!: MusterChatSink;
  let release!: () => void;
  const chat = createMusterChatHarness({
    onSubmit: (_text, sink) => new Promise<boolean>((done) => { sinkRef = sink; release = () => done(true); }),
  });
  chat.type("clean up");
  const turn = chat.submit();
  await tick();
  for (const [key, expected, label] of [["y", "accept", "approved once"], ["a", "acceptForSession", "approved for this session"], ["n", "decline", "denied"], ["\x1b", "cancel", "denied · turn stopped"]] as const) {
    const pending = sinkRef.requestApproval({ id: `r-${key}`, kind: "command", title: "rm -rf build", reason: "clean the build" });
    await tick();
    const shown = plain(chat.transcript()).join("\n");
    assert.match(shown, /Run rm -rf build\?/);
    assert.match(shown, /clean the build/);
    assert.match(shown, /y once · a this session · n deny · esc stop/);
    chat.type("should not be sent");
    chat.input(key);
    decisions.push(await pending);
    const after = plain(chat.transcript());
    assert.ok(after.some((row) => row.includes(label)), `${label} in ${after.join("|")}`);
    assert.equal(after.filter((row) => /y once · a this session/.test(row)).length, 0, "the prompt row is replaced, not left behind");
  }
  assert.deepEqual(decisions, ["accept", "acceptForSession", "decline", "cancel"]);
  release();
  await turn;
});

// Spec: MUS-SPEC-10-1D (docs/spec/clauses/10-access-approvals.md#mus-spec-10-1d--access-changes-the-mode-and-the-status-bar-shows-it)
test("/access shows the current mode", { timeout: 120_000 }, async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-access-cli-"));
  const env = { ...process.env, MUSTER_ONBOARDING_HOME: join(cwd, ".test-home"), MUSTER_SKIP_ONBOARDING: "1", NO_COLOR: "1" };
  delete (env as Record<string, string | undefined>).FORCE_COLOR;
  try {
    await execFileAsync("tsx", [cliPath, "init"], { cwd, env });
    const row = async (extra: string[]) => {
      const { stdout } = await execFileAsync("tsx", [cliPath, "chat", ...extra, "--complete", "/acc", "--describe"], { cwd, env, timeout: 60_000 });
      return stdout.split("\n").map((line) => line.split("\t")).find(([value]) => value === "/access");
    };
    assert.match((await row([]))?.[2] ?? "", /^auto-edit\b/);
    assert.match((await row(["--access", "ask"]))?.[2] ?? "", /^ask\b/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
