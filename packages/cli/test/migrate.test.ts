import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readdir, readFile, readlink, rm, stat, symlink, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

const cliPath = resolve(import.meta.dirname, "..", "src", "index.ts");

/** Every secret the fixtures hold. None may ever reach output or a Muster file. */
const SECRETS = {
  telegram: "123456789:AAFakeTelegramTokenValue_abcdefghijklmnop",
  discord: "discord-FAKE-bot-token-value-zz9",
  github: "ghp_FAKEgithubTOKEN1234567890abcdefXYZ",
  frappe: "frappe-FAKE-api-secret-7777",
  gatewayAuth: "gw-FAKE-gateway-auth-token-0001",
  hermesTelegram: "987654321:HermesFakeTelegramToken_qrstuvwxyz0123",
  hermesOpenrouter: "sk-or-FAKE-openrouter-key-5555aaaa",
  linear: "lin_FAKE_api_token_1234567890abcd",
  codexZ: "z-FAKE-codex-key-4242-abcdef",
} as const;

async function writeTree(root: string, files: Record<string, string>): Promise<void> {
  for (const [relative, content] of Object.entries(files)) {
    const path = join(root, relative);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, content);
  }
}

function skillFile(name: string, description: string, body: string): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`;
}

/** A fake HOME holding one setup per source, shaped like their documented layouts. */
async function makeFakeHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "muster-migrate-home-"));
  await writeTree(home, {
    ".openclaw/openclaw.json": JSON.stringify({
      meta: { lastTouchedVersion: "2026.4.1" },
      agents: { defaults: { model: "anthropic/claude-sonnet" } },
      channels: {
        telegram: { enabled: true, dmPolicy: "pairing", botToken: SECRETS.telegram, allowFrom: ["111"], streaming: "partial" },
        discord: { enabled: true, token: SECRETS.discord },
      },
      gateway: { mode: "local", auth: { mode: "token", token: SECRETS.gatewayAuth } },
      mcp: { servers: { github: { command: "npx", args: ["-y", "@modelcontextprotocol/server-github"], env: { GITHUB_TOKEN: SECRETS.github } } } },
      plugins: {
        entries: {
          "openclaw-mcp-adapter": {
            enabled: true,
            config: { servers: [{ name: "frappe", transport: "stdio", command: "frappe-mcp", args: ["serve"], env: { FRAPPE_SITE: "site1.local", FRAPPE_API_SECRET: SECRETS.frappe } }] },
          },
        },
      },
    }, null, 2),
    ".openclaw/workspace/USER.md": "# User\n\n- Name: Test Person\n- Prefers concise answers\n",
    ".openclaw/workspace/MEMORY.md": "# Memory\n\n- Deploys go through staging first\n- The API lives in services/api\n",
    ".openclaw/workspace/AGENTS.md": "# Agents\n\nAlways run the tests before saying done.\n",
    ".openclaw/skills/figma/SKILL.md": skillFile("figma", "Turn Figma frames into components", "# Figma\n\nExport the frame, then build it."),
    ".openclaw/skills/figma/references/notes.md": "Use the REST API.\n",
    ".openclaw/cron/jobs.json": JSON.stringify({
      version: 1,
      jobs: [{ id: "job-1", name: "morning-brief", enabled: true, schedule: { kind: "cron", expr: "0 7 * * *", tz: "UTC" }, payload: { kind: "agentTurn", message: "Summarize my inbox" } }],
    }),
    ".hermes/config.yaml": "model:\n  default: anthropic/claude-sonnet\nmcp_servers:\n  fs:\n    command: npx\n    args: [\"-y\", \"@modelcontextprotocol/server-filesystem\"]\n",
    ".hermes/memories/MEMORY.md": "Uses pnpm for every repo\n§\nThe staging host is staging.example.com\n",
    ".hermes/memories/USER.md": "Works in IST\n§\nLikes bullet lists\n",
    ".hermes/skills/x/SKILL.md": skillFile("x", "Post a thread", "Write the thread, then post it."),
    ".hermes/.env": `TELEGRAM_BOT_TOKEN=${SECRETS.hermesTelegram}\nOPENROUTER_API_KEY=${SECRETS.hermesOpenrouter}\n`,
    ".claude.json": JSON.stringify({ mcpServers: { linear: { type: "http", url: "https://mcp.linear.example/mcp", headers: { Authorization: `Bearer ${SECRETS.linear}` } } } }),
    ".claude/skills/y/SKILL.md": skillFile("y", "Review a pull request", "Read the diff first."),
    ".claude/CLAUDE.md": "Prefer small diffs.\n",
    ".codex/config.toml": `model = "gpt-6"\n\n[mcp_servers.z]\ncommand = "z-mcp"\nargs = ["--stdio"]\n\n[mcp_servers.z.env]\nZ_API_KEY = "${SECRETS.codexZ}"\nZ_REGION = "eu"\n`,
    ".codex/AGENTS.md": "Explain every shell command you run.\n",
    ".codex/skills/w/SKILL.md": skillFile("w", "Write release notes", "Group changes by area."),
  });
  // Real setups link skills from elsewhere; the link is followed for reading only.
  await symlink("../../.claude/skills/y", join(home, ".openclaw", "skills", "y"));
  // A memory database whose schema is not one Muster knows: listed as skipped, never guessed.
  const db = new DatabaseSync(join(home, ".openclaw", "memory-unknown.sqlite"));
  db.exec("CREATE TABLE things (blob TEXT)");
  db.close();
  await mkdir(join(home, ".openclaw", "memory"), { recursive: true });
  await writeFile(join(home, ".openclaw", "memory", "main.sqlite"), await readFile(join(home, ".openclaw", "memory-unknown.sqlite")));
  await rm(join(home, ".openclaw", "memory-unknown.sqlite"));
  return home;
}

/** path → sha256 of every file (symlinks hash their target path) under root. */
async function hashTree(root: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const visit = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir)) {
      const path = join(dir, entry);
      const info = await lstat(path);
      if (info.isSymbolicLink()) out[path] = `link:${await readlink(path)}`;
      else if (info.isDirectory()) await visit(path);
      else out[path] = `${createHash("sha256").update(await readFile(path)).digest("hex")}:${info.mode.toString(8)}`;
    }
  };
  await visit(root);
  return out;
}

/** Concatenated contents of every file under root (for "no secret anywhere" checks). */
async function allText(root: string): Promise<string> {
  if (!existsSync(root)) return "";
  const parts: string[] = [];
  const visit = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir)) {
      const path = join(dir, entry);
      const info = await lstat(path);
      if (info.isDirectory()) await visit(path);
      else if (info.isFile()) parts.push((await readFile(path)).toString("latin1"));
    }
  };
  await visit(root);
  return parts.join("\n");
}

function assertNoSecrets(text: string, where: string): void {
  for (const [name, value] of Object.entries(SECRETS)) {
    assert.ok(!text.includes(value), `${name} secret leaked into ${where}`);
  }
}

interface CliResult { code: number; stdout: string; stderr: string }

function runCli(args: readonly string[], options: { cwd: string; home: string }): Promise<CliResult> {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: options.home, USER: "tester", NO_COLOR: "1", MUSTER_ONBOARDING_HOME: options.home };
  delete env.CODEX_HOME;
  delete env.HERMES_HOME;
  delete env.TELEGRAM_BOT_TOKEN;
  delete env.GITHUB_TOKEN;
  return new Promise((resolvePromise) => {
    execFile("tsx", [cliPath, ...args], { cwd: options.cwd, env, timeout: 120_000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      const code = error ? (typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : 1) : 0;
      resolvePromise({ code, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

async function workspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), "muster-migrate-ws-"));
}

// Spec: MUS-SPEC-26-1A (docs/spec/clauses/26-migrate.md#mus-spec-26-1a--the-plan-lists-what-each-source-has-read-only)
test("migrate plans each source read-only and never shows a secret", async () => {
  const home = await makeFakeHome();
  const cwd = await workspace();
  try {
    const before = await hashTree(home);
    const plans: Record<string, string> = {};
    for (const source of ["openclaw", "hermes", "claude", "codex"]) {
      const result = await runCli(["migrate", source], { cwd, home });
      assert.equal(result.code, 0, `${source}: ${result.stderr}`);
      plans[source] = result.stdout;
      assertNoSecrets(result.stdout + result.stderr, `${source} plan output`);
      for (const group of ["Memory", "Profile", "Skills", "MCP servers", "Channels", "Schedules", "Rules"]) {
        assert.match(result.stdout, new RegExp(`^${group}\\b`, "m"), `${source} plan has a ${group} group`);
      }
      assert.match(result.stdout, /dry run/i);
      assert.match(result.stdout, /nothing was written/i);
    }

    const openclaw = plans.openclaw!;
    assert.match(openclaw, /new\s+.*Deploys go through staging first/);
    assert.match(openclaw, /new\s+.*Prefers concise answers/, "USER.md facts are profile items");
    assert.match(openclaw, /new\s+figma — Turn Figma frames into components/);
    assert.match(openclaw, /new\s+y — Review a pull request/, "a linked skill is read through the link");
    assert.match(openclaw, /new\s+github\b/);
    assert.match(openclaw, /new\s+frappe\b/);
    assert.match(openclaw, /new\s+telegram\b/);
    assert.match(openclaw, /new\s+discord\b/);
    assert.match(openclaw, /new\s+morning-brief — 0 7 \* \* \*/);
    assert.match(openclaw, /new\s+AGENTS\.md\b/);
    assert.match(openclaw, /skipped: unknown memory schema/);
    assert.ok(openclaw.includes("•••• (from openclaw.json channels.telegram.botToken) → set TELEGRAM_BOT_TOKEN"), openclaw);
    assert.ok(openclaw.includes("•••• (from openclaw.json channels.discord.token) → set DISCORD_BOT_TOKEN"));
    assert.ok(openclaw.includes("•••• (from openclaw.json mcp.servers.github.env.GITHUB_TOKEN) → set GITHUB_TOKEN"));
    assert.ok(openclaw.includes("FRAPPE_API_SECRET"), "the adapter server's secret is referenced by name");

    const hermes = plans.hermes!;
    assert.match(hermes, /new\s+.*Uses pnpm for every repo/);
    assert.match(hermes, /new\s+.*Works in IST/);
    assert.match(hermes, /new\s+x — Post a thread/);
    assert.match(hermes, /new\s+fs\b/);
    assert.ok(hermes.includes("•••• (from .env TELEGRAM_BOT_TOKEN) → set TELEGRAM_BOT_TOKEN"), hermes);

    const claude = plans.claude!;
    assert.match(claude, /new\s+linear\b/);
    assert.match(claude, /new\s+y — Review a pull request/);
    assert.match(claude, /new\s+CLAUDE\.md\b/);
    assert.match(claude, /→ set LINEAR_TOKEN/);

    const codex = plans.codex!;
    assert.match(codex, /new\s+z\b/);
    assert.match(codex, /new\s+w — Write release notes/);
    assert.match(codex, /new\s+AGENTS\.md\b/);
    assert.ok(codex.includes("•••• (from config.toml mcp_servers.z.env.Z_API_KEY) → set Z_API_KEY"), codex);

    assert.deepEqual(await hashTree(home), before, "no file under the fake HOME changed");
    assert.equal(existsSync(join(cwd, ".muster")), false, "a dry run writes nothing to Muster");
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  }
});

// Spec: MUS-SPEC-26-1B (docs/spec/clauses/26-migrate.md#mus-spec-26-1b--applying-brings-items-in-as-muster-native-with-secrets-as-env-references)
test("apply imports memory, skills, mcp, channels and schedules with secrets as env references, idempotently", async () => {
  const home = await makeFakeHome();
  const cwd = await workspace();
  const envDir = await mkdtemp(join(tmpdir(), "muster-migrate-env-"));
  try {
    const before = await hashTree(home);
    const envFile = join(envDir, "migrated.env");
    const first = await runCli(["migrate", "openclaw", "--apply", "--yes", "--write-env", envFile], { cwd, home });
    assert.equal(first.code, 0, first.stderr);
    assertNoSecrets(first.stdout + first.stderr, "apply output");
    const runId = first.stdout.match(/run (mig_[A-Za-z0-9_]+)/)?.[1];
    assert.ok(runId, first.stdout);

    const { listMemory, loadConfig, listSchedules } = await import("@musterhq/core");
    const memories = await listMemory(cwd);
    const migrated = memories.filter((memory) => memory.provenance.includes("migrated:openclaw"));
    assert.ok(migrated.some((memory) => memory.summary === "Deploys go through staging first"));
    assert.ok(migrated.some((memory) => memory.kind === "user_profile" && memory.summary === "Prefers concise answers"), "USER.md facts go into the profile");
    assert.ok(migrated.every((memory) => memory.scopes.some((scope) => scope.kind === "user" && scope.id === "tester")));
    assert.ok(migrated.every((memory) => memory.provenance.includes(`migrate:${runId}`)), "each entry carries the run's receipt id");

    const skill = await readFile(join(cwd, ".muster", "skills", "figma", "SKILL.md"), "utf8");
    assert.match(skill, /Export the frame, then build it\./);
    assert.match(skill, /migrated:openclaw/);
    assert.match(skill, new RegExp(`"sourceRunId":"${runId}"`));
    assert.equal(await readFile(join(cwd, ".muster", "skills", "figma", "references", "notes.md"), "utf8"), "Use the REST API.\n");

    const config = await loadConfig(cwd);
    const github = config.tools?.mcp?.servers?.github;
    assert.ok(github && github.transport.kind === "stdio");
    assert.equal(github.transport.command, "npx");
    assert.deepEqual(github.transport.env, { GITHUB_TOKEN: "${GITHUB_TOKEN}" });
    const frappe = config.tools?.mcp?.servers?.frappe;
    assert.ok(frappe && frappe.transport.kind === "stdio");
    assert.deepEqual(frappe.transport.env, { FRAPPE_SITE: "site1.local", FRAPPE_API_SECRET: "${FRAPPE_API_SECRET}" });

    const gateway = JSON.parse(await readFile(join(cwd, ".muster", "gateway.json"), "utf8"));
    assert.equal(gateway.telegram.botTokenEnv, "TELEGRAM_BOT_TOKEN");
    assert.equal(gateway.telegram.botToken, undefined);
    assert.equal(gateway.discord.botTokenEnv, "DISCORD_BOT_TOKEN");

    const jobs = await listSchedules(cwd);
    const job = jobs.find((entry) => entry.prompt === "Summarize my inbox");
    assert.ok(job, "the cron job became an automation");
    assert.equal(job.cron, "0 7 * * *");
    assert.equal(job.disabled, true, "imported automations stay off until enabled");

    assert.ok(existsSync(join(cwd, ".muster", "rules", "openclaw-agents.md")));
    assert.ok(existsSync(join(cwd, ".muster", "migrations", `${runId}.json`)), "the run left a receipt");
    assertNoSecrets(await allText(cwd), "Muster files");

    const envInfo = await stat(envFile);
    assert.equal(envInfo.mode & 0o777, 0o600, "--write-env writes a 0600 file");
    const dotenv = await readFile(envFile, "utf8");
    assert.ok(dotenv.includes(`TELEGRAM_BOT_TOKEN="${SECRETS.telegram}"`));
    assert.ok(dotenv.includes(`GITHUB_TOKEN="${SECRETS.github}"`));

    const musterBefore = await hashTree(join(cwd, ".muster"));
    const second = await runCli(["migrate", "openclaw", "--apply", "--yes"], { cwd, home });
    assert.equal(second.code, 0, second.stderr);
    assert.match(second.stdout, /already in Muster/);
    assert.doesNotMatch(second.stdout, /^\s+(added|new)\s/m);
    assert.match(second.stdout, /Nothing to apply/);
    assert.deepEqual(await hashTree(join(cwd, ".muster")), musterBefore, "a second apply changes nothing");
    assert.equal((await listMemory(cwd)).length, memories.length);

    assert.deepEqual(await hashTree(home), before, "apply never touches the source tree");
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
    await rm(envDir, { recursive: true, force: true });
  }
});
