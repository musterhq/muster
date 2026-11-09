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
