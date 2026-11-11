import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import type { VoiceConfig } from "@musterhq/core";
import { createMusterChatHarness, type MusterChatSink } from "../src/chat-tui.js";
import { installFakeVoiceTools, readFakeVoiceCalls } from "../../core/test/fakes/voice-tools.js";

const CTRL_R = "\x12";
const ESC = "\x1b";

function plain(lines: readonly string[] | string): string {
  return (typeof lines === "string" ? lines : lines.join("\n")).replace(/\x1b\[[0-9;]*m/g, "");
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const tick = () => new Promise((resolve) => setImmediate(resolve));

/** Fail instead of hanging when a dictation never settles. */
function within<T>(promise: Promise<T>, ms = 5000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(`not settled within ${ms} ms`)), ms); });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

async function workspace(only?: readonly string[]) {
  const cwd = await mkdtemp(join(tmpdir(), "muster-dictation-test-"));
  const tools = await installFakeVoiceTools(join(cwd, ".fake"), only);
  const model = join(cwd, "ggml-small.en.bin");
  await writeFile(model, "model");
  const env = {
    PATH: `${tools.bin}:${dirname(process.execPath)}:/usr/bin:/bin`,
    FAKE_VOICE_LOG: tools.log,
    FAKE_TRANSCRIPT: "add a test for the parser",
    HOME: cwd,
  };
  const voice: VoiceConfig = { stt: { provider: "whisper-cpp", model } };
  const done = async () => {
    // A recorder the code under test failed to stop must not outlive the test.
    for (const call of await readFakeVoiceCalls(tools.log)) {
      if (call.tool === "rec" && call.pid) try { process.kill(call.pid, "SIGKILL"); } catch { /* already gone */ }
    }
    await rm(cwd, { recursive: true, force: true });
  };
  return { cwd, env, voice, log: tools.log, bin: tools.bin, done };
}

/** A runtime whose turns stay open until the test releases them. */
function fakeRuntime() {
  const turns: string[] = [];
  const steered: string[] = [];
  const releases: Array<() => void> = [];
  let interrupted = 0;
  return {
    turns,
    steered,
    get interrupted() { return interrupted; },
    onSubmit: (text: string, _sink: MusterChatSink) => new Promise<boolean>((resolve) => {
      turns.push(text);
      releases.push(() => resolve(true));
    }),
    onSteer: async (text: string) => {
      steered.push(text);
      return true;
    },
    onInterrupt: () => {
      interrupted += 1;
      releases.shift()?.();
      return true;
    },
    release() { releases.shift()?.(); },
  };
}

// Spec: MUS-SPEC-22-1A (docs/spec/clauses/22-dictation.md#mus-spec-22-1a--ctrlr-records-ctrlr-stops-the-text-lands-in-the-composer-unsent)
test("ctrl+r records and inserts the transcript into the composer without sending", { timeout: 15000 }, async () => {
  const ws = await workspace();
  try {
    const runtime = fakeRuntime();
    let offset = 0;
    const chat = createMusterChatHarness({
      onSubmit: runtime.onSubmit,
      dictation: { voice: () => ws.voice, env: ws.env, cwd: ws.cwd, now: () => Date.now() + offset },
    });
    chat.type("please ");
    chat.input(CTRL_R);
    await sleep(300);
    const recording = plain(chat.visible());
    assert.match(recording, /● Recording 0:00 [▁▂▃▄▅▆▇█]{3} · ctrl\+r stop · esc cancel/);
    offset = 1000;
    await sleep(300);
    assert.match(plain(chat.visible()), /● Recording 0:01 /, "the timer advances");
    chat.input(CTRL_R);
    await tick();
    assert.match(plain(chat.visible()), /Transcribing…/);
    await within(chat.dictationDone());
    assert.equal(chat.text(), "please add a test for the parser");
    assert.doesNotMatch(plain(chat.visible()), /Recording|Transcribing/);
    // The cursor is at the end: typing continues the dictated text.
    chat.type("!");
    assert.equal(chat.text(), "please add a test for the parser!");
    assert.deepEqual(runtime.turns, [], "nothing is sent until Enter");
    const calls = await readFakeVoiceCalls(ws.log);
    const rec = calls.find((call) => call.tool === "rec");
    assert.ok(rec, "rec was spawned");
    assert.deepEqual(rec.argv.slice(0, -1), ["-q", "-c", "1", "-r", "16000", "-b", "16"]);
    const wav = rec.argv[rec.argv.length - 1]!;
    assert.match(wav, /\.wav$/);
    assert.ok(calls.some((call) => call.tool === "rec:signal" && call.argv[0] === "SIGINT"), "rec got SIGINT");
    assert.ok(calls.some((call) => call.tool === "whisper-cli"), "the clip was transcribed");
    assert.equal(existsSync(wav), false, "the temp WAV is removed");
    assert.equal(existsSync(dirname(wav)), false, "the temp dir is removed");
  } finally {
    await ws.done();
  }
});

// Spec: MUS-SPEC-22-1E (docs/spec/clauses/22-dictation.md#mus-spec-22-1e--dictation-works-while-a-turn-runs-steer-by-voice)
test("dictated text can steer a running turn", { timeout: 15000 }, async () => {
  const ws = await workspace();
  try {
    const runtime = fakeRuntime();
    const chat = createMusterChatHarness({
      onSubmit: runtime.onSubmit,
      onSteer: runtime.onSteer,
      onInterrupt: runtime.onInterrupt,
      dictation: { voice: () => ws.voice, env: ws.env, cwd: ws.cwd },
    });
    chat.type("fix the failing test");
    const first = chat.submit();
    await tick();
    chat.input(CTRL_R);
    await sleep(300);
    assert.match(plain(chat.visible()), /● Recording/);
    chat.input(CTRL_R);
    await within(chat.dictationDone());
    assert.equal(chat.text(), "add a test for the parser");
    assert.equal(runtime.interrupted, 0, "recording never interrupts the turn");
    assert.deepEqual(runtime.turns, ["fix the failing test"]);
    await chat.submit();
    assert.deepEqual(runtime.steered, ["add a test for the parser"], "Enter steers like typed text");
    assert.deepEqual(runtime.turns, ["fix the failing test"], "no second turn starts");
    assert.match(plain(chat.transcript()), /add a test for the parser[\s\S]*sent to the running turn/);
    runtime.release();
    await within(first);
  } finally {
    await ws.done();
  }
});

// Spec: MUS-SPEC-22-1B (docs/spec/clauses/22-dictation.md#mus-spec-22-1b--esc-cancels-a-recording-and-discards-the-audio)
test("esc cancels a recording without transcribing", { timeout: 15000 }, async () => {
  const ws = await workspace();
  try {
    const runtime = fakeRuntime();
    const chat = createMusterChatHarness({
      onSubmit: runtime.onSubmit,
      onSteer: runtime.onSteer,
      onInterrupt: runtime.onInterrupt,
      dictation: { voice: () => ws.voice, env: ws.env, cwd: ws.cwd },
    });
    chat.type("fix the failing test");
    const first = chat.submit();
    await tick();
    chat.type("please ");
    chat.input(CTRL_R);
    await sleep(300);
    assert.match(plain(chat.visible()), /● Recording/);
    chat.input(ESC);
    await within(chat.dictationDone());
    assert.equal(chat.text(), "please ", "the composer text is unchanged");
    assert.doesNotMatch(plain(chat.visible()), /Recording|Transcribing/, "the row disappears");
    assert.equal(runtime.interrupted, 0, "esc does not also interrupt the running turn");
    const calls = await readFakeVoiceCalls(ws.log);
    assert.ok(calls.some((call) => call.tool === "rec:signal"), "the recorder was stopped");
    assert.equal(calls.some((call) => call.tool === "whisper-cli" || call.tool === "ffmpeg"), false, "no transcription runs");
    const wav = calls.find((call) => call.tool === "rec")!.argv.at(-1)!;
    assert.equal(existsSync(dirname(wav)), false, "the temp audio is deleted");
    // With no recording, Esc interrupts the turn as before.
    chat.input(ESC);
    await tick();
    assert.equal(runtime.interrupted, 1);
    await within(first);
  } finally {
    await ws.done();
  }
});

// Spec: MUS-SPEC-22-1D (docs/spec/clauses/22-dictation.md#mus-spec-22-1d--a-recording-stops-itself-at-the-limit)
test("a recording stops at the dictation limit and is still transcribed", { timeout: 15000 }, async () => {
  const ws = await workspace();
  try {
    const chat = createMusterChatHarness({
      dictation: { voice: () => ({ ...ws.voice, dictation: { maxSeconds: 1 } }), env: ws.env, cwd: ws.cwd },
    });
    const started = Date.now();
    chat.input(CTRL_R);
    await sleep(1500);
    await within(chat.dictationDone());
    const calls = await readFakeVoiceCalls(ws.log);
    assert.ok(calls.some((call) => call.tool === "rec:signal"), "the recorder was stopped");
    assert.ok(Date.now() - started < 4000);
    assert.equal(chat.text(), "add a test for the parser");
    assert.match(plain(chat.transcript()), /stopped at the 1 s limit/);
  } finally {
    await ws.done();
  }
});
