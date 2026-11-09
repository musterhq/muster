import assert from "node:assert/strict";
import { test } from "node:test";
import { createMusterChatHarness, type MusterChatSink } from "../src/chat-tui.js";

function plain(lines: readonly string[]): string {
  return lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
}

/** A runtime whose turns stay open until the test releases them. */
function fakeRuntime(options: { steer?: boolean } = {}) {
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
      if (!options.steer) return false;
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

const tick = () => new Promise((resolve) => setImmediate(resolve));

function start(runtime: ReturnType<typeof fakeRuntime>) {
  const chat = createMusterChatHarness({ onSubmit: runtime.onSubmit, onSteer: runtime.onSteer, onInterrupt: runtime.onInterrupt });
  chat.type("fix the failing test");
  const first = chat.submit();
  return { chat, first };
}

// Spec: MUS-SPEC-02-1A (docs/spec/clauses/02-chat-composer.md#mus-spec-02-1a--enter-during-a-turn-steers-it)
test("enter during a running turn steers it instead of starting a new turn", { timeout: 3000 }, async () => {
  const runtime = fakeRuntime({ steer: true });
  const { chat, first } = start(runtime);
  await tick();
  chat.type("use uv instead");
  await chat.submit();
  assert.deepEqual(runtime.steered, ["use uv instead"]);
  assert.deepEqual(runtime.turns, ["fix the failing test"], "no second turn starts");
  assert.equal(chat.text(), "");
  assert.match(plain(chat.transcript()), /use uv instead[\s\S]*sent to the running turn/);
  runtime.release();
  await first;
  assert.deepEqual(runtime.turns, ["fix the failing test"], "a steered message never replays as a turn");
});

// Spec: MUS-SPEC-02-1B (docs/spec/clauses/02-chat-composer.md#mus-spec-02-1b--when-steering-is-unavailable-the-message-is-queued-and-runs-next)
test("a message that cannot steer is queued, shown above the composer, and runs after the turn", { timeout: 3000 }, async () => {
  const runtime = fakeRuntime({ steer: false });
  const { chat, first } = start(runtime);
  await tick();
  chat.type("then update the README");
  await chat.submit();
  assert.match(plain(chat.visible()), /queued.*then update the README/);
  assert.deepEqual(runtime.turns, ["fix the failing test"]);
  runtime.release();
  await first;
  await tick();
  assert.deepEqual(runtime.turns, ["fix the failing test", "then update the README"]);
  assert.doesNotMatch(plain(chat.visible()), /queued/);
  runtime.release();
});

// Spec: MUS-SPEC-02-1C (docs/spec/clauses/02-chat-composer.md#mus-spec-02-1c--ctrlq-queues-a-follow-up-even-when-steering-is-possible)
test("ctrl+q queues a follow-up without steering", { timeout: 3000 }, async () => {
  const runtime = fakeRuntime({ steer: true });
  const { chat, first } = start(runtime);
  await tick();
  chat.type("next: write the changelog");
  chat.input("\x11");
  await tick();
  assert.deepEqual(runtime.steered, []);
  assert.equal(chat.text(), "");
  assert.match(plain(chat.visible()), /queued.*next: write the changelog/);
  chat.type("and bump the version");
  chat.input("\x1b\r");
  await tick();
  assert.match(plain(chat.visible()), /queued.*and bump the version/, "alt+enter queues too");
  runtime.release();
  await first;
  await tick();
  assert.equal(runtime.turns[1], "next: write the changelog");
});

// Spec: MUS-SPEC-02-1D (docs/spec/clauses/02-chat-composer.md#mus-spec-02-1d--interrupting-returns-queued-messages-to-the-composer)
test("esc interrupts and puts queued messages back in the composer", { timeout: 3000 }, async () => {
  const runtime = fakeRuntime({ steer: false });
  const { chat, first } = start(runtime);
  await tick();
  chat.type("then update the README");
  await chat.submit();
  chat.input("\x1b");
  await first;
  await tick();
  assert.equal(runtime.interrupted, 1);
  assert.equal(chat.text(), "then update the README");
  assert.deepEqual(runtime.turns, ["fix the failing test"], "nothing runs automatically after an interrupt");
});

// Spec: MUS-SPEC-02-1E (docs/spec/clauses/02-chat-composer.md#mus-spec-02-1e--altup-edits-the-last-queued-message)
test("alt+up pulls the last queued message back into the composer", { timeout: 3000 }, async () => {
  const runtime = fakeRuntime({ steer: false });
  const { chat, first } = start(runtime);
  await tick();
  chat.type("first follow-up");
  await chat.submit();
  chat.type("second follow-up");
  await chat.submit();
  chat.input("\x1b[1;3A");
  assert.equal(chat.text(), "second follow-up");
  const visible = plain(chat.visible());
  assert.match(visible, /queued.*first follow-up/);
  assert.doesNotMatch(visible, /queued.*second follow-up/);
  runtime.release();
  await first;
  await tick();
  runtime.release();
});
