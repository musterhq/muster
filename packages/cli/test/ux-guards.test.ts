/**
 * Guards for CLI friction that was reproduced LIVE, not imagined.
 *
 * Every test here corresponds to something that actually went wrong in a real
 * session: `muster run --help` spending money on a paid turn, a raw ENOENT
 * where "no workspace" belonged, a next-step hint telling the user to start a
 * daemon that was already serving, and a one-shot answer ending in a bare code
 * fence. They are cheap, offline, and none of them may ever pass by accident.
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { commandUsageLines, trimDanglingCodeFence } from "../src/output.js";

const execFileAsync = promisify(execFile);
const cliPath = resolve(import.meta.dirname, "..", "src", "index.ts");
// The help table lives in main.ts; index.ts is only the entry that loads it.
const helpText = await readFile(resolve(import.meta.dirname, "..", "src", "main.ts"), "utf8");

async function runCli(args: string[], cwd: string): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const result = await execFileAsync("tsx", [cliPath, ...args], {
      cwd,
      env: { ...process.env, MUSTER_ONBOARDING_HOME: join(cwd, ".test-home"), NO_COLOR: "1" },
      timeout: 60_000,
      maxBuffer: 1024 * 1024,
    });
    return { ...result, code: 0 };
  } catch (error) {
    const detail = error as Error & { stdout?: string; stderr?: string; code?: number };
    return { stdout: detail.stdout ?? "", stderr: detail.stderr ?? "", code: detail.code ?? 1 };
  }
}

/* ---------- 1. help never becomes a prompt ---------- */

test("a flag-shaped --help is answered as usage and never dispatched as work", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-ux-help-"));
  // No workspace and no provider here: if `run --help` reached the run path at
  // all it would either fail loudly or (as it did live) spend a paid turn.
  const run = await runCli(["run", "--help"], cwd);

  assert.equal(run.code, 0);
  assert.match(run.stdout, /^muster run/);
  assert.match(run.stdout, /muster run "prompt"/);
  assert.doesNotMatch(run.stdout, /run=|tokens in=/);
  assert.doesNotMatch(run.stdout, /No muster workspace/);
});

test("run, gateway, memory and codex all carry real usage text", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-ux-usage-"));
  for (const [command, expected] of [
    ["run", /muster run "prompt"/],
    ["gateway", /muster gateway daemon start\|stop\|status\|restart/],
    ["memory", /muster memory add --summary/],
    ["codex", /muster codex sessions/],
    ["latency", /muster latency "prompt"/],
  ] as const) {
    const result = await runCli([command, "--help"], cwd);
    assert.equal(result.code, 0, `${command} --help must exit 0`);
    assert.match(result.stdout, expected, `${command} --help must print its usage`);
  }
});

test("-h is intercepted too, and a bare `help` only counts in first position", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-ux-h-"));
  const short = await runCli(["gateway", "-h"], cwd);
  assert.equal(short.code, 0);
  assert.match(short.stdout, /muster gateway init/);

  // "help" mid-argv is user content, not a request for usage: `muster memory
  // search --query help` must still run the search, not print the manual.
  const notHelp = await runCli(["memory", "search", "--scope", "user:me", "--query", "help"], cwd);
  assert.doesNotMatch(notHelp.stdout, /Full command list/);
});

test("commandUsageLines derives usage from the master table instead of duplicating it", () => {
  const table = "Usage:\n  muster run \"prompt\" [--model X]\n  muster runtime doctor\n  muster gateway init\n";
  assert.deepEqual(commandUsageLines(table, "run"), ['  muster run "prompt" [--model X]']);
  assert.deepEqual(commandUsageLines(table, "runtime"), ["  muster runtime doctor"]);
  assert.deepEqual(commandUsageLines(table, "nope"), []);
});

/* ---------- 2. missing workspace ---------- */

test("a missing workspace fails closed with the fix, not a raw ENOENT", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-ux-nows-"));
  const result = await runCli(["run", "say hello"], cwd);

  assert.equal(result.code, 1);
  assert.match(result.stderr, /^No muster workspace\. Fix: muster init$/m);
  assert.doesNotMatch(result.stderr, /ENOENT/);
  // Failing closed means it also refuses to silently create one behind the user.
  assert.equal(existsSync(join(cwd, ".muster", "config.json")), false);
});

test("muster init writes the workspace the guard asks for", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-ux-init-"));
  await runCli(["init"], cwd);
  const config = JSON.parse(await readFile(join(cwd, ".muster", "config.json"), "utf8")) as {
    version: number;
    providers: Record<string, { kind: string }>;
    routing: { defaultRuntime: string };
  };

  assert.equal(config.version, 1);
  assert.equal(config.providers.codex?.kind, "codex-cli");
  assert.equal(config.routing.defaultRuntime, "native");
});

/* ---------- 3. state-aware next hints ---------- */

test("gateway status stops telling a running daemon to start", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-ux-gw-"));
  await runCli(["init"], cwd);
  await runCli(["gateway", "init"], cwd);

  const stopped = await runCli(["gateway", "status"], cwd);
  assert.match(stopped.stdout, /daemon=stopped/);
  assert.match(stopped.stdout, /next="muster gateway daemon start/);

  // A pid file naming a process that IS alive (this test runner) is exactly the
  // state that produced the stale hint live.
  await mkdir(join(cwd, ".muster"), { recursive: true });
  await writeFile(join(cwd, ".muster", "gateway.pid"), `${process.pid}\n`, "utf8");

  const running = await runCli(["gateway", "status"], cwd);
  assert.match(running.stdout, /daemon=running/);
  assert.doesNotMatch(running.stdout, /next="muster gateway daemon start/);
  assert.match(running.stdout, /next="muster gateway daemon status"/);
});

/* ---------- 4. one-shot output hygiene ---------- */

test("trimDanglingCodeFence removes only an unbalanced trailing fence", () => {
  assert.equal(trimDanglingCodeFence("done\n\n```"), "done\n");
  assert.equal(trimDanglingCodeFence("done\n```ts"), "done");
  // Balanced fences are content and must survive byte-identical.
  const balanced = "here:\n```ts\nconst x = 1;\n```\n";
  assert.equal(trimDanglingCodeFence(balanced), balanced);
  assert.equal(trimDanglingCodeFence("no fences at all"), "no fences at all");
  // Three fences: the last one is open, so it goes; the pair stays.
  assert.equal(trimDanglingCodeFence("a\n```\nb\n```\nc\n```"), "a\n```\nb\n```\nc");
});

/* ---------- 5. doctor covers the four things that actually broke ---------- */

test("doctor reports dist freshness, backend auth, daemon health and the PATH shim", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-ux-doctor-"));
  await runCli(["init"], cwd);
  const { stdout } = await runCli(["doctor"], cwd);

  assert.match(stdout, /^(pass|warn|fail)\s+dist:core/m);
  assert.match(stdout, /^(pass|warn|fail)\s+backend:codex/m);
  assert.match(stdout, /^(pass|warn|fail)\s+backend:claude/m);
  assert.match(stdout, /^(pass|warn|fail)\s+gateway-daemon/m);
  assert.match(stdout, /^(pass|warn|fail)\s+path-shim/m);
  // Every non-passing check owes the user exactly one line of remedy.
  for (const line of stdout.split("\n")) {
    const match = /^(warn|fail)\s+(\S+)/.exec(line);
    if (!match) continue;
    assert.match(stdout, new RegExp(`^fix\\s+${match[2].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s+\\S`, "m"),
      `check ${match[2]} is ${match[1]} but offers no fix`);
  }
});

test("the help table itself still lists every command doctor and the guards reference", () => {
  for (const command of ["run", "gateway", "memory", "codex", "doctor", "init"]) {
    assert.ok(commandUsageLines(helpText, command).length > 0, `muster ${command} must appear in the help table`);
  }
});
