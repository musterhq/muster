import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

const run = promisify(execFile);
const cliPath = resolve(import.meta.dirname, "..", "src", "index.ts");
const GIT = ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false"];

async function gitRepo(dir: string, files: Record<string, string>): Promise<string> {
  for (const [path, body] of Object.entries(files)) {
    await mkdir(join(dir, path, ".."), { recursive: true });
    await writeFile(join(dir, path), body);
  }
  await run("git", ["init", "-q", "-b", "main"], { cwd: dir });
  await run("git", ["add", "-A"], { cwd: dir });
  await run("git", [...GIT, "commit", "-qm", "init"], { cwd: dir });
  return (await run("git", ["rev-parse", "HEAD"], { cwd: dir })).stdout.trim();
}

const skill = (name: string, description: string) => `---\nname: ${name}\ndescription: ${description}\n---\n\nUse this skill for ${name}.\n`;

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "muster-hub-"));
  const tides = join(root, "tides");
  const tidesSha = await gitRepo(tides, { "plugin.json": JSON.stringify({ name: "tides", version: "1.0.0", description: "Harbour tides" }), "skills/tide-lookup/SKILL.md": skill("tide-lookup", "Look up harbour tides") });
  const mono = join(root, "mono");
  const monoSha = await gitRepo(mono, { "plugins/weather/.claude-plugin/plugin.json": JSON.stringify({ name: "weather", version: "2.0.0" }), "plugins/weather/skills/forecast/SKILL.md": skill("forecast", "Weather lookups"), "README.md": "other things" });
  const market = join(root, "market");
  await gitRepo(market, {
    ".claude-plugin/marketplace.json": JSON.stringify({
      name: "fixture-market",
      owner: { name: "test" },
      plugins: [
        { name: "notes", description: "Take notes", category: "productivity", source: "./plugins/notes" },
        { name: "tides", description: "Harbour tides", source: { source: "url", url: `file://${tides}`, sha: tidesSha } },
        { name: "weather", description: "Weather lookups", source: { source: "git-subdir", url: `file://${mono}`, path: "plugins/weather", ref: "main", sha: monoSha } },
        { name: "inline-orders", description: "Order lookups", strict: false, source: "./plugins/inline", mcpServers: { orders: { command: "node", args: ["${CLAUDE_PLUGIN_ROOT}/server.mjs"] } } },
      ],
    }),
    "plugins/notes/.claude-plugin/plugin.json": JSON.stringify({ name: "notes", version: "0.1.0" }),
    "plugins/notes/skills/note-taking/SKILL.md": skill("note-taking", "Take notes"),
    "plugins/inline/server.mjs": "// a tiny server\n",
  });
  const ws = join(root, "ws");
  await mkdir(ws, { recursive: true });
  const env = { ...process.env, MUSTER_ONBOARDING_HOME: join(root, ".home"), MUSTER_SKIP_ONBOARDING: "1", NO_COLOR: "1" };
  delete (env as Record<string, string | undefined>).FORCE_COLOR;
  const cli = async (...args: string[]) => (await run("tsx", [cliPath, ...args], { cwd: ws, env, timeout: 60_000 })).stdout;
  await cli("init");
  return { root, ws, market, tidesSha, monoSha, cli, env };
}

// Spec: MUS-SPEC-19-1A, MUS-SPEC-19-1B, MUS-SPEC-19-1C, MUS-SPEC-19-1D (docs/spec/clauses/19-plugin-hub.md)
test("a marketplace is added, searched and its plugins install by name at their pinned commits", { timeout: 240_000 }, async () => {
  const f = await fixture();
  try {
    assert.match(await f.cli("plugins", "marketplace", "add", f.market), /marketplace=fixture-market plugins=4/);
    assert.match(await f.cli("plugins", "marketplace", "list"), /fixture-market\s+plugins=4/);
    const tide = await f.cli("plugins", "search", "tide");
    assert.match(tide, /tides@fixture-market\s+Harbour tides/);
    const lookups = await f.cli("plugins", "search", "lookups");
    assert.match(lookups, /weather@fixture-market/);
    assert.match(lookups, /inline-orders@fixture-market/);

    await f.cli("plugins", "install", "tides");
    await f.cli("plugins", "install", "weather@fixture-market");
    await f.cli("plugins", "install", "notes");
    await f.cli("plugins", "install", "inline-orders");
    const lock = JSON.parse(await readFile(join(f.ws, ".muster", "data", "plugins", "plugins.lock.json"), "utf8")) as { entries: Record<string, { commit?: string; source: Record<string, string> }> };
    assert.equal(lock.entries.tides?.commit, f.tidesSha);
    assert.equal(lock.entries.weather?.commit, f.monoSha);
    assert.equal(lock.entries.weather?.source.path, "plugins/weather");
    assert.equal(lock.entries.tides?.source.marketplace, "fixture-market");
    const skills = await f.cli("skills", "list");
    for (const name of ["tide-lookup", "forecast", "note-taking"]) assert.match(skills, new RegExp(name));
    const mcp = await f.cli("mcp", "list");
    assert.match(mcp, /inline-orders__orders\s+stdio node .*inline-orders\/server\.mjs/);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

// Spec: MUS-SPEC-19-1E (docs/spec/clauses/19-plugin-hub.md#mus-spec-19-1e--denied-plugins-never-install)
test("a denied marketplace plugin is refused", { timeout: 120_000 }, async () => {
  const f = await fixture();
  try {
    await f.cli("plugins", "marketplace", "add", f.market);
    const configPath = join(f.ws, ".muster", "config.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    await writeFile(configPath, JSON.stringify({ ...config, plugins: { ...(config.plugins ?? {}), deny: ["weather"] } }));
    await assert.rejects(() => f.cli("plugins", "install", "weather"), /denied by plugins\.deny/);
    assert.doesNotMatch(await f.cli("plugins", "list"), /plugin=weather/);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
