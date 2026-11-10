/**
 * Adversarial NEGATIVE + STRESS suite for workspace-observer.ts.
 *
 * Assumes the builder was optimistic. Every scenario here is an attempt to
 * lose a patch, corrupt a hash chain, leak pre-existing state, or leave a
 * timer/watcher alive after stop(). The per-path hash-chain assertion (S1) is
 * the audit-spine property from docs/STRATEGY_V2.md §2.2: every observed
 * transition must chain beforeHash → afterHash with no gaps.
 *
 * B1–B3 are regression pins for three real lifecycle races found by this
 * suite and fixed in the module (see each test's comment).
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rename, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import {
  createWorkspaceObserver,
  WorkspaceObserverError,
  type WorkspaceObserver,
  type WorkspaceObserverDiagnostic,
  type WorkspaceObserverOptions,
  type WorkspacePatchEvent,
} from "../src/workspace-observer.js";

/* ---------- hermetic repo helpers (mirrors workspace-observer.test.ts) ---------- */

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "Muster Test",
  GIT_AUTHOR_EMAIL: "test@muster.invalid",
  GIT_COMMITTER_NAME: "Muster Test",
  GIT_COMMITTER_EMAIL: "test@muster.invalid",
};

function git(cwd: string, ...args: string[]): { status: number; stdout: string; stderr: string } {
  const result = spawnSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8" });
  return { status: result.status ?? -1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

async function makeRepo(t: TestContext, files: Readonly<Record<string, string>> = { "keep.txt": "a\nb\nc\n" }): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "muster-observer-stress-")));
  t.after(async () => { await rm(dir, { recursive: true, force: true }); });
  assert.equal(git(dir, "init", "-q", "-b", "main", ".").status, 0);
  for (const [name, body] of Object.entries(files)) {
    await mkdir(join(dir, name, ".."), { recursive: true });
    await writeFile(join(dir, name), body);
  }
  if (Object.keys(files).length > 0) {
    assert.equal(git(dir, "add", "-A").status, 0);
    assert.equal(git(dir, "commit", "-qm", "init").status, 0);
  }
  return dir;
}

interface Harness {
  readonly observer: WorkspaceObserver;
  readonly events: WorkspacePatchEvent[];
  readonly diagnostics: WorkspaceObserverDiagnostic[];
}

async function attach(t: TestContext, root: string, overrides: Partial<WorkspaceObserverOptions> = {}): Promise<Harness> {
  const events: WorkspacePatchEvent[] = [];
  const diagnostics: WorkspaceObserverDiagnostic[] = [];
  const observer = createWorkspaceObserver({
    root,
    watch: false,
    pollMs: 0,
    onPatch: (event) => events.push(event),
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    ...overrides,
  });
  t.after(async () => { await observer.stop(); });
  await observer.start();
  return { observer, events, diagnostics };
}

async function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
  assert.fail(`Condition not met within ${timeoutMs}ms.`);
}

const sleep = (ms: number): Promise<void> => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

function sha256(input: string | Uint8Array): string {
  return `sha256:${createHash("sha256").update(typeof input === "string" ? Buffer.from(input, "utf8") : input).digest("hex")}`;
}

function groupByPath(events: readonly WorkspacePatchEvent[]): Map<string, WorkspacePatchEvent[]> {
  const byPath = new Map<string, WorkspacePatchEvent[]>();
  for (const event of events) {
    const bucket = byPath.get(event.path);
    if (bucket) bucket.push(event);
    else byPath.set(event.path, [event]);
  }
  return byPath;
}

/** The audit-spine invariant: consecutive events for one path must chain hashes. */
function assertChain(bucket: readonly WorkspacePatchEvent[], path: string): void {
  for (let index = 1; index < bucket.length; index += 1) {
    assert.equal(bucket[index]!.beforeHash, bucket[index - 1]!.afterHash, `hash chain broken for ${path} at event ${index}`);
  }
}

/* ---------- S1: 320-file storm ---------- */

const TRACKED = 120;
const CREATED = 200;
const MODIFIED = 80; // tracked 0..79
const DELETED = 40; // tracked 80..119

const trackedName = (index: number): string => `tracked-${String(index).padStart(3, "0")}.txt`;
const createdName = (index: number): string => `created-${String(index).padStart(3, "0")}.txt`;
const trackedOriginal = (index: number): string => `tracked ${index} original content line\n`;
const trackedModified = (index: number): string => `tracked ${index} modified content line\n`;
const createdContent = (index: number): string => `created ${index} content\n`;

test("S1: a 320-file create/modify/delete storm under live watch loses nothing and keeps every hash chain intact", async (t) => {
  const seed: Record<string, string> = {};
  for (let index = 0; index < TRACKED; index += 1) seed[trackedName(index)] = trackedOriginal(index);
  const repo = await makeRepo(t, seed);
  // Watch is LIVE during the storm so detection cycles interleave with the
  // writes — the adversarial posture. Contents are unique per file so no
  // accidental rename pairing can hide a delete behind an add.
  const { observer, events } = await attach(t, repo, { watch: true, pollMs: 0, debounceMs: 40 });

  const stormStart = Date.now();
  for (let index = 0; index < CREATED; index += 1) {
    await writeFile(join(repo, createdName(index)), createdContent(index));
    if (index < MODIFIED) await writeFile(join(repo, trackedName(index)), trackedModified(index));
    if (index < DELETED) await unlink(join(repo, trackedName(MODIFIED + index)));
    if (index % 40 === 39) await sleep(25); // let watch cycles interleave mid-storm
  }
  const stormMs = Date.now() - stormStart;
  assert.ok(stormMs < 10_000, `storm took ${stormMs}ms; the ~2s scenario has degenerated`);

  await observer.flush();
  const byPath = groupByPath(events);

  assert.equal(byPath.size, CREATED + MODIFIED + DELETED, "every mutated path has at least one event and no unexpected path appears");
  for (let index = 0; index < CREATED; index += 1) {
    const path = createdName(index);
    const bucket = byPath.get(path);
    assert.ok(bucket, `lost patch: ${path} was created and never observed`);
    assert.equal(bucket[0]!.changeKind, "add");
    assert.equal(bucket[0]!.beforeHash, null);
    assert.equal(bucket.at(-1)!.afterHash, sha256(createdContent(index)), `final content of ${path} not captured`);
    assertChain(bucket, path);
  }
  for (let index = 0; index < MODIFIED; index += 1) {
    const path = trackedName(index);
    const bucket = byPath.get(path);
    assert.ok(bucket, `lost patch: ${path} was modified and never observed`);
    assert.equal(bucket[0]!.beforeHash, sha256(trackedOriginal(index)), `${path} first beforeHash must be the committed baseline`);
    assert.equal(bucket.at(-1)!.afterHash, sha256(trackedModified(index)));
    assert.notEqual(bucket.at(-1)!.changeKind, "delete");
    assertChain(bucket, path);
  }
  for (let index = MODIFIED; index < TRACKED; index += 1) {
    const path = trackedName(index);
    const bucket = byPath.get(path);
    assert.ok(bucket, `lost patch: ${path} was deleted and never observed`);
    assert.equal(bucket[0]!.beforeHash, sha256(trackedOriginal(index)));
    assert.equal(bucket.at(-1)!.changeKind, "delete");
    assert.equal(bucket.at(-1)!.afterHash, null);
    assertChain(bucket, path);
  }

  // Global spine properties: gapless sequence, honest stats, no phantom renames.
  assert.deepEqual(events.map((event) => event.sequence), events.map((_, index) => index + 1), "sequence must be gapless and strictly increasing");
  assert.ok(events.every((event) => event.changeKind !== "rename"), "unique contents admit no rename pairing");
  assert.ok(events.every((event) => event.changeKind === "delete" || event.afterHash !== null), "hashes stay exact even when diffs are budget-omitted");
  assert.equal(observer.stats.eventsEmitted, events.length);

  // Convergence: a second flush after the storm settles must find nothing.
  assert.deepEqual(await observer.flush(), []);
  const snapshot = observer.snapshot();
  for (let index = 0; index < CREATED; index += 1) assert.equal(snapshot.get(createdName(index))?.hash, sha256(createdContent(index)));
  for (let index = 0; index < MODIFIED; index += 1) assert.equal(snapshot.get(trackedName(index))?.hash, sha256(trackedModified(index)));
  for (let index = MODIFIED; index < TRACKED; index += 1) assert.equal(snapshot.has(trackedName(index)), false);
});

/* ---------- S2: modify-then-revert inside one debounce window ---------- */

test("S2: modify-then-revert within one debounce window emits nothing and leaves the baseline uncorrupted", async (t) => {
  const repo = await makeRepo(t, { "keep.txt": "a\nb\nc\n" });
  const { observer, events } = await attach(t, repo, { watch: true, pollMs: 0, debounceMs: 150 });

  await writeFile(join(repo, "keep.txt"), "tampered\n");
  await writeFile(join(repo, "keep.txt"), "a\nb\nc\n"); // reverted well inside the 150ms window
  await waitFor(() => observer.stats.cycles >= 1);
  assert.equal(events.length, 0, "a net-zero transition inside one window must not emit");

  // The revert must not have corrupted the baseline: a later real edit chains
  // from the COMMITTED content, not from the transient tamper.
  // writeFile truncates before it writes, so a watch read can land between the
  // two and see an empty file; the observer then emits again once the write
  // lands. Wait for the settled content instead of taking the first event.
  await writeFile(join(repo, "keep.txt"), "real change\n");
  await waitFor(() => events.at(-1)?.afterHash === sha256("real change\n"));
  assert.equal(events[0]!.beforeHash, sha256("a\nb\nc\n"));
  for (let index = 1; index < events.length; index += 1) assert.equal(events[index]!.beforeHash, events[index - 1]!.afterHash, "events chain");
  assert.ok(events.every((event) => event.detectedBy === "watch"));
});

/* ---------- S3: deeply nested new directories ---------- */

test("S3: files in freshly created deep directory trees are observed on create and on recursive delete", async (t) => {
  const repo = await makeRepo(t);
  const { observer } = await attach(t, repo);

  const deep = Array.from({ length: 10 }, (_, index) => `depth-${String(index + 1).padStart(2, "0")}`).join("/");
  const paths = [
    `${deep}/leaf.txt`,
    "depth-01/depth-02/depth-03/mid.txt",
    "wide/a/b/x.txt",
    "wide/a/b/y.txt",
    "wide/a/c/z.txt",
  ] as const;
  for (const relPath of paths) {
    await mkdir(join(repo, relPath, ".."), { recursive: true });
    await writeFile(join(repo, relPath), `content of ${relPath}\n`);
  }

  const added = await observer.flush();
  assert.deepEqual(added.map((event) => event.path), [...paths].sort(), "POSIX toplevel-relative paths in byte order");
  for (const event of added) {
    assert.equal(event.changeKind, "add");
    assert.ok(!event.path.includes("\\"), "paths are POSIX even on odd platforms");
    assert.ok(event.diff!.includes(`+++ b/${event.path}`));
    assert.equal(event.afterHash, sha256(`content of ${event.path}\n`));
  }

  await rm(join(repo, "depth-01"), { recursive: true, force: true });
  await rm(join(repo, "wide"), { recursive: true, force: true });
  const removed = await observer.flush();
  assert.deepEqual(removed.map((event) => event.path), [...paths].sort());
  assert.ok(removed.every((event) => event.changeKind === "delete" && event.afterHash === null));
  for (const relPath of paths) assert.equal(observer.snapshot().has(relPath), false);
});

/* ---------- S4: rename chains ---------- */

test("S4: a rename chain links across flushes, and a chain inside one window collapses to its endpoints", async (t) => {
  const content = "chain content v1\n";
  const repo = await makeRepo(t, { "chain.txt": content });
  const { observer } = await attach(t, repo);

  await rename(join(repo, "chain.txt"), join(repo, "hop.txt"));
  const [first] = await observer.flush();
  assert.equal(first!.changeKind, "rename");
  assert.equal(first!.previousPath, "chain.txt");
  assert.equal(first!.path, "hop.txt");
  assert.equal(first!.beforeHash, sha256(content));
  assert.equal(first!.afterHash, sha256(content));

  await rename(join(repo, "hop.txt"), join(repo, "final.txt"));
  const [second] = await observer.flush();
  assert.equal(second!.changeKind, "rename");
  assert.equal(second!.previousPath, "hop.txt");
  assert.equal(second!.path, "final.txt");
  assert.equal(second!.beforeHash, first!.afterHash, "rename chain links hash-to-hash across cycles");

  // Two hops inside ONE window: the intermediate name is the documented blind
  // spot; the endpoints must still collapse to a single truthful rename.
  await rename(join(repo, "final.txt"), join(repo, "mid.txt"));
  await rename(join(repo, "mid.txt"), join(repo, "dest.txt"));
  const collapsed = await observer.flush();
  assert.equal(collapsed.length, 1);
  assert.equal(collapsed[0]!.changeKind, "rename");
  assert.equal(collapsed[0]!.previousPath, "final.txt");
  assert.equal(collapsed[0]!.path, "dest.txt");
  assert.ok(collapsed[0]!.diff!.includes("rename from final.txt"));
  assert.ok(collapsed[0]!.diff!.includes("rename to dest.txt"));

  const snapshot = observer.snapshot();
  assert.equal(snapshot.get("dest.txt")?.hash, sha256(content));
  for (const gone of ["chain.txt", "hop.txt", "final.txt", "mid.txt"]) assert.equal(snapshot.has(gone), false);
});

/* ---------- S5: watcher survives a deleted watched subdirectory ---------- */

test("S5: deleting a watched subdirectory neither kills the watcher nor loses the deletes", async (t) => {
  const repo = await makeRepo(t, { "sub/one.txt": "one\n", "sub/two.txt": "two\n", "root.txt": "root\n" });
  // pollMs: 0 on purpose — if the watcher dies, NOTHING else can detect the
  // follow-up write, so waitFor failing here is a genuine watcher-death signal.
  const { observer, events, diagnostics } = await attach(t, repo, { watch: true, pollMs: 0, debounceMs: 30 });

  await rm(join(repo, "sub"), { recursive: true, force: true });
  await waitFor(() => events.filter((event) => event.changeKind === "delete").length >= 2);
  assert.deepEqual(
    events.filter((event) => event.changeKind === "delete").map((event) => event.path).sort(),
    ["sub/one.txt", "sub/two.txt"],
  );

  await writeFile(join(repo, "alive.txt"), "still watching\n");
  await waitFor(() => events.some((event) => event.path === "alive.txt"));
  const alive = events.find((event) => event.path === "alive.txt")!;
  assert.equal(alive.changeKind, "add");
  assert.equal(alive.detectedBy, "watch", "the follow-up must arrive via watch — poll is disabled");
  assert.equal(observer.degraded, false);
  assert.ok(diagnostics.every((diagnostic) => diagnostic.code !== "watch_unavailable"));
});

/* ---------- S6: pre-existing staged AND unstaged state (this repo's shape) ---------- */

test("S6: on a repo with staged AND unstaged pre-existing changes, only NEW mutations after start() are reported", async (t) => {
  const repo = await makeRepo(t, { "a.txt": "alpha v1\n", "b.txt": "beta v1\n", "gone.txt": "gone v1\n" });
  // Reproduce a mid-feature tree: staged modify + unstaged modify on top,
  // a staged new file, a loose untracked file, and a staged delete.
  await writeFile(join(repo, "a.txt"), "alpha staged\n");
  assert.equal(git(repo, "add", "a.txt").status, 0);
  await writeFile(join(repo, "a.txt"), "alpha worktree\n");
  await writeFile(join(repo, "staged-new.txt"), "staged new\n");
  assert.equal(git(repo, "add", "staged-new.txt").status, 0);
  await writeFile(join(repo, "untracked.txt"), "untracked\n");
  assert.equal(git(repo, "rm", "-q", "gone.txt").status, 0);
  const indexBefore = git(repo, "ls-files", "--stage").stdout;

  const { observer, events } = await attach(t, repo);
  assert.equal(observer.baselineRev, git(repo, "rev-parse", "HEAD").stdout.trim());
  assert.deepEqual(events, [], "start() never emits");
  assert.deepEqual(await observer.flush(), [], "pre-existing staged+unstaged dirt is the world as the run found it");

  // NEW mutations, one of each flavor of pre-existing state:
  await writeFile(join(repo, "a.txt"), "alpha v3\n"); // was staged+unstaged
  await writeFile(join(repo, "b.txt"), "beta v2\n"); // was clean
  await writeFile(join(repo, "gone.txt"), "resurrected\n"); // was staged-deleted (absent at start)
  await unlink(join(repo, "staged-new.txt")); // was staged-new
  await writeFile(join(repo, "untracked.txt"), "untracked v2\n"); // was untracked

  const emitted = await observer.flush();
  assert.deepEqual(emitted.map((event) => [event.path, event.changeKind]), [
    ["a.txt", "modify"],
    ["b.txt", "modify"],
    ["gone.txt", "add"],
    ["staged-new.txt", "delete"],
    ["untracked.txt", "modify"],
  ]);
  const byPath = new Map(emitted.map((event) => [event.path, event]));
  assert.equal(byPath.get("a.txt")!.beforeHash, sha256("alpha worktree\n"), "baseline is the WORKTREE at start — not the index, not HEAD");
  assert.equal(byPath.get("b.txt")!.beforeHash, sha256("beta v1\n"));
  assert.equal(byPath.get("gone.txt")!.beforeHash, null, "a file absent at start is an add, not a modify from HEAD");
  assert.equal(byPath.get("staged-new.txt")!.beforeHash, sha256("staged new\n"));
  assert.equal(byPath.get("staged-new.txt")!.afterHash, null);
  assert.equal(byPath.get("untracked.txt")!.beforeHash, sha256("untracked\n"));

  assert.equal(git(repo, "ls-files", "--stage").stdout, indexBefore, "the observer never touches the index");
});

/* ---------- S7: concurrent flush() ---------- */

test("S7: concurrent flush() calls partition events exactly once with a gapless global sequence", async (t) => {
  const repo = await makeRepo(t);
  const { observer, events } = await attach(t, repo);
  for (const name of ["d.txt", "b.txt", "a.txt", "c.txt", "e.txt"]) await writeFile(join(repo, name), `${name}\n`);

  const results = await Promise.all([observer.flush(), observer.flush(), observer.flush()]);
  const combined = results.flat();
  assert.equal(combined.length, 5, "no event is duplicated or dropped across concurrent flushes");
  assert.equal(events.length, 5);
  assert.deepEqual(
    combined.map((event) => event.sequence).sort((left, right) => left - right),
    [1, 2, 3, 4, 5],
    "each event belongs to exactly one flush result",
  );
  assert.deepEqual(events.map((event) => event.path), ["a.txt", "b.txt", "c.txt", "d.txt", "e.txt"]);

  assert.deepEqual(await Promise.all([observer.flush(), observer.flush()]), [[], []], "quiescent concurrent flushes settle empty");

  // A write racing two flushes is observed by exactly one of them.
  const firstFlush = observer.flush();
  await writeFile(join(repo, "late.txt"), "late\n");
  const secondFlush = observer.flush();
  const raced = (await Promise.all([firstFlush, secondFlush])).flat();
  assert.deepEqual(raced.map((event) => event.path), ["late.txt"]);
  assert.deepEqual(await observer.flush(), [], "converged after the race");
});

/* ---------- S8: stop() then further writes ---------- */

test("S8: after stop(), further writes produce no events, no unhandled rejections, and every entrypoint fails closed", async (t) => {
  const repo = await makeRepo(t);
  const { observer, events } = await attach(t, repo, { watch: true, pollMs: 25, debounceMs: 20 });
  await writeFile(join(repo, "live.txt"), "before stop\n");
  await waitFor(() => events.length >= 1);
  const seen = events.length;

  const rejections: unknown[] = [];
  const onRejection = (reason: unknown): void => { rejections.push(reason); };
  process.on("unhandledRejection", onRejection);
  t.after(() => { process.off("unhandledRejection", onRejection); });

  await observer.stop();
  await unlink(join(repo, "live.txt"));
  for (const name of ["post-1.txt", "post-2.txt", "post-3.txt"]) await writeFile(join(repo, name), "after stop\n");
  await writeFile(join(repo, "keep.txt"), "after stop too\n");
  await sleep(400); // several would-be poll intervals and debounce windows

  assert.equal(events.length, seen, "no events after stop()");
  assert.deepEqual(rejections, [], "no unhandled rejections from orphaned timers or watchers");
  await assert.rejects(() => observer.flush(), (error: unknown) => (error as WorkspaceObserverError).code === "not_started");
  assert.throws(() => observer.snapshot(), (error: unknown) => (error as WorkspaceObserverError).code === "not_started");
  await Promise.all([observer.stop(), observer.stop()]); // concurrent re-stop is idempotent
});

/* ---------- B1-B3: regression pins for real bugs found and fixed ---------- */

test("B1 (fixed bug): flush() during an in-flight start() fails closed instead of racing the baseline seed", async (t) => {
  // BUG: start() flipped `started = true` BEFORE seeding the baseline, so a
  // flush() racing start() ran a detection cycle against a half-seeded state
  // map — able to emit PRE-EXISTING dirty files as events (invariant 4
  // violation) and returning success before the observer was ready. Probed at
  // 15/15 rounds fail-open pre-fix. FIX: `started` flips only after the seed;
  // a mid-start flush now throws not_started deterministically.
  const files: Record<string, string> = {};
  for (let index = 0; index < 30; index += 1) files[`f${String(index).padStart(2, "0")}.txt`] = `committed ${index}\n`;
  const repo = await makeRepo(t, files);
  for (let index = 0; index < 30; index += 1) await writeFile(join(repo, `f${String(index).padStart(2, "0")}.txt`), `dirty ${index}\n`);

  const events: WorkspacePatchEvent[] = [];
  const observer = createWorkspaceObserver({ root: repo, watch: false, pollMs: 0, onPatch: (event) => events.push(event) });
  t.after(async () => { await observer.stop(); });

  const startPromise = observer.start();
  let startResolved = false;
  void startPromise.then(() => { startResolved = true; });
  // `started` flips with no await before start() resolves, and resolution
  // microtasks drain before the next macrotask — so post-fix, a flush() issued
  // while startResolved is false MUST throw. Pre-fix it was accepted mid-seed.
  while (!startResolved) {
    try {
      await observer.flush();
      assert.fail("flush() was accepted while start() was still seeding — the fail-open window is back");
    } catch (error) {
      if (error instanceof assert.AssertionError) throw error;
      assert.equal((error as WorkspaceObserverError).code, "not_started");
    }
    await new Promise((resolveTick) => setImmediate(resolveTick));
  }
  await startPromise;
  assert.equal(observer.stats.cycles, 0, "no detection cycle may run before start() completes");
  assert.deepEqual(events, [], "pre-existing dirty state must never leak as events");
  assert.deepEqual(await observer.flush(), [], "post-start flush confirms the seed absorbed the dirt");
});

test("B2 (fixed bug): stop() racing start() wins — start() must not resurrect the watcher and poll timer", async (t) => {
  // BUG: stop() during start()'s async phase was ignored: start() continued,
  // set started=true, and re-installed the watcher and poll timer AFTER stop()
  // had resolved — events flowed after stop and the watcher leaked. FIX:
  // start() re-checks `stopped` after seeding and tears itself down.
  const repo = await makeRepo(t);
  const events: WorkspacePatchEvent[] = [];
  const observer = createWorkspaceObserver({ root: repo, watch: true, pollMs: 20, debounceMs: 20, onPatch: (event) => events.push(event) });
  t.after(async () => { await observer.stop(); });

  const startPromise = observer.start();
  await observer.stop();
  await startPromise; // resolves quietly; the stop is honored

  await assert.rejects(() => observer.flush(), (error: unknown) => (error as WorkspaceObserverError).code === "not_started");
  await writeFile(join(repo, "after-stop.txt"), "must not be observed\n");
  await sleep(300); // many would-be poll intervals
  assert.deepEqual(events, [], "no watcher or timer survived the stop");
});

test("B3 (fixed bug): a second start() during an in-flight start() fails closed as already_started", async (t) => {
  // BUG: `started` flipped only late in start(), so two concurrent start()
  // calls both proceeded — two recursive watchers, two poll timers, and the
  // first shadow tree orphaned on disk. FIX: a synchronous `starting` latch
  // makes the second call throw before doing any work.
  const repo = await makeRepo(t);
  const events: WorkspacePatchEvent[] = [];
  const observer = createWorkspaceObserver({ root: repo, watch: false, pollMs: 0, onPatch: (event) => events.push(event) });
  t.after(async () => { await observer.stop(); });

  const firstStart = observer.start();
  await assert.rejects(() => observer.start(), (error: unknown) => (error as WorkspaceObserverError).code === "already_started");
  await firstStart;

  // The surviving observer is fully functional.
  await writeFile(join(repo, "solo.txt"), "one observer only\n");
  const emitted = await observer.flush();
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0]!.path, "solo.txt");
  assert.deepEqual(events, [...emitted]);
});
