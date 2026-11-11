import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

const run = promisify(execFile);
const cliPath = resolve(import.meta.dirname, "..", "src", "index.ts");

const WEATHER_MANIFEST = {
  id: "weather",
  version: "1.0.0",
  entry: "dist/index.js",
  description: "Current weather for a city",
  permissions: ["tools", "hooks:tool.after", "commands", "net:api.open-meteo.com", "env:WEATHER_UNITS"],
  configSchema: { type: "object", properties: { units: { enum: ["metric", "imperial"] } } },
};

/** Write a code plugin folder: `muster.plugin.json` plus its entry source. */
async function writePlugin(dir: string, manifest: Record<string, unknown>, files: Record<string, string>): Promise<string> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "muster.plugin.json"), JSON.stringify(manifest, null, 2));
  for (const [name, text] of Object.entries(files)) {
    await mkdir(join(dir, name, ".."), { recursive: true });
    await writeFile(join(dir, name), text);
  }
  return dir;
}

function cliEnv(root: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, MUSTER_ONBOARDING_HOME: join(root, ".home"), MUSTER_SKIP_ONBOARDING: "1", NO_COLOR: "1", ...extra };
  delete env.FORCE_COLOR;
  return env;
}

/** Run the real CLI; a non-zero exit resolves with its code instead of throwing. */
async function cli(cwd: string, env: NodeJS.ProcessEnv, ...args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const { stdout, stderr } = await run("tsx", [cliPath, ...args], { cwd, env, timeout: 90_000 });
    return { stdout, stderr, code: 0 };
  } catch (error) {
    const failed = error as { stdout?: string; stderr?: string; code?: number };
    return { stdout: failed.stdout ?? "", stderr: failed.stderr ?? "", code: typeof failed.code === "number" ? failed.code : 1 };
  }
}

// Spec: MUS-SPEC-23-1A (docs/spec/clauses/23-plugin-api.md#mus-spec-23-1a--inspect-reads-the-manifest-and-never-runs-plugin-code)
test("inspect describes a code plugin's permissions without importing it", { timeout: 180_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "muster-plugapi-inspect-"));
  try {
    const marker = join(root, "imported.txt");
    const plugin = await writePlugin(join(root, "weather"), WEATHER_MANIFEST, {
      "dist/index.js": `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "ran");\nexport async function register(ctx) {}\n`,
    });
    const ws = join(root, "ws");
    await mkdir(ws, { recursive: true });
    const env = cliEnv(root);
    await cli(ws, env, "init");

    const out = await cli(ws, env, "plugins", "inspect", plugin);
    assert.equal(out.code, 0, out.stdout + out.stderr);
    assert.match(out.stdout, /id=weather version=1\.0\.0 kind=code/);
    assert.match(out.stdout, /net:api\.open-meteo\.com .*may make network requests to api\.open-meteo\.com/);
    assert.match(out.stdout, /tools .*may add tools/);
    assert.match(out.stdout, /hooks:tool\.after .*may see/);
    assert.match(out.stdout, /commands .*may add chat commands/);
    assert.match(out.stdout, /env:WEATHER_UNITS .*may read the environment variable WEATHER_UNITS/);
    assert.match(out.stdout, /runs_plugin_code=no/);
    assert.equal(existsSync(marker), false, "inspect never imports the entry");

    // Invalid manifests are errors that name the field.
    const cases: Array<[string, Record<string, unknown>, RegExp]> = [
      ["unknown-permission", { ...WEATHER_MANIFEST, id: "bad-perm", permissions: ["tools", "teleport"] }, /field=permissions .*teleport/],
      ["missing-entry", { ...WEATHER_MANIFEST, id: "no-entry", entry: undefined }, /field=entry /],
      ["escaping-entry", { ...WEATHER_MANIFEST, id: "escapes", entry: "../outside.js" }, /field=entry .*outside the plugin folder/],
    ];
    for (const [name, manifest, expected] of cases) {
      const dir = await writePlugin(join(root, name), manifest, { "dist/index.js": "export async function register() {}\n" });
      const result = await cli(ws, env, "plugins", "inspect", dir);
      assert.equal(result.code, 1, `${name} exits 1: ${result.stdout}${result.stderr}`);
      assert.match(result.stdout + result.stderr, expected, name);
    }
    assert.equal(existsSync(marker), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
