import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  approvePairing,
  defaultChannelRegistry,
  initGatewayConfig,
  loadPairings,
  parseEmailMessage,
  requestPairing,
  runChannelWorker,
} from "../src/index.js";
import type { GatewayConfig } from "../src/index.js";
import { mailHeaders, rawMail, startFakeImapServer, startFakeSmtpServer } from "./fakes/mail-servers.js";
import type { FakeImapServer, FakeSmtpServer } from "./fakes/mail-servers.js";
import { startStubModel, stubModelConfig } from "./fakes/stub-model.js";

const BOT = "muster@corp.test";
const BOB = "bob@corp.test";
const SURFACE = `email:${BOT}`;
const ENV = { MAIL_PASSWORD: "imap-secret" };

interface Harness {
  readonly cwd: string;
  readonly gateway: GatewayConfig;
  readonly imap: FakeImapServer;
  readonly smtp: FakeSmtpServer;
  readonly llm: Awaited<ReturnType<typeof startStubModel>>;
  stop(): Promise<void>;
}

async function start(prefix: string, before?: (imap: FakeImapServer) => void): Promise<Harness> {
  const cwd = await mkdtemp(join(tmpdir(), prefix));
  const init = await initGatewayConfig(cwd);
  const imap = await startFakeImapServer();
  const smtp = await startFakeSmtpServer();
  const llm = await startStubModel("noted");
  const gateway: GatewayConfig = {
    ...init.config,
    channels: {
      email: {
        address: BOT,
        imap: { host: "127.0.0.1", port: imap.port, security: "none", user: "muster", passwordEnv: "MAIL_PASSWORD" },
        smtp: { host: "127.0.0.1", port: smtp.port, security: "none", user: "muster", passwordEnv: "MAIL_PASSWORD" },
        allowFrom: ["*@corp.test"],
        pollIntervalMs: 100,
        idleTimeoutMs: 1_000,
      },
    },
  };
  const pending = await requestPairing(SURFACE, BOB, cwd);
  await approvePairing(pending.code, cwd);
  before?.(imap);
  const controller = new AbortController();
  const done = runChannelWorker({
    channelId: "email",
    config: stubModelConfig(llm.url),
    gateway,
    cwd,
    env: ENV,
    signal: controller.signal,
    log: () => undefined,
  });
  const deadline = Date.now() + 5_000;
  while (imap.idling() === 0) {
    if (Date.now() > deadline) throw new Error("email worker never reached IMAP IDLE");
    await delay(10);
  }
  return {
    cwd,
    gateway,
    imap,
    smtp,
    llm,
    async stop() {
      controller.abort();
      await done;
      await imap.close();
      await smtp.close();
      await llm.close();
    },
  };
}

// Spec: MUS-SPEC-18-4A
test("email: an allowed sender's mail is answered in the same thread over SMTP", async () => {
  const harness = await start("muster-email-answer-", (imap) => {
    imap.add(rawMail({ from: BOB, to: BOT, subject: "Old", messageId: "<old@corp.test>", body: "already here" }));
  });
  try {
    const uid = harness.imap.add(rawMail({ from: `Bob <${BOB}>`, to: BOT, subject: "Quarterly numbers", messageId: "<m1@corp.test>", body: "Can you summarise Q3?" }));
    await harness.smtp.waitFor(1);
    const sent = harness.smtp.messages[0];
    assert.equal(sent.from, BOT);
    assert.deepEqual(sent.to, [BOB]);
    const { headers, body } = mailHeaders(sent.data);
    assert.match(headers.from, /muster@corp\.test/);
    assert.equal(headers.to, BOB);
    assert.equal(headers.subject, "Re: Quarterly numbers");
    assert.equal(headers["in-reply-to"], "<m1@corp.test>");
    assert.match(headers.references, /<m1@corp\.test>/);
    assert.equal(headers["auto-submitted"], "auto-replied");
    assert.match(headers["message-id"], /^<[^<>@\s]+@corp\.test>$/);
    assert.match(body, /noted/);
    await delay(200);
    assert.equal(harness.smtp.messages.length, 1, "pre-existing mail must not be answered");
    const inbound = harness.imap.messages.find((message) => message.uid === uid)!;
    assert.ok(inbound.flags.has("\\Seen"));
    assert.ok(!JSON.stringify(harness.gateway).includes(ENV.MAIL_PASSWORD));
  } finally {
    await harness.stop();
  }
});

// Spec: MUS-SPEC-18-4B
test("email: strangers, auto-replies and own mail are ignored", async () => {
  const harness = await start("muster-email-ignore-");
  try {
    harness.imap.add(rawMail({ from: "eve@evil.test", to: BOT, subject: "Hi", messageId: "<eve@evil.test>", body: "let me in" }));
    harness.imap.add(rawMail({ from: BOB, to: BOT, subject: "Out of office", messageId: "<ooo@corp.test>", body: "away", headers: { "Auto-Submitted": "auto-replied" } }));
    harness.imap.add(rawMail({ from: BOT, to: BOT, subject: "Loop", messageId: "<loop@corp.test>", body: "own" }));
    harness.imap.add(rawMail({ from: BOB, to: BOT, subject: "Sentinel", messageId: "<sentinel@corp.test>", body: "real question" }));
    await harness.smtp.waitFor(1);
    await delay(200);
    assert.equal(harness.smtp.messages.length, 1);
    assert.equal(mailHeaders(harness.smtp.messages[0].data).headers["in-reply-to"], "<sentinel@corp.test>");
    const pairings = await loadPairings(harness.cwd);
    assert.ok(!pairings.pending.some((entry) => entry.senderId === "eve@evil.test"));
  } finally {
    await harness.stop();
  }
});

// Spec: MUS-SPEC-18-4C
test("email: a reply in the thread keeps the same conversation and reference chain", async () => {
  const harness = await start("muster-email-thread-");
  try {
    const first = rawMail({ from: BOB, to: BOT, subject: "Plan", messageId: "<m1@corp.test>", body: "first" });
    harness.imap.add(first);
    await harness.smtp.waitFor(1);
    const botId = mailHeaders(harness.smtp.messages[0].data).headers["message-id"];
    const second = rawMail({
      from: BOB,
      to: BOT,
      subject: "Re: Plan",
      messageId: "<m2@corp.test>",
      inReplyTo: botId,
      references: `<m1@corp.test> ${botId}`,
      body: "second\r\n\r\nOn Tue, Muster wrote:\r\n> noted",
    });
    harness.imap.add(second);
    await harness.smtp.waitFor(2);
    const { headers } = mailHeaders(harness.smtp.messages[1].data);
    assert.equal(headers["in-reply-to"], "<m2@corp.test>");
    assert.equal(headers.subject, "Re: Plan");
    assert.deepEqual(headers.references.split(/\s+/), ["<m1@corp.test>", botId, "<m2@corp.test>"]);

    const email = defaultChannelRegistry().get("email")!;
    const [one] = email.normalize(parseEmailMessage(first), { gateway: harness.gateway });
    const [two] = email.normalize(parseEmailMessage(second), { gateway: harness.gateway });
    assert.equal(one.conversationId, "<m1@corp.test>");
    assert.equal(two.conversationId, one.conversationId);
    assert.equal(two.text, "second");
  } finally {
    await harness.stop();
  }
});
