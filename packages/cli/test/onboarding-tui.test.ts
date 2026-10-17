import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { PassThrough } from "node:stream";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { addMemory, loadConfig, MemoryPolicyError } from "@musterhq/core";
import { loadGatewayConfig } from "@musterhq/gateway";
import { applyOnboardingProfile, globalOnboardingProfilePath, memoryPolicyForSelections, onboardingProfilePath, onboardingStateForSelections, renderOnboarding, runMusterOnboardingTui } from "../src/onboarding-tui.js";

function fakeTtyInput(): PassThrough & NodeJS.ReadStream {
  const input = new PassThrough() as PassThrough & NodeJS.ReadStream & { isRaw: boolean };
  input.isTTY = true;
  input.isRaw = false;
  input.setRawMode = (mode: boolean) => {
    input.isRaw = mode;
    return input;
  };
  return input;
}

function fakeTtyOutput(): { output: PassThrough & NodeJS.WriteStream; read: () => string } {
  const output = new PassThrough() as PassThrough & NodeJS.WriteStream;
  output.isTTY = true;
  output.columns = 100;
  let raw = "";
  output.on("data", (chunk) => {
    raw += chunk.toString("utf8");
  });
  return { output, read: () => raw };
}

async function tick(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

test("onboarding applies real providers, plugins, MCPs, channels, memory policy, and profiles", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-onboarding-apply-"));
  const home = await mkdtemp(join(tmpdir(), "muster-onboarding-home-"));
  const state = onboardingStateForSelections({
    purpose: ["code", "frappe", "research"],
    style: ["speed", "tokens", "privacy"],
    provider: ["codex", "openai", "claude", "selfhosted"],
    integrations: ["frappe", "github", "browser", "web", "mcp", "artifacts"],
    channels: ["slack", "google-chat", "whatsapp"],
    memory: ["project", "preferences", "ask"],
  });

  const applied = await applyOnboardingProfile(state, cwd, home);
  const config = await loadConfig(cwd);
  const gateway = await loadGatewayConfig(cwd);
  const workspaceProfile = JSON.parse(await readFile(onboardingProfilePath(cwd), "utf8")) as {
    configured: string[];
    nextActions: Array<{ id: string; command?: string; url?: string; env?: string[] }>;
  };
  const globalProfile = JSON.parse(await readFile(globalOnboardingProfilePath(home), "utf8")) as {
    lastWorkspaceProfilePath: string;
    configured: string[];
  };

  assert.equal(config.providers.codex?.kind, "codex-cli");
  assert.equal(config.providers.openai?.kind, "openai");
  assert.equal(config.providers.selfhosted, undefined);
  assert.equal(config.runtimes.native.provider, "codex");
  assert.equal(config.runtimes.native.routes.simple_qa.provider, "codex");

  assert.ok(!config.plugins?.allow?.includes("frappe-federated-bridge"), "high-risk plugins are not enabled silently");

  assert.ok(config.plugins?.allow?.includes("web-frameworks"));
  assert.ok(config.plugins?.allow?.includes("github"));
  assert.ok(!config.plugins?.allow?.includes("browser"), "browser is high risk: opt-in");
  assert.ok(config.plugins?.allow?.includes("artifact-studio"));
  assert.ok(!config.plugins?.load?.paths?.some((path) => /(?:capability|builtin)-packs[\\/]frappe/.test(path)), "frappe pack is opt-in (high risk)");

  assert.equal(config.tools?.mcp?.servers?.git?.transport.kind, "stdio");
  assert.equal(config.tools?.mcp?.servers?.sqlite?.transport.kind, "stdio");
  assert.equal(config.tools?.mcp?.servers?.browser?.transport.kind, "stdio");
  assert.equal(config.tools?.mcp?.servers?.["parallel-search"]?.transport.kind, "http");
  assert.equal(config.tools?.mcp?.servers?.notion?.auth, "oauth");

  assert.ok(gateway.token);
  assert.ok(applied.gatewayPath?.endsWith(".muster/gateway.json"));
  assert.equal(config.identity?.name, "Muster");
  assert.match(config.identity?.persona ?? "", /scoped memory/);

  assert.ok(workspaceProfile.configured.includes("provider:codex"));
  assert.ok(workspaceProfile.configured.includes("provider:selfhosted:manual"));
  assert.ok(workspaceProfile.configured.includes("channel:slack:gateway-ready"));
  assert.ok(workspaceProfile.nextActions.some((action) => action.id === "slack" && action.env?.includes("SLACK_BOT_TOKEN")));
  assert.ok(workspaceProfile.nextActions.some((action) => action.id === "gchat" && action.command === "muster channels ready gchat --audience https://your-domain.example/v1/adapters/gchat --no-start" && !action.env?.length));
  assert.ok(workspaceProfile.nextActions.some((action) => action.id === "openai" && action.url?.includes("platform.openai.com")));
  assert.ok(workspaceProfile.nextActions.some((action) => action.id === "notion" && action.command === "muster mcp oauth setup notion"));

  assert.ok(workspaceProfile.nextActions.some((action) => action.id === "frappe-federated-bridge" && action.command === "muster plugins enable frappe-federated-bridge"));
  assert.equal(globalProfile.lastWorkspaceProfilePath, onboardingProfilePath(cwd));
  assert.ok(globalProfile.configured.includes("memory:scoped-policy"));
});

test("interactive onboarding redraws in one live screen and ignores normal character keys", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-onboarding-redraw-"));
  const input = fakeTtyInput();
  const { output, read } = fakeTtyOutput();
  const running = runMusterOnboardingTui(["--no-chat", "--no-color"], { cwd, input, output });

  await tick();
  input.write("\x1b[B");
  await tick();
  input.write("x");
  await tick();
  input.write("q");

  const result = await running;
  const raw = read();
  assert.equal(result.saved, false);
  assert.match(raw, /\x1b\[\?1049h/, "onboarding should enter the alternate screen to avoid scrollback panes");
  assert.match(raw, /\x1b\[\?1049l/, "onboarding should leave the alternate screen on cleanup");
  assert.equal((raw.match(/Muster onboarding/g) ?? []).length, 2, "initial render plus Down update only; ordinary character keys should not append duplicate frames");
});

test("every step carries a running summary of the steps before it", async () => {
  const state = onboardingStateForSelections({
    purpose: ["code", "memory"],
    style: [],
    provider: ["codex", "claude"],
  });

  // Step 4 (integrations): the rail must carry purpose, style, and provider.
  state.stepIndex = 3;
  const screen = renderOnboarding(state, 120, false);
  assert.match(screen, /So far:/);
  assert.match(screen, /01 \/ shape/);
  assert.match(screen, /Build with code/);
  assert.match(screen, /Personal memory/);
  assert.match(screen, /02 \/ priorities/);
  assert.match(screen, /— skipped/, "a step left empty is stated as skipped, not hidden");
  assert.match(screen, /03 \/ model/);
  assert.match(screen, /Claude Code/);
  assert.doesNotMatch(screen, /04 \/ senses\s+\n?.*So far/, "the rail lists prior steps, not the current one");

  // First step: the rail exists and says so, rather than showing an empty column.
  const emptyState = onboardingStateForSelections({});
  emptyState.stepIndex = 0;
  const first = renderOnboarding(emptyState, 120, false);
  assert.match(first, /So far:/);
  assert.match(first, /Nothing chosen yet/);

  // Narrow terminals keep the summary; they stack it instead of dropping it.
  const narrow = renderOnboarding(state, 76, false);
  assert.match(narrow, /So far:/);
  assert.match(narrow, /Build with code/);

  // Every step, not just some: walk all of them.
  for (let index = 0; index < 6; index += 1) {
    state.stepIndex = index;
    assert.match(renderOnboarding(state, 120, false), /So far:/, `step ${index} lost the summary rail`);
    assert.match(renderOnboarding(state, 120, false), /every step optional — s starts coding now/, `step ${index} lost the optional hint`);
  }
});

test("the setup surface names runnable commands and never fakes an input field", async () => {
  const state = onboardingStateForSelections({ channels: ["slack", "whatsapp"] });
  state.stepIndex = 4;
  const screen = renderOnboarding(state, 130, false);
  assert.match(screen, /configure later: muster channels setup slack --bot-token-env/);
  assert.match(screen, /SLACK_BOT_TOKEN/);
  assert.match(screen, /muster channels login whatsapp/);
  assert.match(screen, /Meta ToS gray zone/);
  assert.doesNotMatch(screen, /Bot token\/env:/, "credential fields that could not be typed into are gone");
  assert.doesNotMatch(screen, /Access token\/env:/);
});

test("the memory step writes an ENFORCED policy, not only persona prose", async () => {
  for (const [selection, expected] of [[["never"], "never"], [["ask"], "ask"], [["project"], "ask"], [["auto"], "auto"], [["ask", "never"], "never"]] as const) {
    const cwd = await mkdtemp(join(tmpdir(), "muster-onboarding-memory-"));
    const home = await mkdtemp(join(tmpdir(), "muster-onboarding-memory-home-"));
    const state = onboardingStateForSelections({ memory: [...selection] });
    assert.equal(memoryPolicyForSelections(state), expected);

    const applied = await applyOnboardingProfile(state, cwd, home);
    const config = await loadConfig(cwd);
    assert.equal(config.memory?.policy, expected, `memory:${selection.join("+")} must persist policy ${expected}`);
    assert.ok(applied.configured.includes(`memory:policy=${expected}`));

    // The policy is not advice: the write path enforces it.
    if (expected === "auto") {
      const written = await addMemory({ summary: "auto policy fact", provenance: ["onboarding:test"], scopes: [{ kind: "user", id: "me" }] }, cwd);
      assert.ok(written.id.startsWith("mem_"));
      continue;
    }
    await assert.rejects(
      () => addMemory({ summary: "policy fact", provenance: ["onboarding:test"], scopes: [{ kind: "user", id: "me" }] }, cwd),
      (error: unknown) => error instanceof MemoryPolicyError && error.policy === expected,
      `memory:${selection.join("+")} must block an unconsented durable write`,
    );
  }
});

test("Claude Code does not add the API preset, high-risk plugins are not enabled silently, and write policies are exclusive", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-onboarding-claude-"));
  const home = await mkdtemp(join(tmpdir(), "muster-onboarding-claude-home-"));
  const state = onboardingStateForSelections({ provider: ["claude"], integrations: [] });
  const applied = await applyOnboardingProfile(state, cwd, home);
  const config = await loadConfig(cwd);
  assert.ok(!applied.configured.includes("provider:anthropic"));
  assert.equal(Object.keys(config.providers ?? {}).includes("anthropic"), false);
  assert.equal(config.tools?.mcp?.servers?.git, undefined, "git MCP is no longer added unasked");
  assert.equal(config.tools?.mcp?.servers?.sqlite, undefined);

});

test("quit asks before discarding choices, finish lists what it will write, and the checklist waits for a key", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-onboarding-quit-"));
  const input = fakeTtyInput();
  const { output, read } = fakeTtyOutput();
  const running = runMusterOnboardingTui(["--no-chat", "--no-color"], { cwd, input, output });
  await tick();
  input.write(" "); await tick();
  input.write("q"); await tick();
  assert.match(read(), /Discard your choices and quit\?/);
  input.write("n"); await tick();
  input.write("\x03"); await tick();
  input.write("y");
  assert.equal((await running).saved, false);

  const state = onboardingStateForSelections({ purpose: ["code"], memory: ["never"] });
  const finish = renderOnboarding(state, 120, false);
  assert.match(finish, /Will write/);
  assert.match(finish, /memory write policy: never/);
  assert.match(finish, /Nothing is saved until you press Enter/);

  const fakeHome = await mkdtemp(join(tmpdir(), "muster-onboarding-quit-home-"));
  const previousHome = process.env.MUSTER_ONBOARDING_HOME;
  process.env.MUSTER_ONBOARDING_HOME = fakeHome;
  try {
  const input2 = fakeTtyInput();
  const second = fakeTtyOutput();
  let settled = false;
  const saving = runMusterOnboardingTui(["--no-chat", "--no-color"], { cwd, input: input2, output: second.output }).then((r) => { settled = true; return r; });
  await tick();
  input2.write("s");
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(settled, false, "the post-save checklist stays up until a key is pressed");
  assert.match(second.read(), /Saved\. Press any key to continue\./);
  input2.write("x");
  assert.equal((await saving).saved, true);
  } finally {
    if (previousHome === undefined) delete process.env.MUSTER_ONBOARDING_HOME;
    else process.env.MUSTER_ONBOARDING_HOME = previousHome;
  }
});
