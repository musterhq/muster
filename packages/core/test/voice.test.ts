import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { synthesize, transcribe } from "../src/voice.js";
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
