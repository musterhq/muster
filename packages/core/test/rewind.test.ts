import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { clearCodexAppServerSessions, createWorkspaceObserver, defaultConfig, executeRun, rewindTurns, type RecordedTurn, type WorkspacePatchEvent } from "../src/index.js";

// Spec: MUS-SPEC-17-1A (docs/spec/clauses/17-rewind.md#mus-spec-17-1a--codex-runs-report-their-turn-id)
test("codex runs report the provider turn id", { timeout: 30_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "muster-turnid-"));
  const fake = join(dir, "codex-fake.mjs");
  await writeFile(fake, `#!/usr/bin/env node
import readline from "node:readline";
if (process.argv[2] !== "app-server") process.exit(0);
const rl = readline.createInterface({ input: process.stdin });
const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
rl.on("line", (line) => {
  const m = JSON.parse(line);
  if (m.method === "initialize") send({ id: m.id, result: {} });
  else if (m.method === "thread/start") send({ id: m.id, result: { thread: { id: "thread-9" } } });
  else if (m.method === "turn/start") {
    send({ id: m.id, result: { turn: { id: "turn-42", status: "inProgress" } } });
    send({ method: "item/completed", params: { threadId: "thread-9", turnId: "turn-42", item: { type: "agentMessage", id: "m", text: "ok" } } });
    send({ method: "turn/completed", params: { threadId: "thread-9", turn: { id: "turn-42", status: "completed" } } });
  }
});
`, "utf8");
  await chmod(fake, 0o755);
  const previous = process.env.MUSTER_CODEX_COMMAND;
  process.env.MUSTER_CODEX_COMMAND = fake;
  try {
    const outcome = await executeRun(defaultConfig(), {
      runtime: "codex", prompt: "hi", cwd: dir, nativeSession: true, nativeTransport: "warm", nativeSessionKeepAlive: false,
      conversationKey: "turn-id", skipAgentRules: true, skipRecall: true, skipSkillSelection: true, skipMemoryWrite: true,
    });
    assert.equal(outcome.codexThreadId, "thread-9");
    assert.equal(outcome.providerTurnId, "turn-42");
  } finally {
    if (previous === undefined) delete process.env.MUSTER_CODEX_COMMAND;
    else process.env.MUSTER_CODEX_COMMAND = previous;
    clearCodexAppServerSessions();
    await rm(dir, { recursive: true, force: true });
  }
});

const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };

// Spec: MUS-SPEC-17-1B (docs/spec/clauses/17-rewind.md#mus-spec-17-1b--rewinding-to-turn-2-of-3-restores-files-and-reverts-the-conversation)
test("rewinding to an earlier turn restores files from that turn on and reverts the thread", async (t: TestContext) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "muster-rewind-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  spawnSync("git", ["init", "-q", "-b", "main", "."], { cwd: root, env: GIT_ENV });
  await writeFile(join(root, "a.txt"), "a0\n");
  await writeFile(join(root, "c.txt"), "c0\n");
  spawnSync("git", ["add", "-A"], { cwd: root, env: GIT_ENV });
  spawnSync("git", ["commit", "-qm", "init"], { cwd: root, env: GIT_ENV });
  const observer = createWorkspaceObserver({ root, watch: false, pollMs: 0, onPatch: () => {} });
  await observer.start();
  const turn = async (edit: () => Promise<void>): Promise<WorkspacePatchEvent[]> => { await edit(); return observer.flush(); };
  const turns: RecordedTurn[] = [
    { prompt: "first", providerTurnId: "turn-1", threadId: "th", patches: await turn(() => writeFile(join(root, "a.txt"), "a1\n")) },
    { prompt: "second", providerTurnId: "turn-2", threadId: "th", patches: await turn(async () => { await writeFile(join(root, "a.txt"), "a2\n"); await writeFile(join(root, "b.txt"), "b\n"); }) },
    { prompt: "third", providerTurnId: "turn-3", threadId: "th", patches: await turn(() => writeFile(join(root, "c.txt"), "c3\n")) },
  ];
  await observer.stop();
  const reverts: Array<{ threadId: string; beforeTurnId: string }> = [];
  const result = await rewindTurns(turns, 1, { revertThread: async (threadId, beforeTurnId) => { reverts.push({ threadId, beforeTurnId }); return true; } });
  assert.equal(await readFile(join(root, "a.txt"), "utf8"), "a1\n");
  assert.equal(existsSync(join(root, "b.txt")), false);
  assert.equal(await readFile(join(root, "c.txt"), "utf8"), "c0\n");
  assert.deepEqual(reverts, [{ threadId: "th", beforeTurnId: "turn-2" }]);
  assert.equal(result.prompt, "second");
  assert.equal(result.conversation, "reverted");
  assert.deepEqual(result.files.restored.map((file) => file.path).sort(), ["a.txt", "b.txt", "c.txt"]);
  assert.equal(result.remainingTurns, 1);
});
