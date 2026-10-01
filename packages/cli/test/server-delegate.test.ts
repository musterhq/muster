import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import {
  resolveServerBinary,
  runServerDelegate,
  serverInstallSteps,
  SERVER_NOT_FOUND_EXIT_CODE,
} from "../src/server-delegate.js";

const execFileAsync = promisify(execFile);
const cliPath = resolve(import.meta.dirname, "..", "src", "index.ts");
const posixOnly = { skip: process.platform === "win32" };

async function fakeServer(dir: string, body: string, name = "muster-server"): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, `#!/bin/sh\n${body}\n`);
  await chmod(path, 0o755);
  return path;
}

async function runCli(args: string[], env: NodeJS.ProcessEnv): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const result = await execFileAsync("tsx", [cliPath, ...args], { env, timeout: 60_000 });
    return { ...result, code: 0 };
  } catch (error) {
    const e = error as Error & { stdout?: string; stderr?: string; code?: number };
    return { stdout: e.stdout ?? "", stderr: e.stderr ?? "", code: typeof e.code === "number" ? e.code : 1 };
  }
}

test("resolves MUSTER_SERVER_BIN first, ahead of PATH", posixOnly, async () => {
  const a = await mkdtemp(join(tmpdir(), "muster-srv-a-"));
  const b = await mkdtemp(join(tmpdir(), "muster-srv-b-"));
  const viaEnv = await fakeServer(a, "exit 0", "custom-server");
  await fakeServer(b, "exit 0");
  assert.equal(resolveServerBinary({ env: { MUSTER_SERVER_BIN: viaEnv, PATH: b } }), viaEnv);
});

test("an invalid MUSTER_SERVER_BIN does not silently fall back to PATH", posixOnly, async () => {
  const b = await mkdtemp(join(tmpdir(), "muster-srv-b-"));
  await fakeServer(b, "exit 0");
  assert.equal(resolveServerBinary({ env: { MUSTER_SERVER_BIN: join(b, "nope"), PATH: b } }), undefined);
});

test("finds muster-server on PATH", posixOnly, async () => {
  const dir = await mkdtemp(join(tmpdir(), "muster-srv-path-"));
  const bin = await fakeServer(dir, "exit 0");
  assert.equal(resolveServerBinary({ env: { PATH: `/nonexistent-dir:${dir}` } }), bin);
});

test("forwards args verbatim and propagates the exit code", posixOnly, async () => {
  const dir = await mkdtemp(join(tmpdir(), "muster-srv-exit-"));
  const out = join(dir, "args.txt");
  await fakeServer(dir, `printf '%s\\n' "$@" > '${out}'\nexit 7`);
  const code = await runServerDelegate(["users", "list", "--json", "a b", "--role=x"], { env: { PATH: dir } });
  assert.equal(code, 7);
  const { readFile } = await import("node:fs/promises");
  assert.equal(await readFile(out, "utf8"), "users\nlist\n--json\na b\n--role=x\n");
});

test("a child killed by a signal maps to 128+n", posixOnly, async () => {
  const dir = await mkdtemp(join(tmpdir(), "muster-srv-sig-"));
  await fakeServer(dir, "kill -TERM $$");
  assert.equal(await runServerDelegate(["start"], { env: { PATH: dir } }), 143);
});

test("not installed: install steps on stderr and exit 127", posixOnly, async () => {
  const empty = await mkdtemp(join(tmpdir(), "muster-srv-empty-"));
  const r = await runCli(["server", "status"], { ...process.env, MUSTER_SERVER_BIN: join(empty, "missing"), NO_COLOR: "1" });
  assert.equal(r.code, SERVER_NOT_FOUND_EXIT_CODE);
  assert.match(r.stderr, /muster-server is not installed/);
  assert.match(r.stderr, /releases/);
  assert.match(r.stderr, /SHA256SUMS/);
  assert.match(r.stderr, /docs\/server\.md/);
  assert.match(r.stderr, /MUSTER_SERVER_BIN/);
});

test("not installed with --json prints the documented shape", posixOnly, async () => {
  const empty = await mkdtemp(join(tmpdir(), "muster-srv-empty-"));
  const r = await runCli(["server", "status", "--json"], { ...process.env, MUSTER_SERVER_BIN: join(empty, "missing"), NO_COLOR: "1" });
  assert.equal(r.code, 127);
  const parsed = JSON.parse(r.stdout) as { ok: boolean; error: string; install: string[] };
  assert.equal(parsed.ok, false);
  assert.equal(parsed.error, "muster-server not installed");
  assert.deepEqual(parsed.install, serverInstallSteps());
});

test("server --help without the binary lists commands and install steps", posixOnly, async () => {
  const empty = await mkdtemp(join(tmpdir(), "muster-srv-empty-"));
  const r = await runCli(["server", "--help"], { ...process.env, MUSTER_SERVER_BIN: join(empty, "missing"), NO_COLOR: "1" });
  assert.equal(r.code, 0);
  assert.match(r.stdout, /muster server init/);
  assert.match(r.stdout, /connectors add\|list\|test\|route\|remove\|import-gateway/);
  assert.match(r.stdout, /not installed/);
});

test("muster server forwards to the binary end to end (exit code and args)", posixOnly, async () => {
  const dir = await mkdtemp(join(tmpdir(), "muster-srv-e2e-"));
  const bin = await fakeServer(dir, `echo "got:$*"\nexit 3`);
  const r = await runCli(["server", "--help", "doctor"], { ...process.env, MUSTER_SERVER_BIN: bin, NO_COLOR: "1" });
  assert.equal(r.code, 3);
  assert.equal(r.stdout.trim(), "got:--help doctor");
});
