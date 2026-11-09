import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { clearCodexAppServerSessions, defaultConfig, executeRun, type ApprovalRequest } from "../src/index.js";

const quiet = { skipAgentRules: true, skipRecall: true, skipSkillSelection: true, skipMemoryWrite: true } as const;

// Spec: MUS-SPEC-10-1A (docs/spec/clauses/10-access-approvals.md#mus-spec-10-1a--codex-turns-follow-the-access-mode-and-route-approvals-to-the-user)
test("codex turns follow the access mode and route approval requests to the listener", { timeout: 60_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "muster-access-"));
  const fake = join(dir, "codex-fake.mjs");
  const log = join(dir, "log.jsonl");
  await writeFile(fake, `#!/usr/bin/env node
import readline from "node:readline";
import { appendFileSync } from "node:fs";
if (process.argv[2] !== "app-server") process.exit(0);
const rl = readline.createInterface({ input: process.stdin });
const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
const note = (m) => appendFileSync(${JSON.stringify(log)}, JSON.stringify(m) + "\\n");
let pendingTurn;
rl.on("line", (line) => {
  const m = JSON.parse(line);
  if (m.method === "initialize") send({ id: m.id, result: { userAgent: "fake" } });
  else if (m.method === "thread/start" || m.method === "thread/resume") { note({ thread: m.params }); send({ id: m.id, result: { thread: { id: "t" } } }); }
  else if (m.method === "turn/start") {
    note({ turn: m.params });
    send({ id: m.id, result: { turn: { id: "turn-1", status: "inProgress" } } });
    if (m.params.approvalPolicy === "untrusted") {
      pendingTurn = true;
      send({ id: 900, method: "item/commandExecution/requestApproval", params: { threadId: "t", turnId: "turn-1", itemId: "c1", command: "rm -rf build", cwd: "/w", reason: "clean the build", startedAtMs: 1 } });
    } else finish();
  } else if (m.id === 900) { note({ approval: m.result }); finish(); }
});
function finish() {
  send({ method: "item/completed", params: { threadId: "t", turnId: "turn-1", item: { type: "agentMessage", id: "m", text: "ok" } } });
  send({ method: "turn/completed", params: { threadId: "t", turn: { id: "turn-1", status: "completed" } } });
}
`, "utf8");
  await chmod(fake, 0o755);
  const previous = process.env.MUSTER_CODEX_COMMAND;
  process.env.MUSTER_CODEX_COMMAND = fake;
  try {
    const requests: ApprovalRequest[] = [];
    const ask = await executeRun(defaultConfig(), {
      runtime: "codex", prompt: "clean up", cwd: dir, nativeSession: true, nativeTransport: "warm", nativeSessionKeepAlive: false,
      conversationKey: "access-ask", accessMode: "ask", ...quiet,
      onApprovalRequest: async (request) => { requests.push(request); return "acceptForSession"; },
    });
    assert.equal(ask.episode.responseText, "ok");
    assert.deepEqual(requests.map((request) => [request.kind, request.title, request.reason]), [["command", "rm -rf build", "clean the build"]]);
    await executeRun(defaultConfig(), {
      runtime: "codex", prompt: "look", cwd: dir, nativeSession: true, nativeTransport: "warm", nativeSessionKeepAlive: false,
      conversationKey: "access-ro", accessMode: "read-only", ...quiet,
    });
    const entries = (await readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as Record<string, Record<string, unknown>>);
    const turns = entries.filter((entry) => entry.turn).map((entry) => entry.turn!);
    const threads = entries.filter((entry) => entry.thread).map((entry) => entry.thread!);
    assert.equal(turns[0]!.approvalPolicy, "untrusted");
    assert.equal(threads[0]!.sandbox, "workspace-write");
    assert.deepEqual(entries.find((entry) => entry.approval)?.approval, { decision: "acceptForSession" });
    assert.equal(threads[1]!.sandbox, "read-only");
    assert.notEqual(turns[1]!.approvalPolicy, "untrusted");
  } finally {
    if (previous === undefined) delete process.env.MUSTER_CODEX_COMMAND;
    else process.env.MUSTER_CODEX_COMMAND = previous;
    clearCodexAppServerSessions();
    await rm(dir, { recursive: true, force: true });
  }
});

// Spec: MUS-SPEC-10-1B (docs/spec/clauses/10-access-approvals.md#mus-spec-10-1b--claude-code-turns-follow-the-access-mode)
test("claude turns get the permission mode for each access mode", { timeout: 60_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "muster-access-claude-"));
  const command = join(dir, "claude");
  const log = join(dir, "args.log");
  await writeFile(command, `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "${log}"\nprintf 'ok\\n'\n`, "utf8");
  await chmod(command, 0o755);
  try {
    for (const accessMode of ["read-only", "ask", "auto-edit", "full"] as const) {
      await executeRun(defaultConfig(), { runtime: "claude-code", prompt: "hi", cwd: dir, claudeCommand: command, accessMode, ...quiet });
    }
    const lines = (await readFile(log, "utf8")).trim().split("\n");
    const modes = lines.map((line) => line.match(/--permission-mode (\S+)/)?.[1]);
    assert.deepEqual(modes, ["plan", "default", "acceptEdits", "bypassPermissions"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
