import assert from "node:assert/strict";
import { createHmac, createSign, generateKeyPairSync } from "node:crypto";
import type { JsonWebKey } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  approvePairing,
  gatewayConfigPath,
  loadGatewayConfig,
  requestPairing,
  startGatewayServer,
} from "../src/index.js";
import { startHeldStubModel, startStubModel, stubModelConfig } from "./fakes/stub-model.js";

const APP_ID = "app-24-5a";
const OPENID = "https://login.botframework.fake/v1/.well-known/openidconfiguration";
const JWKS = "https://login.botframework.fake/v1/keys";
const TOKEN_URL = "https://login.botframework.fake/token";
const SERVICE_URL = "https://smba.fake.test/amer/";
const TENANT = "tenant-24-5a";
const USER = "29:user-24-5a";
const CONVERSATION = "19:conv-24-5a@thread.skype";

function jwt(privateKey: string, kid: string, claims: Record<string, unknown>): string {
  const segment = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const unsigned = `${segment({ alg: "RS256", kid, typ: "JWT" })}.${segment(claims)}`;
  return `${unsigned}.${createSign("RSA-SHA256").update(unsigned).sign(privateKey).toString("base64url")}`;
}

function activity(id: string, text: string) {
  return {
    type: "message",
    id,
    timestamp: "2026-11-11T10:00:00.000Z",
    serviceUrl: SERVICE_URL,
    channelId: "msteams",
    from: { id: USER, name: "Ana" },
    conversation: { id: CONVERSATION },
    recipient: { id: `28:${APP_ID}`, name: "Muster" },
    text: `<at>Muster</at> ${text}`,
    channelData: { tenant: { id: TENANT } },
  };
}

interface Call {
  readonly method: string;
  readonly url: string;
  readonly authorization?: string;
  readonly body: string;
}

// Spec: MUS-SPEC-24-5A (docs/spec/clauses/24-channels-sdk-2.md#mus-spec-24-5a--teams-bot-framework-activities-with-proactive-replies)
test("teams bot framework activities are acknowledged and answered proactively; bad tokens are rejected", async () => {
  const connector = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const stranger = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const connectorPem = connector.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const strangerPem = stranger.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const jwk = connector.publicKey.export({ format: "jwk" }) as JsonWebKey;
  const calls: Call[] = [];
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("http://127.0.0.1")) return fetch(input, init);
    const headers = new Headers(init?.headers);
    const call = { method: init?.method ?? "GET", url, authorization: headers.get("authorization") ?? undefined, body: typeof init?.body === "string" ? init.body : "" };
    calls.push(call);
    if (url === OPENID) return Response.json({ issuer: "https://api.botframework.com", jwks_uri: JWKS });
    if (url === JWKS) return Response.json({ keys: [{ ...jwk, kid: "bf-kid-24", use: "sig", alg: "RS256" }] });
    if (url === TOKEN_URL) {
      const form = new URLSearchParams(call.body);
      const ok = form.get("grant_type") === "client_credentials" && form.get("client_id") === APP_ID && form.get("client_secret") === "teams-password-24";
      return ok ? Response.json({ access_token: "bf-token-24", expires_in: 3600, token_type: "Bearer" }) : Response.json({ error: "invalid_client" }, { status: 401 });
    }
    if (url.startsWith(`${SERVICE_URL}v3/conversations/`)) return Response.json({ id: `reply-${calls.length}` });
    throw new Error(`fake bot framework: unexpected ${call.method} ${url}`);
  }) as typeof fetch;

  const cwd = await mkdtemp(join(tmpdir(), "muster-teams-sdk-"));
  const previousPassword = process.env.TEAMS_APP_PASSWORD_24;
  process.env.TEAMS_APP_PASSWORD_24 = "teams-password-24";
  await mkdir(join(cwd, ".muster"), { recursive: true });
  await writeFile(gatewayConfigPath(cwd), JSON.stringify({
    token: "test-token",
    teams: { appId: APP_ID, appPasswordEnv: "TEAMS_APP_PASSWORD_24", openIdConfigUrl: OPENID, tokenUrl: TOKEN_URL },
  }));
  const gateway = await loadGatewayConfig(cwd);
  await requestPairing(`teams:${TENANT}`, USER, cwd).then((pending) => approvePairing(pending.code, cwd));
  const llm = await startHeldStubModel("the ledger is balanced");
  const running = await startGatewayServer({ config: stubModelConfig(llm.url), gateway, cwd, fetcher }, 0);
  const now = Math.floor(Date.now() / 1000);
  const claims = { iss: "https://api.botframework.com", aud: APP_ID, nbf: now - 10, exp: now + 300, serviceurl: SERVICE_URL };
  const post = (body: unknown, bearer: string) => fetch(`http://127.0.0.1:${running.port}/v1/adapters/teams`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${bearer}` },
    body: JSON.stringify(body),
  });
  const connectorCalls = () => calls.filter((call) => call.url.startsWith(SERVICE_URL));
  try {
    // A valid activity is acknowledged with 202 while the (long) turn still runs.
    const accepted = await post(activity("act-24-5a-1", "show the ledger"), jwt(connectorPem, "bf-kid-24", claims));
    assert.equal(accepted.status, 202);
    await llm.waitForPrompts(1);
    assert.equal(connectorCalls().length, 0, "nothing is sent before the turn finishes");

    llm.release();
    await running.waitForIdle();
    const replies = connectorCalls();
    assert.equal(replies.length, 1);
    assert.equal(replies[0].method, "POST");
    assert.equal(replies[0].url, `${SERVICE_URL}v3/conversations/${encodeURIComponent(CONVERSATION)}/activities/act-24-5a-1`);
    assert.equal(replies[0].authorization, "Bearer bf-token-24");
    assert.deepEqual(JSON.parse(replies[0].body), { type: "message", text: "the ledger is balanced", replyToId: "act-24-5a-1" });
    assert.ok(calls.every((call) => !call.url.includes("teams-password-24")));

    // Invalid tokens: wrong signer, wrong audience, expired, wrong or missing serviceUrl claim, none.
    const rejected = [
      jwt(strangerPem, "bf-kid-24", claims),
      jwt(connectorPem, "bf-kid-24", { ...claims, aud: "someone-else" }),
      jwt(connectorPem, "bf-kid-24", { ...claims, exp: now - 3600, nbf: now - 7200 }),
      jwt(connectorPem, "bf-kid-24", { ...claims, serviceurl: "https://evil.fake.test/" }),
      jwt(connectorPem, "bf-kid-24", { ...claims, serviceurl: undefined }),
      "not-a-jwt",
    ];
    for (const [index, bearer] of rejected.entries()) {
      const response = await post(activity(`act-24-5a-bad-${index}`, "hi"), bearer);
      assert.equal(response.status, 401, `token ${index}`);
      assert.deepEqual(await response.json(), { error: "Teams Bot Framework token verification failed." });
    }
    assert.equal(llm.prompts.length, 1);
    assert.equal(connectorCalls().length, 1);
  } finally {
    await running.close();
    await llm.close();
    if (previousPassword === undefined) delete process.env.TEAMS_APP_PASSWORD_24;
    else process.env.TEAMS_APP_PASSWORD_24 = previousPassword;
    await rm(cwd, { recursive: true, force: true });
  }

  // The outgoing-webhook HMAC mode still answers synchronously when configured instead.
  const hmacCwd = await mkdtemp(join(tmpdir(), "muster-teams-sdk-hmac-"));
  const secret = Buffer.from("teams-hmac-24").toString("base64");
  await mkdir(join(hmacCwd, ".muster"), { recursive: true });
  await writeFile(gatewayConfigPath(hmacCwd), JSON.stringify({ token: "test-token", teams: { hmacSecret: secret } }));
  await requestPairing(`teams:${TENANT}`, USER, hmacCwd).then((pending) => approvePairing(pending.code, hmacCwd));
  const quick = await startStubModel("hmac still works");
  const hmacRunning = await startGatewayServer({ config: stubModelConfig(quick.url), gateway: await loadGatewayConfig(hmacCwd), cwd: hmacCwd }, 0);
  try {
    const body = JSON.stringify(activity("act-24-5a-hmac", "hi"));
    const response = await fetch(`http://127.0.0.1:${hmacRunning.port}/v1/adapters/teams`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `HMAC ${createHmac("sha256", Buffer.from(secret, "base64")).update(body, "utf8").digest("base64")}` },
      body,
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { type: "message", text: "hmac still works" });
  } finally {
    await hmacRunning.close();
    await quick.close();
    await rm(hmacCwd, { recursive: true, force: true });
  }
});

// Spec: MUS-SPEC-24-5B (docs/spec/clauses/24-channels-sdk-2.md#mus-spec-24-5b--unknown-signing-keys-cannot-make-the-gateway-refetch-keys-on-every-request)
test("tokens with unknown key ids refresh the signing keys at most once per window", async () => {
  const { verifyBotFrameworkToken } = await import("../src/channels/bot-framework.js");
  let fetches = 0;
  const openId = "https://login.example.test/openid-ratelimit";
  const fetcher = (async (url: string | URL) => {
    fetches += 1;
    const href = String(url);
    if (href === openId) return new Response(JSON.stringify({ jwks_uri: "https://login.example.test/keys-ratelimit" }));
    return new Response(JSON.stringify({ keys: [] }));
  }) as typeof fetch;
  const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const now = Date.now();
  const token = (kid: string) => `Bearer ${b64({ alg: "RS256", kid })}.${b64({ iss: "https://api.botframework.com", aud: "app-1", exp: Math.floor(now / 1000) + 600, serviceurl: "https://smba.example.test/" })}.c2ln`;
  for (let index = 0; index < 5; index += 1) {
    const ok = await verifyBotFrameworkToken({ authorization: token(`forged-${index}`), appId: "app-1", serviceUrl: "https://smba.example.test/", fetcher, openIdConfigUrl: openId, now: now + index });
    assert.equal(ok, false);
  }
  // The first request loads the keys (OpenID config + JWKS). They were just fetched, so no forced refresh follows,
  // and later unknown kids reuse the cache: forged tokens cannot make the gateway hammer the key endpoints.
  assert.equal(fetches, 2, `fetched ${fetches} times for 5 forged tokens`);
});
