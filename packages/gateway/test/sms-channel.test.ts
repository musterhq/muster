import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { approvePairing, gatewayConfigPath, requestPairing, sendToChannel, startGatewayServer, twilioSignature } from "../src/index.js";
import type { GatewayConfig } from "../src/index.js";
import { postSigned, startFakeTwilio } from "./fakes/twilio.js";
import { startStubModel, stubModelConfig } from "./fakes/stub-model.js";

const FROM = "+15550004000";
const OWNER = "+15550004001";
const DENTIST = "+15550004002";
const STRANGER = "+15550004999";

// Spec: MUS-SPEC-25-4A (docs/spec/clauses/25-calls-sms.md#mus-spec-25-4a--sms-is-a-channel-on-the-sdk)
test("sms inbound runs through the shared runner and outbound goes only to named contacts", async () => {
  const twilio = await startFakeTwilio();
  const cwd = await mkdtemp(join(tmpdir(), "muster-sms-4a-"));
  const env = { TWILIO_ACCOUNT_SID_4A: twilio.accountSid, TWILIO_AUTH_TOKEN_4A: twilio.authToken };
  const gateway: GatewayConfig = {
    token: "test-token-4a",
    calls: {
      provider: "twilio",
      accountSidEnv: "TWILIO_ACCOUNT_SID_4A",
      authTokenEnv: "TWILIO_AUTH_TOKEN_4A",
      from: FROM,
      contacts: { owner: OWNER, dentist: DENTIST },
      apiBaseUrl: twilio.baseUrl,
    },
    sms: { enabled: true },
  };
  await mkdir(join(cwd, ".muster"), { recursive: true });
  await writeFile(gatewayConfigPath(cwd), JSON.stringify(gateway));
  await requestPairing(`sms:${FROM}`, OWNER, cwd).then((pending) => approvePairing(pending.code, cwd));
  const llm = await startStubModel("four");
  const running = await startGatewayServer({ config: stubModelConfig(llm.url), gateway, cwd, env }, 0);
  const route = `http://127.0.0.1:${running.port}/v1/calls/twilio/sms`;
  const inbound = (sid: string, from: string, body: string): Array<[string, string]> => [
    ["AccountSid", twilio.accountSid], ["MessageSid", sid], ["From", from], ["To", FROM], ["Body", body], ["NumMedia", "0"],
  ];
  const previous = { ...process.env };
  Object.assign(process.env, env);
  try {
    // The owner's text starts one turn; the reply goes out through Messages.json.
    const owner = await postSigned(route, inbound("SM4A-OWNER-1", OWNER, "what is 2+2"), twilio.authToken);
    assert.equal(owner.status, 200);
    assert.match(owner.body, /<Response><\/Response>/);
    await running.waitForIdle();
    assert.equal(llm.prompts.length, 1);
    assert.match(llm.prompts[0], /what is 2\+2/);
    assert.deepEqual(twilio.messages(), [{ to: OWNER, from: FROM, body: "four" }]);

    // An unknown number gets the pairing challenge, and no turn.
    const stranger = await postSigned(route, inbound("SM4A-STRANGER-1", STRANGER, "hello"), twilio.authToken);
    assert.equal(stranger.status, 200);
    await running.waitForIdle();
    assert.equal(llm.prompts.length, 1);
    const challenge = twilio.messages().at(-1)!;
    assert.equal(challenge.to, STRANGER);
    assert.match(challenge.body, /muster pairing approve [A-Z0-9-]+/);

    // A forged inbound is refused before anything runs.
    const forged = await postSigned(route, inbound("SM4A-FORGED-1", OWNER, "hi"), twilio.authToken, { signature: twilioSignature("not-the-token", route, inbound("SM4A-FORGED-1", OWNER, "hi")) });
    assert.equal(forged.status, 403);
    await running.waitForIdle();
    assert.equal(llm.prompts.length, 1);

    // Outbound: contact names only, split at 1600 characters.
    const sentBefore = twilio.messages().length;
    const short = await sendToChannel("sms", "owner", "x".repeat(400), { cwd, gateway, env });
    assert.equal(short.messageIds.length, 1);
    assert.deepEqual(twilio.messages().slice(sentBefore), [{ to: OWNER, from: FROM, body: "x".repeat(400) }]);
    const long = await sendToChannel("sms", "dentist", "word ".repeat(660), { cwd, gateway, env });
    assert.equal(long.messageIds.length, 3);
    const parts = twilio.messages().slice(sentBefore + 1);
    assert.ok(parts.every((part) => part.to === DENTIST && part.body.length <= 1600), JSON.stringify(parts.map((part) => [part.to, part.body.length])));
    assert.equal(parts.map((part) => part.body).join(""), "word ".repeat(660));
    for (const peer of [DENTIST, STRANGER, "+15550004002 ", "nobody"]) {
      await assert.rejects(sendToChannel("sms", peer, "hi", { cwd, gateway, env }), /SMS goes only to contact names from calls\.contacts/);
    }
    assert.equal(twilio.messages().length, sentBefore + 4, "refused sends reach nothing");
  } finally {
    for (const key of Object.keys(env)) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
    await running.close();
    await llm.close();
    await twilio.close();
    await rm(cwd, { recursive: true, force: true });
  }
});
