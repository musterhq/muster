import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildClaudeCodeArgs, defaultConfig, executeRun, inspectClaudeCode, promoteSkill, runClaudeCode, writeCandidateSkill } from "../src/index.js";
import type { EvolveReport } from "../src/index.js";

function report(converged: boolean): EvolveReport {
  return {
    startedAt: new Date().toISOString(),
    iterations: [{ iteration: 1, passed: converged ? 1 : 0, failed: converged ? 0 : 1, results: [{ taskId: "t1", status: converged ? "passed" : "failed", durationMs: 1 }] }],
    harnessChecks: [],
    converged,
  };
}

test("buildClaudeCodeArgs creates a non-interactive Claude Code invocation", () => {
  const args = buildClaudeCodeArgs({
    prompt: "Review this repo",
    model: "sonnet",
    effort: "low",
    allowedTools: ["Bash(git status)", "Read"]
  });

  assert.deepEqual(args, [
    "--print",
    "--output-format",
    "text",
    "--no-session-persistence",
    "--model",
    "sonnet",
    "--effort",
    "low",
    "--allowedTools",
    "Bash(git status),Read",
    "--",
    "Review this repo"
  ]);
});

test("buildClaudeCodeArgs passes per-run plugin dirs before the user prompt", () => {
  const args = buildClaudeCodeArgs({
    prompt: "Review this repo",
    pluginDirs: ["/tmp/muster-skills-a", "/tmp/muster-skills-b"],
  });

  assert.deepEqual(args.slice(args.indexOf("--plugin-dir"), args.indexOf("Review this repo")), [
    "--plugin-dir",
    "/tmp/muster-skills-a",
    "--plugin-dir",
    "/tmp/muster-skills-b",
    "--",
  ]);
});

test("buildClaudeCodeArgs pins a fresh muster session id and drops --no-session-persistence", () => {
  const args = buildClaudeCodeArgs({ prompt: "hi", sessionId: "sess-uuid" });
  assert.equal(args[args.indexOf("--session-id") + 1], "sess-uuid");
  assert.ok(!args.includes("--no-session-persistence"), "a managed session persists for resume");
  assert.ok(!args.includes("--resume"));
});

test("buildClaudeCodeArgs resumes an existing session id", () => {
  const args = buildClaudeCodeArgs({ prompt: "next turn", sessionId: "sess-uuid", resume: true });
  assert.equal(args[args.indexOf("--resume") + 1], "sess-uuid");
  assert.ok(!args.includes("--session-id"));
  assert.ok(!args.includes("--no-session-persistence"));
});

test("runClaudeCode invokes an external Claude-compatible command", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-claude-command-"));
  const command = join(cwd, "fake-claude.sh");
  await writeFile(command, "#!/usr/bin/env bash\nprintf 'claude-output:%s\\n' \"$*\"\n", "utf8");
  await chmod(command, 0o755);

  const result = await runClaudeCode({
    command,
    prompt: "Say hello",
    cwd,
    model: "sonnet",
    effort: "low"
  });

  assert.equal(result.status, "completed");
  assert.equal(result.command, command);
  assert.match(result.stdout, /claude-output:/);
  assert.match(result.stdout, /Say hello/);
});

test("executeRun gives claude-code a temporary skill plugin instead of prompt catalog duplication", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-claude-snapshot-run-"));
  const command = join(cwd, "fake-claude.sh");
  const argsFile = join(cwd, "args.txt");
  const pluginFile = join(cwd, "plugin.txt");
  const systemFile = join(cwd, "system.txt");
  const promptFile = join(cwd, "prompt.txt");
  await writeFile(command, `#!/usr/bin/env bash
set -euo pipefail
plugin=""
prev=""
for arg in "$@"; do
  printf '%s\\n' "$arg" >> "$MUSTER_ARGS_FILE"
  if [ "$prev" = "--plugin-dir" ]; then plugin="$arg"; fi
  if [ "$prev" = "--append-system-prompt" ]; then printf '%s' "$arg" > "$MUSTER_SYSTEM_FILE"; fi
  prev="$arg"
done
printf '%s' "$plugin" > "$MUSTER_PLUGIN_FILE"
test -f "$plugin/.claude-plugin/plugin.json"
test -f "$plugin/skills/review-code/SKILL.md"
printf '%s' "\${@: -1}" > "$MUSTER_PROMPT_FILE"
printf 'ok from fake claude\\n'
`, "utf8");
  await chmod(command, 0o755);

  await writeCandidateSkill({
    name: "review-code",
    description: "Review code changes",
    body: "Review carefully.",
  }, cwd);
  await promoteSkill("review-code", report(true), cwd);

  const previous = {
    args: process.env.MUSTER_ARGS_FILE,
    plugin: process.env.MUSTER_PLUGIN_FILE,
    system: process.env.MUSTER_SYSTEM_FILE,
    prompt: process.env.MUSTER_PROMPT_FILE,
  };
  process.env.MUSTER_ARGS_FILE = argsFile;
  process.env.MUSTER_PLUGIN_FILE = pluginFile;
  process.env.MUSTER_SYSTEM_FILE = systemFile;
  process.env.MUSTER_PROMPT_FILE = promptFile;
  try {
    const outcome = await executeRun(defaultConfig(), {
      runtime: "claude-code",
      prompt: "please review",
      cwd,
      claudeCommand: command,
      skipAgentRules: true,
      skipMemoryWrite: true,
    });

    assert.equal(outcome.episode.responseText, "ok from fake claude");
    const args = await readFile(argsFile, "utf8");
    assert.match(args, /--plugin-dir/);
    const system = await readFile(systemFile, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return "";
      throw error;
    });
    assert.doesNotMatch(system, /Available skills/);
    assert.equal(await readFile(promptFile, "utf8"), "please review");
    const pluginDir = await readFile(pluginFile, "utf8");
    await assert.rejects(() => readFile(join(pluginDir, ".claude-plugin", "plugin.json"), "utf8"), /ENOENT/);
  } finally {
    if (previous.args === undefined) delete process.env.MUSTER_ARGS_FILE;
    else process.env.MUSTER_ARGS_FILE = previous.args;
    if (previous.plugin === undefined) delete process.env.MUSTER_PLUGIN_FILE;
    else process.env.MUSTER_PLUGIN_FILE = previous.plugin;
    if (previous.system === undefined) delete process.env.MUSTER_SYSTEM_FILE;
    else process.env.MUSTER_SYSTEM_FILE = previous.system;
    if (previous.prompt === undefined) delete process.env.MUSTER_PROMPT_FILE;
    else process.env.MUSTER_PROMPT_FILE = previous.prompt;
  }
});

test("inspectClaudeCode reports unavailable commands safely", async () => {
  const report = await inspectClaudeCode("/definitely/missing/claude");

  assert.equal(report.available, false);
});

test("runClaudeCode classifies only pre-dispatch spawn failures as fallback-safe", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-claude-fallback-"));
  const missing = await runClaudeCode({
    command: join(cwd, "missing-claude"),
    prompt: "hello",
    cwd,
  });
  assert.equal(missing.status, "failed");
  assert.equal(missing.fallbackEligible, true);

  const exitsAfterStart = join(cwd, "claude-exit.sh");
  await writeFile(exitsAfterStart, "#!/usr/bin/env bash\nexit 7\n", "utf8");
  await chmod(exitsAfterStart, 0o755);
  const dispatched = await runClaudeCode({ command: exitsAfterStart, prompt: "hello", cwd });
  assert.equal(dispatched.status, "failed");
  assert.equal(dispatched.fallbackEligible, false);
});
