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

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await run("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd })).stdout.trim();
}

/** A git repo holding `files`, committed once; returns its HEAD. */
async function gitRepo(dir: string, files: Record<string, string>): Promise<string> {
  await mkdir(dir, { recursive: true });
  for (const [name, text] of Object.entries(files)) {
    await mkdir(join(dir, name, ".."), { recursive: true });
    await writeFile(join(dir, name), text);
  }
  await git(dir, "init", "-q");
  await git(dir, "config", "gc.auto", "0");
  await git(dir, "add", "-A");
  await git(dir, "commit", "-q", "-m", "c");
  return git(dir, "rev-parse", "HEAD");
}

const COMMAND_ENTRY = (name: string, text: string) => `export async function register(ctx) {\n  ctx.command({ name: ${JSON.stringify(name)}, description: "says something", run: async (args) => ${JSON.stringify(text)} + " " + args });\n}\n`;

// Spec: MUS-SPEC-23-3A (docs/spec/clauses/23-plugin-api.md#mus-spec-23-3a--install-pins-shows-permissions-and-honours-the-kill-list)
test("install pins the commit, lists permissions and refuses kill-listed plugins at install and load", { timeout: 240_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "muster-plugapi-install-"));
  try {
    const ws = join(root, "ws");
    await mkdir(ws, { recursive: true });
    const env = cliEnv(root);
    await cli(ws, env, "init");

    // The hub index: a marketplace whose removed.json lists evil-plugin.
    await gitRepo(join(root, "hub"), {
      ".claude-plugin/marketplace.json": JSON.stringify({ name: "fixture-hub", owner: { name: "t" }, plugins: [] }),
      "removed.json": JSON.stringify([{ name: "evil-plugin", reason: "sends tokens to a third party" }]),
    });
    const added = await cli(ws, env, "plugins", "marketplace", "add", `file://${join(root, "hub")}`);
    assert.equal(added.code, 0, added.stdout + added.stderr);

    const commit = await gitRepo(join(root, "weather-src"), {
      "muster.plugin.json": JSON.stringify(WEATHER_MANIFEST),
      "dist/index.js": COMMAND_ENTRY("forecast", "sunny in"),
    });
    const source = `file://${join(root, "weather-src")}`;
    const refusedQuietly = await cli(ws, env, "plugins", "install", source);
    assert.equal(refusedQuietly.code, 1, "a code plugin needs --yes when nobody can answer the prompt");
    assert.match(refusedQuietly.stdout + refusedQuietly.stderr, /--yes/);

    const installed = await cli(ws, env, "plugins", "install", source, "--yes");
    assert.equal(installed.code, 0, installed.stdout + installed.stderr);
    for (const words of ["may add tools the agent can call", "may see each tool call's result after it runs", "may add chat commands", "may make network requests to api.open-meteo.com", "may read the environment variable WEATHER_UNITS"]) {
      assert.ok(installed.stdout.includes(words), `install shows "${words}": ${installed.stdout}`);
    }
    assert.match(installed.stdout, new RegExp(`installed=weather kind=code .*commit=${commit}`));
    const list = await cli(ws, env, "plugins", "list");
    assert.match(list.stdout, new RegExp(`plugin=weather kind=code .*sha=${commit}.*enabled=yes`));

    // Kill-listed at install: a code plugin and a bundle under that name are both refused, and nothing is written.
    const evil = await writePlugin(join(root, "evil"), { ...WEATHER_MANIFEST, id: "evil-plugin" }, { "dist/index.js": COMMAND_ENTRY("evil", "x") });
    const evilBundle = join(root, "evil-bundle");
    await mkdir(join(evilBundle, ".claude-plugin"), { recursive: true });
    await writeFile(join(evilBundle, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "evil-plugin", version: "1.0.0" }));
    for (const dir of [evil, evilBundle]) {
      const refused = await cli(ws, env, "plugins", "install", dir, "--yes");
      assert.equal(refused.code, 1, refused.stdout);
      assert.match(refused.stdout + refused.stderr, /evil-plugin is on the kill list of fixture-hub: sends tokens to a third party/);
    }
    assert.doesNotMatch((await cli(ws, env, "plugins", "list")).stdout, /evil-plugin/);

    // Listed after install: not loaded, one warning line in chat.
    const later = await writePlugin(join(root, "later"), { ...WEATHER_MANIFEST, id: "later-bad", permissions: ["commands"] }, { "dist/index.js": COMMAND_ENTRY("later", "later ran") });
    assert.equal((await cli(ws, env, "plugins", "install", later, "--yes")).code, 0);
    const before = await cli(ws, env, "chat", "/later now");
    assert.match(before.stdout, /later ran now/, "the plugin works before it is listed");
    const cached = join(ws, ".muster");
    const removedFiles = (await run("find", [cached, root + "/.home", "-name", "removed.json", "-path", "*fixture-hub*"])).stdout.trim().split("\n").filter(Boolean);
    assert.equal(removedFiles.length, 1, `one cached hub index: ${removedFiles.join(", ")}`);
    await writeFile(removedFiles[0]!, JSON.stringify([{ name: "evil-plugin", reason: "sends tokens to a third party" }, { name: "later-bad", reason: "found mining" }]));
    const after = await cli(ws, env, "chat", "/later now");
    assert.doesNotMatch(after.stdout, /later ran/, "a kill-listed plugin is not loaded");
    const warnings = (after.stdout + after.stderr).split("\n").filter((line) => /later-bad/.test(line) && /kill list/.test(line));
    assert.equal(warnings.length, 1, `one warning line: ${after.stdout}${after.stderr}`);
    assert.match(warnings[0]!, /found mining/);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
