import assert from "node:assert/strict";
import { test } from "node:test";
import { detectProviders } from "../src/onboarding-detect.js";
import { onboardingStateForSelections, preselectDetectedProviders, renderOnboarding } from "../src/onboarding-tui.js";

test("detectProviders reports install, login and key state without reading credentials", async () => {
  const detected = await detectProviders({
    env: { OPENAI_API_KEY: "sk-test" },
    home: "/home/u",
    run: async (command) => (command === "codex" ? "codex 1.0" : undefined),
    exists: (path) => path === "/home/u/.codex/auth.json",
  });
  assert.deepEqual(detected.codex, { badge: "ready", ready: true });
  assert.deepEqual(detected.claude, { badge: "not installed", ready: false });
  assert.deepEqual(detected.openai, { badge: "key found", ready: true });
  assert.deepEqual(detected.anthropic, { badge: "no key", ready: false });

  const login = await detectProviders({ env: {}, home: "/h", run: async () => "v", exists: () => false });
  assert.equal(login.codex?.badge, "needs login");
  assert.equal(login.claude?.badge, "needs login");
});

test("the provider step shows detected status, preselects ready routes and drops the login hint for them", async () => {
  const state = onboardingStateForSelections({});
  state.stepIndex = 2;
  state.detected = await detectProviders({ env: {}, home: "/h", run: async (c) => (c === "codex" ? "v" : undefined), exists: () => true });
  preselectDetectedProviders(state);
  assert.deepEqual([...state.selected.provider], ["codex"]);
  const screen = renderOnboarding(state, 120, false);
  assert.match(screen, /Codex\s+ready/);
  assert.match(screen, /Claude Code\s+not installed/);
  assert.match(screen, /OpenAI API\s+no key/);
  assert.doesNotMatch(screen, /configure later: codex login/);

  const manual = onboardingStateForSelections({ provider: ["claude"] });
  manual.stepIndex = 2;
  manual.detected = state.detected;
  preselectDetectedProviders(manual);
  assert.deepEqual([...manual.selected.provider], ["claude"], "an explicit choice is never overridden");
});
