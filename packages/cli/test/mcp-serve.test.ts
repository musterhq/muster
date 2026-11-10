import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import readline from "node:readline";
import { test } from "node:test";

const cliPath = resolve(import.meta.dirname, "..", "src", "index.ts");

/** A minimal MCP client over the real `muster mcp serve` process. */
async function connect(cwd: string) {
  const child = spawn("tsx", [cliPath, "mcp", "serve"], { cwd, env: { ...process.env, MUSTER_ONBOARDING_HOME: join(cwd, ".test-home") }, stdio: ["pipe", "pipe", "pipe"] });
  const pending = new Map<number, (message: Record<string, unknown>) => void>();
  readline.createInterface({ input: child.stdout }).on("line", (line) => {
    let message: Record<string, unknown>;
    try { message = JSON.parse(line); } catch { return; }
    const id = message.id as number;
    pending.get(id)?.(message);
    pending.delete(id);
  });
  let nextId = 1;
  const request = (method: string, params: Record<string, unknown> = {}) => new Promise<Record<string, unknown>>((resolveRequest, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 20_000);
    pending.set(id, (message) => { clearTimeout(timer); resolveRequest(message); });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
  return { request, close: () => child.kill() };
}

async function workspace(policy?: string): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "muster-mcp-serve-"));
  const { execFile } = await import("node:child_process");
  await new Promise<void>((done, fail) => execFile("tsx", [cliPath, "init"], { cwd, env: { ...process.env, MUSTER_ONBOARDING_HOME: join(cwd, ".test-home") } }, (error) => error ? fail(error) : done()));
  if (policy) {
    const path = join(cwd, ".muster", "config.json");
    const config = JSON.parse(await readFile(path, "utf8"));
    await writeFile(path, JSON.stringify({ ...config, memory: { ...(config.memory ?? {}), policy } }));
  }
  return cwd;
}

function text(result: Record<string, unknown>): string {
  const content = (result.result as { content?: Array<{ text?: string }> }).content ?? [];
  return content.map((block) => block.text ?? "").join("\n");
}

// Spec: MUS-SPEC-04-1A (docs/spec/clauses/04-mcp-serve.md#mus-spec-04-1a--an-mcp-client-can-list-and-call-musters-tools)
test("an MCP client lists Muster's tools, writes a memory and finds it again", { timeout: 90_000 }, async () => {
  const cwd = await workspace();
  const client = await connect(cwd);
  try {
    const init = await client.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
    assert.equal((init.result as { serverInfo: { name: string } }).serverInfo.name, "muster");
    const list = await client.request("tools/list");
    const tools = (list.result as { tools: Array<{ name: string; inputSchema?: unknown }> }).tools;
    const names = tools.map((tool) => tool.name).sort();
    for (const name of ["memory_get", "memory_search", "memory_write", "result_fetch", "session_search", "session_status"]) {
      assert.ok(names.includes(name), `${name} is listed`);
    }
    assert.ok(tools.every((tool) => tool.inputSchema), "every tool has an input schema");
    assert.ok(!names.some((name) => ["terminal", "write_file"].includes(name)), "no shell or file-write tools");
    const written = await client.request("tools/call", { name: "memory_write", arguments: { summary: "Prefers metric units", scopes: ["user:me"] } });
    assert.notEqual((written.result as { isError?: boolean }).isError, true, text(written));
    assert.match(text(written), /mem_/);
    const found = await client.request("tools/call", { name: "memory_search", arguments: { scopes: ["user:me"], query: "metric" } });
    assert.match(text(found), /Prefers metric units/);
  } finally {
    client.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

// Spec: MUS-SPEC-04-1B (docs/spec/clauses/04-mcp-serve.md#mus-spec-04-1b--memory-policy-still-governs-writes-through-mcp)
test("memory_write through MCP obeys memory.policy", { timeout: 90_000 }, async () => {
  const cwd = await workspace("never");
  const client = await connect(cwd);
  try {
    await client.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
    const written = await client.request("tools/call", { name: "memory_write", arguments: { summary: "Prefers metric units", scopes: ["user:me"] } });
    assert.equal((written.result as { isError?: boolean }).isError, true);
    assert.match(text(written), /policy is "never"/);
    const found = await client.request("tools/call", { name: "memory_search", arguments: { scopes: ["user:me"], query: "metric" } });
    assert.doesNotMatch(text(found), /Prefers metric units/);
  } finally {
    client.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

// Spec: MUS-SPEC-16-4A (docs/spec/clauses/16-automations.md#mus-spec-16-4a--agents-set-reminders-through-schedule_manage)
test("an agent sets, lists and removes a reminder over MCP", { timeout: 90_000 }, async () => {
  const cwd = await workspace();
  const client = await connect(cwd);
  try {
    await client.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
    const list = await client.request("tools/list");
    const tool = (list.result as { tools: Array<{ name: string; inputSchema?: unknown }> }).tools.find((entry) => entry.name === "schedule_manage");
    assert.ok(tool?.inputSchema, "schedule_manage is listed with a schema");

    const before = Date.now();
    const created = await client.request("tools/call", { name: "schedule_manage", arguments: { action: "create", kind: "reminder", when: "in 5 minutes", message: "stretch" } });
    assert.notEqual((created.result as { isError?: boolean }).isError, true, text(created));
    const echo = text(created);
    const id = echo.match(/sched_[a-z0-9]+/)?.[0];
    assert.ok(id, echo);
    assert.match(echo, /reminder/);
    assert.match(echo, /"stretch"/);
    assert.match(echo, /terminal/);
    const iso = echo.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z/)?.[0];
    assert.ok(iso, echo);
    const delta = Date.parse(iso!) - before;
    assert.ok(delta >= 4.5 * 60_000 && delta <= 5.5 * 60_000, `fires ~5 minutes out (${delta} ms)`);

    const listed = await client.request("tools/call", { name: "schedule_manage", arguments: { action: "list" } });
    assert.match(text(listed), new RegExp(`${id}[\\s\\S]*stretch`));

    const removed = await client.request("tools/call", { name: "schedule_manage", arguments: { action: "remove", id } });
    assert.match(text(removed), new RegExp(`Removed ${id}`));
    const after = await client.request("tools/call", { name: "schedule_manage", arguments: { action: "list" } });
    assert.doesNotMatch(text(after), new RegExp(id!));
  } finally {
    client.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

// Spec: MUS-SPEC-11-1H (docs/spec/clauses/11-plugin-bundles.md#mus-spec-11-1h--a-codex-turn-can-read-an-installed-bundles-skill-through-skill_view)
test("skill_view over MCP returns an installed bundle's skill", { timeout: 120_000 }, async () => {
  const cwd = await workspace();
  const { mkdir } = await import("node:fs/promises");
  const { execFile } = await import("node:child_process");
  const bundle = join(cwd, "src", "hello-kit");
  const files: Record<string, string> = {
    ".claude-plugin/plugin.json": JSON.stringify({ name: "hello-kit", version: "0.1.0", description: "Greetings" }),
    "skills/greet/SKILL.md": "---\nname: greet\ndescription: Greet the user warmly\n---\n\nSay hello and use the user's name.\n",
  };
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(bundle, path, ".."), { recursive: true });
    await writeFile(join(bundle, path), content, "utf8");
  }
  await new Promise<void>((done, fail) => execFile("tsx", [cliPath, "plugins", "install", bundle], { cwd, env: { ...process.env, MUSTER_ONBOARDING_HOME: join(cwd, ".test-home") } }, (error) => error ? fail(error) : done()));
  const client = await connect(cwd);
  try {
    await client.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
    const tools = ((await client.request("tools/list")).result as { tools: Array<{ name: string; inputSchema?: { properties?: Record<string, unknown> } }> }).tools;
    const view = tools.find((tool) => tool.name === "skill_view");
    assert.ok(view, `skill_view is listed: ${tools.map((tool) => tool.name).join(", ")}`);
    assert.ok(view.inputSchema?.properties?.name, "it takes a skill name");
    assert.ok(!tools.some((tool) => /terminal|write_file|shell/.test(tool.name)), "still no shell or file writes");
    const found = await client.request("tools/call", { name: "skill_view", arguments: { name: "greet" } });
    assert.notEqual((found.result as { isError?: boolean }).isError, true, text(found));
    assert.match(text(found), /greet/);
    assert.match(text(found), /Greet the user warmly/);
    assert.match(text(found), /Say hello and use the user's name\./);
    const missing = await client.request("tools/call", { name: "skill_view", arguments: { name: "nope" } });
    assert.equal((missing.result as { isError?: boolean }).isError, true);
    assert.match(text(missing), /nope/);
  } finally {
    client.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

// Spec: MUS-SPEC-04-1C (docs/spec/clauses/04-mcp-serve.md#mus-spec-04-1c--memory-tools-default-to-the-user-scope)
test("memory tools default to the user's scope when a client passes none", { timeout: 90_000 }, async () => {
  const cwd = await workspace();
  const client = await connect(cwd);
  try {
    await client.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
    const user = `user:${process.env.USER || process.env.USERNAME || "local"}`;
    const written = await client.request("tools/call", { name: "memory_write", arguments: { summary: "Lunch is at noon on Fridays", scopes: [user] } });
    assert.notEqual((written.result as { isError?: boolean }).isError, true, text(written));
    const found = await client.request("tools/call", { name: "memory_search", arguments: { query: "lunch" } });
    assert.notEqual((found.result as { isError?: boolean }).isError, true, text(found));
    assert.match(text(found), /Lunch is at noon/);
  } finally {
    client.close();
    await rm(cwd, { recursive: true, force: true });
  }
});
