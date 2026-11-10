import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { listVoiceReceipts, synthesize, transcribe, voiceLedgerPath } from "../src/voice.js";
import type { VoiceConfig } from "../src/voice.js";
import { installFakeVoiceTools, readFakeVoiceCalls } from "./fakes/voice-tools.js";

async function workspace(prefix: string, only?: readonly string[]) {
  const cwd = await mkdtemp(join(tmpdir(), prefix));
  const tools = await installFakeVoiceTools(cwd, only);
  const env = { ...process.env, PATH: `${tools.bin}:${process.env.PATH ?? ""}`, FAKE_VOICE_LOG: tools.log };
  return { cwd, env, log: tools.log, done: () => rm(cwd, { recursive: true, force: true }) };
}

// Spec: MUS-SPEC-21-1B (docs/spec/clauses/21-voice.md#mus-spec-21-1b--local-speech-to-text-with-whispercpp)
test("whisper-cpp transcribes through ffmpeg with argv only and cleans up", async () => {
  const ws = await workspace("muster-voice-whisper-");
  try {
    // A model path a shell would split or expand proves argv-only spawning.
    const model = join(ws.cwd, "my models", "ggml $(echo pwned).bin");
    await mkdir(dirname(model), { recursive: true });
    await writeFile(model, "model");
    const input = join(ws.cwd, "clip.ogg");
    await writeFile(input, "OggS fake");
    const voice: VoiceConfig = { stt: { provider: "whisper-cpp", model } };

    const result = await transcribe(input, { voice, cwd: ws.cwd, env: ws.env });
    assert.equal(result.text, "what is two plus two");
    assert.equal(result.provider, "whisper-cpp");
    assert.equal(result.local, true);
    assert.equal(result.seconds, 2);

    const calls = await readFakeVoiceCalls(ws.log);
    assert.deepEqual(calls.map((call) => call.tool), ["ffmpeg", "whisper-cli"]);
    const ffmpeg = calls[0].argv;
    const wav = ffmpeg[ffmpeg.length - 1];
    assert.ok(wav.endsWith(".wav"), wav);
    assert.equal(ffmpeg[ffmpeg.indexOf("-i") + 1], input);
    assert.equal(ffmpeg[ffmpeg.indexOf("-ar") + 1], "16000");
    assert.equal(ffmpeg[ffmpeg.indexOf("-ac") + 1], "1");
    const whisper = calls[1].argv;
    assert.equal(whisper[whisper.indexOf("-m") + 1], model);
    assert.equal(whisper[whisper.indexOf("-f") + 1], wav);
    assert.equal(calls[1].existed[wav], true, "the WAV existed while whisper ran");
    assert.equal(existsSync(wav), false, "the WAV is deleted");
    assert.equal(existsSync(dirname(wav)), false, "the temp dir is deleted");
  } finally {
    await ws.done();
  }
});

// Spec: MUS-SPEC-21-1C (docs/spec/clauses/21-voice.md#mus-spec-21-1c--a-command-provider-for-either-direction-with-no-shell)
test("command providers substitute placeholders into argv and never use a shell", async () => {
  const ws = await workspace("muster-voice-command-");
  try {
    const input = join(ws.cwd, "clip.ogg");
    await writeFile(input, "OggS fake");
    const voice: VoiceConfig = {
      stt: { provider: "command", command: ["my-stt", "{input}"] },
      tts: { provider: "command", command: ["my-tts", "{text}", "{output}"] },
    };
    const heard = await transcribe(input, { voice, cwd: ws.cwd, env: ws.env });
    assert.equal(heard.text, "command transcript");

    const spoken = await synthesize("a; rm -rf ~", { voice, cwd: ws.cwd, env: ws.env, format: "wav" });
    try {
      assert.equal(spoken.mime, "audio/wav");
      assert.equal(await readFile(spoken.path, "utf8"), "RIFFa; rm -rf ~");
    } finally {
      await spoken.cleanup();
    }
    const calls = await readFakeVoiceCalls(ws.log);
    assert.deepEqual(calls.find((call) => call.tool === "my-stt")?.argv, [input]);
    const tts = calls.find((call) => call.tool === "my-tts")!;
    assert.equal(tts.argv.length, 2);
    assert.equal(tts.argv[0], "a; rm -rf ~", "the text is one argument");

    await assert.rejects(
      synthesize("hi", { voice, cwd: ws.cwd, env: { ...ws.env, FAKE_TTS_FAIL: "1" }, format: "wav" }),
      (error: Error) => /my-tts/.test(error.message) && /exit 5/.test(error.message) && /voice not installed/.test(error.message),
    );
  } finally {
    await ws.done();
  }
});

// Spec: MUS-SPEC-21-1E (docs/spec/clauses/21-voice.md#mus-spec-21-1e--local-text-to-speech-with-say-converted-for-the-channel)
test("say synthesizes and ffmpeg converts to ogg opus", async () => {
  const ws = await workspace("muster-voice-say-");
  try {
    const voice: VoiceConfig = { tts: { provider: "say", voice: "Samantha" } };
    const result = await synthesize("hello", { voice, cwd: ws.cwd, env: ws.env, format: "ogg-opus" });
    try {
      assert.equal(result.mime, "audio/ogg");
      assert.equal(result.provider, "say");
      assert.equal(result.local, true);
      assert.ok(result.path.endsWith(".ogg"));
      assert.ok(existsSync(result.path));
      const calls = await readFakeVoiceCalls(ws.log);
      assert.deepEqual(calls.map((call) => call.tool), ["say", "ffmpeg"]);
      const say = calls[0].argv;
      assert.equal(say.length, 6);
      assert.deepEqual([say[0], say[1], say[2], say[4], say[5]], ["-v", "Samantha", "-o", "--", "hello"]);
      const aiff = say[3];
      assert.ok(aiff.endsWith(".aiff"), aiff);
      const ffmpeg = calls[1].argv;
      assert.equal(ffmpeg[ffmpeg.indexOf("-i") + 1], aiff);
      assert.equal(ffmpeg[ffmpeg.indexOf("-c:a") + 1], "libopus");
      assert.equal(ffmpeg[ffmpeg.length - 1], result.path);
      assert.equal(existsSync(aiff), false, "the AIFF is deleted");
    } finally {
      await result.cleanup();
    }
    assert.equal(existsSync(result.path), false, "cleanup removes the synthesized file");
  } finally {
    await ws.done();
  }
});

interface FakeOpenAIRequest {
  readonly method: string;
  readonly path: string;
  readonly authorization?: string;
  readonly contentType?: string;
  readonly body: Buffer;
}

async function startFakeOpenAIAudio(): Promise<{ url: string; requests: FakeOpenAIRequest[]; failWith(status: number | undefined): void; close(): Promise<void> }> {
  const { createServer } = await import("node:http");
  const requests: FakeOpenAIRequest[] = [];
  let failure: number | undefined;
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = Buffer.concat(chunks);
      requests.push({ method: request.method ?? "", path: request.url ?? "", authorization: request.headers.authorization, contentType: request.headers["content-type"], body });
      if (failure) {
        response.writeHead(failure, { "content-type": "application/json" });
        // Some servers echo the presented key back; it must never surface.
        response.end(JSON.stringify({ error: { message: `Incorrect API key provided: ${request.headers.authorization ?? ""}` } }));
        return;
      }
      if (request.url === "/v1/audio/transcriptions") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ text: " cloud transcript " }));
        return;
      }
      if (request.url === "/v1/audio/speech") {
        response.writeHead(200, { "content-type": "audio/ogg" });
        response.end(Buffer.concat([Buffer.from("OggS"), Buffer.from("opus-bytes")]));
        return;
      }
      response.writeHead(404);
      response.end();
    });
  });
  await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    requests,
    failWith: (status) => { failure = status; },
    close: () => new Promise<void>((resolvePromise) => { server.closeAllConnections(); server.close(() => resolvePromise()); }),
  };
}

// Spec: MUS-SPEC-21-1D (docs/spec/clauses/21-voice.md#mus-spec-21-1d--cloud-providers-run-only-when-configured-and-keys-never-leak)
test("openai voice providers use the env key, write audio, and never print the key", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-voice-openai-"));
  const server = await startFakeOpenAIAudio();
  const KEY = "sk-test-123";
  try {
    const voice: VoiceConfig = {
      stt: { provider: "openai", baseUrl: server.url, apiKeyEnv: "VOICE_KEY", model: "whisper-1" },
      tts: { provider: "openai", baseUrl: server.url, apiKeyEnv: "VOICE_KEY", model: "tts-1", voice: "alloy" },
    };
    const env = { PATH: process.env.PATH, VOICE_KEY: KEY };
    const input = join(cwd, "clip.ogg");
    await writeFile(input, "OggS audio bytes");

    const heard = await transcribe(input, { voice, cwd, env });
    assert.equal(heard.text, "cloud transcript");
    assert.equal(heard.local, false);
    const stt = server.requests[0];
    assert.equal(stt.method, "POST");
    assert.equal(stt.path, "/v1/audio/transcriptions");
    assert.equal(stt.authorization, `Bearer ${KEY}`);
    assert.match(stt.contentType ?? "", /^multipart\/form-data; boundary=/);
    assert.ok(stt.body.includes("OggS audio bytes"), "the audio is uploaded");
    assert.ok(stt.body.includes("whisper-1"), "the model is sent");

    const output = join(cwd, "reply.ogg");
    const spoken = await synthesize("hello there", { voice, cwd, env, format: "ogg-opus", output });
    assert.equal(spoken.path, output);
    assert.equal(spoken.mime, "audio/ogg");
    assert.equal(await readFile(output, "utf8"), "OggSopus-bytes");
    const tts = server.requests[1];
    assert.equal(tts.path, "/v1/audio/speech");
    assert.equal(tts.authorization, `Bearer ${KEY}`);
    const ttsBody = JSON.parse(tts.body.toString("utf8")) as Record<string, unknown>;
    assert.equal(ttsBody.input, "hello there");
    assert.equal(ttsBody.model, "tts-1");
    assert.equal(ttsBody.response_format, "opus");

    server.failWith(401);
    const leaks = (error: Error) => error.message.includes(KEY) || (error.stack ?? "").includes(KEY);
    await assert.rejects(transcribe(input, { voice, cwd, env }), (error: Error) => /openai/.test(error.message) && /401/.test(error.message) && !leaks(error));
    await assert.rejects(synthesize("hi", { voice, cwd, env, format: "ogg-opus" }), (error: Error) => /openai/.test(error.message) && /401/.test(error.message) && !leaks(error));

    const before = server.requests.length;
    await assert.rejects(transcribe(input, { voice, cwd, env: { PATH: process.env.PATH } }), /VOICE_KEY/);
    await assert.rejects(synthesize("hi", { voice, cwd, env: { PATH: process.env.PATH } }), /VOICE_KEY/);
    assert.equal(server.requests.length, before, "no request without a key");
  } finally {
    await server.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

// Spec: MUS-SPEC-21-3A (docs/spec/clauses/21-voice.md#mus-spec-21-3a--every-transcription-and-synthesis-leaves-a-receipt)
test("voice operations write receipts without audio, keys or full transcripts", async () => {
  const ws = await workspace("muster-voice-receipts-");
  const server = await startFakeOpenAIAudio();
  const KEY = "sk-receipt-secret";
  try {
    const model = join(ws.cwd, "ggml-tiny.en.bin");
    await writeFile(model, "model");
    const input = join(ws.cwd, "clip.ogg");
    await writeFile(input, "OggS AUDIO-PAYLOAD-MARKER");
    const transcript = `start ${"word ".repeat(80)}tail-marker`;
    const local: VoiceConfig = { stt: { provider: "whisper-cpp", model }, tts: { provider: "say" } };
    await transcribe(input, { voice: local, cwd: ws.cwd, env: { ...ws.env, FAKE_TRANSCRIPT: transcript }, surfaceId: "telegram:bot" });
    const spoken = await synthesize("say this reply aloud", { voice: local, cwd: ws.cwd, env: ws.env, format: "ogg-opus" });
    await spoken.cleanup();
    const cloud: VoiceConfig = {
      stt: { provider: "openai", baseUrl: server.url, apiKeyEnv: "VOICE_KEY" },
      tts: { provider: "openai", baseUrl: server.url, apiKeyEnv: "VOICE_KEY" },
    };
    const cloudEnv = { ...ws.env, VOICE_KEY: KEY };
    await transcribe(input, { voice: cloud, cwd: ws.cwd, env: cloudEnv });
    const cloudSpoken = await synthesize("cloud reply", { voice: cloud, cwd: ws.cwd, env: cloudEnv });
    await cloudSpoken.cleanup();

    const receipts = await listVoiceReceipts(ws.cwd);
    assert.deepEqual(receipts.map((receipt) => [receipt.kind, receipt.provider, receipt.local]), [
      ["voice.stt", "whisper-cpp", true],
      ["voice.tts", "say", true],
      ["voice.stt", "openai", false],
      ["voice.tts", "openai", false],
    ]);
    const [stt, tts, cloudStt, cloudTts] = receipts;
    assert.equal(stt.audioSeconds, 2);
    assert.equal(stt.surfaceId, "telegram:bot");
    assert.equal(stt.costUsd, 0);
    assert.equal(tts.characters, "say this reply aloud".length);
    assert.equal(tts.costUsd, 0);
    assert.ok(typeof stt.durationMs === "number" && stt.durationMs >= 0);
    assert.ok((stt.transcriptPreview ?? "").length <= 200);
    assert.ok(stt.transcriptPreview?.startsWith("start word"));
    assert.ok(cloudStt.costUsd > 0, "cloud speech has an estimated cost");
    assert.ok(cloudTts.costUsd > 0);
    assert.equal(cloudTts.characters, "cloud reply".length);

    const raw = await readFile(voiceLedgerPath(ws.cwd), "utf8");
    assert.ok(!raw.includes("tail-marker"), "no full transcript");
    assert.ok(!raw.includes("AUDIO-PAYLOAD-MARKER"), "no audio");
    assert.ok(!raw.includes("OggS"), "no audio");
    assert.ok(!raw.includes(KEY), "no key");
    assert.ok(!raw.includes("say this reply aloud"), "no spoken text");
  } finally {
    await server.close();
    await ws.done();
  }
});
