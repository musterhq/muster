import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { installFakeVoiceTools, readFakeVoiceCalls } from "../../core/test/fakes/voice-tools.js";

const cliPath = resolve(import.meta.dirname, "..", "src", "index.ts");

function runCli(args: readonly string[], cwd: string, env: Record<string, string> = {}): Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string }> {
  return new Promise((resolvePromise) => {
    execFile("tsx", [cliPath, ...args], {
      cwd,
      env: { ...process.env, NO_COLOR: "1", MUSTER_ONBOARDING_HOME: join(cwd, ".home"), ...env },
      timeout: 30_000,
      maxBuffer: 4 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      const code = error ? (typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : 1) : 0;
      resolvePromise({ code, stdout, stderr });
    });
  });
}

async function workspace(prefix: string) {
  const cwd = await mkdtemp(join(tmpdir(), prefix));
  const tools = await installFakeVoiceTools(join(cwd, ".fake"));
  const home = join(cwd, ".fakehome");
  await mkdir(home, { recursive: true });
  const env = { PATH: `${tools.bin}:${process.env.PATH ?? ""}`, FAKE_VOICE_LOG: tools.log, HOME: home };
  return { cwd, home, bin: tools.bin, log: tools.log, env, done: () => rm(cwd, { recursive: true, force: true }) };
}

async function writeVoiceConfig(cwd: string, voice: unknown): Promise<void> {
  await mkdir(join(cwd, ".muster"), { recursive: true });
  await writeFile(join(cwd, ".muster", "config.json"), `${JSON.stringify({ version: 1, voice }, null, 2)}\n`);
}

// Spec: MUS-SPEC-21-1A (docs/spec/clauses/21-voice.md#mus-spec-21-1a--speech-is-off-until-configured-and-doctor-says-what-is-available)
test("voice doctor reports speech off and lists the local tools it found", async () => {
  const ws = await workspace("muster-voice-doctor-");
  try {
    const model = join(ws.home, ".cache", "whisper", "ggml-small.en.bin");
    await mkdir(join(ws.home, ".cache", "whisper"), { recursive: true });
    await writeFile(model, "model");
    // Any outbound connection from the doctor is recorded here.
    const netLog = join(ws.cwd, "network.log");
    const guard = join(ws.cwd, "no-network.mjs");
    await writeFile(guard, [
      "import net from 'node:net'; import { appendFileSync } from 'node:fs';",
      `const log = ${JSON.stringify(netLog)};`,
      "const realFetch = globalThis.fetch;",
      "globalThis.fetch = (...args) => { appendFileSync(log, `fetch ${String(args[0])}\\n`); return realFetch(...args); };",
      "const realConnect = net.Socket.prototype.connect;",
      "net.Socket.prototype.connect = function (...args) { const o = args[0]; if (o && typeof o === 'object' && o.port) appendFileSync(log, `tcp ${o.host}:${o.port}\\n`); else if (typeof o === 'number') appendFileSync(log, `tcp ${o}\\n`); return realConnect.apply(this, args); };",
    ].join("\n"));
    const env = { ...ws.env, NODE_OPTIONS: `--import ${guard}` };

    const text = await runCli(["voice", "doctor"], ws.cwd, env);
    assert.equal(text.code, 0, text.stderr);
    // A readable checklist, not key=value lines.
    assert.match(text.stdout, /^  Speech-to-text +off +voice notes get a setup hint instead of a turn$/m);
    assert.match(text.stdout, /^  Text-to-speech +off +replies are text only$/m);
    assert.match(text.stdout, /^  Spoken replies +off$/m);
    assert.match(text.stdout, new RegExp(`^  ✓ whisper-cli +${join(ws.bin, "whisper-cli")}$`, "m"));
    assert.match(text.stdout, new RegExp(`^  ✓ ffmpeg +${join(ws.bin, "ffmpeg")}$`, "m"));
    assert.match(text.stdout, new RegExp(`^  ✓ say +${join(ws.bin, "say")}$`, "m"));
    assert.match(text.stdout, new RegExp(`^  ✓ whisper model +${model}$`, "m"));
    assert.doesNotMatch(text.stdout, /\b(?:stt|tts|tool|model)=/);
    const line = `"voice": {"stt": {"provider": "whisper-cpp", "model": "${model}"}, "tts": {"provider": "say"}}`;
    assert.ok(text.stdout.includes(line), text.stdout);

    const json = await runCli(["voice", "doctor", "--json"], ws.cwd, env);
    assert.equal(json.code, 0, json.stderr);
    const report = JSON.parse(json.stdout) as {
      stt: { provider: string }; tts: { provider: string };
      tools: Array<{ name: string; path?: string }>; models: string[]; suggestedConfig: { voice: unknown };
    };
    assert.equal(report.stt.provider, "off");
    assert.equal(report.tts.provider, "off");
    assert.equal(report.tools.find((tool) => tool.name === "whisper-cli")?.path, join(ws.bin, "whisper-cli"));
    assert.ok(report.models.includes(model));
    assert.deepEqual(report.suggestedConfig.voice, { stt: { provider: "whisper-cpp", model }, tts: { provider: "say" } });
    assert.equal(existsSync(netLog), false, "voice doctor made no network call");
  } finally {
    await ws.done();
  }
});

// Spec: MUS-SPEC-21-1B (docs/spec/clauses/21-voice.md#mus-spec-21-1b--local-speech-to-text-with-whispercpp)
test("voice transcribe prints the transcript", async () => {
  const ws = await workspace("muster-voice-transcribe-");
  try {
    const model = join(ws.cwd, "ggml-tiny.en.bin");
    await writeFile(model, "model");
    await writeVoiceConfig(ws.cwd, { stt: { provider: "whisper-cpp", model } });
    const clip = join(ws.cwd, "clip.ogg");
    await writeFile(clip, "OggS fake");
    const result = await runCli(["voice", "transcribe", clip], ws.cwd, ws.env);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout.trim(), "what is two plus two");
  } finally {
    await ws.done();
  }
});

// Spec: MUS-SPEC-21-4A (docs/spec/clauses/21-voice.md#mus-spec-21-4a--muster-voice-say-speaks-or-writes-a-file)
test("voice say writes ogg with -o and plays without it", async () => {
  const ws = await workspace("muster-voice-say-cli-");
  try {
    await writeVoiceConfig(ws.cwd, { tts: { provider: "say", voice: "Samantha" } });
    const out = join(ws.cwd, "x.ogg");
    const written = await runCli(["voice", "say", "hello there", "-o", out], ws.cwd, ws.env);
    assert.equal(written.code, 0, written.stderr);
    assert.equal(written.stdout.trim(), out);
    assert.ok(existsSync(out));
    let calls = await readFakeVoiceCalls(ws.log);
    const convert = calls.find((call) => call.tool === "ffmpeg")!;
    assert.equal(convert.argv[convert.argv.indexOf("-c:a") + 1], "libopus");
    assert.equal(convert.argv[convert.argv.length - 1], out);

    const played = await runCli(["voice", "say", "hi"], ws.cwd, ws.env);
    assert.equal(played.code, 0, played.stderr);
    calls = await readFakeVoiceCalls(ws.log);
    const afplay = calls.find((call) => call.tool === "afplay");
    assert.ok(afplay, "afplay ran");
    const played_file = afplay.argv[afplay.argv.length - 1];
    assert.equal(afplay.existed[played_file], true);
    assert.equal(existsSync(played_file), false, "the temp audio is removed after playing");

    const failed = await runCli(["voice", "say", "hi", "-o", join(ws.cwd, "y.ogg")], ws.cwd, { ...ws.env, FAKE_FFMPEG_FAIL: "1" });
    assert.notEqual(failed.code, 0);
    assert.match(failed.stderr, /ffmpeg failed \(exit 1\): ffmpeg: Invalid data/);
  } finally {
    await ws.done();
  }
});

// Spec: MUS-SPEC-21-4B (docs/spec/clauses/21-voice.md#mus-spec-21-4b--voice-say-speaks-text-that-starts-with-a-dash)
test("voice say speaks text that starts with a dash", async () => {
  const ws = await workspace("muster-voice-dash-");
  try {
    await writeVoiceConfig(ws.cwd, { tts: { provider: "say" } });
    const out = join(ws.cwd, "minus.ogg");
    const written = await runCli(["voice", "say", "-5 degrees outside", "-o", out], ws.cwd, ws.env);
    assert.equal(written.code, 0, written.stderr);
    const say = (await readFakeVoiceCalls(ws.log)).find((call) => call.tool === "say");
    assert.ok(say, "say ran");
    assert.equal(say.argv[say.argv.length - 1], "-5 degrees outside");
  } finally {
    await ws.done();
  }
});
