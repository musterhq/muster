import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { MusterConfig, VoiceConfig } from "@musterhq/core";
import {
  approvePairing,
  gatewayConfigPath,
  loadGatewayConfig,
  requestPairing,
  startGatewayServer,
  TELEGRAM_SURFACE_ID,
} from "../src/index.js";
import { installFakeVoiceTools, readFakeVoiceCalls } from "../../core/test/fakes/voice-tools.js";
import { createFakeTelegramBotApi } from "./fakes/telegram-bot-api.js";
import type { FakeTelegramBotApi } from "./fakes/telegram-bot-api.js";
import { startStubModel, stubModelConfig } from "./fakes/stub-model.js";

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
  const running = await startGatewayServer({ config, gateway, cwd, fetcher: bot.fetcher }, 0);
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
