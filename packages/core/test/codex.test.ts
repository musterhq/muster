import assert from "node:assert/strict";
import { mkdtemp, writeFile, chmod, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { buildCodexArgs, parseCodexEvents, runCodex } from "../src/codex.js";
import { buildCodexAppServerArgs, clearCodexAppServerConversation, clearCodexAppServerSessions, interruptActiveCodexTurn, readGatewayCodexWarmThreadCount, runCodexAppServer } from "../src/codex-app-server.js";
import { codexMcpDisableOverrides } from "../src/run.js";

test("runCodex marks an unavailable CLI as safe for governed fallback", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-codex-missing-"));
  const result = await runCodex({
    prompt: "hello",
    cwd,
    command: join(cwd, "missing-codex"),
  });

  assert.equal(result.status, "failed");
  assert.equal(result.fallbackEligible, true);
});

test("buildCodexArgs: fresh turn runs codex exec at full native power", () => {
  const args = buildCodexArgs({
    prompt: "build me an xlsx of last week's tickets",
    cwd: "/home/goblin/.muster/profiles/tg/workspace",
    model: "gpt-5.5",
    reasoning: "low",
    instructionsFile: "/tmp/muster-inject.md",
    networkAccess: true,
    ignoreRules: true,
  }, "/tmp/out.txt");

  assert.deepEqual(args, [
    "exec", "--json",
    "-C", "/home/goblin/.muster/profiles/tg/workspace", "--skip-git-repo-check",
    "-m", "gpt-5.5",
    "-c", 'model_reasoning_effort="low"',
    "-s", "workspace-write",
    "--ignore-rules",
    "-c", "approval_policy=never",
    "-c", "sandbox_workspace_write.network_access=true",
    "-c", "experimental_instructions_file=/tmp/muster-inject.md",
    "-o", "/tmp/out.txt",
    "build me an xlsx of last week's tickets",
  ]);
});

test("buildCodexArgs: resume threads the native session id", () => {
  const args = buildCodexArgs({
    prompt: "now add a totals row",
    cwd: "/ws",
    sessionId: "11111111-2222-3333-4444-555555555555",
    resume: true,
  }, "/tmp/o.txt");

  assert.deepEqual(args, [
    "exec", "resume", "--json",
    "--skip-git-repo-check",
    "-c", "approval_policy=never",
    "-o", "/tmp/o.txt",
    "11111111-2222-3333-4444-555555555555",
    "now add a totals row",
  ]);
  // never passes --no-session-persistence; full native power retained
  assert.ok(!args.includes("--no-session-persistence"));
  assert.ok(!args.includes("-q"));
});

test("buildCodexArgs: ephemeral fresh turns skip native session persistence for speed", () => {
  const args = buildCodexArgs({
    prompt: "hi",
    cwd: "/ws",
    model: "gpt-5.5",
    ephemeral: true,
  }, "/tmp/o.txt");

  assert.deepEqual(args.slice(0, 5), ["exec", "--json", "--ephemeral", "-C", "/ws"]);
  assert.ok(args.includes("--ephemeral"));
});

test("native Codex transports apply governed MCP exclusions without disabling native power", () => {
  const override = "mcp_servers.frappe_control_plane.enabled=false";
  const execArgs = buildCodexArgs({
    prompt: "show my leave balance",
    cwd: "/ws",
    configOverrides: [override],
  }, "/tmp/o.txt");
  const appServerArgs = buildCodexAppServerArgs({ configOverrides: [override], networkAccess: true });

  assert.deepEqual(execArgs.slice(execArgs.indexOf(override) - 1, execArgs.indexOf(override) + 1), ["-c", override]);
  assert.deepEqual(appServerArgs, [
    "app-server", "--stdio",
    "-c", "sandbox_workspace_write.network_access=true",
    "-c", override,
  ]);
});

test("MCP exclusions never synthesize a transport-less Codex server", async () => {
  const codexHome = await mkdtemp(join(tmpdir(), "muster-codex-home-"));
  await writeFile(join(codexHome, "config.toml"), [
    "[mcp_servers.frappe_control_plane]",
    'command = "/opt/frappe-mcp"',
    "",
    '[mcp_servers."playwright"]',
    'command = "npx"',
  ].join("\n"));
  assert.deepEqual(
    await codexMcpDisableOverrides(["filesystem", "frappe_control_plane", "playwright"], codexHome),
    ["mcp_servers.frappe_control_plane.enabled=false", "mcp_servers.playwright.enabled=false"],
  );
});

test("parseCodexEvents: extracts thread_id (resume handle) from the JSONL stream", () => {
  const stream = [
    '{"type":"thread.started","thread_id":"abc-123"}',
    '{"type":"turn.started"}',
    '{"type":"item.completed","item":{"type":"assistant_message","text":"done"}}',
    '{"type":"turn.completed"}',
  ].join("\n");
  const r = parseCodexEvents(stream);
  assert.equal(r.threadId, "abc-123");
  assert.equal(r.failed, false);
});

test("parseCodexEvents: detects a failed turn and its message", () => {
  const stream = [
    '{"type":"thread.started","thread_id":"x"}',
    '{"type":"turn.failed","error":{"message":"401 Unauthorized"}}',
  ].join("\n");
  const r = parseCodexEvents(stream);
  assert.equal(r.failed, true);
  assert.equal(r.failureMessage, "401 Unauthorized");
});

test("parseCodexEvents: tolerates non-JSON log lines without throwing", () => {
  const stream = "warning: --full-auto is deprecated\n{\"type\":\"thread.started\",\"thread_id\":\"y\"}\nplain log line";
  const r = parseCodexEvents(stream);
  assert.equal(r.threadId, "y");
  assert.equal(r.failed, false);
});

test("runCodexAppServer: streams a turn and reuses the session", async () => {
  const dir = await mkdtemp(join(tmpdir(), "muster-codex-app-server-"));
  const fake = join(dir, "codex-fake.mjs");
  await writeFile(fake, `#!/usr/bin/env node
import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin });
let threadId = "thread-1";
let turn = 0;
function send(msg) { process.stdout.write(JSON.stringify(msg) + "\\n"); }
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") send({ id: msg.id, result: { userAgent: "fake" } });
  else if (msg.method === "initialized") {}
  else if (msg.method === "thread/start") setTimeout(() => send({ id: msg.id, result: { thread: { id: threadId } } }), 40);
  else if (msg.method === "turn/start") {
    turn += 1;
    send({ id: msg.id, result: { turn: { id: "turn-" + turn, status: "inProgress" } } });
    send({ method: "item/reasoning/summaryTextDelta", params: { threadId, turnId: "turn-" + turn, itemId: "r", summaryIndex: 0, delta: "checking " + turn } });
    send({ method: "item/agentMessage/delta", params: { threadId, turnId: "turn-" + turn, itemId: "m", delta: "ok" + turn } });
    send({ method: "item/completed", params: { item: { type: "agentMessage", id: "m", text: "ok" + turn }, threadId, turnId: "turn-" + turn } });
    send({ method: "thread/tokenUsage/updated", params: { threadId, turnId: "turn-" + turn, tokenUsage: { last: { inputTokens: 10 + turn, cachedInputTokens: turn === 1 ? 0 : 10, outputTokens: 1, reasoningOutputTokens: 7 } } } });
    send({ method: "turn/completed", params: { threadId, turn: { id: "turn-" + turn, status: "completed" } } });
  }
});
`, "utf8");
  await chmod(fake, 0o755);
  try {
    const deltas: string[] = [];
    const reasoning: string[] = [];
    const first = await runCodexAppServer({
      prompt: "one",
      cwd: dir,
      command: fake,
      cacheKey: "test",
      onDelta: (delta) => deltas.push(delta),
      onReasoningDelta: (delta) => reasoning.push(delta),
    });
    const second = await runCodexAppServer({
      prompt: "two",
      cwd: dir,
      command: fake,
      cacheKey: "test",
      onDelta: (delta) => deltas.push(delta),
      onReasoningDelta: (delta) => reasoning.push(delta),
    });
    assert.equal(first.status, "completed");
    assert.equal(first.dispatchState, "dispatched");
    assert.equal(first.turnId, "turn-1");
    assert.equal(first.finalMessage, "ok1");
    assert.equal(typeof first.firstDeltaMs, "number");
    assert.equal(second.finalMessage, "ok2");
    assert.equal(second.dispatchState, "dispatched");
    assert.equal(second.turnId, "turn-2");
    assert.equal(second.threadId, "thread-1");
    assert.equal(typeof second.firstDeltaMs, "number");
    assert.deepEqual(deltas, ["ok1", "ok2"]);
    assert.deepEqual(reasoning, ["checking 1", "checking 2"]);
    assert.equal(second.tokenUsage?.cachedInputTokens, 10);
    assert.equal(second.tokenUsage?.reasoningOutputTokens, 7);
    assert.equal(first.timings?.cacheState, "miss");
    assert.equal(first.timings?.threadOpenState, "started");
    assert.equal(typeof first.timings?.startupMs, "number");
    assert.equal(typeof first.timings?.threadOpenMs, "number");
    assert.equal(typeof first.timings?.requestToFirstDeltaMs, "number");
    assert.ok((first.timings?.requestToFirstDeltaMs ?? 0) >= 35, "cold request-to-first-delta includes thread startup");
    assert.equal(second.timings?.cacheState, "hit");
    assert.equal(second.timings?.threadOpenState, "cached");
    assert.equal(second.timings?.startupMs, 0);
    assert.equal(second.timings?.threadOpenMs, 0);
    assert.ok((second.timings?.requestToFirstDeltaMs ?? Infinity) < (first.timings?.requestToFirstDeltaMs ?? 0), "warm hit excludes cold startup from request latency");
  } finally {
    clearCodexAppServerSessions();
    await rm(dir, { recursive: true, force: true });
  }
});

test("runCodexAppServer: interrupts the active native turn and requests reasoning summaries", async () => {
  const dir = await mkdtemp(join(tmpdir(), "muster-codex-app-server-interrupt-"));
  const fake = join(dir, "codex-fake.mjs");
  const argsLog = join(dir, "args.json");
  await writeFile(fake, `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import readline from "node:readline";
writeFileSync(${JSON.stringify(argsLog)}, JSON.stringify(process.argv.slice(2)));
const rl = readline.createInterface({ input: process.stdin });
function send(msg) { process.stdout.write(JSON.stringify(msg) + "\\n"); }
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") send({ id: msg.id, result: {} });
  else if (msg.method === "thread/start") send({ id: msg.id, result: { thread: { id: "thread-interrupt" } } });
  else if (msg.method === "turn/start") {
    send({ id: msg.id, result: { turn: { id: "turn-interrupt", status: "inProgress" } } });
    send({ method: "item/agentMessage/delta", params: { delta: "partial" } });
  } else if (msg.method === "turn/interrupt") {
    send({ id: msg.id, result: {} });
    send({ method: "turn/completed", params: { turn: { id: "turn-interrupt", status: "interrupted" } } });
  }
});
`, "utf8");
  await chmod(fake, 0o755);
  try {
    const deltas: string[] = [];
    let markDispatched!: () => void;
    const dispatched = new Promise<void>((resolve) => { markDispatched = resolve; });
    const turn = runCodexAppServer({
      prompt: "stop me",
      cwd: dir,
      command: fake,
      cacheKey: "interrupt",
      transportOwner: "test-tui",
      onDelta: (delta) => {
        deltas.push(delta);
        markDispatched();
      },
    });
    await dispatched;
    assert.equal(await interruptActiveCodexTurn("test-tui"), true);
    const result = await turn;
    assert.equal(result.status, "completed");
    assert.deepEqual(deltas, ["partial"]);
    const args = JSON.parse(await readFile(argsLog, "utf8")) as string[];
    assert.ok(args.includes('model_reasoning_summary="detailed"'));
  } finally {
    clearCodexAppServerSessions();
    await rm(dir, { recursive: true, force: true });
  }
});

test("runCodexAppServer: serializes concurrent turns on one warm session", async () => {
  const dir = await mkdtemp(join(tmpdir(), "muster-codex-app-server-serial-"));
  const fake = join(dir, "codex-fake.mjs");
  const log = join(dir, "turns.log");
  await writeFile(fake, `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin });
const log = ${JSON.stringify(log)};
let turn = 0;
function send(msg) { process.stdout.write(JSON.stringify(msg) + "\\n"); }
function later(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
rl.on("line", async (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") send({ id: msg.id, result: { userAgent: "fake" } });
  else if (msg.method === "initialized") {}
  else if (msg.method === "thread/start") send({ id: msg.id, result: { thread: { id: "thread-serial" } } });
  else if (msg.method === "turn/start") {
    turn += 1;
    const id = "turn-" + turn;
    const prompt = msg.params.input[0].text;
    appendFileSync(log, "start:" + prompt + "\\n");
    send({ id: msg.id, result: { turn: { id, status: "inProgress" } } });
    await later(prompt === "one" ? 60 : 1);
    send({ method: "item/completed", params: { item: { type: "agentMessage", id: "m-" + id, text: "ok:" + prompt }, threadId: "thread-serial", turnId: id } });
    appendFileSync(log, "done:" + prompt + "\\n");
    send({ method: "turn/completed", params: { threadId: "thread-serial", turn: { id, status: "completed" } } });
  }
});
`, "utf8");
  await chmod(fake, 0o755);
  try {
    await runCodexAppServer({ prompt: "warm", cwd: dir, command: fake, cacheKey: "serial" });
    const [one, two] = await Promise.all([
      runCodexAppServer({ prompt: "one", cwd: dir, command: fake, cacheKey: "serial" }),
      runCodexAppServer({ prompt: "two", cwd: dir, command: fake, cacheKey: "serial" }),
    ]);

    assert.equal(one.finalMessage, "ok:one");
    assert.equal(two.finalMessage, "ok:two");
    assert.ok(Math.max(one.timings?.queueMs ?? 0, two.timings?.queueMs ?? 0) >= 40, "one concurrent turn reports its warm-session queue delay");
    const events = (await readFile(log, "utf8")).trim().split("\n");
    assert.deepEqual(events, ["start:warm", "done:warm", "start:one", "done:one", "start:two", "done:two"]);
  } finally {
    clearCodexAppServerSessions();
    await rm(dir, { recursive: true, force: true });
  }
});

test("runCodexAppServer: resumes a persisted thread after the warm process is gone", async () => {
  const dir = await mkdtemp(join(tmpdir(), "muster-codex-app-server-resume-"));
  const fake = join(dir, "codex-fake.mjs");
  const startLog = join(dir, "start.json");
  const resumeLog = join(dir, "resume.json");
  const turnLog = join(dir, "turn.jsonl");
  await writeFile(fake, `#!/usr/bin/env node
import { appendFileSync, writeFileSync } from "node:fs";
import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin });
let threadId = "thread-" + process.pid;
function send(msg) { process.stdout.write(JSON.stringify(msg) + "\\n"); }
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") send({ id: msg.id, result: { userAgent: "fake" } });
  else if (msg.method === "thread/start") {
    writeFileSync(${JSON.stringify(startLog)}, JSON.stringify(msg.params));
    send({ id: msg.id, result: { thread: { id: threadId } } });
  }
  else if (msg.method === "thread/resume") {
    writeFileSync(${JSON.stringify(resumeLog)}, JSON.stringify(msg.params));
    threadId = msg.params.threadId;
    send({ id: msg.id, result: { thread: { id: threadId } } });
  } else if (msg.method === "turn/start") {
    appendFileSync(${JSON.stringify(turnLog)}, JSON.stringify(msg.params) + "\\n");
    send({ id: msg.id, result: { turn: { id: "turn-1", status: "inProgress" } } });
    send({ method: "item/completed", params: { item: { type: "agentMessage", id: "m", text: threadId }, threadId, turnId: "turn-1" } });
    send({ method: "turn/completed", params: { threadId, turn: { id: "turn-1", status: "completed" } } });
  }
});
`, "utf8");
  await chmod(fake, 0o755);
  try {
    const developerInstructions = "Use only the host-supplied permission-filtered business context.";
    const first = await runCodexAppServer({ prompt: "one", cwd: dir, command: fake, cacheKey: "resume-chat", developerInstructions, applicationContext: "fresh snapshot one", sandbox: "read-only", networkAccess: false });
    clearCodexAppServerSessions();
    const second = await runCodexAppServer({ prompt: "two", cwd: dir, command: fake, cacheKey: "resume-chat", threadId: first.threadId, developerInstructions, applicationContext: "fresh snapshot two", sandbox: "read-only", networkAccess: false });

    assert.equal(first.status, "completed");
    assert.equal(second.status, "completed");
    assert.equal(second.threadId, first.threadId);
    assert.equal(second.timings?.threadOpenState, "resumed");
    assert.deepEqual(JSON.parse(await readFile(startLog, "utf8")), {
      cwd: dir,
      approvalPolicy: "never",
      sandbox: "read-only",
      developerInstructions,
    });
    assert.deepEqual(JSON.parse(await readFile(resumeLog, "utf8")), {
      threadId: first.threadId,
      cwd: dir,
      excludeTurns: true,
      approvalPolicy: "never",
      sandbox: "read-only",
      developerInstructions,
    });
    const turns = (await readFile(turnLog, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.deepEqual(turns.map((turn) => turn.additionalContext), [
      { "muster.application": { value: "fresh snapshot one", kind: "application" } },
      { "muster.application": { value: "fresh snapshot two", kind: "application" } },
    ]);
  } finally {
    clearCodexAppServerSessions();
    await rm(dir, { recursive: true, force: true });
  }
});

test("runCodexAppServer: replaces a stale persisted thread before dispatching the turn", async () => {
  const dir = await mkdtemp(join(tmpdir(), "muster-codex-app-server-stale-"));
  const fake = join(dir, "codex-fake.mjs");
  await writeFile(fake, `#!/usr/bin/env node
import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin });
const threadId = "thread-fresh-" + process.pid;
function send(msg) { process.stdout.write(JSON.stringify(msg) + "\\n"); }
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") send({ id: msg.id, result: { userAgent: "fake" } });
  else if (msg.method === "thread/resume") send({ id: msg.id, error: { code: -32600, message: "thread/resume failed: no rollout found for thread id thread-stale" } });
  else if (msg.method === "thread/start") send({ id: msg.id, result: { thread: { id: threadId } } });
  else if (msg.method === "turn/start") {
    send({ id: msg.id, result: { turn: { id: "turn-1", status: "inProgress" } } });
    send({ method: "item/completed", params: { item: { type: "agentMessage", id: "m", text: "fresh response" }, threadId, turnId: "turn-1" } });
    send({ method: "turn/completed", params: { threadId, turn: { id: "turn-1", status: "completed" } } });
  }
});
`, "utf8");
  await chmod(fake, 0o755);
  try {
    const result = await runCodexAppServer({
      prompt: "answer once",
      cwd: dir,
      command: fake,
      cacheKey: "stale-chat",
      threadId: "thread-stale",
    });

    assert.equal(result.status, "completed");
    assert.equal(result.finalMessage, "fresh response");
    assert.match(result.threadId ?? "", /^thread-fresh-/);
    assert.equal(result.timings?.threadOpenState, "started");
  } finally {
    clearCodexAppServerSessions();
    await rm(dir, { recursive: true, force: true });
  }
});

test("runCodexAppServer: rotates a provider thread without restarting the warm process", async () => {
  const dir = await mkdtemp(join(tmpdir(), "muster-codex-app-server-rotate-"));
  const fake = join(dir, "codex-fake.mjs");
  await writeFile(fake, `#!/usr/bin/env node
import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin });
let threadCount = 0;
let threadId = "";
function send(msg) { process.stdout.write(JSON.stringify(msg) + "\\n"); }
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") send({ id: msg.id, result: { userAgent: "fake" } });
  else if (msg.method === "thread/start") {
    threadCount += 1;
    threadId = "thread-" + threadCount + "-pid-" + process.pid;
    send({ id: msg.id, result: { thread: { id: threadId } } });
  } else if (msg.method === "turn/start") {
    send({ id: msg.id, result: { turn: { id: "turn-1", status: "inProgress" } } });
    send({ method: "item/completed", params: { item: { type: "agentMessage", id: "m", text: threadId }, threadId, turnId: "turn-1" } });
    send({ method: "turn/completed", params: { threadId, turn: { id: "turn-1", status: "completed" } } });
  }
});
`, "utf8");
  await chmod(fake, 0o755);
  try {
    const first = await runCodexAppServer({ prompt: "one", cwd: dir, command: fake, cacheKey: "rotate" });
    const second = await runCodexAppServer({ prompt: "two", cwd: dir, command: fake, cacheKey: "rotate", rotateThread: true });

    assert.match(first.finalMessage, /^thread-1-pid-/);
    assert.match(second.finalMessage, /^thread-2-pid-/);
    assert.equal(first.finalMessage.split("-pid-")[1], second.finalMessage.split("-pid-")[1], "same warm process was retained");
    assert.equal(second.timings?.cacheState, "hit");
    assert.equal(second.timings?.threadOpenState, "started");
  } finally {
    clearCodexAppServerSessions();
    await rm(dir, { recursive: true, force: true });
  }
});

test("runCodexAppServer: never replays a turn after the provider accepts it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "muster-codex-app-server-no-replay-"));
  const fake = join(dir, "codex-fake.mjs");
  await writeFile(fake, `#!/usr/bin/env node
import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin });
function send(msg) { process.stdout.write(JSON.stringify(msg) + "\\n"); }
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") send({ id: msg.id, result: { userAgent: "fake" } });
  else if (msg.method === "thread/start") send({ id: msg.id, result: { thread: { id: "thread-hang" } } });
  else if (msg.method === "turn/start") send({ id: msg.id, result: { turn: { id: "turn-hang", status: "inProgress" } } });
});
`, "utf8");
  await chmod(fake, 0o755);
  try {
    const result = await runCodexAppServer({
      prompt: "perform one write",
      cwd: dir,
      command: fake,
      cacheKey: "no-replay",
      timeoutMs: 20,
    });

    assert.equal(result.status, "failed");
    assert.equal(result.hadActivity, true);
    assert.equal(result.dispatchState, "dispatched");
    assert.equal(result.turnId, "turn-hang");
    assert.equal(result.fallbackEligible, false);
    assert.match(result.errorMessage ?? "", /timed out/i);
  } finally {
    clearCodexAppServerSessions();
    await rm(dir, { recursive: true, force: true });
  }
});

test("runCodexAppServer: lost turn acknowledgement is still an unsafe replay boundary", async () => {
  const dir = await mkdtemp(join(tmpdir(), "muster-codex-app-server-lost-ack-"));
  const fake = join(dir, "codex-fake.mjs");
  await writeFile(fake, `#!/usr/bin/env node
import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin });
function send(msg) { process.stdout.write(JSON.stringify(msg) + "\\n"); }
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") send({ id: msg.id, result: { userAgent: "fake" } });
  else if (msg.method === "thread/start") send({ id: msg.id, result: { thread: { id: "thread-lost-ack" } } });
  else if (msg.method === "turn/start") process.exit(7);
});
`, "utf8");
  await chmod(fake, 0o755);
  try {
    const result = await runCodexAppServer({
      prompt: "perform one write",
      cwd: dir,
      command: fake,
      cacheKey: "lost-ack",
      timeoutMs: 1_000,
    });

    assert.equal(result.status, "failed");
    assert.equal(result.hadActivity, true);
    assert.equal(result.dispatchState, "unknown");
    assert.equal(result.fallbackEligible, false);
  } finally {
    clearCodexAppServerSessions();
    await rm(dir, { recursive: true, force: true });
  }
});

test("runCodexAppServer: cold starts are single-flight per key and parallel across conversations", async () => {
  const dir = await mkdtemp(join(tmpdir(), "muster-codex-app-server-flights-"));
  const fake = join(dir, "codex-fake.mjs");
  const opensLog = join(dir, "opens.log");
  await writeFile(fake, `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin });
const threadId = "thread-" + process.pid;
let turn = 0;
function send(msg) { process.stdout.write(JSON.stringify(msg) + "\\n"); }
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") send({ id: msg.id, result: { userAgent: "fake" } });
  else if (msg.method === "thread/start") {
    appendFileSync(${JSON.stringify(opensLog)}, process.pid + ":" + Date.now() + "\\n");
    setTimeout(() => send({ id: msg.id, result: { thread: { id: threadId } } }), 900);
  } else if (msg.method === "turn/start") {
    turn += 1;
    const turnId = "turn-" + turn;
    send({ id: msg.id, result: { turn: { id: turnId, status: "inProgress" } } });
    send({ method: "item/completed", params: { item: { type: "agentMessage", id: "m-" + turn, text: threadId }, threadId, turnId } });
    send({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed" } } });
  }
});
`, "utf8");
  await chmod(fake, 0o755);
  try {
    const [a1, a2, b] = await Promise.all([
      runCodexAppServer({ prompt: "A1", cwd: dir, command: fake, cacheKey: "A" }),
      runCodexAppServer({ prompt: "A2", cwd: dir, command: fake, cacheKey: "A" }),
      runCodexAppServer({ prompt: "B", cwd: dir, command: fake, cacheKey: "B" }),
    ]);

    assert.equal(a1.threadId, a2.threadId, "same-key callers share one cold process");
    assert.notEqual(a1.threadId, b.threadId, "different conversations stay isolated");
    assert.deepEqual(new Set([a1.timings?.cacheState, a2.timings?.cacheState]), new Set(["miss", "shared-miss"]));
    const opens = (await readFile(opensLog, "utf8")).trim().split("\n").map((line) => Number(line.split(":")[1]));
    assert.equal(opens.length, 2, "one process per cold conversation key");
    assert.ok(Math.abs(opens[0] - opens[1]) < 700, "different cold keys initialize without a global lock");
  } finally {
    clearCodexAppServerSessions();
    await rm(dir, { recursive: true, force: true });
  }
});

test("clearCodexAppServerConversation invalidates only the targeted warm conversation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "muster-codex-app-server-invalidate-"));
  const fake = join(dir, "codex-fake.mjs");
  await writeFile(fake, `#!/usr/bin/env node
import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin });
const threadId = "thread-" + process.pid;
function send(msg) { process.stdout.write(JSON.stringify(msg) + "\\n"); }
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") send({ id: msg.id, result: { userAgent: "fake" } });
  else if (msg.method === "thread/start") send({ id: msg.id, result: { thread: { id: threadId } } });
  else if (msg.method === "turn/start") {
    send({ id: msg.id, result: { turn: { id: "turn-1", status: "inProgress" } } });
    send({ method: "item/completed", params: { item: { type: "agentMessage", id: "m", text: threadId }, threadId, turnId: "turn-1" } });
    send({ method: "turn/completed", params: { threadId, turn: { id: "turn-1", status: "completed" } } });
  }
});
`, "utf8");
  await chmod(fake, 0o755);
  try {
    const firstA = await runCodexAppServer({ prompt: "A1", cwd: dir, command: fake, cacheKey: "A" });
    const firstB = await runCodexAppServer({ prompt: "B1", cwd: dir, command: fake, cacheKey: "B" });
    clearCodexAppServerConversation("A");
    const secondA = await runCodexAppServer({ prompt: "A2", cwd: dir, command: fake, cacheKey: "A" });
    const secondB = await runCodexAppServer({ prompt: "B2", cwd: dir, command: fake, cacheKey: "B" });

    assert.notEqual(secondA.threadId, firstA.threadId);
    assert.equal(secondA.timings?.cacheState, "miss");
    assert.equal(secondB.threadId, firstB.threadId);
    assert.equal(secondB.timings?.cacheState, "hit");
  } finally {
    clearCodexAppServerSessions();
    await rm(dir, { recursive: true, force: true });
  }
});

test("runCodexAppServer: instruction content changes create a fresh cached session", async () => {
  const dir = await mkdtemp(join(tmpdir(), "muster-codex-app-server-instructions-"));
  const fake = join(dir, "codex-fake.mjs");
  const instructions = join(dir, "instructions.md");
  await writeFile(fake, `#!/usr/bin/env node
import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin });
const threadId = "thread-" + process.pid;
function send(msg) { process.stdout.write(JSON.stringify(msg) + "\\n"); }
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") send({ id: msg.id, result: { userAgent: "fake" } });
  else if (msg.method === "initialized") {}
  else if (msg.method === "thread/start") send({ id: msg.id, result: { thread: { id: threadId } } });
  else if (msg.method === "turn/start") {
    send({ id: msg.id, result: { turn: { id: "turn-1", status: "inProgress" } } });
    send({ method: "item/completed", params: { item: { type: "agentMessage", id: "m", text: threadId }, threadId, turnId: "turn-1" } });
    send({ method: "turn/completed", params: { threadId, turn: { id: "turn-1", status: "completed" } } });
  }
});
`, "utf8");
  await chmod(fake, 0o755);
  try {
    await writeFile(instructions, "context one", "utf8");
    const first = await runCodexAppServer({ prompt: "one", cwd: dir, command: fake, cacheKey: "same-chat", instructionsFile: instructions });
    await writeFile(instructions, "context two", "utf8");
    const second = await runCodexAppServer({ prompt: "two", cwd: dir, command: fake, cacheKey: "same-chat", instructionsFile: instructions });

    assert.equal(first.status, "completed");
    assert.equal(second.status, "completed");
    assert.notEqual(second.threadId, first.threadId, "changed injected context must not reuse a warm Codex process");
  } finally {
    clearCodexAppServerSessions();
    await rm(dir, { recursive: true, force: true });
  }
});

test("runCodexAppServer: warm session cache evicts the least-recent idle process", async () => {
  const dir = await mkdtemp(join(tmpdir(), "muster-codex-app-server-lru-"));
  const fake = join(dir, "codex-fake.mjs");
  await writeFile(fake, `#!/usr/bin/env node
import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin });
const threadId = "thread-" + process.pid;
function send(msg) { process.stdout.write(JSON.stringify(msg) + "\\n"); }
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") send({ id: msg.id, result: { userAgent: "fake" } });
  else if (msg.method === "thread/start") send({ id: msg.id, result: { thread: { id: threadId } } });
  else if (msg.method === "turn/start") {
    send({ id: msg.id, result: { turn: { id: "turn-1", status: "inProgress" } } });
    send({ method: "item/completed", params: { item: { type: "agentMessage", id: "m", text: threadId }, threadId, turnId: "turn-1" } });
    send({ method: "turn/completed", params: { threadId, turn: { id: "turn-1", status: "completed" } } });
  }
});
`, "utf8");
  await chmod(fake, 0o755);
  const previous = process.env.MUSTER_NATIVE_SESSION_CACHE_SIZE;
  process.env.MUSTER_NATIVE_SESSION_CACHE_SIZE = "2";
  try {
    clearCodexAppServerSessions();
    const firstA = await runCodexAppServer({ prompt: "A1", cwd: dir, command: fake, cacheKey: "A" });
    await runCodexAppServer({ prompt: "B", cwd: dir, command: fake, cacheKey: "B" });
    await runCodexAppServer({ prompt: "C", cwd: dir, command: fake, cacheKey: "C" });
    const secondA = await runCodexAppServer({ prompt: "A2", cwd: dir, command: fake, cacheKey: "A" });
    assert.notEqual(secondA.threadId, firstA.threadId, "the oldest idle session is replaced after the cache reaches its bound");
  } finally {
    if (previous === undefined) delete process.env.MUSTER_NATIVE_SESSION_CACHE_SIZE;
    else process.env.MUSTER_NATIVE_SESSION_CACHE_SIZE = previous;
    clearCodexAppServerSessions();
    await rm(dir, { recursive: true, force: true });
  }
});

test("runCodexAppServer: keepAlive=false closes the app-server instead of caching it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "muster-codex-app-server-no-cache-"));
  const fake = join(dir, "codex-fake.mjs");
  await writeFile(fake, `#!/usr/bin/env node
import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin });
const threadId = "thread-" + process.pid;
function send(msg) { process.stdout.write(JSON.stringify(msg) + "\\n"); }
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") send({ id: msg.id, result: { userAgent: "fake" } });
  else if (msg.method === "initialized") {}
  else if (msg.method === "thread/start") send({ id: msg.id, result: { thread: { id: threadId } } });
  else if (msg.method === "turn/start") {
    send({ id: msg.id, result: { turn: { id: "turn-1", status: "inProgress" } } });
    send({ method: "item/completed", params: { item: { type: "agentMessage", id: "m", text: threadId }, threadId, turnId: "turn-1" } });
    send({ method: "turn/completed", params: { threadId, turn: { id: "turn-1", status: "completed" } } });
  }
});

`, "utf8");
  await chmod(fake, 0o755);
  try {
    const first = await runCodexAppServer({ prompt: "one", cwd: dir, command: fake, cacheKey: "same-chat", keepAlive: false });
    const second = await runCodexAppServer({ prompt: "two", cwd: dir, command: fake, cacheKey: "same-chat", keepAlive: false });

    assert.equal(first.status, "completed");
    assert.equal(second.status, "completed");
    assert.notEqual(second.threadId, first.threadId);
  } finally {
    clearCodexAppServerSessions();
    await rm(dir, { recursive: true, force: true });
  }
});

test("runCodexAppServer: gateway sessions report their count and expire on the shorter TTL", async () => {
  const dir = await mkdtemp(join(tmpdir(), "muster-codex-gateway-ttl-"));
  const fake = join(dir, "codex-fake.mjs");
  await writeFile(fake, `#!/usr/bin/env node
import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin });
const threadId = "thread-" + process.pid;
function send(msg) { process.stdout.write(JSON.stringify(msg) + "\\n"); }
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") send({ id: msg.id, result: { userAgent: "fake" } });
  else if (msg.method === "thread/start") send({ id: msg.id, result: { thread: { id: threadId } } });
  else if (msg.method === "turn/start") {
    send({ id: msg.id, result: { turn: { id: "turn-1", status: "inProgress" } } });
    send({ method: "item/completed", params: { item: { type: "agentMessage", id: "m", text: "ok" }, threadId, turnId: "turn-1" } });
    send({ method: "turn/completed", params: { threadId, turn: { id: "turn-1", status: "completed" } } });
  }
});
`, "utf8");
  await chmod(fake, 0o755);
  const previous = process.env.MUSTER_GATEWAY_CODEX_IDLE_MS;
  process.env.MUSTER_GATEWAY_CODEX_IDLE_MS = "1000";
  try {
    clearCodexAppServerSessions();
    const result = await runCodexAppServer({ prompt: "one", cwd: dir, command: fake, cacheKey: "gateway-chat", transportOwner: "gateway:test" });
    assert.equal(result.status, "completed");
    assert.equal(readGatewayCodexWarmThreadCount(process.pid), 1);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_150));
    assert.equal(readGatewayCodexWarmThreadCount(process.pid), 0);
  } finally {
    if (previous === undefined) delete process.env.MUSTER_GATEWAY_CODEX_IDLE_MS;
    else process.env.MUSTER_GATEWAY_CODEX_IDLE_MS = previous;
    clearCodexAppServerSessions();
    await rm(dir, { recursive: true, force: true });
  }
});

test("runCodex refuses legacy Codex before passing modern exec flags", async () => {
  const dir = await mkdtemp(join(tmpdir(), "muster-codex-legacy-"));
  const fake = join(dir, "codex-legacy.mjs");
  const unsafeMarker = join(dir, "unsafe.txt");
  await writeFile(fake, `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
const args = process.argv.slice(2);
if (args[0] === "exec" && args[1] === "--help") {
  console.error("Usage: codex [options] <prompt>");
  process.exit(2);
}
if (args.includes("-c")) writeFileSync(${JSON.stringify(unsafeMarker)}, "unsafe");
process.exit(0);
`, "utf8");
  await chmod(fake, 0o755);
  try {
    const result = await runCodex({
      prompt: "hi",
      cwd: dir,
      command: fake,
      instructionsFile: join(dir, "instructions.md"),
      timeoutMs: 1_000,
    });

    assert.equal(result.status, "failed");
    assert.match(result.errorMessage ?? "", /does not support `codex exec --json`/);
    await assert.rejects(readFile(unsafeMarker, "utf8"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runCodexAppServer: forwards raw item events and routes server requests to onRequest", async () => {
  const dir = await mkdtemp(join(tmpdir(), "muster-codex-app-server-events-"));
  const fake = join(dir, "codex-fake-events.mjs");
  await writeFile(fake, `#!/usr/bin/env node
import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin });
function send(msg) { process.stdout.write(JSON.stringify(msg) + "\\n"); }
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") send({ id: msg.id, result: { userAgent: "fake" } });
  else if (msg.method === "thread/start") send({ id: msg.id, result: { thread: { id: "t" } } });
  else if (msg.method === "turn/start") {
    send({ id: msg.id, result: { turn: { id: "turn-1", status: "inProgress" } } });
    send({ method: "item/started", params: { threadId: "t", turnId: "turn-1", item: { type: "fileChange", id: "fc", changes: [{ path: "a.txt" }] } } });
    send({ method: "item/fileChange/outputDelta", params: { threadId: "t", turnId: "turn-1", itemId: "fc", delta: "*** Begin Patch\\n" } });
    send({ id: 77, method: "item/commandExecution/requestApproval", params: { threadId: "t", turnId: "turn-1", itemId: "cmd", command: "ls" } });
  } else if (msg.id === 77) {
    send({ method: "item/agentMessage/delta", params: { threadId: "t", turnId: "turn-1", itemId: "m", delta: "decision:" + msg.result.decision } });
    send({ method: "item/completed", params: { item: { type: "agentMessage", id: "m", text: "decision:" + msg.result.decision }, threadId: "t", turnId: "turn-1" } });
    send({ method: "turn/completed", params: { threadId: "t", turn: { id: "turn-1", status: "completed" } } });
  }
});
`, "utf8");

  await chmod(fake, 0o755);
  try {
    const events: string[] = [];
    const requests: string[] = [];
    const result = await runCodexAppServer({
      prompt: "go",
      cwd: dir,
      command: fake,
      cacheKey: "events",
      onEvent: (method) => events.push(method),
      onRequest: async (method) => { requests.push(method); return { decision: "accept" }; },
    });
    assert.equal(result.status, "completed");
    assert.ok(events.includes("item/fileChange/outputDelta"), "streamed patch text is forwarded raw");
    assert.ok(events.includes("item/started"), "item lifecycle is forwarded");
    assert.deepEqual(requests, ["item/commandExecution/requestApproval"]);
    assert.equal(result.finalMessage, "decision:accept", "the handler's answer reached the server");
  } finally {
    clearCodexAppServerSessions();
    await rm(dir, { recursive: true, force: true });
  }
});

test("runCodexAppServer: child events stay raw and cannot complete or pollute the parent turn", async () => {
  const dir = await mkdtemp(join(tmpdir(), "muster-codex-app-server-child-filter-"));
  const fake = join(dir, "codex-fake-child-filter.mjs");
  await writeFile(fake, [
    "#!/usr/bin/env node",
    "import readline from \"node:readline\";",
    "const rl = readline.createInterface({ input: process.stdin });",
    "function send(msg) { process.stdout.write(JSON.stringify(msg) + \"\\n\"); }",
    "rl.on(\"line\", (line) => {",
    "  const msg = JSON.parse(line);",
    "  if (msg.method === \"initialize\") send({ id: msg.id, result: { userAgent: \"fake\" } });",
    "  else if (msg.method === \"thread/start\") send({ id: msg.id, result: { thread: { id: \"parent-thread\" } } });",
    "  else if (msg.method === \"turn/start\") {",
    "    send({ id: msg.id, result: { turn: { id: \"parent-turn\", status: \"inProgress\" } } });",
    "    send({ method: \"item/agentMessage/delta\", params: { threadId: \"child-a\", turnId: \"child-turn\", delta: \"child text\" } });",
    "    send({ method: \"item/reasoning/summaryTextDelta\", params: { threadId: \"child-b\", turnId: \"child-turn-b\", delta: \"child reasoning\" } });",
    "    send({ method: \"thread/tokenUsage/updated\", params: { threadId: \"child-a\", turnId: \"child-turn\", tokenUsage: { last: { inputTokens: 900, outputTokens: 901 } } } });",
    "    send({ method: \"turn/completed\", params: { threadId: \"child-a\", turn: { id: \"child-turn\", status: \"failed\", error: { message: \"child failed\" } } } });",
    "    send({ method: \"item/agentMessage/delta\", params: { threadId: \"parent-thread\", turnId: \"parent-turn\", delta: \"parent text\" } });",
    "    send({ method: \"thread/tokenUsage/updated\", params: { threadId: \"parent-thread\", turnId: \"parent-turn\", tokenUsage: { last: { inputTokens: 12, outputTokens: 4 } } } });",
    "    send({ method: \"item/completed\", params: { threadId: \"parent-thread\", turnId: \"parent-turn\", item: { type: \"agentMessage\", id: \"parent-message\", text: \"parent text\" } } });",
    "    send({ method: \"turn/completed\", params: { threadId: \"parent-thread\", turn: { id: \"parent-turn\", status: \"completed\" } } });",
    "  }",
    "});",
  ].join("\n"), "utf8");
  await chmod(fake, 0o755);
  try {
    const deltas: string[] = []; const reasoning: string[] = []; const events: string[] = [];
    const result = await runCodexAppServer({ prompt: "parent task", cwd: dir, command: fake, cacheKey: "child-filter", onDelta: (delta) => deltas.push(delta), onReasoningDelta: (delta) => reasoning.push(delta), onEvent: (method, params) => { if (params.threadId !== "parent-thread") events.push(method + ":" + String(params.threadId ?? "")); } });
    assert.equal(result.status, "completed");
    assert.equal(result.finalMessage, "parent text");
    assert.deepEqual(deltas, ["parent text"]);
    assert.deepEqual(reasoning, []);
    assert.equal(result.tokenUsage?.inputTokens, 12);
    assert.equal(result.tokenUsage?.outputTokens, 4);
    assert.ok(events.includes("item/agentMessage/delta:child-a"));
    assert.ok(events.includes("turn/completed:child-a"));
  } finally {
    clearCodexAppServerSessions();
    await rm(dir, { recursive: true, force: true });
  }
});

test("runCodexAppServer: keepAlive observes child work and routes approval after parent completion", async () => {
  const dir = await mkdtemp(join(tmpdir(), "muster-codex-app-server-observer-"));
  const fake = join(dir, "codex-fake-observer.mjs");
  await writeFile(fake, [
    "#!/usr/bin/env node",
    "import readline from \"node:readline\";",
    "const rl = readline.createInterface({ input: process.stdin });",
    "function send(msg) { process.stdout.write(JSON.stringify(msg) + \"\\n\"); }",
    "rl.on(\"line\", (line) => {",
    "  const msg = JSON.parse(line);",
    "  if (msg.method === \"initialize\") send({ id: msg.id, result: { userAgent: \"fake\" } });",
    "  else if (msg.method === \"thread/start\") send({ id: msg.id, result: { thread: { id: \"parent-thread\" } } });",
    "  else if (msg.method === \"turn/start\") {",
    "    send({ id: msg.id, result: { turn: { id: \"parent-turn\", status: \"inProgress\" } } });",
    "    send({ method: \"item/agentMessage/delta\", params: { threadId: \"parent-thread\", turnId: \"parent-turn\", delta: \"parent\" } });",
    "    send({ method: \"turn/completed\", params: { threadId: \"parent-thread\", turn: { id: \"parent-turn\", status: \"completed\" } } });",
    "    setTimeout(() => send({ method: \"thread/status/changed\", params: { threadId: \"child-thread\", status: { type: \"active\" } } }), 20);",
    "    setTimeout(() => send({ id: 91, method: \"item/commandExecution/requestApproval\", params: { threadId: \"child-thread\", turnId: \"child-turn\", itemId: \"child-command\", command: \"echo child\" } }), 30);",
    "  } else if (msg.id === 91) {",
    "    send({ method: \"item/agentMessage/delta\", params: { threadId: \"child-thread\", turnId: \"child-turn\", delta: \"child approval:\" + msg.result.decision } });",
    "    send({ method: \"turn/completed\", params: { threadId: \"child-thread\", turn: { id: \"child-turn\", status: \"completed\" } } });",
    "  }",
    "});",
  ].join("\n"), "utf8");
  await chmod(fake, 0o755);
  try {
    const observed: string[] = []; const requests: string[] = []; const parentDeltas: string[] = [];
    const result = await runCodexAppServer({ prompt: "parent", cwd: dir, command: fake, cacheKey: "after-parent", onDelta: (delta) => parentDeltas.push(delta), onEvent: (method, params) => { if (params.threadId === "child-thread") observed.push(method); }, onRequest: async (method) => { requests.push(method); return { decision: "accept" }; } });
    assert.equal(result.status, "completed");
    assert.deepEqual(parentDeltas, ["parent"]);
    await new Promise((resolve) => setTimeout(resolve, 140));
    assert.ok(observed.includes("thread/status/changed"));
    assert.ok(observed.includes("item/commandExecution/requestApproval"));
    assert.ok(observed.includes("item/agentMessage/delta"));
    assert.deepEqual(requests, ["item/commandExecution/requestApproval"]);
    clearCodexAppServerConversation("after-parent");
    const count = observed.length;
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(observed.length, count, "conversation cleanup stops persistent observation");
  } finally {
    clearCodexAppServerSessions();
    await rm(dir, { recursive: true, force: true });
  }
});
