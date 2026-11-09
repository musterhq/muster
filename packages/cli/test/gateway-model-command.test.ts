import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const cliPath = resolve(import.meta.dirname, "..", "src", "index.ts");

async function setup() {
  const cwd = await mkdtemp(join(tmpdir(), "muster-gateway-cli-"));
  const codexHome = join(cwd, "codex-home");
  await mkdir(codexHome, { recursive: true });
  await writeFile(join(codexHome, "config.toml"), 'model = "gpt-6.1-sol"\n\n[model_providers.hybrow]\nname = "Gateway"\nbase_url = "https://router.example/v1"\nwire_api = "responses"\n');
  const log = join(cwd, "argv.log");
  const fake = join(cwd, "codex");
  await writeFile(fake, `#!/usr/bin/env node
const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + "\\n");
const args = process.argv.slice(2);
if (args.includes("--version")) { console.log("codex-cli 0.200.0"); process.exit(0); }
const flag = args.findIndex((arg) => arg === "-o" || arg === "--output-last-message");
const out = flag >= 0 ? args[flag + 1] : undefined;
if (out) fs.writeFileSync(out, "ok from gateway");
console.log(JSON.stringify({ type: "thread.started", thread_id: "th-1" }));
console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 3 } }));
`, "utf8");
  await chmod(fake, 0o755);
  const env = { ...process.env, CODEX_HOME: codexHome, MUSTER_CODEX_COMMAND: fake, MUSTER_ONBOARDING_HOME: join(cwd, ".test-home"), MUSTER_SKIP_ONBOARDING: "1" };
  delete (env as Record<string, string | undefined>).FORCE_COLOR;
  await execFileAsync("tsx", [cliPath, "init"], { cwd, env });
  return { cwd, env, log };
}

// Spec: MUS-SPEC-07-1B (docs/spec/clauses/07-gateway-models.md#mus-spec-07-1b--model-providermodel-in-chat-selects-a-gateway-model)
test("--model provider:model runs on the gateway provider and unknown providers are refused", { timeout: 120_000 }, async () => {
  const { cwd, env, log } = await setup();
  try {
    const { stdout } = await execFileAsync("tsx", [cliPath, "chat", "--model", "hybrow:auto/gpt", "say ok"], { cwd, env, timeout: 60_000 });
    assert.match(stdout, /ok from gateway/);
    const turnArgs = (await readFile(log, "utf8")).trim().split("\n").map((line) => (JSON.parse(line) as string[]).join(" ")).filter((line) => !line.includes("--version"));
    assert.ok(turnArgs.some((line) => /model_provider="hybrow"/.test(line) && /auto\/gpt/.test(line)), turnArgs.join("\n"));
    const refused = await execFileAsync("tsx", [cliPath, "chat", "--model", "nope:auto/gpt", "say ok"], { cwd, env, timeout: 60_000 }).then(
      (result) => ({ code: 0, out: result.stdout + result.stderr }),
      (error: { code?: number; stdout?: string; stderr?: string }) => ({ code: error.code ?? 1, out: `${error.stdout ?? ""}${error.stderr ?? ""}` }),
    );
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /Unknown Codex model provider "nope".*hybrow/s);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

// Spec: MUS-SPEC-07-2A (docs/spec/clauses/07-gateway-models.md#mus-spec-07-2a--the-model-picker-lists-the-models-codex-offers-today)
test("the model picker lists Codex's live models and falls back when Codex cannot list them", { timeout: 120_000 }, async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-model-list-"));
  const bin = join(cwd, "bin");
  await mkdir(bin, { recursive: true });
  const writeFake = (models: string[] | "fail") => writeFile(join(bin, "codex"), `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "login") process.exit(0);
if (args[0] !== "app-server") process.exit(0);
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
rl.on("line", (line) => {
  const m = JSON.parse(line);
  if (m.method === "initialize") send({ id: m.id, result: { userAgent: "fake" } });
  else if (m.method === "model/list") ${models === "fail" ? 'send({ id: m.id, error: { code: -32000, message: "nope" } })' : `send({ id: m.id, result: { data: ${JSON.stringify(models.map((id) => ({ id, model: id, displayName: id })))} } })`};
});
`, { mode: 0o755 });
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, CODEX_HOME: join(cwd, "codex-home"), MUSTER_ONBOARDING_HOME: join(cwd, ".test-home"), MUSTER_SKIP_ONBOARDING: "1" };
  delete (env as Record<string, string | undefined>).FORCE_COLOR;
  (env as Record<string, string>).MUSTER_CODEX_COMMAND = join(bin, "codex");
  try {
    await writeFake(["gpt-7-test", "gpt-7-mini-test"]);
    await execFileAsync("tsx", [cliPath, "init"], { cwd, env });
    const live = (await execFileAsync("tsx", [cliPath, "chat", "/model"], { cwd, env, timeout: 60_000 })).stdout;
    assert.match(live, /gpt-7-test/);
    assert.match(live, /gpt-7-mini-test/);
    assert.doesNotMatch(live, /5\.6 Luna/, "the stale built-in list is not shown when Codex lists models");
    await writeFake("fail");
    const fallback = (await execFileAsync("tsx", [cliPath, "chat", "/model"], { cwd, env, timeout: 60_000 })).stdout;
    assert.doesNotMatch(fallback, /gpt-7-test/);
    assert.match(fallback, /codex\s+\S/, "a fallback list is still shown");

// Spec: MUS-SPEC-02-2A (docs/spec/clauses/02-chat-composer.md#mus-spec-02-2a--the-slash-menu-shows-each-settings-current-value-and-never-cuts-a-hint-mid-word)
test("the slash menu shows current values and whole argument hints", { timeout: 120_000 }, async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-slash-"));
  const env = { ...process.env, MUSTER_ONBOARDING_HOME: join(cwd, ".test-home"), MUSTER_SKIP_ONBOARDING: "1", NO_COLOR: "1" };
  delete (env as Record<string, string | undefined>).FORCE_COLOR;
  try {
    await execFileAsync("tsx", [cliPath, "init"], { cwd, env });
    const { stdout } = await execFileAsync("tsx", [cliPath, "chat", "--model", "gpt-6.1-terra", "--complete", "/", "--describe"], { cwd, env, timeout: 60_000 });
    const rows = stdout.trim().split("\n").map((line) => line.split("\t"));
    const model = rows.find(([value]) => value === "/model");
    assert.ok(model, stdout);
    assert.match(model[2] ?? "", /^gpt-6\.1-terra · \S+/, `model row: ${model.join(" | ")}`);
    const liveDiff = rows.find(([value]) => value === "/live-diff");
    assert.match(liveDiff?.[2] ?? "", /^on\b/);
    for (const [, label] of rows) {
      assert.ok((label ?? "").length <= 28, `label fits the column: ${label}`);
      assert.doesNotMatch(label ?? "", /\[[^\]]*$/, `no half-open bracket: ${label}`);
    }
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
