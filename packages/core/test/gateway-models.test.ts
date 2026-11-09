import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { clearCodexAppServerSessions, defaultConfig, executeRun } from "../src/index.js";

// Spec: MUS-SPEC-07-1A (docs/spec/clauses/07-gateway-models.md#mus-spec-07-1a--a-run-can-pick-a-codex-model-provider)
test("codex turns run on the chosen model provider and do not share warm sessions across providers", { timeout: 60_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "muster-gateway-"));
  const fake = join(dir, "codex-fake.mjs");
  const log = join(dir, "argv.log");
  await writeFile(fake, `#!/usr/bin/env node
import readline from "node:readline";
import { appendFileSync } from "node:fs";
if (process.argv[2] !== "app-server") process.exit(0);
appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + "\\n");
const rl = readline.createInterface({ input: process.stdin });
const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
let turn = 0;
rl.on("line", (line) => {
  const m = JSON.parse(line);
  if (m.method === "initialize") send({ id: m.id, result: { userAgent: "fake" } });
  else if (m.method === "thread/start" || m.method === "thread/resume") send({ id: m.id, result: { thread: { id: "t" } } });
  else if (m.method === "turn/start") {
    turn += 1;
    const id = "turn-" + turn;
    send({ id: m.id, result: { turn: { id, status: "inProgress" } } });
    send({ method: "item/completed", params: { threadId: "t", turnId: id, item: { type: "agentMessage", id: "m", text: "ok" } } });
    send({ method: "turn/completed", params: { threadId: "t", turn: { id, status: "completed" } } });
  }
});
`, "utf8");
  await chmod(fake, 0o755);
  const previous = process.env.MUSTER_CODEX_COMMAND;
  process.env.MUSTER_CODEX_COMMAND = fake;
  const turn = (codexModelProvider: string | undefined, model: string) => executeRun(defaultConfig(), {
    runtime: "codex",
    model,
    ...(codexModelProvider ? { codexModelProvider } : {}),
    prompt: "hi",
    cwd: dir,
    nativeSession: true,
    nativeTransport: "warm",
    conversationKey: "gateway",
    skipAgentRules: true,
    skipRecall: true,
    skipSkillSelection: true,
    skipMemoryWrite: true,
  } as Parameters<typeof executeRun>[1]);
  try {
    assert.equal((await turn("hybrow", "auto/gpt")).episode.responseText, "ok");
    await turn(undefined, "gpt-6.1-sol");
    const launches = (await readFile(log, "utf8")).trim().split("\n").map((line) => (JSON.parse(line) as string[]).join(" "));
    assert.equal(launches.length, 2, "a different provider starts its own app-server");
    assert.match(launches[0]!, /model_provider="hybrow"/);
    assert.match(launches[0]!, /model="auto\/gpt"/);
    assert.doesNotMatch(launches[1]!, /model_provider=/);
  } finally {
    if (previous === undefined) delete process.env.MUSTER_CODEX_COMMAND;
    else process.env.MUSTER_CODEX_COMMAND = previous;
    clearCodexAppServerSessions();
    await rm(dir, { recursive: true, force: true });
  }
});
