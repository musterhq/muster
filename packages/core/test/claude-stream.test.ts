import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { defaultConfig, executeRun, type AgentToolEvent } from "../src/index.js";

const STREAM = [
  { type: "system", subtype: "init", session_id: "s1", model: "claude-sonnet-5-5" },
  { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Checking " } } },
  { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "the code." } } },
  { type: "assistant", message: { content: [{ type: "text", text: "Checking the code." }, { type: "tool_use", id: "t1", name: "Read", input: { file_path: "/w/calc.py" } }] } },
  { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "def add(a, b):\n    return a + b" }] } },
  { type: "assistant", message: { content: [{ type: "tool_use", id: "t2", name: "Bash", input: { command: "pytest -q", description: "Run tests" } }] } },
  { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t2", content: [{ type: "text", text: "1 passed in 0.01s" }], is_error: false }] } },
  { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "All tests pass." } } },
  { type: "assistant", message: { content: [{ type: "text", text: "All tests pass." }] } },
  { type: "result", subtype: "success", is_error: false, result: "Checking the code.\n\nAll tests pass.", duration_ms: 2100, total_cost_usd: 0.0123, usage: { input_tokens: 120, cache_read_input_tokens: 9000, cache_creation_input_tokens: 400, output_tokens: 85 } },
];

async function fakeClaude(script: string) {
  const dir = await mkdtemp(join(tmpdir(), "muster-claude-stream-"));
  const command = join(dir, "claude");
  await writeFile(command, script, "utf8");
  await chmod(command, 0o755);
  return { dir, command };
}

async function run(dir: string, command: string, extra: { readonly fileEditCards?: boolean } = {}) {
  const deltas: string[] = [];
  const tools: AgentToolEvent[] = [];
  const outcome = await executeRun(defaultConfig(), {
    runtime: "claude-code",
    prompt: "fix calc.py and run the tests",
    cwd: dir,
    claudeCommand: command,
    ...extra,
    skipAgentRules: true,
    skipRecall: true,
    skipSkillSelection: true,
    skipMemoryWrite: true,
    onDelta: (delta) => deltas.push(delta),
    onToolEvent: (event) => tools.push(event),
  });
  return { outcome, deltas, tools };
}

// Spec: MUS-SPEC-06-1A (docs/spec/clauses/06-claude-runtime-stream.md#mus-spec-06-1a--tool-calls-streamed-text-and-real-usage-from-a-claude-turn)
test("claude turns report tool calls, stream text and record real usage", { timeout: 30_000 }, async () => {
  const lines = STREAM.map((event) => `printf '%s\\n' ${JSON.stringify(JSON.stringify(event)).replace(/\$/g, "\\$")}`).join("\n");
  const { dir, command } = await fakeClaude(`#!/usr/bin/env bash\n${lines}\n`);
  try {
    const { outcome, deltas, tools } = await run(dir, command);
    assert.equal(outcome.episode.responseText, "Checking the code.\n\nAll tests pass.");
    assert.deepEqual(tools.map((event) => [event.phase, event.kind, event.title]), [
      ["start", "tool", "Read calc.py"],
      ["end", "tool", "Read calc.py"],
      ["start", "command", "pytest -q"],
      ["end", "command", "pytest -q"],
    ]);
    assert.equal(tools[3]!.exitCode, 0);
    assert.equal(tools[3]!.output, "1 passed in 0.01s");
    assert.equal(deltas.join("").replace(/\s+/g, " ").trim(), "Checking the code. All tests pass.");
    assert.equal(outcome.tokens.inputTokens, 120 + 9000 + 400);
    assert.equal(outcome.tokens.cachedInputTokens, 9000);
    assert.equal(outcome.tokens.outputTokens, 85);
    assert.notEqual(outcome.tokens.estimated, true, "real provider numbers, not estimates");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// Spec: MUS-SPEC-06-1B (docs/spec/clauses/06-claude-runtime-stream.md#mus-spec-06-1b--a-claude-binary-without-stream-json-still-answers)
test("a claude that prints plain text still answers", { timeout: 30_000 }, async () => {
  const { dir, command } = await fakeClaude(`#!/usr/bin/env bash\nprintf 'plain answer from an old claude\\n'\n`);
  try {
    const { outcome } = await run(dir, command);
    assert.equal(outcome.episode.responseText, "plain answer from an old claude");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// Spec: MUS-SPEC-06-1C (docs/spec/clauses/06-claude-runtime-stream.md#mus-spec-06-1c--a-file-write-is-shown-once-as-its-diff-card)
test("claude file writes are left to the diff card; a failed write still shows", { timeout: 30_000 }, async () => {
  const events = [
    { type: "assistant", message: { content: [{ type: "tool_use", id: "w1", name: "Write", input: { file_path: "/w/note.txt", content: "plum" } }] } },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "w1", content: "File created successfully at: /w/note.txt (file state is current in your context — no need to Read it back)" }] } },
    { type: "assistant", message: { content: [{ type: "tool_use", id: "w2", name: "Edit", input: { file_path: "/w/calc.py", old_string: "a", new_string: "b" } }] } },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "w2", content: "The file /w/calc.py has been updated." }] } },
    { type: "assistant", message: { content: [{ type: "tool_use", id: "w3", name: "Write", input: { file_path: "/etc/hosts", content: "x" } }] } },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "w3", content: "EACCES: permission denied", is_error: true }] } },
    { type: "result", subtype: "success", is_error: false, result: "Done.", usage: { input_tokens: 1, output_tokens: 1 } },
  ];
  const lines = events.map((event) => `printf '%s\\n' ${JSON.stringify(JSON.stringify(event)).replace(/\$/g, "\\$")}`).join("\n");
  const { dir, command } = await fakeClaude(`#!/usr/bin/env bash\n${lines}\n`);
  try {
    const { tools } = await run(dir, command, { fileEditCards: true });
    assert.deepEqual(tools.map((event) => [event.phase, event.title, event.failed ?? false]), [
      ["start", "Write hosts", false],
      ["end", "Write hosts", true],
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// Spec: MUS-SPEC-06-1D (docs/spec/clauses/06-claude-runtime-stream.md#mus-spec-06-1d--without-diff-cards-a-file-write-keeps-its-own-cell)
test("without diff cards a claude file write keeps its own cell", { timeout: 30_000 }, async () => {
  const events = [
    { type: "assistant", message: { content: [{ type: "tool_use", id: "w1", name: "Write", input: { file_path: "/w/note.txt", content: "plum" } }] } },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "w1", content: "File created successfully at: /w/note.txt" }] } },
    { type: "result", subtype: "success", is_error: false, result: "Done.", usage: { input_tokens: 1, output_tokens: 1 } },
  ];
  const lines = events.map((event) => `printf '%s\\n' ${JSON.stringify(JSON.stringify(event)).replace(/\$/g, "\\$")}`).join("\n");
  const { dir, command } = await fakeClaude(`#!/usr/bin/env bash\n${lines}\n`);
  try {
    const { tools } = await run(dir, command);
    assert.deepEqual(tools.map((event) => [event.phase, event.title, event.failed ?? false]), [
      ["start", "Write note.txt", false],
      ["end", "Write note.txt", false],
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
