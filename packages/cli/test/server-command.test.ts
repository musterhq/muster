import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { normalizeServerUrl, loadServerLink, type FetchLike } from "../src/server-client.js";
import { runServerCommand } from "../src/server-command.js";

function fakeServer(calls: Array<{ url: string; auth?: string; body?: string }> = []): FetchLike {
  const json = (value: unknown, status = 200) => ({ status, text: async () => JSON.stringify(value) });
  return async (url, init) => {
    calls.push({ url, auth: init.headers?.authorization, body: init.body });
    if (url.endsWith("/healthz")) return json({ ok: true, name: "Muster Server", version: "0.3.13" });
    if (init.headers?.authorization !== "Bearer good") return json({ ok: false, error: "Not signed in." }, 401);
    if (url.endsWith("/api/auth/me")) return json({ ok: true, user: { username: "ada", role: "member" } });
    const { command } = JSON.parse(init.body ?? "{}") as { command: string };
    switch (command) {
      case "project.list": return json({ ok: true, value: [{ id: "p1", name: "Alpha", goal: "Ship it" }, { id: "p2", name: "Old", archived: true }] });
      case "project.members.list": return json({ ok: true, value: { members: [{ id: "a1", name: "Scout", kind: "agent" }] } });
      case "project.team.settings": return json({ ok: true, value: { keyPrefix: "ALP" } });
      case "project.work": return json({ ok: true, value: { tasks: { items: [{ id: "t1", seq: 3, state: "todo", priority: 1, title: "Write docs", owner: { kind: "agent", id: "a1" } }, { id: "t2", seq: 4, state: "review", priority: 2, title: "Fix bug", owner: { kind: "user" } }] } } });
      case "project.approvals.list": return json({ ok: true, value: { items: [{ id: "abcdef123456", kind: "hire", state: "pending", title: "Hire Scout" }] } });
      case "paperclip.ledger": return json({ ok: true, value: { entries: [{ endedAt: "2026-10-17T10:00:00Z", agent: "Scout", model: "gpt", tokens: { input: 10, output: 5 }, costUsd: 0.5, outcome: "done" }], chain: { ok: true, entries: 1 } } });
      default: return json({ ok: false, error: `Unknown command "${command}".` }, 400);
    }
  };
}

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "muster-server-link-"));
  const lines: string[] = [];
  const linkPath = join(dir, "server.json");
  const calls: Array<{ url: string; auth?: string; body?: string }> = [];
  const io = { out: (line: string) => lines.push(line), env: { TOK: "good", BAD: "nope" } as NodeJS.ProcessEnv, fetch: fakeServer(calls), linkPath };
  return { io, lines, linkPath, calls };
}

test("server addresses must be https, or http on this computer, with no embedded credentials", () => {
  assert.equal(normalizeServerUrl("https://muster.example.com/x"), "https://muster.example.com");
  assert.equal(normalizeServerUrl("http://127.0.0.1:7470"), "http://127.0.0.1:7470");
  assert.throws(() => normalizeServerUrl("http://muster.example.com"), /https/);
  assert.throws(() => normalizeServerUrl("https://u:p@muster.example.com"), /user name/);
  assert.throws(() => normalizeServerUrl("nope"), /server address/);
});

test("connect verifies the server and token, saves a 0600 link, and never accepts a token on the command line", async () => {
  const { io, lines, linkPath } = await setup();
  await assert.rejects(() => runServerCommand(["connect", "https://muster.example.com", "--token", "good"], io), /Tokens are never taken from the command line/);
  await assert.rejects(() => runServerCommand(["connect", "https://muster.example.com", "--token-env", "BAD"], io), /rejected this token/);
  assert.equal(await loadServerLink(linkPath), undefined, "a rejected token is not saved");

  await runServerCommand(["connect", "https://muster.example.com", "--token-env", "TOK"], io);
  assert.match(lines.at(-1)!, /Connected to https:\/\/muster\.example\.com as ada \(member\), server 0\.3\.13/);
  assert.equal((await stat(linkPath)).mode & 0o777, 0o600);
  assert.equal((JSON.parse(await readFile(linkPath, "utf8")) as { token: string }).token, "good");

  await runServerCommand(["status"], io);
  assert.match(lines.at(-1)!, /Signed in as ada \(member\)/);
  await runServerCommand(["disconnect"], io);
  assert.equal(await loadServerLink(linkPath), undefined);
  await assert.rejects(() => runServerCommand(["projects"], io), /Not connected/);
});

test("projects, tasks, approvals and ledger read the server with the saved token", async () => {
  const { io, lines, calls } = await setup();
  await runServerCommand(["connect", "https://muster.example.com", "--token-env", "TOK"], io);

  await runServerCommand(["projects"], io);
  assert.match(lines.at(-1)!, /Alpha/);
  assert.doesNotMatch(lines.at(-1)!, /Old/, "archived projects are hidden");

  await runServerCommand(["tasks"], io);
  assert.match(lines.at(-1)!, /ALP-3\s+todo\s+1\s+Scout\s+Write docs/);
  assert.match(lines.at(-1)!, /ALP-4\s+review\s+2\s+you\s+Fix bug/);
  await runServerCommand(["tasks", "--project", "alpha", "--state", "review"], io);
  assert.doesNotMatch(lines.at(-1)!, /Write docs/);
  await assert.rejects(() => runServerCommand(["tasks", "--project", "missing"], io), /No project "missing"/);

  await runServerCommand(["approvals"], io);
  assert.match(lines.at(-1)!, /abcdef12\s+hire\s+pending\s+Hire Scout/);
  await runServerCommand(["ledger"], io);
  assert.match(lines.at(-1)!, /Scout\s+gpt\s+15\s+\$0\.50\s+done/);
  assert.match(lines.at(-1)!, /Chain verified \(1 entries\)/);
  assert.ok(calls.filter((call) => call.url.endsWith("/rpc")).every((call) => call.auth === "Bearer good"));
  await assert.rejects(() => runServerCommand(["bogus"], io), /Usage/);
});
