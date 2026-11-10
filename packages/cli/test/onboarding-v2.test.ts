import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer, type IncomingHttpHeaders } from "node:http";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { promisify } from "node:util";
import { loadConfig } from "@musterhq/core";
import { detectProviders, type DetectedProviders } from "../src/onboarding-detect.js";
import { onboardingStateForSelections, preselectDetectedProviders, renderOnboarding, runMusterOnboardingTui } from "../src/onboarding-tui.js";
import type { VerifyOutcome, VerifyTarget } from "../src/onboarding-verify.js";

const execFileAsync = promisify(execFile);
const cliPath = resolve(import.meta.dirname, "..", "src", "index.ts");

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

function fakeTtyOutput(): { output: PassThrough & NodeJS.WriteStream; read: () => string; lastFrame: () => string } {
  const output = new PassThrough() as PassThrough & NodeJS.WriteStream;
  output.isTTY = true;
  output.columns = 120;
  let raw = "";
  output.on("data", (chunk) => {
    raw += chunk.toString("utf8");
  });
  // Each redraw starts with "clear screen"; the last frame is what the user sees now.
  return { output, read: () => raw, lastFrame: () => raw.split("\x1b[H\x1b[2J").at(-1) ?? "" };
}

const settle = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));

async function press(input: NodeJS.ReadStream & PassThrough, keys: string, ms = 30): Promise<void> {
  input.write(keys);
  await settle(ms);
}

const ENTER = "\r";
const DOWN = "\x1b[B";

/** What a laptop with Codex + Claude Code logged in and an Anthropic-compatible proxy in the env looks like. */
function laptopDetection(overrides: DetectedProviders = {}): DetectedProviders {
  return {
    codex: { badge: "logged in", ready: true, kind: "codex", label: "Codex" },
    claude: { badge: "logged in", ready: true, kind: "claude", label: "Claude Code" },
    "anthropic-proxy": {
      badge: "key ref",
      ready: true,
      kind: "anthropic-http",
      label: "Anthropic-compatible proxy",
      detail: "env ANTHROPIC_BASE_URL (proxy.example) · key ANTHROPIC_AUTH_TOKEN · cc/claude-sonnet-5-5",
      baseUrl: "https://proxy.example",
      keyEnv: "ANTHROPIC_AUTH_TOKEN",
      model: "cc/claude-sonnet-5-5",
    },
    openai: { badge: "no key", ready: false, kind: "openai-http", label: "OpenAI API" },
    anthropic: { badge: "no key", ready: false, kind: "anthropic-http", label: "Anthropic API" },
    ...overrides,
  };
}

function rowFor(screen: string, label: string): string {
  return screen.split("\n").find((line) => line.includes(` ${label} `) && /[✓◇]/.test(line)) ?? "";
}

// Spec: MUS-SPEC-08-1A (docs/spec/clauses/08-onboarding.md#mus-spec-08-1a--detection-finds-env-gateways-codex-providers-and-local-servers-without-reading-secrets)
test("detection finds env gateways, Codex model providers and local servers and never holds a secret value", async () => {
  const codexHome = await mkdtemp(join(tmpdir(), "muster-onb-codex-home-"));
  await writeFile(join(codexHome, "config.toml"), 'model = "gpt-6.1-sol"\n\n[model_providers.hybrow]\nname = "Gateway"\nbase_url = "https://router.example/v1"\n');
  await writeFile(join(codexHome, "auth.json"), "{}");
  const proxySecret = "sk-proxy-SECRET-value-2996";
  const openaiSecret = "sk-openai-SECRET-value-1234";
  const fetched: string[] = [];
  const detected = await detectProviders({
    env: {
      ANTHROPIC_BASE_URL: "https://proxy.example/anthropic",
      ANTHROPIC_AUTH_TOKEN: proxySecret,
      ANTHROPIC_MODEL: "cc/claude-sonnet-5-5",
      OPENAI_BASE_URL: "https://router.example/v1",
      OPENAI_API_KEY: openaiSecret,
      CODEX_HOME: codexHome,
    },
    home: "/home/u",
    run: async (command) => (command === "codex" ? "codex-cli 0.200.0" : undefined),
    exists: (path) => path === join(codexHome, "auth.json"),
    fetch: async (url) => {
      fetched.push(String(url));
      if (String(url).includes(":11434/api/tags")) return new Response(JSON.stringify({ models: [{ name: "qwen3:8b" }] }), { status: 200 });
      throw new Error("connect ECONNREFUSED");
    },
  });

  assert.equal(detected.codex?.badge, "logged in");
  assert.equal(detected.codex?.ready, true);
  assert.equal(detected["anthropic-proxy"]?.label, "Anthropic-compatible proxy");
  assert.equal(detected["anthropic-proxy"]?.badge, "key ref");
  assert.equal(detected["anthropic-proxy"]?.ready, true);
  assert.equal(detected["anthropic-proxy"]?.keyEnv, "ANTHROPIC_AUTH_TOKEN");
  assert.equal(detected["anthropic-proxy"]?.baseUrl, "https://proxy.example/anthropic");
  assert.equal(detected["anthropic-proxy"]?.model, "cc/claude-sonnet-5-5");
  assert.equal(detected.openai?.badge, "key ref");
  assert.equal(detected.openai?.keyEnv, "OPENAI_API_KEY");
  assert.equal(detected.openai?.baseUrl, "https://router.example/v1");
  assert.equal(detected["codex-provider:hybrow"]?.ready, true, "a Codex [model_providers.hybrow] table is a route");
  assert.equal(detected.ollama?.badge, "running");
  assert.equal(detected.ollama?.model, "qwen3:8b");
  assert.equal(detected.lmstudio, undefined, "LM Studio is not running, so it is not listed");
  assert.ok(fetched.some((url) => url.includes("127.0.0.1:1234/v1/models")), "LM Studio was probed");

  const serialized = JSON.stringify(detected);
  assert.ok(!serialized.includes(proxySecret) && !serialized.includes(openaiSecret), "detection keeps references, never values");

  const state = onboardingStateForSelections({});
  state.stepIndex = 2;
  state.detected = detected;
  preselectDetectedProviders(state);
  const screen = renderOnboarding(state, 140, false);
  assert.match(rowFor(screen, "Anthropic-compatible proxy"), /key ref/);
  assert.match(rowFor(screen, "Codex provider hybrow"), /\S/);
  assert.match(rowFor(screen, "Ollama"), /running/);
  assert.ok(!screen.includes(proxySecret) && !screen.includes(openaiSecret), "the screen never shows a secret value");
  assert.ok(!screen.includes("SECRET"), "not even a fragment of it");
});

// Spec: MUS-SPEC-08-1B (docs/spec/clauses/08-onboarding.md#mus-spec-08-1b--a-hung-local-port-never-stalls-detection)
test("a local server that never answers does not stall detection", async () => {
  const started = Date.now();
  const detected = await detectProviders({
    env: {},
    home: "/h",
    run: async () => undefined,
    exists: () => false,
    fetch: () => new Promise<Response>(() => undefined),
  });
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 1500, `detection took ${elapsed} ms`);
  assert.equal(detected.ollama, undefined);
  assert.equal(detected.lmstudio, undefined);
  assert.equal(detected.codex?.badge, "not installed");
});

// Spec: MUS-SPEC-08-2A (docs/spec/clauses/08-onboarding.md#mus-spec-08-2a--the-model-step-opens-on-the-detected-routes-ready-ones-pre-selected)
test("the model step lists detected routes with status pills and ticks the ready ones", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-onb-v2-model-"));
  const input = fakeTtyInput();
  const { output, lastFrame } = fakeTtyOutput();
  const running = runMusterOnboardingTui(["--no-chat", "--no-color"], { cwd, input, output, detect: async () => laptopDetection(), verify: async () => ({ ok: true, ms: 1000 }) });
  await settle();
  await press(input, ENTER);
  await press(input, ENTER);
  const screen = lastFrame();
  assert.match(screen, /03 \/ MODEL/);
  assert.match(rowFor(screen, "Codex"), /✓ Codex\s+logged in/);
  assert.match(rowFor(screen, "Claude Code"), /✓ Claude Code\s+logged in/);
  assert.match(rowFor(screen, "Anthropic-compatible proxy"), /✓ Anthropic-compatible proxy\s+key ref/);
  assert.match(rowFor(screen, "OpenAI API"), /◇ OpenAI API\s+no key/);
  assert.doesNotMatch(screen, /configure later: codex login/);
  assert.doesNotMatch(screen, /claude (auth )?login/);
  await press(input, "q");
  await press(input, "y");
  assert.equal((await running).saved, false);
});

// Spec: MUS-SPEC-08-3A (docs/spec/clauses/08-onboarding.md#mus-spec-08-3a--leaving-the-model-step-verifies-every-selected-route-in-parallel-and-shows-the-real-result)
test("leaving the model step verifies selected routes in parallel and offers edit or skip on failure", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-onb-v2-verify-"));
  const input = fakeTtyInput();
  const { output, lastFrame } = fakeTtyOutput();
  let inFlight = 0;
  let maxInFlight = 0;
  const calls: string[] = [];
  const verify = async (route: VerifyTarget): Promise<VerifyOutcome> => {
    calls.push(route.id);
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await settle(40);
    inFlight -= 1;
    if (route.id === "codex") return { ok: true, ms: 1900 };
    if (route.id === "anthropic-proxy") return { ok: true, ms: 2400, model: "cc/claude-sonnet-5-5" };
    return { ok: false, error: "Invalid API key · Please run /login" };
  };
  const running = runMusterOnboardingTui(["--no-chat", "--no-color"], { cwd, input, output, detect: async () => laptopDetection(), verify });
  await settle();
  await press(input, ENTER);
  await press(input, ENTER);
  await press(input, ENTER, 150);

  assert.equal(maxInFlight, 3, "all selected routes are checked at the same time");
  assert.deepEqual([...calls].sort(), ["anthropic-proxy", "claude", "codex"]);
  let screen = lastFrame();
  assert.match(screen, /✓ Codex · replied in 1\.9 s/);
  assert.match(screen, /✓ Anthropic-compatible proxy · cc\/claude-sonnet-5-5 · replied in 2\.4 s/);
  assert.match(screen, /✗ Claude Code · Invalid API key · Please run \/login/);
  assert.match(screen, /e Edit/);
  assert.match(screen, /k Skip/);
  assert.match(screen, /03 \/ MODEL/, "results stay on the model step until the user decides");

  await press(input, "e");
  screen = lastFrame();
  assert.match(screen, /03 \/ MODEL/);
  assert.doesNotMatch(screen, /replied in/, "edit returns to the route list");
  assert.match(rowFor(screen, "Claude Code"), /✓ Claude Code/);

  await press(input, ENTER, 150);
  assert.equal(calls.filter((id) => id === "claude").length, 2, "Enter verifies again");
  await press(input, "k");
  screen = lastFrame();
  assert.match(screen, /04 \/ SENSES/, "skip moves on");
  const rail = screen.split("\n").map((line) => line.split("│").at(-2) ?? "").join("\n");
  assert.match(rail, /Codex/);
  assert.doesNotMatch(rail, /Claude Code/, "the failed route is no longer selected");

  await press(input, "q");
  await press(input, "y");
  await running;
});

async function walkToFinish(options: { verify: (route: VerifyTarget) => Promise<VerifyOutcome>; detected: DetectedProviders; pickSlack?: boolean }) {
  const cwd = await mkdtemp(join(tmpdir(), "muster-onb-v2-finish-"));
  const input = fakeTtyInput();
  const view = fakeTtyOutput();
  const running = runMusterOnboardingTui(["--no-chat", "--no-color"], { cwd, input, output: view.output, detect: async () => options.detected, verify: options.verify });
  await settle();
  await press(input, ENTER); // purpose
  await press(input, ENTER); // priorities
  await press(input, ENTER, 150); // model → verify
  await press(input, ENTER); // continue past the results
  await press(input, ENTER); // senses
  if (options.pickSlack) {
    await press(input, DOWN);
    await press(input, " ");
  }
  await press(input, ENTER); // channels
  await press(input, ENTER); // memory → finish
  return { cwd, input, running, view };
}

const codexFailsProxyReplies = async (route: VerifyTarget): Promise<VerifyOutcome> =>
  route.id === "codex" ? { ok: false, error: "401 Unauthorized: not logged in" } : { ok: true, ms: 2400, model: route.model };

// Spec: MUS-SPEC-08-3B (docs/spec/clauses/08-onboarding.md#mus-spec-08-3b--a-route-that-failed-verification-is-never-saved-as-the-default)
test("a route that failed verification is never saved as the default", async () => {
  const home = await mkdtemp(join(tmpdir(), "muster-onb-v2-home-"));
  const previousHome = process.env.MUSTER_ONBOARDING_HOME;
  process.env.MUSTER_ONBOARDING_HOME = home;
  try {
    const detected = laptopDetection({ claude: { badge: "not installed", ready: false, kind: "claude", label: "Claude Code" } });
    const { cwd, input, running } = await walkToFinish({ detected, verify: codexFailsProxyReplies });
    await press(input, ENTER, 400); // save
    await press(input, "x");
    assert.equal((await running).saved, true);
    const config = await loadConfig(cwd);
    assert.equal(config.runtimes.native.provider, "anthropic-proxy", "the verified proxy is the default, not the failed Codex");
    assert.equal(config.providers["anthropic-proxy"]?.kind, "anthropic");
    assert.equal(config.providers["anthropic-proxy"]?.baseUrl, "https://proxy.example");
    assert.equal(config.providers["anthropic-proxy"]?.apiKeyEnv, "ANTHROPIC_AUTH_TOKEN");
    assert.equal(config.runtimes.native.routes.simple_qa?.model, "cc/claude-sonnet-5-5");
    const profile = JSON.parse(await readFile(join(cwd, ".muster", "onboarding-profile.json"), "utf8")) as { defaultRoute: string | null; verification: Array<{ id: string; ok: boolean; error?: string }>; configured: string[] };
    assert.equal(profile.defaultRoute, "anthropic-proxy");
    assert.deepEqual(profile.verification.find((entry) => entry.id === "codex"), { id: "codex", label: "Codex", ok: false, error: "401 Unauthorized: not logged in" });
    assert.ok(!profile.configured.some((entry) => entry.startsWith("runtime:native->codex")));

    // Nothing verified: no default route is written at all.
    const allFail = await walkToFinish({ detected, verify: async () => ({ ok: false, error: "connect ECONNREFUSED" }) });
    await press(allFail.input, ENTER, 400);
    await press(allFail.input, "x");
    await allFail.running;
    const failedProfile = JSON.parse(await readFile(join(allFail.cwd, ".muster", "onboarding-profile.json"), "utf8")) as { defaultRoute: string | null; configured: string[] };
    assert.equal(failedProfile.defaultRoute, null);
    assert.ok(!failedProfile.configured.some((entry) => entry.startsWith("runtime:native->")));
  } finally {
    if (previousHome === undefined) delete process.env.MUSTER_ONBOARDING_HOME;
    else process.env.MUSTER_ONBOARDING_HOME = previousHome;
  }
});

// Spec: MUS-SPEC-08-4A (docs/spec/clauses/08-onboarding.md#mus-spec-08-4a--the-finish-screen-is-an-honest-capability-summary)
test("the finish screen counts ready capabilities and names the exact fix for each missing one", async () => {
  const detected = laptopDetection({ claude: { badge: "not installed", ready: false, kind: "claude", label: "Claude Code" } });
  const { input, running, view } = await walkToFinish({ detected, verify: codexFailsProxyReplies, pickSlack: true });
  const screen = view.lastFrame();
  assert.match(screen, /Ready 3\/5/);
  assert.match(screen, /✓ chat · default route Anthropic-compatible proxy/);
  assert.match(screen, /✓ Anthropic-compatible proxy · cc\/claude-sonnet-5-5 · replied in 2\.4 s/);
  assert.match(screen, /✗ Codex · 401 Unauthorized: not logged in · fix: codex login/);
  assert.match(screen, /✓ memory \(ask\)/);
  assert.match(screen, /✗ Slack · fix: muster channels setup slack --bot-token-env SLACK_BOT_TOKEN --app-token-env SLACK_APP_TOKEN/);
  assert.doesNotMatch(screen, /It knows what to remember/);
  await press(input, "q");
  await press(input, "y");
  await running;
});

// Spec: MUS-SPEC-08-3C (docs/spec/clauses/08-onboarding.md#mus-spec-08-3c--muster-onboard---preview---verify-makes-real-requests-and-shows-real-errors)
test("onboard --preview --verify runs one real request per route and never prints the key", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "muster-onb-v2-cli-"));
  const home = join(root, "home");
  const codexHome = join(root, "codex-home");
  const bin = join(root, "bin");
  await mkdir(home, { recursive: true });
  await mkdir(codexHome, { recursive: true });
  await mkdir(bin, { recursive: true });
  await writeFile(join(codexHome, "auth.json"), "{}");
  await writeFile(join(codexHome, "config.toml"), 'model = "gpt-6.1-sol"\n');
  await writeFile(join(home, ".claude.json"), "{}");
  const codex = join(bin, "codex");
  await writeFile(codex, `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args.includes("--version")) { console.log("codex-cli 0.200.0"); process.exit(0); }
const flag = args.findIndex((arg) => arg === "-o" || arg === "--output-last-message");
if (flag >= 0) fs.writeFileSync(args[flag + 1], "OK");
console.log(JSON.stringify({ type: "thread.started", thread_id: "th-1" }));
console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 1 } }));
`);
  await writeFile(join(bin, "claude"), `#!/usr/bin/env node
if (process.argv.includes("--version")) { console.log("2.1.0 (Claude Code)"); process.exit(0); }
console.log("Invalid API key · Please run /login");
process.exit(1);
`);
  await chmod(codex, 0o755);
  await chmod(join(bin, "claude"), 0o755);

  const token = "sk-cli-proxy-SECRET-7781";
  const requests: Array<{ url?: string; headers: IncomingHttpHeaders; body: string }> = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      requests.push({ url: req.url, headers: req.headers, body });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ content: [{ type: "text", text: "OK" }] }));
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const port = (server.address() as { port: number }).port;
  try {
    const env: Record<string, string | undefined> = {
      ...process.env,
      HOME: home,
      CODEX_HOME: codexHome,
      PATH: `${bin}:${process.env.PATH}`,
      MUSTER_CODEX_COMMAND: codex,
      MUSTER_ONBOARDING_HOME: join(root, ".test-home"),
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
      ANTHROPIC_AUTH_TOKEN: token,
      ANTHROPIC_MODEL: "cc/claude-sonnet-5-5",
      OLLAMA_HOST: "http://127.0.0.1:9",
      MUSTER_LMSTUDIO_URL: "http://127.0.0.1:9",
    };
    for (const key of ["FORCE_COLOR", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENAI_BASE_URL", "CLAUDE_CODE_OAUTH_TOKEN"]) delete env[key];
    const { stdout: raw } = await execFileAsync("tsx", [cliPath, "onboard", "--preview", "--step", "provider", "--verify", "--no-color"], { cwd: root, env, timeout: 90_000, maxBuffer: 1024 * 1024 });
    // A long result line wraps inside the body column; read the body as the user does.
    const stdout = raw.split("\n").map((line) => line.replace(/^\s*[╭╰].*$/, "").replace(/^│/, "").replace(/│.*$/, "")).join(" ").replace(/\s+/g, " ");
    assert.match(stdout, /✓ Codex · replied in \d+(\.\d)? s/);
    assert.match(stdout, /✓ Anthropic-compatible proxy · cc\/claude-sonnet-5-5 · replied in \d+(\.\d)? s/);
    assert.match(stdout, /✗ Claude Code · Invalid API key/);
    assert.equal(requests.length, 1, "one small request to the gateway");
    assert.equal(requests[0]!.url, "/v1/messages");
    assert.ok(JSON.stringify(requests[0]!.headers).includes(token), "the referenced key is resolved only at request time");
    assert.ok(!raw.includes(token) && !raw.includes("SECRET"), "the key is never printed");
  } finally {
    server.close();
  }
});

// Spec: MUS-SPEC-08-3D (docs/spec/clauses/08-onboarding.md#mus-spec-08-3d--a-codex-model-provider-is-verified-with-a-model-it-serves)
test("a Codex model provider is verified with a model it serves, and a rejected default model gets a model fix", { timeout: 60_000 }, async () => {
  const { verifyRoute, verifyTargetFor } = await import("../src/onboarding-verify.js");
  const codexHome = await mkdtemp(join(tmpdir(), "muster-onb-gw-"));
  await writeFile(join(codexHome, "config.toml"), [
    'model = "gpt-6.1-terra"',
    "",
    "[profiles.gw]",
    'model_provider = "gw2"',
    'model = "auto/gpt"',
    "",
    "[model_providers.hybrow]",
    'name = "Gateway"',
    'base_url = "https://router.example/v1"',
    "",
    "[model_providers.gw2]",
    'base_url = "https://gw2.example/v1"',
    "",
    "[model_providers.bare]",
    'base_url = "https://bare.example/v1"',
    "",
  ].join("\n"));
  const log = join(codexHome, "argv.log");
  const fake = join(codexHome, "codex");
  await writeFile(fake, `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("--version")) process.exit(0);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + "\\n");
const m = args.indexOf("-m");
const model = m >= 0 ? args[m + 1] : "gpt-6.1-terra";
if (!["cc/claude-sonnet-5-5", "auto/gpt"].includes(model)) {
  const message = "[400]: The '" + model + "' model is not supported when using Codex with a ChatGPT account.";
  console.log(JSON.stringify({ type: "error", message }));
  console.log(JSON.stringify({ type: "turn.failed", error: { message } }));
  process.exit(1);
}
const o = args.indexOf("-o") >= 0 ? args.indexOf("-o") : args.indexOf("--output-last-message");
if (o >= 0) fs.writeFileSync(args[o + 1], "OK");
console.log(JSON.stringify({ type: "thread.started", thread_id: "t" }));
console.log(JSON.stringify({ type: "item.completed", item: { id: "i", type: "agent_message", text: "OK" } }));
console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } }));
`, "utf8");
  await chmod(fake, 0o755);
  const detected = await detectProviders({
    env: { CODEX_HOME: codexHome, ANTHROPIC_BASE_URL: "https://router.example", ANTHROPIC_AUTH_TOKEN: "x-token-123456", ANTHROPIC_MODEL: "cc/claude-sonnet-5-5" },
    home: "/home/u",
    run: async (command) => (command === "codex" ? "codex-cli 0.200.0" : undefined),
    exists: () => true,
    fetch: async () => { throw new Error("offline"); },
  });
  assert.equal(detected["codex-provider:hybrow"]?.model, "cc/claude-sonnet-5-5", "a model from an env route on the same gateway host");
  assert.equal(detected["codex-provider:gw2"]?.model, "auto/gpt", "a model from a Codex profile for that provider");
  assert.equal(detected["codex-provider:bare"]?.model, undefined);

  const previous = process.env.MUSTER_CODEX_COMMAND;
  process.env.MUSTER_CODEX_COMMAND = fake;
  try {
    for (const id of ["hybrow", "gw2"]) {
      const target = verifyTargetFor(`codex-provider:${id}`, id, detected[`codex-provider:${id}`])!;
      const outcome = await verifyRoute(target);
      assert.equal(outcome.ok, true, `${id}: ${JSON.stringify(outcome)}`);
    }
    const lines = (await readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as string[]);
    assert.ok(lines.some((args) => args.join(" ").includes('model_provider="hybrow"') && args.includes("cc/claude-sonnet-5-5")), JSON.stringify(lines));
    const bare = await verifyRoute(verifyTargetFor("codex-provider:bare", "bare", detected["codex-provider:bare"])!);
    assert.equal(bare.ok, false);
    assert.match(bare.ok ? "" : bare.error, /gpt-6\.1-terra.*not served by bare|not served by bare.*gpt-6\.1-terra/);
  } finally {
    if (previous === undefined) delete process.env.MUSTER_CODEX_COMMAND;
    else process.env.MUSTER_CODEX_COMMAND = previous;
  }

  const state = onboardingStateForSelections({});
  state.detected = detected;
  state.selected.provider = new Set(["codex-provider:bare"]);
  state.verify = { running: false, order: ["codex-provider:bare"], targets: {}, results: { "codex-provider:bare": { ok: false, error: "Codex's default model gpt-6.1-terra is not served by bare" } } };
  state.stepIndex = 99;
  const finish = renderOnboarding(state, 160, false);
  assert.doesNotMatch(finish, /check \[model_providers\.bare\]/);
  assert.match(finish, /muster chat --model bare:<model>/);

  const verified: string[] = [];
  const view = fakeTtyOutput();
  await runMusterOnboardingTui(["--preview", "--verify", "--no-color"], {
    cwd: codexHome,
    output: view.output,
    detect: async () => detected,
    verify: async (target) => { verified.push(target.id); return { ok: true, ms: 1000 }; },
  });
  assert.ok(verified.length > 0, "--verify without --step still verifies the model step");
});
