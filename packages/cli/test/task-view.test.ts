import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type { ChildProcess } from "node:child_process";
import { openFileWithEditorGuard, renderTaskTranscript } from "../src/task-view.js";

function plain(value: string): string { return value.replace(/\x1b\[[0-9;]*m/g, ""); }

test("task transcript replay uses the chat grammar for every stored role", () => {
  const lines = renderTaskTranscript([
    { role: "user", content: "review this\ncarefully" },
    { role: "reasoning", content: "Checking the edge case" },
    { role: "assistant", content: "I found the cause.\nThe guard was missing." },
    { role: "tool", content: JSON.stringify({ name: "Read", target: "src/a.ts", summary: "12 lines" }) },
  ]).map(plain);
  assert.deepEqual(lines, [
    "> review this",
    "  carefully",
    "∴ Checking the edge case",
    "● I found the cause.",
    "  The guard was missing.",
    "⏺ Read(src/a.ts)",
    "  ⎿ 12 lines",
  ]);
});

test("editor guard suspends raw input and restores mouse/raw state after exit", async () => {
  const raw: boolean[] = [];
  const writes: string[] = [];
  let invocation: { command: string; args: readonly string[]; cwd: string } | undefined;
  await openFileWithEditorGuard("src/a.ts", {
    editor: "nvim -f",
    cwd: "/work",
    line: 17,
    setRawMode: (enabled) => raw.push(enabled),
    write: (data) => writes.push(data),
    spawnEditor: (command, args, cwd) => {
      invocation = { command, args, cwd };
      const child = new EventEmitter() as ChildProcess;
      queueMicrotask(() => child.emit("exit", 0, null));
      return child;
    },
  });
  assert.deepEqual(raw, [false, true]);
  assert.deepEqual(invocation, { command: "nvim", args: ["-f", "+17", "src/a.ts"], cwd: "/work" });
  assert.match(writes[0] ?? "", /\?1002l/);
  assert.match(writes[1] ?? "", /\?1002h/);
});

test("editor guard restores raw mode when spawn fails", async () => {
  const raw: boolean[] = [];
  await assert.rejects(openFileWithEditorGuard("src/a.ts", {
    editor: "missing-editor",
    cwd: "/work",
    setRawMode: (enabled) => raw.push(enabled),
    write: () => {},
    spawnEditor: () => { throw new Error("ENOENT"); },
  }), /ENOENT/);
  assert.deepEqual(raw, [false, true]);
});
