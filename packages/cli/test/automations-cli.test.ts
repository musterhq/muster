import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { createAutomation } from "@musterhq/core";

const cliPath = resolve(import.meta.dirname, "..", "src", "index.ts");

function env(cwd: string): NodeJS.ProcessEnv {
  return { ...process.env, MUSTER_ONBOARDING_HOME: join(cwd, ".test-home"), NO_COLOR: "1" };
}

function muster(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((done) => {
    execFile("tsx", [cliPath, ...args], { cwd, env: env(cwd), timeout: 60_000 }, (error, stdout, stderr) => {
      done({ stdout, stderr, code: error ? Number((error as { code?: number }).code ?? 1) : 0 });
    });
  });
}

async function workspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), "muster-automations-cli-"));
}

/** A reminder that was due a minute ago. */
async function dueReminder(cwd: string, text: string) {
  return createAutomation({ kind: "reminder", text, when: "in 1m", deliver: "terminal", now: new Date(Date.now() - 2 * 60_000), cwd });
}

// Spec: MUS-SPEC-16-2A (docs/spec/clauses/16-automations.md#mus-spec-16-2a--two-ticks-at-once-never-double-deliver)
test("two daemons ticking at once deliver a due reminder once", { timeout: 90_000 }, async () => {
  const cwd = await workspace();
  try {
    const job = await dueReminder(cwd, "stretch");
    const [a, b] = await Promise.all([muster(cwd, ["daemon", "--once"]), muster(cwd, ["daemon", "--once"])]);
    assert.equal(a.code, 0, a.stderr);
    assert.equal(b.code, 0, b.stderr);
    const combined = `${a.stdout}\n${b.stdout}`;
    assert.equal(combined.split("\n").filter((line) => line.includes(job.id) && line.includes("stretch")).length, 1, combined);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

// Spec: MUS-SPEC-16-2C (docs/spec/clauses/16-automations.md#mus-spec-16-2c--the-daemon-ticks-prints-one-line-per-run-and-stops-cleanly)
test("muster daemon delivers due reminders and stops on SIGTERM", { timeout: 90_000 }, async () => {
  const cwd = await workspace();
  try {
    const job = await dueReminder(cwd, "stretch");
    const child = spawn("tsx", [cliPath, "daemon", "--interval", "1"], { cwd, env: env(cwd), stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const exited = new Promise<number | null>((done) => child.on("exit", (code) => done(code)));
    await new Promise<void>((done, fail) => {
      const timer = setTimeout(() => fail(new Error(`no delivery line; stdout=${stdout} stderr=${stderr}`)), 60_000);
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
        if (stdout.includes("stretch")) { clearTimeout(timer); done(); }
      });
    });
    child.kill("SIGTERM");
    assert.equal(await exited, 0, stderr);
    assert.equal(stdout.split("\n").filter((line) => line.includes(job.id) && line.includes("stretch")).length, 1, stdout);
    assert.match(stdout, /stopped/i);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

// Spec: MUS-SPEC-16-5A (docs/spec/clauses/16-automations.md#mus-spec-16-5a--an-automations-table-in-the-cli-and-chat)
test("muster schedule list prints the automations table", { timeout: 90_000 }, async () => {
  const cwd = await workspace();
  try {
    const added = await muster(cwd, ["schedule", "add", "0 9 * * 1", "weekly review", "--tz", "Asia/Kolkata"]);
    assert.equal(added.code, 0, added.stderr);
    const reminded = await muster(cwd, ["schedule", "remind", "in 10m", "drink water"]);
    assert.equal(reminded.code, 0, reminded.stderr);
    assert.match(reminded.stdout, /drink water/);
    const done = await dueReminder(cwd, "stretch");
    assert.equal((await muster(cwd, ["daemon", "--once"])).code, 0);

    const listed = await muster(cwd, ["schedule", "list"]);
    assert.equal(listed.code, 0, listed.stderr);
    const lines = listed.stdout.split("\n");
    const header = lines.find((line) => line.includes("ID"))!;
    for (const column of ["ID", "KIND", "NEXT RUN", "LAST RUN", "RESULT", "ENABLED"]) assert.ok(header.includes(column), `${column} in ${header}`);
    const doneRow = lines.find((line) => line.includes(done.id))!;
    assert.match(doneRow, /reminder/);
    assert.match(doneRow, /completed/);
    assert.match(doneRow, /done/);
    assert.ok(lines.some((line) => /run/.test(line) && line.includes("weekly review")), listed.stdout);
    assert.ok(lines.some((line) => /reminder/.test(line) && line.includes("drink water") && /yes/.test(line)), listed.stdout);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
