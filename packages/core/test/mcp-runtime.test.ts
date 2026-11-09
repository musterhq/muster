import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { clearCodexAppServerSessions, defaultConfig, executeRun, resolveRuntimeMcpServers, writeMcpOAuthToken } from "../src/index.js";
import type { MusterConfig } from "../src/index.js";

function withServers(servers: Record<string, unknown>, extra: Record<string, unknown> = {}): MusterConfig {
  const base = defaultConfig();
  return { ...base, tools: { ...(base.tools ?? {}), ...extra, mcp: { servers } } } as MusterConfig;
}

const NOTES = { transport: { kind: "stdio", command: "notes-mcp", args: ["--stdio"], env: { NOTES_TOKEN: "s3cret-value" } } };
const DOCS = { transport: { kind: "http", url: "https://docs.example/mcp", headers: { "X-Team": "core" } } };

async function withEnv<T>(values: Record<string, string>, body: () => Promise<T>): Promise<T> {
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  Object.assign(process.env, values);
  try {
    return await body();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

// Spec: MUS-SPEC-03-1A (docs/spec/clauses/03-mcp-runtime.md#mus-spec-03-1a--codex-turns-get-musters-mcp-servers-without-secrets-on-the-command-line)
test("codex turns receive configured MCP servers through thread config, never argv", async () => {
  const dir = await mkdtemp(join(tmpdir(), "muster-mcp-codex-"));
  const fake = join(dir, "codex-fake.mjs");
  const record = join(dir, "record.json");
  await writeFile(fake, `#!/usr/bin/env node
import readline from "node:readline";
import { writeFileSync } from "node:fs";
const rl = readline.createInterface({ input: process.stdin });
const seen = { argv: process.argv.slice(2), threadStart: null };
function send(msg) { process.stdout.write(JSON.stringify(msg) + "\\n"); }
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") send({ id: msg.id, result: { userAgent: "fake" } });
  else if (msg.method === "thread/start" || msg.method === "thread/resume") {
    seen.threadStart = msg.params;
    writeFileSync(${JSON.stringify(record)}, JSON.stringify(seen));
    send({ id: msg.id, result: { thread: { id: "thread-mcp" } } });
  } else if (msg.method === "turn/start") {
    send({ id: msg.id, result: { turn: { id: "turn-1", status: "inProgress" } } });
    send({ method: "item/completed", params: { threadId: "thread-mcp", turnId: "turn-1", item: { type: "agentMessage", id: "m", text: "ok" } } });
    send({ method: "turn/completed", params: { threadId: "thread-mcp", turn: { id: "turn-1", status: "completed" } } });
  }
});
`, "utf8");
  await chmod(fake, 0o755);
  try {
    await withEnv({ MUSTER_CODEX_COMMAND: fake, MUSTER_HOME: join(dir, "home") }, async () => {
      const outcome = await executeRun(withServers({ notes: NOTES }), {
        runtime: "codex",
        prompt: "list my notes",
        cwd: dir,
        nativeSession: true,
        nativeTransport: "warm",
        nativeSessionKeepAlive: false,
        conversationKey: "mcp-codex",
        skipAgentRules: true,
        skipRecall: true,
        skipSkillSelection: true,
        skipMemoryWrite: true,
      });
      assert.equal(outcome.episode.responseText, "ok");
    });
    const seen = JSON.parse(await readFile(record, "utf8")) as { argv: string[]; threadStart: { config?: Record<string, unknown> } };
    const server = seen.threadStart.config?.["mcp_servers.notes"] as Record<string, unknown> | undefined;
    assert.ok(server, "the thread config names the server");
    assert.equal(server.command, "notes-mcp");
    assert.deepEqual(server.args, ["--stdio"]);
    assert.deepEqual(server.env, { NOTES_TOKEN: "s3cret-value" });
    assert.doesNotMatch(seen.argv.join(" "), /s3cret-value|notes-mcp/, "nothing about the server is on the command line");
  } finally {
    clearCodexAppServerSessions();
    await rm(dir, { recursive: true, force: true });
  }
});

// Spec: MUS-SPEC-03-1B (docs/spec/clauses/03-mcp-runtime.md#mus-spec-03-1b--claude-code-turns-get-musters-mcp-servers-through-a-private-config-file)
test("claude turns receive configured MCP servers through a private --mcp-config file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "muster-mcp-claude-"));
  const command = join(dir, "claude");
  const record = join(dir, "record.txt");
  await writeFile(command, `#!/usr/bin/env bash
set -euo pipefail
prev=""
for arg in "$@"; do
  if [ "$prev" = "--mcp-config" ]; then
    printf '%s\\n' "$arg" > "${record}"
    stat -f '%Lp' "$arg" >> "${record}"
    cat "$arg" >> "${record}"
  fi
  prev="$arg"
done
printf 'ok from fake claude\\n'
`, "utf8");
  await chmod(command, 0o755);
  try {
    await withEnv({ MUSTER_HOME: join(dir, "home") }, async () => {
      const outcome = await executeRun(withServers({ notes: NOTES, docs: DOCS }), {
        runtime: "claude-code",
        prompt: "list my notes",
        cwd: dir,
        claudeCommand: command,
        skipAgentRules: true,
        skipRecall: true,
        skipSkillSelection: true,
        skipMemoryWrite: true,
      });
      assert.equal(outcome.episode.responseText, "ok from fake claude");
    });
    const [path, mode, ...json] = (await readFile(record, "utf8")).split("\n");
    assert.equal(mode, "600", "only the user can read the file");
    const parsed = JSON.parse(json.join("\n")) as { mcpServers: Record<string, Record<string, unknown>> };
    assert.deepEqual(parsed.mcpServers.notes, { type: "stdio", command: "notes-mcp", args: ["--stdio"], env: { NOTES_TOKEN: "s3cret-value" } });
    assert.deepEqual(parsed.mcpServers.docs, { type: "http", url: "https://docs.example/mcp", headers: { "X-Team": "core" } });
    await assert.rejects(() => stat(path!), /ENOENT/, "the file is removed after the turn");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// Spec: MUS-SPEC-03-1C (docs/spec/clauses/03-mcp-runtime.md#mus-spec-03-1c--denied-or-disabled-servers-never-reach-a-turn)
test("denied and disabled MCP servers are not passed to any runtime", async () => {
  const config = withServers({ notes: NOTES, blocked: NOTES, off: NOTES }, { deny: ["mcp:blocked"], entries: { off: { enabled: false } } });
  const resolved = await resolveRuntimeMcpServers(config, tmpdir());
  assert.deepEqual(Object.keys(resolved.servers).sort(), ["notes"]);
});

// Spec: MUS-SPEC-03-1D (docs/spec/clauses/03-mcp-runtime.md#mus-spec-03-1d--signed-in-oauth-servers-carry-their-token)
test("oauth servers carry the saved token and unsigned ones are skipped with a reason", async () => {
  const dir = await mkdtemp(join(tmpdir(), "muster-mcp-oauth-"));
  try {
    await withEnv({ MUSTER_HOME: join(dir, "home") }, async () => {
      await writeMcpOAuthToken("linear", { accessToken: "lin-token", tokenType: "Bearer", obtainedAt: Date.now() }, dir);
      const config = withServers({
        linear: { transport: { kind: "http", url: "https://mcp.linear.app/mcp" }, auth: "oauth" },
        github: { transport: { kind: "http", url: "https://api.githubcopilot.com/mcp/" }, auth: "oauth" },
      });
      const resolved = await resolveRuntimeMcpServers(config, dir);
      const linear = resolved.servers.linear?.transport;
      assert.ok(linear && linear.kind === "http");
      assert.equal(linear.headers?.Authorization, "Bearer lin-token");
      assert.equal(resolved.servers.github, undefined);
      assert.match(resolved.skipped.find((entry) => entry.name === "github")?.reason ?? "", /muster mcp login github/);
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
