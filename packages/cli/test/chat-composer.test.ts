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

// Spec: MUS-SPEC-02-1F (docs/spec/clauses/02-chat-composer.md#mus-spec-02-1f--ctrlc-interrupts-first-and-quits-only-on-a-second-press)
test("ctrl+c interrupts a running turn and only a second press quits", { timeout: 3000 }, async () => {
  const runtime = fakeRuntime();
  const { chat, first } = start(runtime);
  await tick();
  chat.type("keep this draft");
  chat.input("\x03");
  await first;
  await tick();
  assert.equal(runtime.interrupted, 1, "the first ctrl+c interrupts the turn");
  assert.equal(chat.exited(), false, "the first ctrl+c does not quit");
  assert.equal(chat.text(), "keep this draft");
  assert.match(plain(chat.transcript()), /ctrl\+c again to quit/i);
  chat.input("\x03");
  assert.equal(chat.exited(), true, "a second ctrl+c within the window quits");

  const idle = createMusterChatHarness({ onSubmit: runtime.onSubmit, onInterrupt: runtime.onInterrupt });
  idle.input("\x03");
  assert.equal(idle.exited(), true, "ctrl+c on an idle, empty composer quits");

  const drafting = createMusterChatHarness({ onSubmit: runtime.onSubmit, onInterrupt: runtime.onInterrupt });
  drafting.type("half a thought");
  drafting.input("\x03");
  assert.equal(drafting.exited(), false);
  assert.equal(drafting.text(), "", "ctrl+c with text clears the composer first");
  drafting.input("\x03");
  assert.equal(drafting.exited(), true);
});

// Spec: MUS-SPEC-02-2B (docs/spec/clauses/02-chat-composer.md#mus-spec-02-2b--pickers-cover-the-full-width-under-a-rule)
test("composer pickers cover every column and open under a rule", async () => {
  const { composerOverlayOptions, RuledOverlay } = await import("../src/chat-tui.js");
  const options = composerOverlayOptions(110);
  assert.equal(options.width, 110, "no uncovered last column for the row behind to show through");
  assert.deepEqual(options.margin, { left: 0, right: 0 });
  let typed = "";
  const inner = { render: (width: number) => [`item ${width}`], handleInput: (data: string) => { typed += data; }, invalidate: () => {} };
  const ruled = new RuledOverlay(inner);
  const rows = ruled.render(110).map((row) => row.replace(/\x1b\[[0-9;]*m/g, ""));
  assert.equal(rows[0], "─".repeat(110));
  assert.equal(rows[1], "item 110");
  ruled.handleInput?.("j");
  assert.equal(typed, "j", "keys reach the picker");
});

// Spec: MUS-SPEC-17-2A (docs/spec/clauses/17-rewind.md#mus-spec-17-2a--rewound-turns-are-greyed-out-in-the-transcript)
test("rewound turns are greyed out in the transcript", async () => {
  let sinkRef!: MusterChatSink;
  const chat = createMusterChatHarness({ onSubmit: async (text, sink) => { sinkRef = sink; sink.appendLine(`● answer to ${text}`); return true; } });
  for (const prompt of ["first", "second", "third"]) {
    chat.type(prompt);
    await chat.submit();
  }
  const before = chat.transcript().length;
  sinkRef.markRewound("second");
  const rows = chat.transcript();
  assert.equal(rows.length, before + 1, "one marker row is added");
  const at = rows.findIndex((row) => row.replace(/\x1b\[[0-9;]*m/g, "").includes("rewound"));
  assert.ok(at >= 0 && rows[at + 1]!.replace(/\x1b\[[0-9;]*m/g, "").startsWith("> second"), rows.join("\n"));
  const muted = "\x1b[38;2;148;144;140m";
  assert.ok(rows.slice(at + 1).filter((row) => row.trim()).every((row) => row.startsWith(muted) && !row.slice(muted.length).includes("\x1b[38;2;2")), "every rewound row is grey");
  assert.ok(!rows.find((row) => row.includes("answer to first"))!.startsWith(muted), "earlier turns keep their look");
});

// Spec: MUS-SPEC-02-2C (docs/spec/clauses/02-chat-composer.md#mus-spec-02-2c--shortcuts-lists-every-key-and-help-columns-line-up)
test("/shortcuts lists every chat key and help rows line up", async () => {
  const { CHAT_SHORTCUTS, alignHelpRows } = await import("../src/chat-tui.js");
  const keys = CHAT_SHORTCUTS.map(([key]) => key).join(" | ");
  for (const key of ["Enter", "Ctrl+Q", "Alt+Enter", "Alt+↑", "Esc", "Ctrl+C", "Ctrl+O", "Ctrl+D", "PgUp", "PgDn", "Tab"]) {
    assert.ok(keys.includes(key), `${key} is listed: ${keys}`);
  }
  const rows = alignHelpRows([
    ["/model [name]", "choose the model"],
    ["/reasoning [auto|low|medium|high|compact|full]", "choose thinking effort"],
    ["/exit", "leave chat"],
  ], 100).map((row) => row.replace(/\x1b\[[0-9;]*m/g, ""));
  const columns = rows.filter((row) => /\S\s{2,}\S/.test(row)).map((row) => row.search(/(?<=\S\s{2,})\S/));
  assert.equal(columns.length, 2, rows.join("\n"));
  assert.ok(columns.every((column) => column === columns[0] && column > 0), rows.join("\n"));
  const long = rows.findIndex((row) => row.startsWith("/reasoning"));
  assert.ok(rows[long + 1]!.trim() === "choose thinking effort" && rows[long + 1]!.indexOf("choose") === columns[0], "a usage wider than the column puts its text on the next row, aligned");
});

// Spec: MUS-SPEC-02-2C (docs/spec/clauses/02-chat-composer.md#mus-spec-02-2c--shortcuts-lists-every-key-and-help-columns-line-up)
test("muster chat --shortcuts prints the keys in aligned columns", { timeout: 60_000 }, async () => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { resolve } = await import("node:path");
  const cli = resolve(import.meta.dirname, "..", "src", "index.ts");
  const { stdout } = await promisify(execFile)("tsx", [cli, "chat", "--shortcuts"], { env: { ...process.env, NO_COLOR: "1", MUSTER_SKIP_ONBOARDING: "1" } });
  const rows = stdout.split("\n").filter((row) => /^ {2}\S/.test(row));
  assert.ok(rows.length >= 10, stdout);
  const starts = rows.map((row) => row.search(/(?<=\S {2,})\S/));
  assert.ok(starts.every((start) => start > 0 && start === starts[0]), `descriptions start in one column:\n${stdout}`);
});

async function chatCommandReplies(commands: readonly string[]): Promise<Map<string, string>> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { resolve, join } = await import("node:path");
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const run = promisify(execFile);
  const cli = resolve(import.meta.dirname, "..", "src", "index.ts");
  const cwd = await mkdtemp(join(tmpdir(), "muster-replies-"));
  const env = { ...process.env, NO_COLOR: "1", MUSTER_SKIP_ONBOARDING: "1", MUSTER_ONBOARDING_HOME: join(cwd, ".test-home") };
  const replies = new Map<string, string>();
  try {
    await run("tsx", [cli, "init"], { cwd, env });
    for (const command of commands) {
      const { stdout } = await run("tsx", [cli, "chat", "--session", "replies", command], { cwd, env, timeout: 60_000 });
      replies.set(command, stdout);
    }
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
  return replies;
}

// Spec: MUS-SPEC-02-3A (docs/spec/clauses/02-chat-composer.md#mus-spec-02-3a--command-replies-are-plain-sentences-not-debug-keyvalue-pairs)
test("chat command replies are plain sentences", { timeout: 240_000 }, async () => {
  const replies = await chatCommandReplies(["/runtime claude-code", "/runtime codex", "/model gpt-5.5", "/access ask", "/reasoning full", "/new s2", "/reset"]);
  const debug = /provider_handles_cleared|\bruntime=|\bprovider=|\bmodel=|Model=|\baccess=|reasoning_density=|session=/;
  for (const [command, out] of replies) assert.doesNotMatch(out, debug, `${command}:\n${out}`);
  assert.match(replies.get("/runtime claude-code")!, /^Runtime: Claude Code · model sonnet$/m);
  assert.match(replies.get("/runtime codex")!, /^Runtime: Codex · model \S+$/m);
  assert.match(replies.get("/model gpt-5.5")!, /^Model: \S.* · this session$/m);
  assert.match(replies.get("/access ask")!, /^Access: ask · asks before /m);
  assert.match(replies.get("/reasoning full")!, /^Reasoning summaries: full$/m);
  assert.match(replies.get("/new s2")!, /^New session s2\.$/m);
  assert.match(replies.get("/reset")!, /^Conversation reset; the next turn starts a fresh provider thread\.$/m);
});

// Spec: MUS-SPEC-02-3B (docs/spec/clauses/02-chat-composer.md#mus-spec-02-3b--switching-runtime-does-not-pre-fill-the-composer)
test("switching runtime leaves the composer empty and hints at /model", { timeout: 240_000 }, async () => {
  const replies = await chatCommandReplies(["/runtime claude-code", "/runtime codex"]);
  for (const [command, out] of replies) {
    assert.doesNotMatch(out, /Next: \/model/, `${command} must not pre-fill /model:\n${out}`);
    assert.match(out, /^Type \/model to pick a different model\.$/m, `${command}:\n${out}`);
  }
});
