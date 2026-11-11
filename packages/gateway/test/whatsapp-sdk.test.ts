import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { MusterConfig } from "@musterhq/core";
import {
  approvePairing,
  ChannelRegistry,
  createWhatsAppChannel,
  gatewayConfigPath,
  initGatewayConfig,
  loadGatewayConfig,
  requestPairing,
  runChannelWorker,
  startGatewayServer,
} from "../src/index.js";
import type { GatewayConfig } from "../src/index.js";
import { installFakeVoiceTools, readFakeVoiceCalls } from "../../core/test/fakes/voice-tools.js";
import { createFakeGraphApi } from "./fakes/graph-api.js";
import { startStubModel, stubModelConfig } from "./fakes/stub-model.js";

const PHONE_NUMBER_ID = "24000000001";
const SENDER = "15550002401";
const APP_SECRET = "wa-app-secret-24";
const VOICE_BYTES = new Uint8Array(Buffer.from("OggS fake whatsapp voice note"));

function notification(messages: unknown[], statuses?: unknown[]) {
  return {
    object: "whatsapp_business_account",
    entry: [{
      id: "WABA-24",
      changes: [{
        field: "messages",
        value: {
          messaging_product: "whatsapp",
          metadata: { display_phone_number: "15550000000", phone_number_id: PHONE_NUMBER_ID },
          ...(messages.length ? { contacts: [{ profile: { name: "Ana" }, wa_id: SENDER }], messages } : {}),
          ...(statuses ? { statuses } : {}),
        },
      }],
    }],
  };
}

function sign(body: string, secret = APP_SECRET): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

// Spec: MUS-SPEC-24-3A (docs/spec/clauses/24-channels-sdk-2.md#mus-spec-24-3a--whatsapp-cloud-on-the-sdk-including-voice-notes)
test("whatsapp cloud text and voice notes run through the shared runner; statuses and bad signatures are rejected", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-wa-cloud-sdk-"));
  const tools = await installFakeVoiceTools(join(cwd, ".fake"));
  const previous = { PATH: process.env.PATH, FAKE_VOICE_LOG: process.env.FAKE_VOICE_LOG, WA_CLOUD_TOKEN_24: process.env.WA_CLOUD_TOKEN_24 };
  process.env.PATH = `${tools.bin}:${previous.PATH ?? ""}`;
  process.env.FAKE_VOICE_LOG = tools.log;
  process.env.WA_CLOUD_TOKEN_24 = "EAAG-env-token-24";
  const model = join(cwd, "ggml-tiny.en.bin");
  await writeFile(model, "model");
  await mkdir(join(cwd, ".muster"), { recursive: true });
  await writeFile(gatewayConfigPath(cwd), JSON.stringify({
    token: "test-token",
    "whatsapp-cloud": { accessTokenEnv: "WA_CLOUD_TOKEN_24", verifyToken: "verify-24", phoneNumberId: PHONE_NUMBER_ID, appSecret: APP_SECRET },
  }));
  const gateway = await loadGatewayConfig(cwd);
  await requestPairing(`whatsapp-cloud:${PHONE_NUMBER_ID}`, SENDER, cwd).then((pending) => approvePairing(pending.code, cwd));
  const llm = await startStubModel("four");
  const config: MusterConfig = { ...stubModelConfig(llm.url), voice: { stt: { provider: "whisper-cpp", model } } };
  const graph = createFakeGraphApi({
    media: { "MEDIA-24-1": { bytes: VOICE_BYTES, mime: "audio/ogg" } },
    passThrough: (url) => url.startsWith("http://127.0.0.1"),
  });
  const running = await startGatewayServer({ config, gateway, cwd, fetcher: graph.fetcher }, 0);
  const route = `http://127.0.0.1:${running.port}/v1/adapters/whatsapp-cloud`;
  const post = async (payload: unknown, signature?: string) => {
    const body = JSON.stringify(payload);
    const response = await fetch(route, {
      method: "POST",
      headers: { "content-type": "application/json", "x-hub-signature-256": signature ?? sign(body) },
      body,
    });
    await running.waitForIdle();
    return response;
  };
  try {
    // 1. Text: one turn, the reply goes to /{phoneNumberId}/messages with the env token.
    const text = await post(notification([{ from: SENDER, id: "wamid.24-TEXT-1", timestamp: "1", type: "text", text: { body: "hello" } }]));
    assert.equal(text.status, 200);
    assert.deepEqual(await text.json(), { ok: true, accepted: true });
    assert.equal(graph.sent().length, 1);
    const textSend = graph.calls.find((call) => call.method === "POST")!;
    assert.equal(textSend.url, `https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`);
    assert.equal(textSend.authorization, "Bearer EAAG-env-token-24");
    assert.deepEqual(graph.sent()[0], { messaging_product: "whatsapp", recipient_type: "individual", to: SENDER, type: "text", text: { body: "four" } });
    assert.equal(llm.prompts.length, 1);

    // 2. Voice note: GET /{M} → url → bytes, transcribed, answered with the echo.
    const voice = await post(notification([{ from: SENDER, id: "wamid.24-VOICE-1", timestamp: "2", type: "audio", audio: { id: "MEDIA-24-1", mime_type: "audio/ogg; codecs=opus", voice: true } }]));
    assert.equal(voice.status, 200);
    const afterText = graph.calls.slice(graph.calls.indexOf(textSend) + 1);
    assert.deepEqual(afterText.map((call) => `${call.method} ${call.url.split("?")[0]}`), [
      "GET https://graph.facebook.com/v19.0/MEDIA-24-1",
      "GET https://lookaside.fbsbx.com/whatsapp_business/attachments/",
      `POST https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`,
    ]);
    assert.ok(afterText.slice(0, 2).every((call) => call.authorization === "Bearer EAAG-env-token-24"));
    assert.deepEqual((await readFakeVoiceCalls(tools.log)).map((call) => call.tool), ["ffmpeg", "whisper-cli"]);
    assert.equal(llm.prompts.length, 2);
    assert.match(llm.prompts[1], /what is two plus two/);
    assert.equal((graph.sent()[1].text as { body: string }).body, "🎙 \"what is two plus two\"\n\nfour");

    // 3. Status-only notifications start nothing.
    const status = await post(notification([], [{ id: "wamid.24-TEXT-1", status: "read", recipient_id: SENDER }]));
    assert.equal(status.status, 200);
    assert.equal(graph.sent().length, 2);
    assert.equal(llm.prompts.length, 2);

    // 4. A wrong X-Hub-Signature-256 is refused.
    const forged = await post(notification([{ from: SENDER, id: "wamid.24-FORGED", timestamp: "3", type: "text", text: { body: "hi" } }]), sign("other", APP_SECRET));
    assert.equal(forged.status, 401);
    assert.deepEqual(await forged.json(), { error: "WhatsApp signature verification failed." });
    assert.equal(graph.sent().length, 2);

    // GET verification still answers the challenge.
    const challenge = await fetch(`${route}?hub.mode=subscribe&hub.verify_token=verify-24&hub.challenge=2424`);
    assert.equal(challenge.status, 200);
    assert.equal(await challenge.text(), "2424");
  } finally {
    await running.close();
    await llm.close();
    process.env.PATH = previous.PATH;
    for (const name of ["FAKE_VOICE_LOG", "WA_CLOUD_TOKEN_24"] as const) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
    await rm(cwd, { recursive: true, force: true });
  }
});

const OWNER = "15550003001@s.whatsapp.net";
const ALICE = "15550003002@s.whatsapp.net";
const BOT = "15550003000:4@s.whatsapp.net";
const G1 = "120363000000002401@g.us";
const G2 = "120363000000002402@g.us";

/** Linked-device fake: a Baileys-shaped module whose socket the test drives. */
function fakeBaileys(media: Readonly<Record<string, Uint8Array>>) {
  const listeners = new Map<string, Array<(...args: any[]) => void>>();
  const sent: Array<{ jid: string; text: string }> = [];
  const downloads: string[] = [];
  let opened!: () => void;
  const open = new Promise<void>((resolvePromise) => { opened = resolvePromise; });
  const sentWaiters: Array<{ count: number; resolve: () => void }> = [];
  const emit = (event: string, payload: unknown) => { for (const listener of listeners.get(event) ?? []) listener(payload); };
  const module = {
    default: () => {
      setImmediate(() => { emit("connection.update", { connection: "open" }); opened(); });
      return {
        ev: { on: (event: string, listener: (...args: any[]) => void) => { listeners.set(event, [...(listeners.get(event) ?? []), listener]); } },
        user: { id: BOT },
        async sendMessage(jid: string, content: { text: string }) {
          sent.push({ jid, text: content.text });
          for (const waiter of sentWaiters.filter((entry) => sent.length >= entry.count)) waiter.resolve();
          return { key: { id: `out-${sent.length}` } };
        },
        async groupMetadata(jid: string) { return { subject: jid === G1 ? "Ops" : "Other" }; },
        end() { emit("connection.update", { connection: "close" }); },
      };
    },
    useMultiFileAuthState: async () => ({ state: {}, saveCreds: async () => undefined }),
    async downloadMediaMessage(message: { key?: { id?: string } }) {
      downloads.push(message.key?.id ?? "");
      return Buffer.from(media[message.key?.id ?? ""] ?? new Uint8Array());
    },
  };
  return {
    module,
    sent,
    downloads,
    open,
    upsert: (messages: unknown[]) => emit("messages.upsert", { type: "notify", messages }),
    waitForSent: (count: number) => (sent.length >= count ? Promise.resolve() : new Promise<void>((resolvePromise) => { sentWaiters.push({ count, resolve: resolvePromise }); })),
  };
}

// Spec: MUS-SPEC-24-3B (docs/spec/clauses/24-channels-sdk-2.md#mus-spec-24-3b--personal-whatsapp-on-the-sdk-keeps-its-group-policy)
test("personal whatsapp on the sdk answers DMs and allowed mentions only and transcribes voice notes", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-wa-personal-sdk-"));
  const tools = await installFakeVoiceTools(join(cwd, ".fake"));
  const previous = { PATH: process.env.PATH, FAKE_VOICE_LOG: process.env.FAKE_VOICE_LOG };
  process.env.PATH = `${tools.bin}:${previous.PATH ?? ""}`;
  process.env.FAKE_VOICE_LOG = tools.log;
  const model = join(cwd, "ggml-tiny.en.bin");
  await writeFile(model, "model");
  const init = await initGatewayConfig(cwd);
  const gateway: GatewayConfig = { ...init.config, whatsapp: { activation: "mention", groups: [G1], sessionDir: join(cwd, "wa-session") } };
  await requestPairing("whatsapp:default", OWNER, cwd).then((pending) => approvePairing(pending.code, cwd));
  const llm = await startStubModel("four");
  const baileys = fakeBaileys({ "24-3b-voice": VOICE_BYTES });
  const controller = new AbortController();
  const worker = runChannelWorker({
    channelId: "whatsapp",
    channels: new ChannelRegistry([createWhatsAppChannel({ loadBaileys: async () => baileys.module as never })]),
    config: { ...stubModelConfig(llm.url), voice: { stt: { provider: "whisper-cpp", model } } },
    gateway,
    cwd,
    signal: controller.signal,
    log: () => undefined,
  });
  try {
    await baileys.open;
    baileys.upsert([
      { key: { id: "24-3b-dm", remoteJid: OWNER }, message: { conversation: "what is 2+2" } },
      { key: { id: "24-3b-g1-mention", remoteJid: G1, participant: ALICE }, message: { extendedTextMessage: { text: "@Muster what is 2+2", contextInfo: { mentionedJid: [BOT] } } } },
      { key: { id: "24-3b-g1-plain", remoteJid: G1, participant: ALICE }, message: { conversation: "just chatting" } },
      { key: { id: "24-3b-g2-mention", remoteJid: G2, participant: ALICE }, message: { extendedTextMessage: { text: "@Muster hi", contextInfo: { mentionedJid: [BOT] } } } },
      { key: { id: "24-3b-voice", remoteJid: OWNER }, message: { audioMessage: { mimetype: "audio/ogg; codecs=opus", seconds: 3, ptt: true, fileLength: VOICE_BYTES.length } } },
    ]);
    await baileys.waitForSent(3);
    // Group messages wait for the group subject, so arrival order across chats may differ.
    const repliesTo = (jid: string) => baileys.sent.filter((entry) => entry.jid === jid).map((entry) => entry.text).sort();
    assert.deepEqual(repliesTo(OWNER), ["four", "🎙 \"what is two plus two\"\n\nfour"]);
    assert.deepEqual(repliesTo(G1), ["four"]);
    assert.deepEqual(repliesTo(G2), []);
    assert.deepEqual(baileys.downloads, ["24-3b-voice"]);
    assert.deepEqual((await readFakeVoiceCalls(tools.log)).map((call) => call.tool), ["ffmpeg", "whisper-cli"]);
    assert.equal(llm.prompts.length, 3, "the unmentioned G1 message and the G2 mention start no turn");

    // A redelivered message is answered once (durable ingress keys on the message id).
    baileys.upsert([{ key: { id: "24-3b-dm", remoteJid: OWNER }, message: { conversation: "what is 2+2" } }]);
    baileys.upsert([{ key: { id: "24-3b-dm-2", remoteJid: OWNER }, message: { conversation: "and 3+3?" } }]);
    await baileys.waitForSent(4);
    assert.equal(llm.prompts.length, 4);
    assert.match(llm.prompts[3], /and 3\+3\?/, "the redelivered message was not run again");
  } finally {
    controller.abort();
    await worker;
    await llm.close();
    process.env.PATH = previous.PATH;
    if (previous.FAKE_VOICE_LOG === undefined) delete process.env.FAKE_VOICE_LOG;
    else process.env.FAKE_VOICE_LOG = previous.FAKE_VOICE_LOG;
    await rm(cwd, { recursive: true, force: true });
  }
});
