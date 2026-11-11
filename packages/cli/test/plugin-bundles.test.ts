import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const cliPath = resolve(import.meta.dirname, "..", "src", "index.ts");

interface CliResult { readonly stdout: string; readonly stderr: string; readonly code: number }

async function workspace(): Promise<string> {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "muster-bundles-")));
  await cli(cwd, ["init"]);
  return cwd;
}

function cliEnv(cwd: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    MUSTER_ONBOARDING_HOME: join(cwd, ".test-home"),
    MUSTER_SKIP_ONBOARDING: "1",
    CODEX_HOME: join(cwd, ".codex-home"),
    ...extra,
  };
  delete env.FORCE_COLOR;
  return env;
}

async function cli(cwd: string, args: string[], extra: Record<string, string> = {}): Promise<CliResult> {
  try {
    const result = await execFileAsync("tsx", [cliPath, ...args], { cwd, env: cliEnv(cwd, extra), timeout: 60_000, maxBuffer: 4 * 1024 * 1024 });
    return { stdout: result.stdout, stderr: result.stderr, code: 0 };
  } catch (error) {
    const detail = error as { stdout?: string; stderr?: string; code?: number };
    return { stdout: detail.stdout ?? "", stderr: detail.stderr ?? "", code: typeof detail.code === "number" ? detail.code : 1 };
  }
}

async function ok(cwd: string, args: string[], extra: Record<string, string> = {}): Promise<string> {
  const result = await cli(cwd, args, extra);
  assert.equal(result.code, 0, `muster ${args.join(" ")} failed:\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

async function put(root: string, files: Record<string, string>): Promise<string> {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content, "utf8");
  }
  return root;
}

/** Plugin code that leaves a marker if anything ever runs it. */
function tripwire(marker: string): string {
  return `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "ran");\n`;
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(() => true, () => false);
}

async function agentPluginsBundle(base: string, marker: string): Promise<string> {
  return put(join(base, "weather-kit"), {
    "plugin.json": JSON.stringify({ name: "weather-kit", version: "1.0.0", description: "Weather forecasts" }),
    "mcp.json": JSON.stringify({
      mcpServers: {
        forecast: {
          command: "node",
          args: ["${PLUGIN_ROOT}/server.mjs"],
          env: { WEATHER_API_KEY: "${WEATHER_API_KEY}", LITERAL_TOKEN: "lit-secret-123" },
        },
        docs: { type: "http", url: "https://docs.weather.example/mcp", headers: { "X-Api-Key": "hdr-secret-456" } },
        alerts: { command: "node", args: ["${PLUGIN_ROOT}/server.mjs", "--alerts"], env: { ALERTS_TOKEN: "${ALERTS_TOKEN}" } },
      },
    }),
    "server.mjs": tripwire(marker),
    "package.json": JSON.stringify({ name: "weather-kit", scripts: { postinstall: `node -e "require('fs').writeFileSync('${marker}','ran')"` } }),
    "skills/forecast-helper/SKILL.md": "---\nname: forecast-helper\ndescription: Explain weather forecasts in plain words\n---\n\nUse the forecast tool, then summarise.\n",
    "commands/today.md": "Show today's weather.\n",
  });
}

async function claudeBundle(base: string, marker: string): Promise<string> {
  return put(join(base, "claude-notes"), {
    ".claude-plugin/plugin.json": JSON.stringify({ name: "claude-notes", version: "0.2.0", description: "Notes for Claude" }),
    ".mcp.json": JSON.stringify({ mcpServers: { notes: { command: "${CLAUDE_PLUGIN_ROOT}/bin/notes", args: ["--root", "${CLAUDE_PLUGIN_ROOT}/data"] } } }),
    "bin/notes": `#!/usr/bin/env node\n${tripwire(marker)}`,
    "skills/note-taking/SKILL.md": "---\nname: note-taking\ndescription: Keep tidy notes\n---\n\nWrite short notes.\n",
    "commands/save.md": "Save a note.\n",
    "agents/reviewer.md": "---\nname: reviewer\n---\nReview notes.\n",
    "hooks/hooks.json": JSON.stringify({ hooks: { PostToolUse: [{ hooks: [{ type: "command", command: "${CLAUDE_PLUGIN_ROOT}/bin/notes" }] }] } }),
  });
}

async function codexRepo(base: string, marker: string): Promise<{ url: string; head: string }> {
  const repo = await put(join(base, "codex-search"), {
    ".codex-plugin/plugin.json": JSON.stringify({ name: "codex-search", version: "0.3.0", skills: "./skills/", mcpServers: "./.mcp.json", interface: { displayName: "Search" } }),
    ".mcp.json": JSON.stringify({ mcpServers: { search: { command: "./bin/server", args: ["./server.mjs"], cwd: ".", env_vars: ["SEARCH_TOKEN"] } } }),
    "bin/server": `#!/usr/bin/env node\n${tripwire(marker)}`,
    "server.mjs": tripwire(marker),
    "skills/search-tips/SKILL.md": "---\nname: search-tips\ndescription: Search the codebase well\n---\n\nPrefer exact names.\n",
  });
  const git = (args: string[]) => execFileAsync("git", ["-c", "user.name=t", "-c", "user.email=t@example.test", ...args], { cwd: repo });
  await git(["init", "-q"]);
  await git(["add", "."]);
  await git(["commit", "-q", "-m", "seed"]);
  const head = (await git(["rev-parse", "HEAD"])).stdout.trim();
  return { url: `file://${repo}`, head };
}

interface LockEntry {
  readonly id: string;
  readonly format: string;
  readonly source: { type: string; path?: string; url?: string };
  readonly commit?: string;
  readonly digest: string;
  readonly installedPath: string;
  readonly mcpServers: string[];
  readonly skills: string[];
}

async function lock(cwd: string): Promise<Record<string, LockEntry>> {
  const raw = JSON.parse(await readFile(join(cwd, ".muster", "data", "plugins", "plugins.lock.json"), "utf8")) as { entries: Record<string, LockEntry> };
  return raw.entries;
}

type Server = { transport: { kind: string; command?: string; args?: string[]; env?: Record<string, string>; cwd?: string; url?: string }; origin?: { plugin?: string } };

async function servers(cwd: string): Promise<Record<string, Server>> {
  const config = JSON.parse(await readFile(join(cwd, ".muster", "config.json"), "utf8")) as { tools?: { mcp?: { servers?: Record<string, Server> } } };
  return config.tools?.mcp?.servers ?? {};
}

// Spec: MUS-SPEC-11-1A (docs/spec/clauses/11-plugin-bundles.md#mus-spec-11-1a--inspect-shows-exactly-what-install-adds-without-running-plugin-code)
test("inspect lists servers, skills and ignored parts of an Agent Plugins v1 bundle without running it", { timeout: 120_000 }, async () => {
  const cwd = await workspace();
  const marker = join(cwd, "RAN");
  try {
    const bundle = await agentPluginsBundle(join(cwd, "src"), marker);
    const out = await ok(cwd, ["plugins", "inspect", bundle]);
    assert.match(out, /bundle=weather-kit format=agent-plugins-v1 version=1\.0\.0/);
    assert.match(out, /mcp_server=weather-kit__forecast transport=stdio command=node /);
    assert.match(out, /mcp_server=weather-kit__forecast .*env_keys=WEATHER_API_KEY,LITERAL_TOKEN/);
    assert.match(out, /mcp_server=weather-kit__forecast .*flags=command-outside-bundle/);
    assert.match(out, /mcp_server=weather-kit__docs transport=http url=https:\/\/docs\.weather\.example\/mcp .*header_keys=X-Api-Key .*flags=remote-url/);
    assert.match(out, /skill=forecast-helper /);
    // Prompt commands are read cold and offered as slash commands (spec 20).
    assert.match(out, /command=today path=commands\/today\.md/);
    assert.match(out, /ignored=package\.json scripts .*never run/);
    assert.doesNotMatch(out, /lit-secret-123|hdr-secret-456/, "env and header values are never printed");
    assert.equal(await exists(marker), false, "inspect never runs plugin code");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

// Spec: MUS-SPEC-11-1B (docs/spec/clauses/11-plugin-bundles.md#mus-spec-11-1b--installing-an-agent-plugins-v1-bundle-activates-its-servers-and-skills)
test("installing an Agent Plugins v1 bundle adds prefixed MCP servers and discoverable skills", { timeout: 120_000 }, async () => {
  const cwd = await workspace();
  const marker = join(cwd, "RAN");
  try {
    const bundle = await agentPluginsBundle(join(cwd, "src"), marker);
    const out = await ok(cwd, ["plugins", "install", bundle]);
    assert.match(out, /installed=weather-kit format=agent-plugins-v1/);
    const entry = (await lock(cwd))["weather-kit"];
    assert.ok(entry, "the lock records the bundle");
    assert.equal(entry.source.type, "local");
    assert.equal(entry.source.path, bundle);
    assert.match(entry.digest, /^sha256:[a-f0-9]{64}$/);
    assert.ok(entry.installedPath.startsWith(join(cwd, ".muster")), entry.installedPath);
    assert.ok(await exists(join(entry.installedPath, "skills", "forecast-helper", "SKILL.md")), "the bundle is copied");
    const configured = await servers(cwd);
    const forecast = configured["weather-kit__forecast"];
    assert.ok(forecast, "the server is added under the plugin prefix");
    assert.equal(forecast.origin?.plugin, "weather-kit");
    assert.deepEqual(forecast.transport.args, [join(entry.installedPath, "server.mjs")]);
    assert.equal(forecast.transport.env?.WEATHER_API_KEY, "${WEATHER_API_KEY}", "secret references stay references");
    assert.equal(configured["weather-kit__docs"]?.transport.url, "https://docs.weather.example/mcp");
    assert.deepEqual([...entry.mcpServers].sort(), ["weather-kit__alerts", "weather-kit__docs", "weather-kit__forecast"]);
    assert.match(await ok(cwd, ["skills", "list"]), /forecast-helper/);
    assert.match(await ok(cwd, ["mcp", "list"]), /weather-kit__forecast\t.*plugin=weather-kit/);
    assert.equal(await exists(marker), false, "install never runs plugin code");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

// Spec: MUS-SPEC-11-1C (docs/spec/clauses/11-plugin-bundles.md#mus-spec-11-1c--claude-code-plugins-install-with-claude_plugin_root-resolved)
test("a Claude Code plugin installs with CLAUDE_PLUGIN_ROOT resolved and hooks recorded but not run", { timeout: 120_000 }, async () => {
  const cwd = await workspace();
  const marker = join(cwd, "RAN");
  try {
    const bundle = await claudeBundle(join(cwd, "src"), marker);
    const inspected = await ok(cwd, ["plugins", "inspect", bundle]);
    assert.match(inspected, /bundle=claude-notes format=claude-code version=0\.2\.0/);
    assert.match(inspected, /mcp_server=claude-notes__notes transport=stdio command=\S+\/bin\/notes/);
    assert.doesNotMatch(inspected, /mcp_server=claude-notes__notes .*command-outside-bundle/, "a command inside the bundle is not flagged");
    assert.match(inspected, /command=save path=commands\/save\.md/, "prompt commands are offered (spec 20)");
    for (const part of ["agents", "hooks"]) assert.match(inspected, new RegExp(`ignored=${part} .*not activated \\(needs register API\\)`));
    await ok(cwd, ["plugins", "install", bundle]);
    const entry = (await lock(cwd))["claude-notes"]!;
    assert.equal(entry.format, "claude-code");
    const notes = (await servers(cwd))["claude-notes__notes"]!;
    assert.equal(notes.transport.command, join(entry.installedPath, "bin", "notes"));
    assert.deepEqual(notes.transport.args, ["--root", join(entry.installedPath, "data")]);
    assert.match(await ok(cwd, ["skills", "list"]), /note-taking/);
    assert.equal(await exists(marker), false, "hooks and servers never ran");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

// Spec: MUS-SPEC-11-1D (docs/spec/clauses/11-plugin-bundles.md#mus-spec-11-1d--codex-plugins-install-from-a-git-url-at-a-resolved-commit)
test("a Codex plugin installs from a git URL pinned to the resolved commit", { timeout: 120_000 }, async () => {
  const cwd = await workspace();
  const marker = join(cwd, "RAN");
  try {
    const { url, head } = await codexRepo(join(cwd, "src"), marker);
    const out = await ok(cwd, ["plugins", "install", url]);
    assert.match(out, new RegExp(`installed=codex-search format=codex .*commit=${head}`));
    const entry = (await lock(cwd))["codex-search"]!;
    assert.equal(entry.source.type, "git");
    assert.equal(entry.source.url, url);
    assert.equal(entry.commit, head);
    assert.match(entry.digest, /^sha256:[a-f0-9]{64}$/);
    assert.equal(await exists(join(entry.installedPath, ".git")), false, "no git metadata is kept");
    const search = (await servers(cwd))["codex-search__search"]!;
    assert.equal(search.transport.command, join(entry.installedPath, "bin", "server"));
    assert.deepEqual(search.transport.args, [join(entry.installedPath, "server.mjs")]);
    assert.equal(search.transport.cwd, entry.installedPath);
    assert.deepEqual(search.transport.env, { SEARCH_TOKEN: "${SEARCH_TOKEN}" });
    assert.match(await ok(cwd, ["skills", "list"]), /search-tips/);
    assert.equal(await exists(marker), false);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

// Spec: MUS-SPEC-11-1E (docs/spec/clauses/11-plugin-bundles.md#mus-spec-11-1e--an-installed-bundles-mcp-server-reaches-a-codex-turn)
test("an installed bundle's MCP server is passed to a Codex turn with env references resolved at turn time", { timeout: 180_000 }, async () => {
  const cwd = await workspace();
  const marker = join(cwd, "RAN");
  const fake = join(cwd, "codex-fake.mjs");
  const record = join(cwd, "record.json");
  await writeFile(fake, `#!/usr/bin/env node
import readline from "node:readline";
import { writeFileSync } from "node:fs";
const argv = process.argv.slice(2);
if (argv.includes("--version")) { console.log("codex-cli 0.200.0"); process.exit(0); }
const seen = { argv, threadStart: null };
const rl = readline.createInterface({ input: process.stdin });
function send(msg) { process.stdout.write(JSON.stringify(msg) + "\\n"); }
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") send({ id: msg.id, result: { userAgent: "fake" } });
  else if (msg.method === "thread/start" || msg.method === "thread/resume") {
    seen.threadStart = msg.params;
    writeFileSync(${JSON.stringify(record)}, JSON.stringify(seen));
    send({ id: msg.id, result: { thread: { id: "thread-plugin" } } });
  } else if (msg.method === "turn/start") {
    send({ id: msg.id, result: { turn: { id: "turn-1", status: "inProgress" } } });
    send({ method: "item/completed", params: { threadId: "thread-plugin", turnId: "turn-1", item: { type: "agentMessage", id: "m", text: "sunny" } } });
    send({ method: "turn/completed", params: { threadId: "thread-plugin", turn: { id: "turn-1", status: "completed" } } });
  } else if (msg.id !== undefined) send({ id: msg.id, error: { code: -32601, message: "not in fake" } });
});
`, "utf8");
  await chmod(fake, 0o755);
  try {
    const bundle = await agentPluginsBundle(join(cwd, "src"), marker);
    await ok(cwd, ["plugins", "install", bundle]);
    const installed = (await lock(cwd))["weather-kit"]!.installedPath;
    const out = await ok(cwd, ["run", "what is the forecast", "--runtime", "codex", "--transport", "warm"], {
      MUSTER_CODEX_COMMAND: fake,
      WEATHER_API_KEY: "wk-live-789",
    });
    assert.match(out, /sunny|status=/);
    const seen = JSON.parse(await readFile(record, "utf8")) as { argv: string[]; threadStart: { config?: Record<string, Record<string, unknown>> } };
    const forecast = seen.threadStart.config?.["mcp_servers.weather-kit__forecast"];
    assert.ok(forecast, `the plugin server is in the thread config: ${JSON.stringify(Object.keys(seen.threadStart.config ?? {}))}`);
    assert.equal(forecast.command, "node");
    assert.deepEqual(forecast.args, [join(installed, "server.mjs")]);
    assert.deepEqual(forecast.env, { WEATHER_API_KEY: "wk-live-789", LITERAL_TOKEN: "lit-secret-123" });
    assert.ok(seen.threadStart.config?.["mcp_servers.weather-kit__docs"], "the http server rides along too");
    assert.equal(seen.threadStart.config?.["mcp_servers.weather-kit__alerts"], undefined, "a server whose env reference is unset is left out");
    assert.doesNotMatch(seen.argv.join(" "), /wk-live-789|weather-kit/, "nothing about the plugin is on the command line");
    assert.equal(await exists(marker), false, "the fake runtime never started the server, and Muster did not either");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

// Spec: MUS-SPEC-11-1F (docs/spec/clauses/11-plugin-bundles.md#mus-spec-11-1f--list-and-remove-undo-exactly-what-install-did)
test("list shows installed bundles and remove deletes exactly their servers, skills and files", { timeout: 180_000 }, async () => {
  const cwd = await workspace();
  const marker = join(cwd, "RAN");
  try {
    await ok(cwd, ["mcp", "add-stdio", "mine", "mine-mcp", "--stdio"]);
    await ok(cwd, ["plugins", "install", await agentPluginsBundle(join(cwd, "src"), marker)]);
    await ok(cwd, ["plugins", "install", await claudeBundle(join(cwd, "src"), marker)]);
    const listed = await ok(cwd, ["plugins", "list"]);
    assert.match(listed, /plugin=weather-kit format=agent-plugins-v1 source=local:\S+ sha=- servers=3 skills=1/);
    assert.match(listed, /plugin=claude-notes format=claude-code source=local:\S+ sha=- servers=1 skills=1/);
    const installed = (await lock(cwd))["weather-kit"]!.installedPath;
    const removed = await ok(cwd, ["plugins", "remove", "weather-kit"]);
    assert.match(removed, /removed=weather-kit servers=3 skills=1/);
    assert.deepEqual(Object.keys(await servers(cwd)).sort(), ["claude-notes__notes", "mine"]);
    const entries = await lock(cwd);
    assert.equal(entries["weather-kit"], undefined);
    assert.ok(entries["claude-notes"]);
    assert.equal(await exists(installed), false, "the installed copy is deleted");
    const skills = await ok(cwd, ["skills", "list"]);
    assert.doesNotMatch(skills, /forecast-helper/);
    assert.match(skills, /note-taking/);
    assert.equal((await cli(cwd, ["plugins", "remove", "weather-kit"])).code === 0, false, "removing twice fails clearly");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

// Spec: MUS-SPEC-11-1G (docs/spec/clauses/11-plugin-bundles.md#mus-spec-11-1g--governance-deny-list-high-risk-gate-and-path-escapes)
test("denied, high-risk and path-escaping bundles are refused", { timeout: 180_000 }, async () => {
  const cwd = await workspace();
  try {
    const configPath = join(cwd, ".muster", "config.json");
    const config = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
    await writeFile(configPath, JSON.stringify({ ...config, plugins: { deny: ["blocked-kit"] } }, null, 2));
    const blocked = await put(join(cwd, "src", "blocked"), {
      "plugin.json": JSON.stringify({ name: "blocked-kit", version: "1.0.0" }),
      "mcp.json": JSON.stringify({ mcpServers: { x: { command: "x" } } }),
    });
    const risky = await put(join(cwd, "src", "risky"), {
      "plugin.json": JSON.stringify({ name: "risky-kit", version: "1.0.0", extensions: { "com.musterhq.muster": { risk: "high", permissions: ["shell", "secrets"] } } }),
      "mcp.json": JSON.stringify({ mcpServers: { shell: { command: "${PLUGIN_ROOT}/run.sh" } } }),
      "run.sh": "#!/bin/sh\n",
    });
    const escaping = await put(join(cwd, "src", "escape", "bundle"), {
      ".claude-plugin/plugin.json": JSON.stringify({ name: "escape-kit", mcpServers: "../elsewhere.json" }),
    });
    await put(join(cwd, "src", "escape"), { "elsewhere.json": JSON.stringify({ mcpServers: { x: { command: "x" } } }) });

    const denied = await cli(cwd, ["plugins", "install", blocked]);
    assert.notEqual(denied.code, 0);
    assert.match(denied.stderr + denied.stdout, /blocked-kit.*denied/i);

    const inspectedRisky = await ok(cwd, ["plugins", "inspect", risky]);
    assert.match(inspectedRisky, /risk=high/);
    assert.match(inspectedRisky, /permissions=shell,secrets/);
    const refused = await cli(cwd, ["plugins", "install", risky]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.stderr + refused.stdout, /--allow-high-risk/);
    await ok(cwd, ["plugins", "install", risky, "--allow-high-risk"]);

    const inspectedEscape = await cli(cwd, ["plugins", "inspect", escaping]);
    assert.match(inspectedEscape.stdout + inspectedEscape.stderr, /blocked.*outside the bundle/i);
    const escaped = await cli(cwd, ["plugins", "install", escaping]);
    assert.notEqual(escaped.code, 0);

    assert.deepEqual(Object.keys(await servers(cwd)), ["risky-kit__shell"], "refused installs write nothing");
    assert.deepEqual(Object.keys(await lock(cwd)), ["risky-kit"]);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

// Spec: MUS-SPEC-11-1I (docs/spec/clauses/11-plugin-bundles.md#mus-spec-11-1i--inspect-on-a-missing-or-empty-folder-says-what-it-looked-for)
test("plugins inspect on a missing or empty folder says what it looked for", { timeout: 60_000 }, async () => {
  const cwd = await workspace();
  try {
    const missing = await cli(cwd, ["plugins", "inspect", join(cwd, "nope")]);
    assert.notEqual(missing.code, 0);
    assert.doesNotMatch(missing.stderr + missing.stdout, /ENOENT|manifest\.json'/);
    assert.match(missing.stderr + missing.stdout, /No such folder: .*nope/);
    await mkdir(join(cwd, "empty"));
    const empty = await cli(cwd, ["plugins", "inspect", join(cwd, "empty")]);
    assert.notEqual(empty.code, 0);
    assert.doesNotMatch(empty.stderr + empty.stdout, /ENOENT/);
    assert.match(empty.stderr + empty.stdout, /No plugin found in .*empty.*\.claude-plugin\/plugin\.json.*\.codex-plugin\/plugin\.json.*plugin\.json/s);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

// Spec: MUS-SPEC-03-2C (docs/spec/clauses/03-mcp-runtime.md#mus-spec-03-2c--mcp-commands-work-in-a-folder-without-muster)
test("mcp add-stdio, list and test work in a folder without .muster/", { timeout: 90_000 }, async () => {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "muster-mcp-fresh-")));
  try {
    const added = await cli(cwd, ["mcp", "add-stdio", "orders", "node", "server.mjs"]);
    assert.equal(added.code, 0, added.stderr);
    assert.doesNotMatch(added.stderr, /ENOENT/);
    const config = JSON.parse(await readFile(join(cwd, ".muster", "config.json"), "utf8"));
    assert.equal(config.tools.mcp.servers.orders.transport.command, "node");
    const fresh = await realpath(await mkdtemp(join(tmpdir(), "muster-mcp-list-")));
    try {
      const listed = await cli(fresh, ["mcp", "list"]);
      assert.equal(listed.code, 0, listed.stderr);
      assert.doesNotMatch(listed.stderr + listed.stdout, /ENOENT/);
    } finally {
      await rm(fresh, { recursive: true, force: true });
    }
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

// Spec: MUS-SPEC-11-2A (docs/spec/clauses/11-plugin-bundles.md#mus-spec-11-2a--an-interpreter-running-a-bundled-script-is-not-flagged-long-descriptions-end-at-a-word)
test("inspect does not flag an interpreter running a bundled script and cuts descriptions at a word", { timeout: 120_000 }, async () => {
  const cwd = await workspace();
  const marker = join(cwd, "RAN");
  try {
    const description = "Use when the user asks to create or update a Frappe DocType, such as adding fields or changing permissions";
    const bundle = await put(join(cwd, "src", "flag-kit"), {
      "plugin.json": JSON.stringify({ name: "flag-kit", version: "1.0.0", description: "Flag cases" }),
      "mcp.json": JSON.stringify({
        mcpServers: {
          local: { command: "node", args: ["${PLUGIN_ROOT}/server.mjs"] },
          remote: { command: "npx", args: ["-y", "some-remote-pkg"] },
          elsewhere: { command: "node", args: ["/etc/elsewhere.js"] },
        },
      }),
      "server.mjs": tripwire(marker),
      "skills/doctype/SKILL.md": `---\nname: doctype\ndescription: ${description}\n---\n\nBody.\n`,
    });
    const out = await ok(cwd, ["plugins", "inspect", bundle]);
    assert.doesNotMatch(out, /mcp_server=flag-kit__local .*command-outside-bundle/, out);
    assert.match(out, /mcp_server=flag-kit__remote .*flags=command-outside-bundle/);
    assert.match(out, /mcp_server=flag-kit__elsewhere .*flags=command-outside-bundle/);
    const shown = out.match(/skill=doctype .*description="([^"]*)"/)?.[1] ?? "";
    assert.equal(shown, "Use when the user asks to create or update a Frappe DocType, such as adding…", out);
    assert.equal(await exists(marker), false, "no plugin code ran");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
