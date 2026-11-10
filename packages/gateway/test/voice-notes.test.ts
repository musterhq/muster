import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { MusterConfig, VoiceConfig } from "@musterhq/core";
import {
  approvePairing,
  gatewayConfigPath,
  initGatewayConfig,
  runChannelWorker,
  loadGatewayConfig,
  requestPairing,
  startGatewayServer,
  TELEGRAM_SURFACE_ID,
} from "../src/index.js";
import { installFakeVoiceTools, readFakeVoiceCalls } from "../../core/test/fakes/voice-tools.js";
import { createFakeTelegramBotApi } from "./fakes/telegram-bot-api.js";
import type { FakeTelegramBotApi } from "./fakes/telegram-bot-api.js";
import { startStubModel, stubModelConfig } from "./fakes/stub-model.js";
import { startFakeMatrixHomeserver } from "./fakes/matrix-homeserver.js";
import { mailHeaders, startFakeImapServer, startFakeSmtpServer } from "./fakes/mail-servers.js";

const TOKEN = "123:ABC";
const CHAT = 4242;
const VOICE_BYTES = new Uint8Array(Buffer.from("OggS fake opus voice note"));

interface TelegramHarness {
  readonly cwd: string;
  readonly bot: FakeTelegramBotApi;
  readonly llm: Awaited<ReturnType<typeof startStubModel>>;
  readonly log: string;
  post(update: unknown): Promise<Response>;
  stop(): Promise<void>;
}

/** Real gateway HTTP server, fake Bot API behind the fetcher, fake whisper and ffmpeg on PATH. */
async function startTelegram(prefix: string, voice: VoiceConfig | undefined, answer = "four"): Promise<TelegramHarness> {
  const cwd = await mkdtemp(join(tmpdir(), prefix));
  const tools = await installFakeVoiceTools(join(cwd, ".fake"));
  const previous = { PATH: process.env.PATH, FAKE_VOICE_LOG: process.env.FAKE_VOICE_LOG };
  process.env.PATH = `${tools.bin}:${previous.PATH ?? ""}`;
  process.env.FAKE_VOICE_LOG = tools.log;
  const model = join(cwd, "ggml-tiny.en.bin");
  await writeFile(model, "model");
  await mkdir(join(cwd, ".muster"), { recursive: true });
  await writeFile(gatewayConfigPath(cwd), JSON.stringify({ token: "test-token", telegram: { botToken: TOKEN } }));
  const gateway = await loadGatewayConfig(cwd);
  await requestPairing(TELEGRAM_SURFACE_ID, String(CHAT), cwd).then((pending) => approvePairing(pending.code, cwd));
  const llm = await startStubModel(answer);
  const config: MusterConfig = {
    ...stubModelConfig(llm.url),
    ...(voice ? { voice: voice.stt?.provider === "whisper-cpp" ? { ...voice, stt: { ...voice.stt, model } } : voice } : {}),
  };
  const bot = createFakeTelegramBotApi({ token: TOKEN, files: { VOICE1: { path: "voice/file_1.oga", bytes: VOICE_BYTES } } });
  const running = await startGatewayServer({ config, gateway, cwd, fetcher: bot.fetcher, log: (line) => { if (process.env.VOICE_TEST_DEBUG) console.error(line); } }, 0);
  return {
    cwd,
    bot,
    llm,
    log: tools.log,
    async post(update) {
      const response = await fetch(`http://127.0.0.1:${running.port}/v1/adapters/telegram`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer test-token" },
        body: JSON.stringify(update),
      });
      await running.waitForIdle();
      return response;
    },
    async stop() {
      await running.close();
      await llm.close();
      process.env.PATH = previous.PATH;
      if (previous.FAKE_VOICE_LOG === undefined) delete process.env.FAKE_VOICE_LOG;
      else process.env.FAKE_VOICE_LOG = previous.FAKE_VOICE_LOG;
      await rm(cwd, { recursive: true, force: true });
    },
  };
}

function voiceUpdate(updateId: number, voice: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return { update_id: updateId, message: { message_id: updateId, from: { id: CHAT }, chat: { id: CHAT, type: "private" }, date: 1, voice, ...extra } };
}

function texts(bot: FakeTelegramBotApi): string[] {
  return bot.sent("sendMessage").map((call) => String(call.body.text));
}

const WHISPER: VoiceConfig = { stt: { provider: "whisper-cpp", model: "(set per test)" } };

// Spec: MUS-SPEC-21-2A (docs/spec/clauses/21-voice.md#mus-spec-21-2a--a-telegram-voice-note-becomes-the-turns-prompt)
test("a telegram voice note is downloaded, transcribed and answered as a prompt", async () => {
  const harness = await startTelegram("muster-voice-tg-", WHISPER);
  try {
    const update = voiceUpdate(9001, { file_id: "VOICE1", duration: 4, mime_type: "audio/ogg", file_size: VOICE_BYTES.length });
    assert.equal((await harness.post(update)).status, 200);
    assert.deepEqual(harness.bot.sent("getFile").map((call) => call.body.file_id), ["VOICE1"]);
    assert.deepEqual(harness.bot.downloads, ["voice/file_1.oga"]);
    const calls = await readFakeVoiceCalls(harness.log);
    assert.deepEqual(calls.map((call) => call.tool), ["ffmpeg", "whisper-cli"]);
    assert.equal(harness.llm.prompts.length, 1);
    assert.match(harness.llm.prompts[0], /what is two plus two/);
    const replies = texts(harness.bot);
    assert.equal(replies.length, 1);
    assert.equal(replies[0], "🎙 \"what is two plus two\"\n\nfour");

    // Durable ingress: the same update_id is answered once.
    assert.equal((await harness.post(update)).status, 200);
    assert.equal(texts(harness.bot).length, 1);
    assert.equal((await readFakeVoiceCalls(harness.log)).length, 2, "no second transcription");
    assert.equal(harness.llm.prompts.length, 1);
  } finally {
    await harness.stop();
  }
});

// Spec: MUS-SPEC-21-2B (docs/spec/clauses/21-voice.md#mus-spec-21-2b--long-or-oversized-audio-is-refused-before-any-provider-runs)
test("voice notes over the length or size limit are refused before download", async () => {
  const harness = await startTelegram("muster-voice-tg-limit-", { ...WHISPER, maxSeconds: 300 });
  try {
    await harness.post(voiceUpdate(9101, { file_id: "VOICE1", duration: 900, mime_type: "audio/ogg", file_size: 2_000_000 }));
    await harness.post({
      update_id: 9102,
      message: {
        message_id: 9102, from: { id: CHAT }, chat: { id: CHAT, type: "private" }, date: 1,
        document: { file_id: "BIG", file_name: "memo.mp3", mime_type: "audio/mpeg", file_size: 30 * 1024 * 1024 },
      },
    });
    assert.deepEqual(texts(harness.bot), [
      "Voice notes up to 5 min; this one is 15 min.",
      "Voice notes up to 25 MB; this one is 30 MB.",
    ]);
    assert.equal(harness.bot.sent("getFile").length, 0, "nothing downloaded");
    assert.equal(harness.bot.downloads.length, 0);
    assert.equal((await readFakeVoiceCalls(harness.log)).length, 0, "no provider ran");
    assert.equal(harness.llm.prompts.length, 0, "no turn started");
  } finally {
    await harness.stop();
  }
});

// Spec: MUS-SPEC-21-2C (docs/spec/clauses/21-voice.md#mus-spec-21-2c--voice-without-speech-to-text-says-how-to-turn-it-on)
test("a voice note with speech off gets a setup hint, not an empty turn", async () => {
  const harness = await startTelegram("muster-voice-tg-off-", undefined);
  try {
    await harness.post(voiceUpdate(9201, { file_id: "VOICE1", duration: 3, mime_type: "audio/ogg", file_size: 100 }));
    const replies = texts(harness.bot);
    assert.equal(replies.length, 1);
    assert.match(replies[0], /speech-to-text/);
    assert.match(replies[0], /muster voice doctor/);
    assert.equal(harness.llm.prompts.length, 0, "no turn on an empty prompt");
    assert.equal(harness.bot.sent("getFile").length, 0);
  } finally {
    await harness.stop();
  }
});

const RICH_ANSWER = [
  "Two plus two is four. See https://example.com/math",
  "```js",
  "console.log(2 + 2)",
  "```",
  "| a | b |",
  "|---|---|",
  "| 1 | 2 |",
  "Done.",
].join("\n");

function textUpdate(updateId: number, text: string) {
  return { update_id: updateId, message: { message_id: updateId, from: { id: CHAT }, chat: { id: CHAT, type: "private" }, date: 1, text } };
}

// Spec: MUS-SPEC-21-2D (docs/spec/clauses/21-voice.md#mus-spec-21-2d--spoken-replies-are-opt-in-mirror-answers-voice-with-voice)
test("mirror replies to a voice note with text and a voice message, text gets text only", async () => {
  const mirror = await startTelegram("muster-voice-tg-mirror-", { ...WHISPER, tts: { provider: "say" }, reply: "mirror", maxReplyChars: 30 }, RICH_ANSWER);
  try {
    await mirror.post(voiceUpdate(9301, { file_id: "VOICE1", duration: 4, mime_type: "audio/ogg", file_size: VOICE_BYTES.length }));
    assert.equal(texts(mirror.bot).length, 1, "the reply is sent as text");
    assert.ok(texts(mirror.bot)[0].startsWith("🎙 \"what is two plus two\""));
    const voices = mirror.bot.sent("sendVoice");
    assert.equal(voices.length, 1, "and as a voice message");
    assert.equal(voices[0].body.chat_id, String(CHAT));
    assert.equal((voices[0].body.voice as { type: string }).type, "audio/ogg");
    const say = (await readFakeVoiceCalls(mirror.log)).filter((call) => call.tool === "say");
    assert.equal(say.length, 1);
    // Code, URL and table skipped; capped at maxReplyChars on a sentence boundary.
    assert.equal(say[0].argv[say[0].argv.length - 1], "Two plus two is four.");

    await mirror.post(textUpdate(9302, "and three plus three?"));
    assert.equal(texts(mirror.bot).length, 2);
    assert.equal(mirror.bot.sent("sendVoice").length, 1, "a text message gets text only");
  } finally {
    await mirror.stop();
  }

  const off = await startTelegram("muster-voice-tg-reply-off-", { ...WHISPER, tts: { provider: "say" }, reply: "off" }, RICH_ANSWER);
  try {
    await off.post(voiceUpdate(9401, { file_id: "VOICE1", duration: 4, mime_type: "audio/ogg", file_size: VOICE_BYTES.length }));
    await off.post(textUpdate(9402, "hello"));
    assert.equal(texts(off.bot).length, 2);
    assert.equal(off.bot.sent("sendVoice").length, 0, "reply off: no audio");
    assert.equal((await readFakeVoiceCalls(off.log)).filter((call) => call.tool === "say").length, 0);
  } finally {
    await off.stop();
  }
});

async function withFakeVoice<T>(cwd: string, work: (input: { model: string; log: string }) => Promise<T>): Promise<T> {
  const tools = await installFakeVoiceTools(join(cwd, ".fake"));
  const previous = { PATH: process.env.PATH, FAKE_VOICE_LOG: process.env.FAKE_VOICE_LOG };
  process.env.PATH = `${tools.bin}:${previous.PATH ?? ""}`;
  process.env.FAKE_VOICE_LOG = tools.log;
  const model = join(cwd, "ggml-tiny.en.bin");
  await writeFile(model, "model");
  try {
    return await work({ model, log: tools.log });
  } finally {
    process.env.PATH = previous.PATH;
    if (previous.FAKE_VOICE_LOG === undefined) delete process.env.FAKE_VOICE_LOG;
    else process.env.FAKE_VOICE_LOG = previous.FAKE_VOICE_LOG;
  }
}

function emailWithAudio(input: { from: string; to: string; subject: string; messageId: string; audio: Buffer }): string {
  const boundary = "voice-boundary-1";
  return [
    `From: ${input.from}`,
    `To: ${input.to}`,
    `Subject: ${input.subject}`,
    `Message-ID: ${input.messageId}`,
    `Date: ${new Date().toUTCString()}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    "Content-Type: audio/ogg; name=\"memo.ogg\"",
    "Content-Disposition: attachment; filename=\"memo.ogg\"",
    "Content-Transfer-Encoding: base64",
    "",
    input.audio.toString("base64"),
    `--${boundary}--`,
    "",
  ].join("\r\n");
}

// Spec: MUS-SPEC-21-2E (docs/spec/clauses/21-voice.md#mus-spec-21-2e--the-same-voice-path-on-every-sdk-channel-that-carries-audio)
test("matrix audio events and email audio attachments become prompts through the shared runner", { timeout: 60_000 }, async () => {
  const ROOM = "!room:fake.test";
  const ALICE = "@alice:fake.test";
  const BOT = "muster@corp.test";
  const BOB = "bob@corp.test";
  const cwd = await mkdtemp(join(tmpdir(), "muster-voice-sdk-"));
  try {
    await withFakeVoice(cwd, async ({ model, log }) => {
      const llm = await startStubModel("heard you");
      try {
      const config: MusterConfig = { ...stubModelConfig(llm.url), voice: { stt: { provider: "whisper-cpp", model } } };
      const init = await initGatewayConfig(cwd);

      // Matrix: an m.audio event with an mxc:// URL.
      const matrix = await startFakeMatrixHomeserver();
      const matrixGateway = { ...init.config, channels: { matrix: { homeserverUrl: matrix.url, userId: matrix.botUserId, accessTokenEnv: "MATRIX_TOKEN", allowFrom: [ALICE], syncTimeoutMs: 100 } } };
      await requestPairing(`matrix:${matrix.botUserId}`, ALICE, cwd).then((pending) => approvePairing(pending.code, cwd));
      const matrixStop = new AbortController();
      const matrixDone = runChannelWorker({ channelId: "matrix", config, gateway: matrixGateway, cwd, env: { MATRIX_TOKEN: matrix.token }, signal: matrixStop.signal, log: () => undefined });
      try {
        await matrix.waitForSyncs(2);
        const mxc = matrix.putMedia(Buffer.from("OggS matrix voice"), "audio/ogg");
        const event = matrix.inject(ROOM, ALICE, "Voice message.ogg", {
          msgtype: "m.audio",
          body: "Voice message.ogg",
          url: mxc,
          info: { mimetype: "audio/ogg", size: 17, duration: 4000 },
          "org.matrix.msc3245.voice": {},
        });
        await matrix.waitFor(() => matrix.sent.length === 1);
        const answer = matrix.sent[0];
        assert.equal(String(answer.content.body), "🎙 \"what is two plus two\"\n\nheard you");
        assert.deepEqual((answer.content["m.relates_to"] as Record<string, unknown>)["m.in_reply_to"], { event_id: event });
        assert.ok(matrix.requests.some((request) => request.path === `/_matrix/client/v1/media/download/fake.test/${mxc.split("/").pop()}`));
        assert.match(llm.prompts.at(-1) ?? "", /what is two plus two/);
      } finally {
        matrixStop.abort();
        await matrixDone;
        await matrix.close();
      }

      // Email: an audio/* attachment, no text body.
      const imap = await startFakeImapServer();
      const smtp = await startFakeSmtpServer();
      const emailGateway = {
        ...init.config,
        channels: {
          email: {
            address: BOT,
            imap: { host: "127.0.0.1", port: imap.port, security: "none" as const, user: "muster", passwordEnv: "MAIL_PASSWORD" },
            smtp: { host: "127.0.0.1", port: smtp.port, security: "none" as const, user: "muster", passwordEnv: "MAIL_PASSWORD" },
            allowFrom: ["*@corp.test"],
            pollIntervalMs: 100,
            idleTimeoutMs: 1_000,
          },
        },
      };
      await requestPairing(`email:${BOT}`, BOB, cwd).then((pending) => approvePairing(pending.code, cwd));
      const emailStop = new AbortController();
      const emailDone = runChannelWorker({ channelId: "email", config, gateway: emailGateway, cwd, env: { MAIL_PASSWORD: "imap-secret" }, signal: emailStop.signal, log: () => undefined });
      try {
        const deadline = Date.now() + 5_000;
        while (imap.idling() === 0) {
          if (Date.now() > deadline) throw new Error("email worker never reached IMAP IDLE");
          await new Promise((wake) => setTimeout(wake, 10));
        }
        const before = llm.prompts.length;
        imap.add(emailWithAudio({ from: BOB, to: BOT, subject: "Voice memo", messageId: "<voice@corp.test>", audio: Buffer.from("OggS email voice") }));
        await smtp.waitFor(1);
        const { headers, body } = mailHeaders(smtp.messages[0].data);
        assert.equal(headers["in-reply-to"], "<voice@corp.test>");
        assert.match(body, /what is two plus two/);
        assert.match(body, /heard you/);
        assert.equal(llm.prompts.length, before + 1);
        assert.match(llm.prompts.at(-1) ?? "", /what is two plus two/);
      } finally {
        emailStop.abort();
        await emailDone;
        await imap.close();
        await smtp.close();
      }
      const calls = await readFakeVoiceCalls(log);
      assert.equal(calls.filter((call) => call.tool === "whisper-cli").length, 2, "one transcription per channel, in the shared runner");
      } finally {
        await llm.close();
      }
    });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
