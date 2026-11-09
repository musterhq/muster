import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, realpath, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { createWorkspaceObserver, undoWorkspacePatches, type WorkspacePatchEvent } from "../src/index.js";

const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const git = (cwd: string, ...args: string[]) => spawnSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8" });

/** A repo plus the observer events of one "turn": a.txt edited twice, new.txt created, gone.txt deleted. */
async function turnWithEdits(t: TestContext): Promise<{ root: string; events: WorkspacePatchEvent[] }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "muster-undo-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, "init", "-q", "-b", "main", ".");
  await writeFile(join(root, "a.txt"), "one\ntwo\nthree\n");
  await writeFile(join(root, "gone.txt"), "keep me\n");
  git(root, "add", "-A");
  git(root, "commit", "-qm", "init");
  const events: WorkspacePatchEvent[] = [];
  const observer = createWorkspaceObserver({ root, watch: false, pollMs: 0, onPatch: (event) => events.push(event) });
  t.after(() => observer.stop());
  await observer.start();
  await writeFile(join(root, "a.txt"), "one\nTWO\nthree\n");
  await observer.flush();
  await writeFile(join(root, "a.txt"), "one\nTWO\nthree\nfour\n");
  await writeFile(join(root, "new.txt"), "brand new\n");
  await unlink(join(root, "gone.txt"));
  await observer.flush();
  await observer.stop();
  return { root, events };
}

// Spec: MUS-SPEC-13-1A (docs/spec/clauses/13-undo.md#mus-spec-13-1a--undo-restores-modified-created-and-deleted-files)
test("undo restores modified, created and deleted files", async (t) => {
  const { root, events } = await turnWithEdits(t);
  assert.ok(events.length >= 4, `recorded ${events.length} events`);
  const result = await undoWorkspacePatches(events);
  assert.equal(await readFile(join(root, "a.txt"), "utf8"), "one\ntwo\nthree\n");
  assert.equal(await readFile(join(root, "gone.txt"), "utf8"), "keep me\n");
  assert.equal(existsSync(join(root, "new.txt")), false);
  assert.deepEqual(result.restored.map((file) => file.path).sort(), ["a.txt", "gone.txt", "new.txt"]);
  assert.deepEqual(result.skipped, []);
});

// Spec: MUS-SPEC-13-1B (docs/spec/clauses/13-undo.md#mus-spec-13-1b--a-file-edited-after-the-turn-is-not-touched)
test("undo leaves files changed after the turn alone", async (t) => {
  const { root, events } = await turnWithEdits(t);
  await writeFile(join(root, "a.txt"), "the user's newer text\n");
  const result = await undoWorkspacePatches(events);
  assert.equal(await readFile(join(root, "a.txt"), "utf8"), "the user's newer text\n");
  assert.deepEqual(result.skipped.map((file) => [file.path, file.reason]), [["a.txt", "changed since the turn"]]);
  assert.equal(await readFile(join(root, "gone.txt"), "utf8"), "keep me\n");
  assert.equal(existsSync(join(root, "new.txt")), false);
});
