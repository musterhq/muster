import assert from "node:assert/strict";
import { createSign, createVerify, generateKeyPairSync } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  approvePairing,
  createGoogleChatRequestVerifier,
  gatewayConfigPath,
  loadGatewayConfig,
  requestPairing,
  startGatewayServer,
} from "../src/index.js";
import { startHeldStubModel, stubModelConfig } from "./fakes/stub-model.js";

const PROJECT_NUMBER = "240000000004";
const CHAT_ISSUER = "chat@system.gserviceaccount.com";
const CHAT_CERTS = `https://www.googleapis.com/service_accounts/v1/metadata/x509/${CHAT_ISSUER}`;
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SPACE = "spaces/S24";
const THREAD = "spaces/S24/threads/T24";
const SENDER = "users/24-4a";

function jwt(privateKey: string, header: Record<string, unknown>, claims: Record<string, unknown>): string {
  const segment = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const unsigned = `${segment(header)}.${segment(claims)}`;
  return `${unsigned}.${createSign("RSA-SHA256").update(unsigned).sign(privateKey).toString("base64url")}`;
}

interface Call {
  readonly method: string;
  readonly url: string;
  readonly authorization?: string;
  readonly body: string;
}

// Spec: MUS-SPEC-24-4A (docs/spec/clauses/24-channels-sdk-2.md#mus-spec-24-4a--google-chat-answers-in-the-thread-and-verifies-the-bearer-token)
test("google chat replies in thread and rejects tokens for another audience", async () => {
  const google = generateKeyPairSync("rsa", { modulusLength: 2048, publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } });
  const serviceAccount = generateKeyPairSync("rsa", { modulusLength: 2048, publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } });
  const calls: Call[] = [];
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("http://127.0.0.1")) return fetch(input, init);
    const headers = new Headers(init?.headers);
    const call = { method: init?.method ?? "GET", url, authorization: headers.get("authorization") ?? undefined, body: typeof init?.body === "string" ? init.body : "" };
    calls.push(call);
    if (url === CHAT_CERTS) return Response.json({ "kid-24": google.publicKey });
    if (url === TOKEN_URL) {
      const form = new URLSearchParams(call.body);
      const [header, claims, signature] = (form.get("assertion") ?? "").split(".");
      const valid = form.get("grant_type") === "urn:ietf:params:oauth:grant-type:jwt-bearer"
        && createVerify("RSA-SHA256").update(`${header}.${claims}`).verify(serviceAccount.publicKey, Buffer.from(signature ?? "", "base64url"));
      return valid ? Response.json({ access_token: "ya29.chat-24", expires_in: 3600 }) : Response.json({ error: "invalid_grant" }, { status: 400 });
    }
    if (url.startsWith("https://chat.googleapis.com/v1/")) return Response.json({ name: `${SPACE}/messages/reply-${calls.length}` });
    throw new Error(`fake google: unexpected ${call.method} ${url}`);
  }) as typeof fetch;

  const cwd = await mkdtemp(join(tmpdir(), "muster-gchat-sdk-"));
  const previousKey = process.env.GCHAT_SA_KEY_24;
  process.env.GCHAT_SA_KEY_24 = JSON.stringify({ client_email: "muster-bot@proj.iam.gserviceaccount.com", private_key: serviceAccount.privateKey, token_uri: TOKEN_URL });
  await mkdir(join(cwd, ".muster"), { recursive: true });
  await writeFile(gatewayConfigPath(cwd), JSON.stringify({
    token: "test-token",
    gchat: { verification: { mode: "bearer", audience: PROJECT_NUMBER }, api: { serviceAccountKeyEnv: "GCHAT_SA_KEY_24" } },
  }));
  const gateway = await loadGatewayConfig(cwd);
  await requestPairing("gchat:app", SENDER, cwd).then((pending) => approvePairing(pending.code, cwd));
  const llm = await startHeldStubModel("two flows are pending");
  const running = await startGatewayServer({
    config: stubModelConfig(llm.url),
    gateway,
    cwd,
    fetcher,
    gchatVerifier: createGoogleChatRequestVerifier({ fetcher }),
  }, 0);
  const now = Math.floor(Date.now() / 1000);
  const token = (audience: string) => jwt(google.privateKey, { alg: "RS256", kid: "kid-24", typ: "JWT" }, { iss: CHAT_ISSUER, aud: audience, iat: now, exp: now + 300 });
  const event = (name: string) => JSON.stringify({
    type: "MESSAGE",
    eventTime: "2026-11-11T10:00:00.000Z",
    space: { name: SPACE, type: "ROOM" },
    message: { name: `${SPACE}/messages/${name}`, sender: { name: SENDER, type: "HUMAN" }, text: "@Muster what is pending?", argumentText: " what is pending?", thread: { name: THREAD } },
    user: { name: SENDER, type: "HUMAN" },
  });
  const post = (body: string, bearer: string) => fetch(`http://127.0.0.1:${running.port}/v1/adapters/googlechat`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${bearer}` },
    body,
  });
  try {
    // The webhook is acknowledged while the turn is still running.
    const accepted = await post(event("m24-1"), token(PROJECT_NUMBER));
    assert.equal(accepted.status, 200);
    assert.deepEqual(await accepted.json(), {});
    await llm.waitForPrompts(1);
    assert.equal(calls.filter((call) => call.url.startsWith("https://chat.googleapis.com/")).length, 0, "no reply before the turn finishes");

    llm.release();
    await running.waitForIdle();
    const replies = calls.filter((call) => call.url.startsWith("https://chat.googleapis.com/"));
    assert.equal(replies.length, 1);
    assert.equal(replies[0].method, "POST");
    assert.equal(replies[0].url, `https://chat.googleapis.com/v1/${SPACE}/messages?messageReplyOption=REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD`);
    assert.equal(replies[0].authorization, "Bearer ya29.chat-24");
    assert.deepEqual(JSON.parse(replies[0].body), { text: "two flows are pending", thread: { name: THREAD } });
    assert.ok(calls.every((call) => !call.body.includes("BEGIN PRIVATE KEY")), "the service-account key never leaves the process");

    // A token minted for another audience is refused before any turn.
    const wrongAudience = await post(event("m24-2"), token("999999999999"));
    assert.equal(wrongAudience.status, 401);
    assert.deepEqual(await wrongAudience.json(), { error: "Google Chat bearer verification failed." });
    assert.equal(llm.prompts.length, 1);
  } finally {
    await running.close();
    await llm.close();
    if (previousKey === undefined) delete process.env.GCHAT_SA_KEY_24;
    else process.env.GCHAT_SA_KEY_24 = previousKey;
    await rm(cwd, { recursive: true, force: true });
  }
});
