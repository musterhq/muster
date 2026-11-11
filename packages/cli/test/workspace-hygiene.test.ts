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

// Spec: MUS-SPEC-15-2A (docs/spec/clauses/15-workspace-hygiene.md#mus-spec-15-2a--commands-do-not-print-nodes-sqlite-experimental-warning)
test("the SQLite experimental warning is hidden and other warnings still print", { timeout: 120_000 }, async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-warning-"));
  const env = { ...process.env, MUSTER_ONBOARDING_HOME: join(cwd, ".test-home"), MUSTER_SKIP_ONBOARDING: "1" };
  delete env.NODE_NO_WARNINGS;
  try {
    const cli = await run("tsx", [cliPath, "--version"], { cwd, env });
    assert.match(cli.stdout, /muster \d/);
    assert.doesNotMatch(cli.stderr, /ExperimentalWarning|SQLite|--trace-warnings/, cli.stderr);

    const filterPath = resolve(import.meta.dirname, "..", "src", "warning-filter.ts");
    const script = [
      `const { installWarningFilter } = await import(${JSON.stringify(filterPath)});`,
      "installWarningFilter();",
      "process.emitWarning('SQLite is an experimental feature and might change at any time', 'ExperimentalWarning');",
      "process.emitWarning('probe-deprecation', 'DeprecationWarning');",
      "process.emitWarning('probe-other-experimental', 'ExperimentalWarning');",
    ].join("\n");
    const probe = await run("tsx", ["--input-type=module", "-e", script], { cwd, env });
    assert.doesNotMatch(probe.stderr, /SQLite/, probe.stderr);
    assert.match(probe.stderr, /DeprecationWarning: probe-deprecation/);
    assert.match(probe.stderr, /ExperimentalWarning: probe-other-experimental/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

// Spec: MUS-SPEC-15-3A (docs/spec/clauses/15-workspace-hygiene.md#mus-spec-15-3a--muster-doctor-in-a-new-folder-says-what-to-do-not-a-raw-error)
test("doctor in a new folder suggests init instead of printing ENOENT", { timeout: 120_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "muster-doctor-fresh-"));
  try {
    const env = { ...process.env, MUSTER_ONBOARDING_HOME: join(dir, ".test-home"), MUSTER_SKIP_ONBOARDING: "1" };
    const { stdout } = await run("tsx", [cliPath, "doctor"], { cwd: dir, env }).catch((error: { stdout?: string }) => ({ stdout: error.stdout ?? "" }));
    assert.match(stdout, /^warn config\s+no Muster config in this folder yet$/m);
    assert.match(stdout, /^fix\s+config\s+muster init \(or muster doctor --fix\)$/m);
    assert.doesNotMatch(stdout, /ENOENT/);
    assert.doesNotMatch(stdout, /^(ok |err) /m, "one vocabulary: pass, warn, fail");
    assert.equal(existsSync(join(dir, ".muster")), false, "doctor makes no files");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
