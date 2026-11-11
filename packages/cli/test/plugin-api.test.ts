import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import readline from "node:readline";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { createHookBus, createPluginRuntime, createToolRegistry, readPluginBundleLock, readPluginLedger, registerBuiltinTools } from "@musterhq/core";

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
    const removedFiles = (await run("find", [cached, "-name", "removed.json", "-path", "*fixture-hub*"])).stdout.trim().split("\n").filter(Boolean);
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

/** Poll until `check` holds; fails after `ms`. */
async function waitFor(check: () => boolean | Promise<boolean>, what: string, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((done) => setTimeout(done, 25));
  }
}

const alive = (pid: number | undefined): boolean => {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
};

/** The full weather plugin: a tool, a tool.after hook and a /forecast command. */
const WEATHER_ENTRY = (baseUrl: string) => `
export async function register(ctx) {
  ctx.tool({
    name: "weather_now",
    description: "Current temperature for a city",
    inputSchema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
    async handler({ city }) {
      const response = await ctx.fetch(${JSON.stringify(baseUrl)} + "/now?city=" + encodeURIComponent(city));
      return await response.json();
    },
  });
  ctx.hook("tool.after", () => ({ action: "pass" }));
  ctx.command({ name: "forecast", usage: "/forecast <city>", description: "Current forecast for a city", run: async (city) => "Forecast for " + city + ": 31°C, clear" });
  ctx.command({ name: "help", description: "tries to take over /help", run: async () => "hijacked" });
}
`;

// Spec: MUS-SPEC-23-1E (docs/spec/clauses/23-plugin-api.md#mus-spec-23-1e--chat-commands-from-a-plugin-appear-in-the-slash-menu)
test("a plugin command is listed in the slash menu and runs without a model turn", { timeout: 240_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "muster-plugapi-command-"));
  try {
    const ws = join(root, "ws");
    await mkdir(ws, { recursive: true });
    const launched = join(root, "codex-launched");
    const fakeCodex = join(root, "codex");
    await writeFile(fakeCodex, `#!/bin/sh\ntouch ${JSON.stringify(launched)}\nexit 1\n`, { mode: 0o755 });
    const env = cliEnv(root, { MUSTER_CODEX_COMMAND: fakeCodex });
    await cli(ws, env, "init");
    const plugin = await writePlugin(join(root, "weather"), { ...WEATHER_MANIFEST, permissions: [...WEATHER_MANIFEST.permissions, "net:127.0.0.1"] }, { "dist/index.js": WEATHER_ENTRY("http://127.0.0.1:9") });
    assert.equal((await cli(ws, env, "plugins", "install", plugin, "--yes")).code, 0);

    const menu = await cli(ws, env, "chat", "--complete", "/fore", "--describe");
    const row = menu.stdout.split("\n").map((line) => line.split("\t")).find(([value]) => value === "/forecast");
    assert.ok(row, `slash menu: ${menu.stdout}${menu.stderr}`);
    assert.match(row[1] ?? "", /\/forecast <city>/);
    assert.equal(row[2], "Current forecast for a city (weather)");
    const help = (await cli(ws, env, "chat", "--complete", "/help", "--describe")).stdout.split("\n").map((line) => line.split("\t")).filter(([value]) => value === "/help");
    assert.equal(help.length, 1, "a plugin cannot take a built-in's name");
    assert.doesNotMatch(help[0]![2] ?? "", /weather/);

    const out = await cli(ws, env, "chat", "/forecast Pune");
    assert.equal(out.code, 0, out.stdout + out.stderr);
    assert.match(out.stdout, /Forecast for Pune: 31°C, clear/);
    assert.equal(existsSync(launched), false, "no model turn started");
    const hijack = await cli(ws, env, "chat", "/help");
    assert.doesNotMatch(hijack.stdout, /hijacked/);
    assert.match(hijack.stdout + hijack.stderr, /command help refused: \/help is a built-in command/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// Spec: MUS-SPEC-23-1B (docs/spec/clauses/23-plugin-api.md#mus-spec-23-1b--a-code-plugins-tool-runs-in-its-own-process-and-reaches-every-runtime)
test("a code plugin's tool is served over Muster's MCP server from an isolated host process", { timeout: 240_000 }, async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "muster-plugapi-mcp-")));
  let release: () => void = () => undefined;
  let requested: () => void = () => undefined;
  const requestSeen = new Promise<void>((done) => { requested = done; });
  const server = createServer((req, res) => {
    requested();
    const city = new URL(req.url ?? "/", "http://x").searchParams.get("city");
    release = () => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ city, tempC: 31 })); };
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const port = (server.address() as { port: number }).port;
  let child: ReturnType<typeof spawn> | undefined;
  try {
    const ws = join(root, "ws");
    await mkdir(ws, { recursive: true });
    const env = cliEnv(root);
    await cli(ws, env, "init");
    const plugin = await writePlugin(join(root, "weather"), { ...WEATHER_MANIFEST, permissions: ["tools", `net:127.0.0.1:${port}`] }, { "dist/index.js": WEATHER_ENTRY(`http://127.0.0.1:${port}`).replace(/\s+ctx\.hook[\s\S]*?\n}\n$/, "\n}\n") });
    const installed = await cli(ws, env, "plugins", "install", plugin, "--yes");
    assert.equal(installed.code, 0, installed.stdout + installed.stderr);

    child = spawn("tsx", [cliPath, "mcp", "serve"], { cwd: ws, env, stdio: ["pipe", "pipe", "pipe"] });
    const pending = new Map<number, (message: Record<string, unknown>) => void>();
    readline.createInterface({ input: child.stdout! }).on("line", (line) => {
      try {
        const message = JSON.parse(line) as Record<string, unknown>;
        pending.get(message.id as number)?.(message);
      } catch { /* not protocol */ }
    });
    let nextId = 1;
    const request = (method: string, params: Record<string, unknown> = {}) => new Promise<Record<string, unknown>>((done) => {
      const id = nextId++;
      pending.set(id, done);
      child!.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
    await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
    const tools = ((await request("tools/list")).result as { tools: Array<{ name: string; inputSchema?: { properties?: Record<string, unknown> } }> }).tools;
    const tool = tools.find((entry) => entry.name === "weather_now");
    assert.ok(tool, `weather_now is listed: ${tools.map((entry) => entry.name).join(", ")}`);
    assert.ok(tool.inputSchema?.properties?.city, "with its schema");

    const called = request("tools/call", { name: "weather_now", arguments: { city: "Pune" } });
    await requestSeen;
    // During the call: the plugin host is its own process, a descendant of `muster mcp serve`, under the permission model.
    const table = (await run("ps", ["-A", "-o", "pid=,ppid=,command="])).stdout.split("\n").map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/)).filter((match): match is RegExpMatchArray => Boolean(match)).map((match) => ({ pid: Number(match[1]), ppid: Number(match[2]), command: match[3]! }));
    const descendants = new Set([child.pid!]);
    for (let grew = true; grew;) {
      grew = false;
      for (const row of table) if (descendants.has(row.ppid) && !descendants.has(row.pid)) { descendants.add(row.pid); grew = true; }
    }
    const hosts = table.filter((row) => descendants.has(row.pid) && row.command.includes("--permission") && row.command.includes("--allow-fs-read="));
    assert.equal(hosts.length, 1, `one plugin host under mcp serve:\n${table.filter((row) => descendants.has(row.pid)).map((row) => `${row.pid} ${row.ppid} ${row.command.slice(0, 160)}`).join("\n")}`);
    const cliProcess = table.find((row) => row.pid === hosts[0]!.ppid)!;
    assert.ok(cliProcess && cliProcess.pid !== hosts[0]!.pid && /mcp serve|index\.ts/.test(cliProcess.command), "its parent is the CLI process");
    release();
    const result = (await called).result as { content: Array<{ text: string }>; isError?: boolean };
    assert.notEqual(result.isError, true, JSON.stringify(result));
    assert.deepEqual(JSON.parse(result.content[0]!.text), { city: "Pune", tempC: 31 });
  } finally {
    child?.kill();
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
    await rm(root, { recursive: true, force: true });
  }
});

// Spec: MUS-SPEC-23-2A (docs/spec/clauses/23-plugin-api.md#mus-spec-23-2a--disable-and-remove-unwind-every-registration-with-no-restart)
test("disable unwinds tools, hooks and commands through the ledger and remove deletes the plugin", { timeout: 240_000 }, async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "muster-plugapi-ledger-")));
  try {
    const ws = join(root, "ws");
    await mkdir(ws, { recursive: true });
    const env = cliEnv(root);
    await cli(ws, env, "init");
    const plugin = await writePlugin(join(root, "weather"), WEATHER_MANIFEST, { "dist/index.js": WEATHER_ENTRY("https://api.open-meteo.com") });
    assert.equal((await cli(ws, env, "plugins", "install", plugin, "--yes")).code, 0);

    // The open chat: one runtime with its own tool registry, hook bus and commands.
    const registry = createToolRegistry();
    registerBuiltinTools(registry);
    const bus = createHookBus();
    const chat = createPluginRuntime({ cwd: ws, registry, hooks: bus, reservedCommands: ["help"] });
    const state = () => ({
      tools: registry.list().filter((entry) => entry.toolset === "plugins").map((entry) => entry.name),
      hooks: bus.count("tool.after"),
      commands: chat.commands().map((entry) => entry.name),
    });
    try {
      await chat.refresh();
      const loaded = state();
      assert.deepEqual(loaded, { tools: ["weather_now"], hooks: 1, commands: ["forecast"] });
      const pid = chat.host("weather")?.pid;
      assert.ok(alive(pid), "the host is running");

      const disabled = await cli(ws, env, "plugins", "disable", "weather");
      assert.equal(disabled.code, 0, disabled.stdout + disabled.stderr);
      assert.match(disabled.stdout, /disabled=weather kind=code/);
      await chat.refresh();
      assert.deepEqual(state(), { tools: [], hooks: 0, commands: [] }, "everything it registered is gone, in the same process");
      await waitFor(() => !alive(pid), "the host process to exit");
      const ledger = await readPluginLedger(ws, "weather");
      assert.deepEqual(ledger.map((entry) => `${entry.kind}:${entry.name}`).sort(), ["command:forecast", "hook:tool.after", "tool:weather_now"]);
      assert.ok(ledger.every((entry) => entry.undone === true && typeof entry.inverse === "string"), JSON.stringify(ledger));

      assert.equal((await cli(ws, env, "plugins", "enable", "weather")).code, 0);
      await chat.refresh();
      assert.deepEqual(state(), loaded, "re-enabling restores exactly the same registrations");

      const removed = await cli(ws, env, "plugins", "remove", "weather");
      assert.equal(removed.code, 0, removed.stdout + removed.stderr);
      await chat.refresh();
      assert.deepEqual(state(), { tools: [], hooks: 0, commands: [] });
      assert.equal((await readPluginBundleLock(ws)).entries.weather, undefined, "the lock entry is gone");
      assert.equal(existsSync(join(ws, ".muster", "data", "plugins", "weather")), false, "the plugin files are gone");
      assert.ok((await readPluginLedger(ws, "weather")).every((entry) => entry.undone === true));
    } finally {
      await chat.stop();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
