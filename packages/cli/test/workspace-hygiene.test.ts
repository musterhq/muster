import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

const run = promisify(execFile);
const cliPath = resolve(import.meta.dirname, "..", "src", "index.ts");

// Spec: MUS-SPEC-15-1A (docs/spec/clauses/15-workspace-hygiene.md#mus-spec-15-1a--muster-never-appears-as-an-untracked-change)
test("muster state in a git repo is excluded locally, once, without touching .gitignore", { timeout: 120_000 }, async () => {
  const repo = await mkdtemp(join(tmpdir(), "muster-hygiene-"));
  const env = { ...process.env, MUSTER_ONBOARDING_HOME: join(repo, ".test-home"), MUSTER_SKIP_ONBOARDING: "1" };
  try {
    await run("git", ["init", "-q", "-b", "main"], { cwd: repo });
    await run("tsx", [cliPath, "init"], { cwd: repo, env });
    await run("tsx", [cliPath, "init"], { cwd: repo, env });
    const status = (await run("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: repo })).stdout;
    assert.doesNotMatch(status, /\.muster\//, status);
    const exclude = await readFile(join(repo, ".git", "info", "exclude"), "utf8");
    assert.equal(exclude.split("\n").filter((line) => line.trim() === ".muster/").length, 1);
    assert.equal(existsSync(join(repo, ".gitignore")), false);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});
