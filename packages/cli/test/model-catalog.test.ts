import assert from "node:assert/strict";
import test from "node:test";
import {
  EFFORT_OPTIONS,
  buildComposerCatalog,
  buildContinuityContext,
  buildReasoningEffortOverride,
  effortDisplayLabel,
  formatModelStatus,
  parseEffortValue,
} from "../src/model-catalog.js";

test("Codex effort labels map exactly to all six config values", () => {
  assert.deepEqual(EFFORT_OPTIONS.map(({ label, value }) => [label, value]), [
    ["Light", "low"],
    ["Medium", "medium"],
    ["High", "high"],
    ["Extra High", "xhigh"],
    ["Max", "max"],
    ["Ultra", "ultra"],
  ]);
  for (const option of EFFORT_OPTIONS) {
    assert.equal(parseEffortValue(option.label), option.value);
    assert.equal(effortDisplayLabel(option.value), option.label);
  }
  assert.equal(EFFORT_OPTIONS.at(-1)?.hint, "Consumes usage limits faster");
});

test("reasoning override construction is the exact Codex config string", () => {
  for (const option of EFFORT_OPTIONS) {
    assert.equal(buildReasoningEffortOverride(option.value), `model_reasoning_effort="${option.value}"`);
  }
});

test("continuity context is deterministic for a fixed transcript and caps at the recent window", () => {
  const messages = [
    { role: "system", content: "Workspace facts" },
    { role: "user", content: "Build the picker.\nKeep it native." },
    { role: "assistant", content: "I found the TUI seam." },
  ];
  assert.equal(buildContinuityContext(messages, 2), [
    "Muster conversation continuity",
    "Summary: The recent context contains 1 user turn and 1 assistant turn. The latest user focus is: Build the picker. Keep it native.",
    "Recent transcript (oldest to newest):",
    "User: Build the picker. Keep it native.\nAssistant: I found the TUI seam.",
    "Continue this same conversation. Do not repeat or describe this handoff unless the user asks.",
  ].join("\n\n"));
});

test("picker model options gate the Claude group on working CLI auth", () => {
  const codexOnly = buildComposerCatalog({ codex: true, claude: false });
  assert.equal(codexOnly.models.length, 4);
  assert.ok(codexOnly.models.every((model) => model.provider === "codex"));
  const both = buildComposerCatalog({ codex: true, claude: true });
  assert.deepEqual(both.models.map((model) => model.provider), ["codex", "codex", "codex", "codex", "claude", "claude", "claude", "claude"]);
  assert.deepEqual(both.models.slice(4).map((model) => model.value), ["claude-fable-5-1", "claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"]);
});

test("status-row model labels use provider names and Codex effort labels", () => {
  assert.equal(formatModelStatus("gpt-5.6-sol", "medium"), "5.6 Sol · Medium");
  assert.equal(formatModelStatus("claude-opus-5-5", "ultra"), "Opus 5.5");
});

// Spec: MUS-SPEC-09-2B (docs/spec/clauses/09-status-bar.md#mus-spec-09-2b--a-chat-names-its-runtime-one-way-and-a-session-reopens-on-its-runtime)
test("runtime names match everywhere and a session reopens on the runtime and model it last used", async () => {
  const { runtimeDisplayName } = await import("../src/model-catalog.js");
  assert.equal(runtimeDisplayName("native"), "codex", "the default runtime is Codex, by name");
  assert.equal(runtimeDisplayName("claude-code"), "claude-code");
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { readChatSessionRoute, writeChatSessionRoute, sessionRouteToRestore } = await import("../src/chat-session-route.js");
  const cwd = await mkdtemp(join(tmpdir(), "muster-route-"));
  try {
    writeChatSessionRoute("qa-4", { runtime: "claude-code", provider: "claude-code", model: "sonnet" }, cwd);
    writeChatSessionRoute("qa-5", { runtime: "codex", provider: "codex", model: "gpt-6.1-terra" }, cwd);
    assert.deepEqual(readChatSessionRoute("qa-4", cwd), { runtime: "claude-code", provider: "claude-code", model: "sonnet" });
    assert.equal(readChatSessionRoute("never-used", cwd), undefined);
    assert.deepEqual(sessionRouteToRestore({}, readChatSessionRoute("qa-4", cwd)), { runtime: "claude-code", provider: "claude-code", model: "sonnet" });
    assert.equal(sessionRouteToRestore({ model: "gpt-6.1-terra" }, readChatSessionRoute("qa-4", cwd)), undefined, "a flag on the command line wins");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
