import assert from "node:assert/strict";
import { test } from "node:test";
import type { WorkspaceObserver, WorkspaceObserverOptions, WorkspacePatchEvent } from "@musterhq/core";
import { WorkspaceObserverError } from "@musterhq/core";
import {
  countDiffStat,
  describeLiveDiffFailure,
  liveDiffPathLabel,
  renderLiveDiffCard,
  renderLiveDiffSummary,
  startLiveDiffFeed,
  LIVE_DIFF_MAX_LINES,
} from "../src/live-diff.js";
import { createNarrationPainter, routeEngineLine } from "../src/chat-tui.js";

function stripAnsi(value: string): string {
  return value.replace(/\x1b\[[0-9;]*m/g, "");
}

function plain(lines: readonly string[]): string[] {
  return lines.map(stripAnsi);
}

let nextSequence = 0;

function patchEvent(overrides: Partial<WorkspacePatchEvent> = {}): WorkspacePatchEvent {
  nextSequence += 1;
  return {
    schemaVersion: 1,
    source: "observer",
    sequence: nextSequence,
    atIso: "2026-08-27T10:00:00.086Z",
    observerId: "observer-1",
    root: "/repo",
    path: "src/run.ts",
    changeKind: "modify",
    beforeHash: "sha256:before",
    afterHash: "sha256:after",
    bytesBefore: 10,
    bytesAfter: 12,
    modeBefore: 100644,
    modeAfter: 100644,
    binary: false,
    diff: null,
    diffHash: null,
    diffContextLines: 3,
    detectedBy: "watch",
    receiptHash: "sha256:d3b9c1a2f0e4aa71",
    idempotencyKey: "key",
    ...overrides,
  };
}

const MODIFY_DIFF = [
  "diff --git a/src/run.ts b/src/run.ts",
  "index 1111111..2222222 100644",
  "--- a/src/run.ts",
  "+++ b/src/run.ts",
  "@@ -1,4 +1,5 @@",
  " const before = 1;",
  "-const removed = 2;",
  "+const added = 2;",
  "+const alsoAdded = 3;",
  " const after = 4;",
  "",
].join("\n");

test("a modify card renders header, stat, latency, and colored hunk lines", () => {
  const card = renderLiveDiffCard(patchEvent({ diff: MODIFY_DIFF }), { color: true, elapsedMs: 86 });

  assert.deepEqual(plain(card), [
    "⏺ Edit(src/run.ts)",
    "  ⎿ +2 −1 · 86ms · receipt d3b9c1a2…",
    "    @@ -1,4 +1,5 @@",
    "     1   const before = 1;",
    "     2 - const removed = 2;",
    "     2 + const added = 2;",
    "     3 + const alsoAdded = 3;",
    "     4   const after = 4;",
  ]);

  assert.match(card[0], /\x1b\[38;2;217;119;87m⏺/, "modify uses the coral action glyph");
  assert.match(card[2], /\x1b\[38;2;217;119;87m@@/, "hunk headers use the coral accent");
  assert.match(card[4], /\x1b\[38;2;255;107;122m- const removed/, "deletions are red");
  assert.match(card[5], /\x1b\[38;2;138;154;91m\+ const added/, "additions use the restrained diff green");
});

test("cards drop the diff preamble and never leak ANSI when color is off", () => {
  const card = renderLiveDiffCard(patchEvent({ diff: MODIFY_DIFF }), { color: false, elapsedMs: 12 });
  const joined = card.join("\n");
  assert.equal(joined, stripAnsi(joined));
  assert.ok(!joined.includes("diff --git"), "the header already names the file");
  assert.ok(!joined.includes("index 1111111"));
  assert.ok(!joined.includes("+++ b/src/run.ts"));
});

test("an add card marks the file green and counts only real additions", () => {
  const diff = [
    "diff --git a/notes.md b/notes.md",
    "new file mode 100644",
    "--- /dev/null",
    "+++ b/notes.md",
    "@@ -0,0 +1,2 @@",
    "+first",
    "+second",
  ].join("\n");
  const card = renderLiveDiffCard(patchEvent({ path: "notes.md", changeKind: "add", diff }), { color: false, elapsedMs: 5 });

  assert.deepEqual(card, [
    "⏺ Create(notes.md)",
    "  ⎿ +2 −0 · 5ms · receipt d3b9c1a2…",
    "    @@ -0,0 +1,2 @@",
    "     1 + first",
    "     2 + second",
  ]);
  assert.match(renderLiveDiffCard(patchEvent({ changeKind: "add", diff }), { color: true })[0], /\x1b\[38;2;138;154;91m⏺/);
});

test("renames show old → new even when the diff carries no hunks", () => {
  const event = patchEvent({
    changeKind: "rename",
    path: "src/renamed.ts",
    previousPath: "src/run.ts",
    diff: ["diff --git a/src/run.ts b/src/renamed.ts", "similarity index 100%", "rename from src/run.ts", "rename to src/renamed.ts", ""].join("\n"),
  });

  assert.equal(liveDiffPathLabel(event), "src/run.ts → src/renamed.ts");
  assert.deepEqual(renderLiveDiffCard(event, { color: false, elapsedMs: 40 }), [
    "⏺ Rename(src/run.ts → src/renamed.ts)",
    "  ⎿ +0 −0 · 40ms · receipt d3b9c1a2…",
    "    rename from src/run.ts",
    "    rename to src/renamed.ts",
  ]);
});

test("long diffs truncate at 40 hunk lines with a remainder notice", () => {
  const hunk = ["@@ -1,60 +1,60 @@", ...Array.from({ length: 59 }, (_, index) => `+line ${index + 1}`)];
  const diff = ["diff --git a/big.ts b/big.ts", "--- a/big.ts", "+++ b/big.ts", ...hunk].join("\n");
  const card = renderLiveDiffCard(patchEvent({ path: "big.ts", diff }), { color: false, elapsedMs: 100 });

  // action + result + 40 body lines + truncation notice
  assert.equal(card.length, LIVE_DIFF_MAX_LINES + 3);
  assert.equal(card[0], "⏺ Edit(big.ts)");
  assert.equal(card[1], "  ⎿ +59 −0 · 100ms · receipt d3b9c1a2…");
  assert.equal(card[2], "    @@ -1,60 +1,60 @@");
  assert.equal(card[LIVE_DIFF_MAX_LINES + 1], "    39 + line 39");
  assert.equal(card.at(-1), "    … +20 lines");
  assert.ok(!card.some((line) => line.includes("line 40")), "truncated lines stay hidden");
});

test("a smaller truncation budget is honored", () => {
  const diff = ["@@ -1,5 +1,5 @@", "+a", "+b", "+c", "+d"].join("\n");
  const card = renderLiveDiffCard(patchEvent({ diff }), { color: false, maxLines: 3, elapsedMs: 1 });
  assert.deepEqual(card, ["⏺ Edit(src/run.ts)", "  ⎿ +4 −0 · 1ms · receipt d3b9c1a2…", "    @@ -1,5 +1,5 @@", "     1 + a", "     2 + b", "    … +2 lines"]);
});

test("an omitted diff still produces an auditable card", () => {
  const card = renderLiveDiffCard(patchEvent({ path: "logo.png", binary: true, diff: null, diffOmitted: "binary" }), { color: false, elapsedMs: 9 });
  assert.deepEqual(card, ["⏺ Edit(logo.png)", "  ⎿ +0 −0 · binary · 9ms · receipt d3b9c1a2…", "    diff omitted: binary"]);

  const secret = renderLiveDiffCard(patchEvent({ path: ".env", diff: null, diffOmitted: "redacted_path" }), { color: false });
  assert.deepEqual(secret, ["⏺ Edit(.env)", "  ⎿ +0 −0 · receipt d3b9c1a2…", "    diff omitted: redacted_path"]);
});

test("countDiffStat ignores unified-diff file headers", () => {
  assert.deepEqual(countDiffStat(MODIFY_DIFF), { additions: 2, deletions: 1 });
  assert.deepEqual(countDiffStat(null), { additions: 0, deletions: 0 });
  assert.deepEqual(countDiffStat("--- a/x\n+++ b/x\n@@ -1 +1 @@\n-one\n+two"), { additions: 1, deletions: 1 });
});

test("the turn summary totals files and both signs", () => {
  assert.equal(stripAnsi(renderLiveDiffSummary({ files: 3, additions: 12, deletions: 4 })), "▸ 3 files changed · +12 −4");
  assert.equal(renderLiveDiffSummary({ files: 1, additions: 0, deletions: 7 }, { color: false }), "▸ 1 file changed · +0 −7");
});

/* ---------- feed behavior ---------- */

interface FakeObserverControl {
  readonly observer: WorkspaceObserver;
  readonly options: WorkspaceObserverOptions;
  readonly calls: string[];
}

function fakeObserver(behavior: {
  startError?: unknown;
  onFlush?: (emit: (event: WorkspacePatchEvent) => void) => void;
} = {}): { create: (options: WorkspaceObserverOptions) => WorkspaceObserver; control: () => FakeObserverControl } {
  let captured: WorkspaceObserverOptions | undefined;
  let observer: WorkspaceObserver | undefined;
  const calls: string[] = [];
  const create = (options: WorkspaceObserverOptions): WorkspaceObserver => {
    captured = options;
    observer = {
      async start() {
        calls.push("start");
        if (behavior.startError) throw behavior.startError;
      },
      async stop() {
        calls.push("stop");
      },
      async flush() {
        calls.push("flush");
        behavior.onFlush?.(options.onPatch);
        return [];
      },
      root: "/repo",
      scope: "",
      baselineRev: "rev",
      sequence: 0,
      degraded: false,
      stats: { cycles: 0, watchTriggers: 0, pollTriggers: 0, gitSpawns: 0, lastCycleMs: 0, eventsEmitted: 0 },
      snapshot: () => new Map(),
    } as WorkspaceObserver;
    return observer;
  };
  return { create, control: () => ({ observer: observer!, options: captured!, calls }) };
}

test("the feed streams cards live and closes with a summary", async () => {
  const lines: string[] = [];
  const fake = fakeObserver({
    onFlush: (emit) => emit(patchEvent({ path: "late.ts", changeKind: "add", atIso: "2026-08-27T10:00:00.400Z", diff: "@@ -0,0 +1 @@\n+late" })),
  });
  const feed = await startLiveDiffFeed({
    cwd: "/repo",
    emit: (line) => lines.push(line),
    color: false,
    now: () => Date.parse("2026-08-27T10:00:00.000Z"),
    createObserver: fake.create,
  });

  assert.equal(feed.active, true);
  assert.deepEqual(lines, [], "attaching the observer prints nothing");

  fake.control().options.onPatch(patchEvent({ diff: MODIFY_DIFF }));
  assert.deepEqual(lines, [
    "⏺ Edit(src/run.ts)",
    "  ⎿ +2 −1 · 86ms · receipt d3b9c1a2…",
    "    @@ -1,4 +1,5 @@",
    "     1   const before = 1;",
    "     2 - const removed = 2;",
    "     2 + const added = 2;",
    "     3 + const alsoAdded = 3;",
    "     4   const after = 4;",
  ], "cards land during the turn, not after it");

  const totals = await feed.finish();
  assert.deepEqual(totals, { files: 2, additions: 3, deletions: 1 });
  assert.deepEqual(lines.slice(-7), ["⏺ Create(late.ts)", "  ⎿ +1 −0 · 400ms · receipt d3b9c1a2…", "    @@ -0,0 +1 @@", "     1 + late", "▸ 2 files changed · +3 −1", "    src/run.ts  +2 −1", "    late.ts     +1 −0"]);
  assert.deepEqual(fake.control().calls, ["start", "flush", "stop"], "flush precedes stop so tail edits still render");
});

test("the feed fans each observer event to Canvas without letting that consumer interfere", async () => {
  const fake = fakeObserver();
  const canvas: WorkspacePatchEvent[] = [];
  const lines: string[] = [];
  await startLiveDiffFeed({
    cwd: "/repo",
    emit: (line) => lines.push(line),
    color: false,
    createObserver: fake.create,
    onPatch: (event) => {
      canvas.push(event);
      throw new Error("Canvas repaint failed");
    },
  });
  const observed = patchEvent({ diff: MODIFY_DIFF });
  fake.control().options.onPatch(observed);
  assert.deepEqual(canvas, [observed]);
  assert.match(lines.join("\n"), /Edit\(src\/run\.ts\)/, "normal transcript card survives Canvas failure");
});

test("a quiet turn stops the observer without printing a summary", async () => {
  const lines: string[] = [];
  const fake = fakeObserver();
  const feed = await startLiveDiffFeed({ cwd: "/repo", emit: (line) => lines.push(line), color: false, createObserver: fake.create });

  assert.deepEqual(await feed.finish(), { files: 0, additions: 0, deletions: 0 });
  assert.deepEqual(lines, []);
  assert.deepEqual(fake.control().calls, ["start", "flush", "stop"]);
});

test("a non-git cwd degrades to one dim notice and an inert feed", async () => {
  const lines: string[] = [];
  const fake = fakeObserver({ startError: new WorkspaceObserverError("not_a_git_repository", "Not a git repository: /tmp/scratch") });
  const feed = await startLiveDiffFeed({ cwd: "/tmp/scratch", emit: (line) => lines.push(line), color: false, createObserver: fake.create });

  assert.equal(feed.active, false);
  assert.deepEqual(lines, ["live diff off: not a git repository"]);
  assert.deepEqual(await feed.finish(), { files: 0, additions: 0, deletions: 0 });
  assert.deepEqual(lines, ["live diff off: not a git repository"], "the notice is printed once, never repeated");
});

test("observer construction failures and missing git degrade the same way", async () => {
  const lines: string[] = [];
  const exploding = await startLiveDiffFeed({
    cwd: "/repo",
    emit: (line) => lines.push(line),
    color: false,
    createObserver: () => {
      throw new Error("boom");
    },
  });
  assert.equal(exploding.active, false);
  assert.deepEqual(lines, ["live diff off: boom"]);

  assert.equal(describeLiveDiffFailure(new WorkspaceObserverError("git_unavailable", "spawn git ENOENT")), "git is unavailable");
  assert.equal(describeLiveDiffFailure("weird"), "workspace observer unavailable");
});

test("disabling the feed is silent and never touches the observer", async () => {
  const lines: string[] = [];
  let created = false;
  const feed = await startLiveDiffFeed({
    cwd: "/repo",
    enabled: false,
    emit: (line) => lines.push(line),
    createObserver: () => {
      created = true;
      throw new Error("must not be constructed");
    },
  });

  assert.equal(feed.active, false);
  assert.equal(created, false);
  assert.deepEqual(await feed.finish(), { files: 0, additions: 0, deletions: 0 });
  assert.deepEqual(lines, [], "an explicit opt-out prints nothing at all");
});

test("a throwing sink cannot break the turn", async () => {
  const fake = fakeObserver();
  const feed = await startLiveDiffFeed({
    cwd: "/repo",
    emit: () => {
      throw new Error("sink exploded");
    },
    color: false,
    createObserver: fake.create,
  });

  fake.control().options.onPatch(patchEvent({ diff: MODIFY_DIFF }));
  assert.deepEqual(await feed.finish(), { files: 1, additions: 2, deletions: 1 });
});

test("patches arriving after finish are ignored", async () => {
  const lines: string[] = [];
  const fake = fakeObserver();
  const feed = await startLiveDiffFeed({ cwd: "/repo", emit: (line) => lines.push(line), color: false, createObserver: fake.create });
  fake.control().options.onPatch(patchEvent({ diff: MODIFY_DIFF }));
  const before = lines.length;
  await feed.finish();

  fake.control().options.onPatch(patchEvent({ path: "stray.ts", diff: MODIFY_DIFF }));
  assert.equal(lines.length, before + 1, "only the summary is appended after the turn closes");
  assert.equal(lines.at(-1), "▸ 1 file changed · +2 −1");
});

test("live diff cards survive the TUI render gate and interleave with streamed narration", async () => {
  // The transcript renders typed events only, so every line the diff feed
  // emits must classify as transcript content — never as a diagnostic, a
  // spinner frame, or a run record it would be filtered into.
  const transcript: string[] = [];
  const fake = fakeObserver();
  const painter = createNarrationPainter({
    emit: (line) => transcript.push(line),
    minChars: 16,
    maxChars: 96,
  });
  const feed = await startLiveDiffFeed({
    cwd: "/repo",
    color: false,
    createObserver: fake.create,
    emit: (line) => {
      const route = routeEngineLine(line);
      assert.equal(route.kind, "transcript", `diff line must stay in the transcript: ${line}`);
      transcript.push(line);
    },
  });

  painter.delta("Rewriting the bearer-token lookup now.\n");
  fake.control().options.onPatch(patchEvent({ diff: MODIFY_DIFF }));
  painter.delta("Done — the helper handles the missing-token case.\n");
  painter.finish();
  await feed.finish();

  const rendered = plain(transcript);
  const narrationAt = rendered.findIndex((line) => line.includes("Rewriting the bearer-token"));
  const cardAt = rendered.findIndex((line) => line.includes("src/run.ts"));
  const closingAt = rendered.findIndex((line) => line.includes("missing-token case"));
  assert.ok(narrationAt >= 0 && cardAt >= 0 && closingAt >= 0, "narration and diff card both painted");
  assert.ok(narrationAt < cardAt && cardAt < closingAt, "events paint in arrival order");
  assert.equal(rendered.some((line) => line.includes("working")), false, "no spinner frame in scrollback");
});

test("the feed never renders the harness's own .muster bookkeeping", async () => {
  // Live-proven 2026-08-27: a project-local `.muster/data/tokens.jsonl` card
  // painted the raw `{"runId"…}` ledger line into the transcript and inflated
  // the summary to 8 files when the model edited two.
  const lines: string[] = [];
  const fake = fakeObserver({
    onFlush: (emit) => {
      emit(patchEvent({ path: ".muster/data/memory.db", changeKind: "modify", diff: null }));
      emit(patchEvent({ path: "test.js", changeKind: "modify", atIso: "2026-08-27T10:00:00.500Z", diff: "@@ -1 +1,2 @@\n one\n+two" }));
    },
  });
  const feed = await startLiveDiffFeed({
    cwd: "/repo",
    emit: (line) => lines.push(line),
    color: false,
    now: () => Date.parse("2026-08-27T10:00:00.000Z"),
    createObserver: fake.create,
  });

  const emitPatch = fake.control().options.onPatch;
  emitPatch(patchEvent({
    path: ".muster/data/tokens.jsonl",
    changeKind: "modify",
    diff: '@@ -1,2 +1,3 @@\n {"runId":"old"}\n+{"runId":"2b06bc47","inputTokens":28449,"outputTokens":224}',
  }));
  assert.deepEqual(lines, [], "the token ledger never becomes a card");

  emitPatch(patchEvent({ path: "server.js", diff: "@@ -1 +1,2 @@\n a\n+b" }));
  const totals = await feed.finish();

  assert.equal(lines.some((line) => line.includes("runId")), false, "no run-record JSON leaks via the diff feed");
  assert.equal(lines.some((line) => line.includes(".muster")), false, "no harness-internal path is shown");
  assert.deepEqual(totals, { files: 2, additions: 2, deletions: 0 }, "totals count only the user's files");
  assert.deepEqual(lines.slice(-3), ["▸ 2 files changed · +2 −0", "    server.js  +1 −0", "    test.js    +1 −0"]);
});

test("the real observer is constructed with the .muster ignore merged over caller options", async () => {
  const fake = fakeObserver();
  await startLiveDiffFeed({
    cwd: "/repo",
    emit: () => {},
    color: false,
    createObserver: fake.create,
    observerOptions: { ignore: ["vendor"] },
  });
  const ignore = fake.control().options.ignore as (relPath: string) => boolean;
  assert.equal(typeof ignore, "function");
  assert.equal(ignore(".muster/data/tokens.jsonl"), true, "internal paths stay ignored");
  assert.equal(ignore("vendor/lib.js"), true, "caller list ignores still apply");
  assert.equal(ignore("__pycache__/a.pyc"), true, "build artifacts are ignored");
  assert.equal(ignore("src/vendor.ts"), false, "ordinary files are observed");

  const fnFake = fakeObserver();
  await startLiveDiffFeed({
    cwd: "/repo",
    emit: () => {},
    color: false,
    createObserver: fnFake.create,
    observerOptions: { ignore: (relPath) => relPath === "generated/api.ts" },
  });
  const merged = fnFake.control().options.ignore;
  assert.equal(typeof merged, "function");
  const matcher = merged as (relPath: string) => boolean;
  assert.equal(matcher(".muster/data/tokens.jsonl"), true, "internal paths stay ignored");
  assert.equal(matcher("generated/api.ts"), true, "caller ignores still apply");
  assert.equal(matcher("src/run.ts"), false);

  const rename = patchEvent({ path: "src/new.ts", previousPath: ".muster/old.ts", changeKind: "rename", diff: null });
  const renameLines: string[] = [];
  const renameFake = fakeObserver();
  const renameFeed = await startLiveDiffFeed({ cwd: "/repo", emit: (line) => renameLines.push(line), color: false, createObserver: renameFake.create });
  renameFake.control().options.onPatch(rename);
  await renameFeed.finish();
  assert.deepEqual(renameLines, [], "a rename out of .muster is still harness-internal");
});

// Spec: MUS-SPEC-01-1E (docs/spec/clauses/01-chat-transcript.md#mus-spec-01-1e--build-artifacts-are-not-reported-as-the-agents-edits)
test("live diff feed skips build artifacts even without a .gitignore", async () => {
  const lines: string[] = [];
  const fake = fakeObserver({
    onFlush: (emit) => {
      emit(patchEvent({ path: "calc.py", diff: "@@ -1,2 +1,2 @@\n def add(a, b):\n-    return a - b\n+    return a + b" }));
      emit(patchEvent({ path: "__pycache__/calc.cpython-314.pyc", changeKind: "add", binary: true }));
      emit(patchEvent({ path: "pkg/mod.pyc", changeKind: "add", binary: true }));
      emit(patchEvent({ path: ".pytest_cache/v/cache/nodeids", changeKind: "add", diff: "@@ -0,0 +1 @@\n+[]" }));
      emit(patchEvent({ path: "web/node_modules/x/index.js", changeKind: "add", diff: "@@ -0,0 +1 @@\n+x" }));
    },
  });
  const feed = await startLiveDiffFeed({ cwd: "/repo", emit: (line) => lines.push(line), color: false, createObserver: fake.create });
  const totals = await feed.finish();
  const text = plain(lines).join("\n");
  assert.equal(totals.files, 1);
  assert.match(text, /Edit\(calc\.py\)/);
  assert.doesNotMatch(text, /pycache|\.pyc|pytest_cache|node_modules/);
  assert.match(text, /1 file changed/);
});

// Spec: MUS-SPEC-01-4A (docs/spec/clauses/01-chat-transcript.md#mus-spec-01-4a--diff-cards-show-line-numbers)
// Protected: the inline diff stays complete — every hunk row is still shown, now with its line number.
test("diff cards number every row from the hunk header", () => {
  const card = renderLiveDiffCard(patchEvent({
    path: "src/run.ts",
    diff: "@@ -9,4 +9,5 @@\n const before = 1;\n-const removed = 2;\n+const added = 2;\n+const alsoAdded = 3;\n const after = 4;",
  }), { color: false });
  assert.deepEqual(card.slice(2), [
    "    @@ -9,4 +9,5 @@",
    "     9   const before = 1;",
    "    10 - const removed = 2;",
    "    10 + const added = 2;",
    "    11 + const alsoAdded = 3;",
    "    12   const after = 4;",
  ]);
});

// Spec: MUS-SPEC-01-5A (docs/spec/clauses/01-chat-transcript.md#mus-spec-01-5a--a-multi-file-turn-ends-with-a-per-file-summary)
test("a multi-file turn ends with one row per file under the summary", async () => {
  const lines: string[] = [];
  const fake = fakeObserver({
    onFlush: (emit) => {
      emit(patchEvent({ path: "src/a.ts", diff: "@@ -1,2 +1,3 @@\n-x\n+y\n+z" }));
      emit(patchEvent({ path: "README.md", diff: "@@ -1,0 +2 @@\n+more" }));
      emit(patchEvent({ path: "test/a.test.ts", changeKind: "add", diff: "@@ -0,0 +1,5 @@\n+1\n+2\n+3\n+4\n+5" }));
    },
  });
  const feed = await startLiveDiffFeed({ cwd: "/repo", emit: (line) => lines.push(line), color: false, createObserver: fake.create });
  await feed.finish();
  const summary = lines.indexOf("▸ 3 files changed · +8 −1");
  assert.ok(summary >= 0, lines.join("\n"));
  assert.deepEqual(lines.slice(summary + 1), [
    "    src/a.ts        +2 −1",
    "    README.md       +1 −0",
    "    test/a.test.ts  +5 −0",
  ]);

  const single: string[] = [];
  const one = fakeObserver({ onFlush: (emit) => emit(patchEvent({ path: "x.ts", diff: "@@ -1 +1 @@\n-a\n+b" })) });
  await (await startLiveDiffFeed({ cwd: "/repo", emit: (line) => single.push(line), color: false, createObserver: one.create })).finish();
  assert.equal(single.at(-1), "▸ 1 file changed · +1 −1", "one file keeps just the summary");

  const many: string[] = [];
  const lots = fakeObserver({ onFlush: (emit) => { for (let index = 1; index <= 11; index += 1) emit(patchEvent({ path: `f${index}.ts`, diff: "@@ -1 +1 @@\n-a\n+b" })); } });
  await (await startLiveDiffFeed({ cwd: "/repo", emit: (line) => many.push(line), color: false, createObserver: lots.create })).finish();
  const tail = many.slice(many.indexOf("▸ 11 files changed · +11 −11") + 1);
  assert.equal(tail.length, 9);
  assert.equal(tail.at(-1), "    … +3 more files");
});
