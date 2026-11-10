import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

const run = promisify(execFile);
const cliPath = resolve(import.meta.dirname, "..", "src", "index.ts");

// Spec: MUS-SPEC-20-1A, MUS-SPEC-20-1B, MUS-SPEC-20-1C (docs/spec/clauses/20-plugin-commands.md)
test("plugin commands appear in the slash menu and expand into the turn's prompt", { timeout: 180_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "muster-plugcmd-"));
  try {
    const bundle = join(root, "reviewer");
    await mkdir(join(bundle, ".claude-plugin"), { recursive: true });
    await mkdir(join(bundle, "commands"), { recursive: true });
    await writeFile(join(bundle, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "reviewer", version: "1.0.0" }));
    await writeFile(join(bundle, "commands", "review-pr.md"), "---\ndescription: Review a pull request\nargument-hint: <number>\n---\n\nReview PR $ARGUMENTS. First number: $1.\n!`git log -1`\n");
    const ws = join(root, "ws");
    await mkdir(ws, { recursive: true });
    const promptLog = join(root, "prompt.txt");
    const fake = join(root, "codex");
    await writeFile(fake, `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] !== "exec") process.exit(0);
fs.writeFileSync(${JSON.stringify(promptLog)}, args[args.length - 1]);
const flag = args.findIndex((arg) => arg === "-o" || arg === "--output-last-message");
if (flag >= 0) fs.writeFileSync(args[flag + 1], "reviewed");
console.log(JSON.stringify({ type: "thread.started", thread_id: "t" }));
`);
    await chmod(fake, 0o755);
    const env = { ...process.env, MUSTER_ONBOARDING_HOME: join(root, ".home"), MUSTER_SKIP_ONBOARDING: "1", NO_COLOR: "1", MUSTER_CODEX_COMMAND: fake };
    delete (env as Record<string, string | undefined>).FORCE_COLOR;
    const cli = async (...args: string[]) => (await run("tsx", [cliPath, ...args], { cwd: ws, env, timeout: 60_000 })).stdout;
    await cli("init");
    const installed = await cli("plugins", "install", bundle);
    assert.match(installed, /command=review-pr status=available/);
    assert.doesNotMatch(installed, /ignored=commands/);

    const menu = await cli("chat", "--complete", "/rev", "--describe");
    const row = menu.split("\n").map((line) => line.split("\t")).find(([value]) => value === "/review-pr");
    assert.ok(row, menu);
    assert.match(row[1] ?? "", /\/review-pr <number>/);
    assert.match(row[2] ?? "", /Review a pull request · reviewer/);

    const out = await cli("chat", "/review-pr 123 urgent");
    assert.match(out, /reviewed/);
    const prompt = await readFile(promptLog, "utf8");
    assert.match(prompt, /Review PR 123 urgent\. First number: 123\./);
    assert.doesNotMatch(prompt, /!`git log -1`/);
    assert.match(prompt, /shell snippets in plugin commands are not executed/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
