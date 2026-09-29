import assert from "node:assert/strict";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { after, test } from "node:test";
import {
  HindsightClient,
  HindsightConfigError,
  HindsightRequestError,
  HindsightScopeError,
  HindsightUnavailableError,
  authorizeHindsightBank,
  hindsightBankId,
  resolveHindsightConfig,
} from "../src/hindsight.js";
import type { MemoryScope } from "../src/types.js";

const userScope: MemoryScope = { kind: "user", id: "me" };
const tenantScope: MemoryScope = { kind: "tenant", id: "acme" };
const globalScope: MemoryScope = { kind: "global", id: "shared" };

interface CapturedRequest {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
}

interface FakeHindsight {
  server: Server;
  baseUrl: string;
  requests: CapturedRequest[];
  respond: (req: CapturedRequest) =>
    | { status: number; body: unknown }
    | { status: number; raw: string }
    | { status: number; stream: (res: ServerResponse) => void };
}

const servers: Server[] = [];
after(() => { for (const server of servers) server.close(); });

async function startFakeHindsight(): Promise<FakeHindsight> {
  const fake: FakeHindsight = {
    server: undefined as unknown as Server,
    baseUrl: "",
    requests: [],
    respond: () => ({ status: 200, body: { success: true } }),
  };
  fake.server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const captured: CapturedRequest = {
        method: req.method ?? "",
        url: req.url ?? "",
        headers: req.headers,
        body: raw ? JSON.parse(raw) : undefined,
      };
      fake.requests.push(captured);
      const reply = fake.respond(captured);
      res.statusCode = reply.status;
      res.setHeader("content-type", "application/json");
      if ("stream" in reply) {
        reply.stream(res);
      } else {
        res.end("raw" in reply ? reply.raw : JSON.stringify(reply.body));
      }
    });
  });
  servers.push(fake.server);
  await new Promise<void>((resolve) => fake.server.listen(0, "127.0.0.1", resolve));
  fake.baseUrl = `http://127.0.0.1:${(fake.server.address() as AddressInfo).port}`;
  return fake;
}

function clientFor(fake: FakeHindsight, apiKey?: string): HindsightClient {
  return new HindsightClient({ baseUrl: fake.baseUrl, apiKey, timeoutMs: 2000, maxResponseBytes: 1_000_000, maxRequestBytes: 1_000_000 });
}

test("hindsight config is opt-in: missing URL throws config error, never a default endpoint", () => {
  assert.throws(() => resolveHindsightConfig({}), HindsightConfigError);
  assert.throws(() => resolveHindsightConfig({ HINDSIGHT_API_URL: "http://x", HINDSIGHT_TIMEOUT_MS: "-5" }), HindsightConfigError);
  const config = resolveHindsightConfig({ HINDSIGHT_API_URL: "http://localhost:8888/", HINDSIGHT_API_KEY: " k1 " });
  assert.equal(config.baseUrl, "http://localhost:8888");
  assert.equal(config.apiKey, "k1");
});

test("direct client construction validates config: bad URL scheme, credentialed URL, out-of-bound limits rejected", () => {
  const base = { timeoutMs: 2000, maxResponseBytes: 1000, maxRequestBytes: 1000 };
  assert.throws(() => new HindsightClient({ baseUrl: "ftp://x", ...base }), HindsightConfigError);
  assert.throws(() => new HindsightClient({ baseUrl: "http://user:pw@x", ...base }), HindsightConfigError);
  assert.throws(
    () => new HindsightClient({ baseUrl: "http://x", ...base, timeoutMs: 0 }),
    HindsightConfigError,
  );
  assert.throws(
    () => new HindsightClient({ baseUrl: "http://x", ...base, maxResponseBytes: 64_000_001 }),
    HindsightConfigError,
  );
  assert.throws(
    () => new HindsightClient({ baseUrl: "http://x", ...base, maxRequestBytes: 16_000_001 }),
    HindsightConfigError,
  );
});

test("bank mapping is deterministic and collision-safe across slug-colliding scopes", () => {
  assert.equal(hindsightBankId(userScope), hindsightBankId({ kind: "user", id: "me" }));
  const a = hindsightBankId({ kind: "user", id: "a.b" });
  const b = hindsightBankId({ kind: "user", id: "a_b" });
  assert.notEqual(a, b); // slugs collide ("a-b"), digest keeps banks distinct
  assert.match(a, /^muster-user-a-b-[0-9a-f]{12}$/);
});

test("scope authorization gates bank selection: cross-scope denied, global needs explicit opt-in", () => {
  assert.equal(
    authorizeHindsightBank({ scope: userScope, allowedScopes: [userScope, tenantScope] }),
    hindsightBankId(userScope),
  );
  assert.throws(
    () => authorizeHindsightBank({ scope: tenantScope, allowedScopes: [userScope] }),
    HindsightScopeError,
  );
  assert.throws(
    () => authorizeHindsightBank({ scope: globalScope, allowedScopes: [globalScope] }),
    HindsightScopeError,
  );
  assert.equal(
    authorizeHindsightBank({ scope: globalScope, allowedScopes: [globalScope], allowGlobal: true }),
    hindsightBankId(globalScope),
  );
});

test("retain posts source-derived path and body with provenance metadata and bearer auth", async () => {
  const fake = await startFakeHindsight();
  fake.respond = () => ({ status: 200, body: { success: true, items_count: 1, is_async: false } });
  const client = clientFor(fake, "secret-key");
  const result = await client.retain({
    scope: userScope,
    allowedScopes: [userScope],
    items: [{ content: "Alice works at Google", tags: ["work"], context: "standup" }],
    provenance: ["session:demo"],
  });
  const bankId = hindsightBankId(userScope);
  assert.equal(result.bankId, bankId);
  assert.equal(result.success, true);
  assert.equal(result.itemsCount, 1);
  const req = fake.requests[0];
  assert.equal(req.method, "POST");
  assert.equal(req.url, `/v1/default/banks/${bankId}/memories`);
  assert.equal(req.headers.authorization, "Bearer secret-key");
  assert.deepEqual(req.body, {
    items: [{
      content: "Alice works at Google",
      context: "standup",
      tags: ["work"],
      metadata: { muster_scope: "user:me", muster_provenance: "session:demo" },
    }],
    async: false,
  });
});

test("retain refuses empty provenance before any network call", async () => {
  const fake = await startFakeHindsight();
  await assert.rejects(
    clientFor(fake).retain({ scope: userScope, allowedScopes: [userScope], items: [{ content: "x" }], provenance: [] }),
    HindsightScopeError,
  );
  assert.equal(fake.requests.length, 0);
});

test("recall posts recall path with budget/max_tokens and parses results defensively", async () => {
  const fake = await startFakeHindsight();
  fake.respond = () => ({
    status: 200,
    body: { results: [{ id: "m1", text: "Alice works at Google", type: "world", score: 0.91 }, { bogus: true }, "junk"] },
  });
  const result = await clientFor(fake).recall({ scope: userScope, allowedScopes: [userScope], query: "Where does Alice work?" });
  assert.equal(result.results.length, 1);
  assert.deepEqual(result.results[0], { id: "m1", text: "Alice works at Google", type: "world", score: 0.91 });
  const req = fake.requests[0];
  assert.equal(req.url, `/v1/default/banks/${hindsightBankId(userScope)}/memories/recall`);
  assert.deepEqual(req.body, { query: "Where does Alice work?", budget: "mid", max_tokens: 4096 });
  assert.equal(req.headers.authorization, undefined); // no key configured -> no header
});

test("reflect posts reflect path and requires a text answer", async () => {
  const fake = await startFakeHindsight();
  fake.respond = () => ({ status: 200, body: { text: "Alice is at Google." } });
  const result = await clientFor(fake).reflect({ scope: userScope, allowedScopes: [userScope], query: "Summarize Alice" });
  assert.equal(result.text, "Alice is at Google.");
  assert.equal(fake.requests[0].url, `/v1/default/banks/${hindsightBankId(userScope)}/reflect`);
  fake.respond = () => ({ status: 200, body: { nope: true } });
  await assert.rejects(
    clientFor(fake).reflect({ scope: userScope, allowedScopes: [userScope], query: "again" }),
    HindsightRequestError,
  );
});

test("missing credentials surface the service's 401 without leaking the configured key", async () => {
  const fake = await startFakeHindsight();
  fake.respond = () => ({ status: 401, body: { detail: "Invalid or missing API key topsecret123" } });
  const client = clientFor(fake, "topsecret123");
  await assert.rejects(
    client.recall({ scope: userScope, allowedScopes: [userScope], query: "q" }),
    (error: unknown) => {
      assert.ok(error instanceof HindsightRequestError);
      assert.equal(error.status, 401);
      assert.ok(!error.message.includes("topsecret123"), "api key must not appear in errors");
      assert.ok(error.message.includes("[redacted]"));
      return true;
    },
  );
});

test("service 500 and non-JSON bodies become HindsightRequestError with status", async () => {
  const fake = await startFakeHindsight();
  fake.respond = () => ({ status: 500, body: { detail: "boom" } });
  await assert.rejects(
    clientFor(fake).recall({ scope: userScope, allowedScopes: [userScope], query: "q" }),
    (error: unknown) => error instanceof HindsightRequestError && error.status === 500,
  );
  fake.respond = () => ({ status: 200, raw: "not-json{" });
  await assert.rejects(
    clientFor(fake).recall({ scope: userScope, allowedScopes: [userScope], query: "q" }),
    HindsightRequestError,
  );
});

test("unreachable service degrades to HindsightUnavailableError, not a hang", async () => {
  const client = new HindsightClient({ baseUrl: "http://127.0.0.1:9", timeoutMs: 500, maxResponseBytes: 1000, maxRequestBytes: 1000 });
  await assert.rejects(
    client.recall({ scope: userScope, allowedScopes: [userScope], query: "q" }),
    HindsightUnavailableError,
  );
});

test("caller AbortSignal cancels an in-flight request", async () => {
  const fake = await startFakeHindsight();
  fake.server.removeAllListeners("request");
  fake.server.on("request", () => { /* never respond */ });
  const controller = new AbortController();
  const pending = clientFor(fake).recall({ scope: userScope, allowedScopes: [userScope], query: "q", signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, HindsightUnavailableError);
});

test("oversized responses are rejected to bound output", async () => {
  const fake = await startFakeHindsight();
  fake.respond = () => ({ status: 200, raw: JSON.stringify({ results: [{ text: "x".repeat(5000) }] }) });
  const client = new HindsightClient({ baseUrl: fake.baseUrl, timeoutMs: 2000, maxResponseBytes: 100, maxRequestBytes: 1_000_000 });
  await assert.rejects(
    client.recall({ scope: userScope, allowedScopes: [userScope], query: "q" }),
    HindsightRequestError,
  );
});

test("oversized request bodies are rejected client-side before any network call", async () => {
  const fake = await startFakeHindsight();
  const client = new HindsightClient({ baseUrl: fake.baseUrl, timeoutMs: 2000, maxResponseBytes: 1_000_000, maxRequestBytes: 200 });
  await assert.rejects(
    client.retain({
      scope: userScope,
      allowedScopes: [userScope],
      items: [{ content: "x".repeat(5000) }],
      provenance: ["test"],
    }),
    HindsightRequestError,
  );
  assert.equal(fake.requests.length, 0); // never left the client
});

test("response cap counts bytes, not UTF-16 units: multibyte body under char count but over byte cap is rejected", async () => {
  const fake = await startFakeHindsight();
  // 60 four-byte emoji = 60 chars but 240 bytes; cap 150 bytes must reject.
  fake.respond = () => ({ status: 200, raw: JSON.stringify({ results: [{ text: "\u{1F600}".repeat(60) }] }) });
  const client = new HindsightClient({ baseUrl: fake.baseUrl, timeoutMs: 2000, maxResponseBytes: 150, maxRequestBytes: 1_000_000 });
  await assert.rejects(
    client.recall({ scope: userScope, allowedScopes: [userScope], query: "q" }),
    HindsightRequestError,
  );
});

test("unending chunked body is cancelled early at the byte cap, not accumulated", async () => {
  const fake = await startFakeHindsight();
  let writes = 0;
  let signalClosed: () => void;
  const socketClosed = new Promise<void>((resolve) => {
    signalClosed = resolve;
  });
  fake.respond = () => ({
    status: 200,
    stream: (res) => {
      let closed = false;
      res.on("close", () => {
        closed = true;
        signalClosed();
      });
      // Drain-driven flood: write until backpressure, resume on drain. No timers.
      const pump = () => {
        while (!closed && res.writable) {
          writes += 1;
          if (!res.write("x".repeat(1024))) {
            res.once("drain", pump);
            return;
          }
        }
      };
      pump();
    },
  });
  const client = new HindsightClient({ baseUrl: fake.baseUrl, timeoutMs: 60_000, maxResponseBytes: 4096, maxRequestBytes: 1_000_000 });
  await assert.rejects(
    client.recall({ scope: userScope, allowedScopes: [userScope], query: "q" }),
    HindsightRequestError,
  );
  // Reader cancel propagates: connection closes instead of streaming forever.
  await socketClosed;
  assert.ok(writes >= 4, `expected flood before cancel, saw ${writes} writes`);
});

test("delayed body (headers sent, body stalls) hits the timeout as a typed unavailable error", async () => {
  const fake = await startFakeHindsight();
  fake.respond = () => ({
    status: 200,
    stream: (res) => {
      res.write("{"); // headers + partial body, then stall
    },
  });
  const client = new HindsightClient({ baseUrl: fake.baseUrl, timeoutMs: 300, maxResponseBytes: 1_000_000, maxRequestBytes: 1_000_000 });
  await assert.rejects(
    client.recall({ scope: userScope, allowedScopes: [userScope], query: "q" }),
    (error: unknown) => error instanceof HindsightUnavailableError && /timed out after 300ms/.test((error as Error).message),
  );
});

test("malformed JSON shapes degrade to empty results, not crashes", async () => {
  const fake = await startFakeHindsight();
  fake.respond = () => ({
    status: 200,
    raw: JSON.stringify({ results: [null, 42, "str", { no_text: true }, { text: "ok", score: "bad" }] }),
  });
  const result = await clientFor(fake).recall({ scope: userScope, allowedScopes: [userScope], query: "q" });
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].text, "ok");
});
