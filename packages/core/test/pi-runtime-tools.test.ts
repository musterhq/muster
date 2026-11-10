import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fauxAssistantMessage, fauxText, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai";
import { defaultConfig, executeRun, type AgentToolEvent } from "../src/index.js";

/** A scripted model behind the real pi AgentSession: no network, real tools. */
async function fauxWorkspace(steps: ReturnType<typeof fauxAssistantMessage>[]) {
  const faux = registerFauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
  faux.setResponses(steps);
  const cwd = await mkdtemp(join(tmpdir(), "muster-pi-tools-"));
  const agentDir = join(cwd, ".pi-agent");
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(agentDir, "models.json"), JSON.stringify({
    providers: { faux: { baseUrl: "http://127.0.0.1:9", api: faux.api, apiKey: "test", models: [{ id: "faux-1", name: "faux" }] } },
  }));
  return {
    cwd,
    agentDir,
    async dispose() {
      faux.unregister();
      await rm(cwd, { recursive: true, force: true });
    },
  };
}

async function runPi(cwd: string, agentDir: string, extra: Record<string, unknown> = {}) {
  const events: AgentToolEvent[] = [];
  const previous = process.env.MUSTER_PI_AGENT_DIR;
  process.env.MUSTER_PI_AGENT_DIR = agentDir;
  try {
    const outcome = await executeRun(defaultConfig(), {
      runtime: "pi",
      provider: "faux",
      model: "faux-1",
      prompt: "make hello.txt and show it",
      cwd,
      skipAgentRules: true,
      skipRecall: true,
      skipSkillSelection: true,
      skipMemoryWrite: true,
      onToolEvent: (event) => events.push(event),
      ...extra,
    });
    return { outcome, events };
  } finally {
    if (previous === undefined) delete process.env.MUSTER_PI_AGENT_DIR;
    else process.env.MUSTER_PI_AGENT_DIR = previous;
  }
}

// Spec: MUS-SPEC-05-1A (docs/spec/clauses/05-pi-runtime-tools.md#mus-spec-05-1a--in-a-writable-workspace-pi-can-edit-files-and-run-commands-and-the-transcript-sees-them)
test("pi turns in a writable workspace edit files, run commands and report tool events", { timeout: 60_000 }, async () => {
  const workspace = await fauxWorkspace([
    fauxAssistantMessage([fauxText("Writing it."), fauxToolCall("write", { path: "hello.txt", content: "hi there\n" })], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxToolCall("bash", { command: "cat hello.txt" })], { stopReason: "toolUse" }),
    fauxAssistantMessage("Done: hello.txt says hi there."),
  ]);
  try {
    const { outcome, events } = await runPi(workspace.cwd, workspace.agentDir);
    assert.equal(outcome.episode.responseText, "Done: hello.txt says hi there.");
    assert.equal(await readFile(join(workspace.cwd, "hello.txt"), "utf8"), "hi there\n");
    assert.deepEqual(events.map((event) => [event.phase, event.kind]), [["start", "tool"], ["end", "tool"], ["start", "command"], ["end", "command"]]);
    assert.match(events[0]!.title, /write.*hello\.txt/);
    const command = events[3]!;
    assert.equal(command.title, "cat hello.txt");
    assert.equal(command.exitCode, 0);
    assert.match(command.output ?? "", /hi there/);
  } finally {
    await workspace.dispose();
  }
});

// Spec: MUS-SPEC-05-1B (docs/spec/clauses/05-pi-runtime-tools.md#mus-spec-05-1b--a-read-only-turn-gives-pi-read-tools-only)
test("read-only pi turns cannot write", { timeout: 60_000 }, async () => {
  const workspace = await fauxWorkspace([
    fauxAssistantMessage([fauxToolCall("write", { path: "blocked.txt", content: "no\n" })], { stopReason: "toolUse" }),
    fauxAssistantMessage("I could not write."),
  ]);
  try {
    const { outcome } = await runPi(workspace.cwd, workspace.agentDir, { nativeSandbox: "read-only" });
    const active = outcome.piResult?.activeTools ?? [];
    assert.ok(active.includes("read"));
    for (const tool of ["write", "edit", "bash"]) assert.ok(!active.includes(tool), `${tool} is not active`);
    await assert.rejects(() => readFile(join(workspace.cwd, "blocked.txt"), "utf8"), /ENOENT/);
  } finally {
    await workspace.dispose();
  }
});

// Spec: MUS-SPEC-05-1C (docs/spec/clauses/05-pi-runtime-tools.md#mus-spec-05-1c--a-missing-pi-key-names-the-provider-and-the-next-step)
test("a missing pi key names the provider, its env var and the next step", async () => {
  const { explainPiError } = await import("../src/pi.js");
  const none = explainPiError("No API key found for the selected model.\n\nUse /login to log into a provider via OAuth or API key. See:\n  /x/providers.md");
  assert.match(none, /ANTHROPIC_API_KEY/);
  assert.match(none, /OPENAI_API_KEY/);
  assert.match(none, /muster pi models/);
  assert.doesNotMatch(none, /Use \/login/, "pi's own /login is not a Muster command");
  const anthropic = explainPiError("No API key found for anthropic.\n\nUse /login …");
  assert.match(anthropic, /anthropic/);
  assert.match(anthropic, /ANTHROPIC_API_KEY/);
  assert.equal(explainPiError("rate limited"), "rate limited");
});

// Spec: MUS-SPEC-05-1C (docs/spec/clauses/05-pi-runtime-tools.md#mus-spec-05-1c--a-missing-pi-key-names-the-provider-and-the-next-step)
test("switching to pi warns up front when no pi provider has a key", async () => {
  const { piNoKeyWarning } = await import("../src/pi.js");
  assert.match(piNoKeyWarning([{ available: false }, { available: false }]) ?? "", /no API key.*ANTHROPIC_API_KEY/);
  assert.equal(piNoKeyWarning([{ available: false }, { available: true }]), undefined);
});
