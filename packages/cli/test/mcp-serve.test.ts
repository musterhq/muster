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
