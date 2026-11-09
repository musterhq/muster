import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { ensureDefaultConfig } from "@musterhq/core";
import { createMusterChatHarness, type MusterChatHarness } from "../src/chat-tui.js";

const execFileAsync = promisify(execFile);
const cliPath = resolve(import.meta.dirname, "..", "src", "index.ts");
const plain = (rows: readonly string[]) => rows.map((row) => row.replace(/\x1b\[[0-9;]*m/g, ""));
const tick = () => new Promise((resolveTick) => setImmediate(resolveTick));
const KEY = { right: "\x1b[C", left: "\x1b[D", up: "\x1b[A", down: "\x1b[B", enter: "\r", esc: "\x1b", tab: "\t", space: " " };

interface Workspace {
  readonly cwd: string;
  readonly home: string;
  readonly env: NodeJS.ProcessEnv;
  readonly project: string;
  readonly global: string;
  cleanup(): Promise<void>;
}

async function workspace(): Promise<Workspace> {
  const cwd = realpathSync(await mkdtemp(join(tmpdir(), "muster-settings-cli-")));
  const home = realpathSync(await mkdtemp(join(tmpdir(), "muster-settings-home-")));
  const env = { ...process.env, MUSTER_CONFIG_HOME: home, MUSTER_ONBOARDING_HOME: join(cwd, ".test-home"), MUSTER_SKIP_ONBOARDING: "1", NO_COLOR: "1" };
  delete (env as Record<string, string | undefined>).FORCE_COLOR;
  return {
    cwd,
    home,
    env,
    project: join(cwd, ".muster", "config.json"),
    global: join(home, "config.json"),
    async cleanup() {
      await rm(cwd, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    },
  };
}

async function muster(ws: Workspace, args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const { stdout, stderr } = await execFileAsync("tsx", [cliPath, ...args], { cwd: ws.cwd, env: ws.env, timeout: 60_000 });
    return { stdout, stderr, code: 0 };
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; code?: number };
    return { stdout: failure.stdout ?? "", stderr: failure.stderr ?? "", code: failure.code ?? 1 };
  }
}

const readJson = (path: string) => JSON.parse(readFileSync(path, "utf8")) as Record<string, any>;

// Spec: MUS-SPEC-14-2A (docs/spec/clauses/14-settings.md#mus-spec-14-2a--muster-config-lists-gets-sets-resets-and-locates-settings)
test("muster config path, set, get, list, list --json and reset work against the config files", { timeout: 180_000 }, async () => {
  const ws = await workspace();
  try {
    await muster(ws, ["init"]);
    const path = await muster(ws, ["config", "path"]);
    assert.match(path.stdout, new RegExp(`project\\s+${ws.project.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    assert.match(path.stdout, new RegExp(`global\\s+${ws.global.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));

    const set = await muster(ws, ["config", "set", "chat.access", "ask"]);
    assert.equal(set.code, 0, set.stderr);
    assert.match(set.stdout, /Saved chat\.access → ask · project/);
    assert.equal(readJson(ws.project).chat.access, "ask");
    assert.equal((await muster(ws, ["config", "get", "chat.access"])).stdout.trim(), "ask");

    const list = (await muster(ws, ["config", "list"])).stdout;
    assert.match(list, /• chat\.access\s+ask\s+project/);
    assert.match(list, /  chat\.speed\s+session\s+default/);

    const json = JSON.parse((await muster(ws, ["config", "list", "--json"])).stdout) as Array<Record<string, unknown>>;
    const access = json.find((row) => row.key === "chat.access")!;
    assert.equal(access.value, "ask");
    assert.equal(access.default, "auto-edit");
    assert.equal(access.source, "project");
    assert.deepEqual((access.options as Array<{ value: string }>).map((option) => option.value), ["read-only", "ask", "auto-edit", "full"]);

    const reset = await muster(ws, ["config", "reset", "chat.access"]);
    assert.equal(reset.code, 0, reset.stderr);
    assert.equal((await muster(ws, ["config", "get", "chat.access"])).stdout.trim(), "auto-edit");
    assert.equal(readJson(ws.project).chat?.access, undefined);
  } finally {
    await ws.cleanup();
  }
});

// Spec: MUS-SPEC-14-2B (docs/spec/clauses/14-settings.md#mus-spec-14-2b--bad-values-and-unknown-keys-fail-with-the-allowed-values-validate-checks-hand-edits)
test("bad values and unknown keys fail naming the allowed values and validate catches hand edits", { timeout: 180_000 }, async () => {
  const ws = await workspace();
  try {
    await muster(ws, ["init"]);
    const before = readFileSync(ws.project, "utf8");
    const bad = await muster(ws, ["config", "set", "chat.access", "yolo"]);
    assert.notEqual(bad.code, 0);
    assert.match(bad.stderr, /read-only, ask, auto-edit, full/);
    assert.equal(readFileSync(ws.project, "utf8"), before);

    const unknown = await muster(ws, ["config", "get", "chat.nope"]);
    assert.notEqual(unknown.code, 0);
    assert.match(unknown.stderr, /Unknown setting chat\.nope/);

    writeFileSync(ws.project, JSON.stringify({ ...readJson(ws.project), chat: { liveDiff: "maybe" } }, null, 2));
    const invalid = await muster(ws, ["config", "validate"]);
    assert.notEqual(invalid.code, 0);
    assert.match(invalid.stdout + invalid.stderr, /chat\.liveDiff.*true, false/);

    writeFileSync(ws.project, JSON.stringify({ ...readJson(ws.project), chat: { liveDiff: false } }, null, 2));
    const valid = await muster(ws, ["config", "validate"]);
    assert.equal(valid.code, 0, valid.stdout + valid.stderr);
    assert.match(valid.stdout, /valid/i);
  } finally {
    await ws.cleanup();
  }
});

// Spec: MUS-SPEC-14-3A (docs/spec/clauses/14-settings.md#mus-spec-14-3a--chat-starts-from-the-configured-defaults-flags-and-slash-commands-still-win-per-session)
test("chat starts from the configured access, speed, live-diff and reasoning defaults and --access still overrides", { timeout: 240_000 }, async () => {
  const ws = await workspace();
  try {
    await muster(ws, ["init"]);
    for (const [key, value] of [["chat.access", "ask"], ["chat.speed", "fast"], ["chat.liveDiff", "false"], ["chat.reasoningMode", "full"]]) {
      const result = await muster(ws, ["config", "set", key!, value!]);
      assert.equal(result.code, 0, result.stderr);
    }
    const menu = async (extra: string[]) => {
      const { stdout } = await muster(ws, ["chat", ...extra, "--complete", "/", "--describe"]);
      return new Map(stdout.split("\n").map((line) => line.split("\t")).map(([value, , description]) => [value ?? "", description ?? ""]));
    };
    const rows = await menu([]);
    assert.match(rows.get("/access") ?? "", /^ask\b/);
    assert.match(rows.get("/speed") ?? "", /^fast\b/);
    assert.match(rows.get("/live-diff") ?? "", /^off\b/);
    assert.match(rows.get("/reasoning") ?? "", /summaries full/);
    const flagged = await menu(["--access", "full"]);
    assert.match(flagged.get("/access") ?? "", /^full\b/);
    assert.match(flagged.get("/speed") ?? "", /^fast\b/);
  } finally {
    await ws.cleanup();
  }
});

async function openPanel(ws: Workspace, changes: string[] = []): Promise<{ chat: MusterChatHarness; closed: () => boolean }> {
  let closed = false;
  const chat = createMusterChatHarness({
    width: 110,
    rows: 34,
    onSubmit: async (text, sink) => {
      if (text === "/settings") {
        void sink.openSettings({ cwd: ws.cwd, onChange: (change) => changes.push(`${change.key}=${String(change.value)}@${change.scope}`) }).then(() => { closed = true; });
      }
      return true;
    },
  });
  chat.type("/settings");
  await chat.submit();
  await tick();
  return { chat, closed: () => closed };
}

// Spec: MUS-SPEC-14-4A (docs/spec/clauses/14-settings.md#mus-spec-14-4a--settings-opens-a-tabbed-panel-an-enum-change-saves-immediately-with-a-toast)
test("/settings shows tabs and descriptions and an enum pick saves to the project file with a toast", { timeout: 30_000 }, async () => {
  const ws = await workspace();
  const previous = process.env.MUSTER_CONFIG_HOME;
  process.env.MUSTER_CONFIG_HOME = ws.home;
  try {
    await ensureDefaultConfig(ws.cwd);
    const changes: string[] = [];
    const { chat } = await openPanel(ws, changes);
    let screen = plain(chat.visible()).join("\n");
    for (const tab of ["Models", "Permissions", "Appearance", "Memory"]) assert.match(screen, new RegExp(tab));
    assert.match(screen, /Default model/);

    chat.input(KEY.right);
    screen = plain(chat.visible()).join("\n");
    assert.match(screen, /Access\s+auto-edit/);
    assert.match(screen, /How much a turn may do without asking/);

    chat.input(KEY.enter);
    screen = plain(chat.visible()).join("\n");
    for (const option of ["read-only", "ask", "auto-edit", "full"]) assert.match(screen, new RegExp(`\\b${option}\\b`));
    assert.match(screen, /asks before commands and edits/);
    assert.match(screen, /no sandbox and never asks/);

    chat.input(KEY.up);
    chat.input(KEY.enter);
    assert.equal(readJson(ws.project).chat.access, "ask");
    const rows = plain(chat.visible());
    assert.ok(rows.some((row) => /Saved chat\.access → ask · project/.test(row)), rows.join("\n"));
    assert.ok(rows.some((row) => /•\s*Access\s+ask/.test(row)), rows.join("\n"));
    assert.deepEqual(changes, ["chat.access=ask@project"]);
  } finally {
    if (previous === undefined) delete process.env.MUSTER_CONFIG_HOME;
    else process.env.MUSTER_CONFIG_HOME = previous;
    await ws.cleanup();
  }
});

// Spec: MUS-SPEC-14-4B (docs/spec/clauses/14-settings.md#mus-spec-14-4b--typing-searches-every-tab-space-toggles-a-boolean-esc-backs-out-one-level)
test("typing searches across tabs with counts, Space toggles a boolean and Esc backs out a level at a time", { timeout: 30_000 }, async () => {
  const ws = await workspace();
  const previous = process.env.MUSTER_CONFIG_HOME;
  process.env.MUSTER_CONFIG_HOME = ws.home;
  try {
    await ensureDefaultConfig(ws.cwd);
    const { chat, closed } = await openPanel(ws);
    chat.type("diff");
    let screen = plain(chat.visible()).join("\n");
    assert.match(screen, /Appearance \(1\)/);
    assert.match(screen, /Live diff\s+on/);
    assert.doesNotMatch(screen, /Default model/);

    chat.input(KEY.space);
    assert.equal(readJson(ws.project).chat.liveDiff, false);
    screen = plain(chat.visible()).join("\n");
    assert.match(screen, /Saved chat\.liveDiff → off · project/);

    chat.input(KEY.esc);
    screen = plain(chat.visible()).join("\n");
    assert.doesNotMatch(screen, /\(1\)/);
    assert.match(screen, /Default model/);
    assert.equal(closed(), false);

    chat.input(KEY.esc);
    await tick();
    assert.equal(closed(), true);
    assert.ok(plain(chat.visible()).some((row) => row.startsWith("❯")));
  } finally {
    if (previous === undefined) delete process.env.MUSTER_CONFIG_HOME;
    else process.env.MUSTER_CONFIG_HOME = previous;
    await ws.cleanup();
  }
});

// Spec: MUS-SPEC-14-4C (docs/spec/clauses/14-settings.md#mus-spec-14-4c--the-scope-toggle-writes-the-global-file)
test("the scope toggle saves to the global config", { timeout: 30_000 }, async () => {
  const ws = await workspace();
  const previous = process.env.MUSTER_CONFIG_HOME;
  process.env.MUSTER_CONFIG_HOME = ws.home;
  try {
    await ensureDefaultConfig(ws.cwd);
    const { chat } = await openPanel(ws);
    chat.input(KEY.tab);
    assert.match(plain(chat.visible()).join("\n"), /● global/);
    chat.input(KEY.right);
    chat.input(KEY.right);
    assert.match(plain(chat.visible()).join("\n"), /Header\s+compact/);
    chat.input(KEY.enter);
    chat.input(KEY.down);
    chat.input(KEY.enter);
    assert.ok(existsSync(ws.global));
    assert.equal(readJson(ws.global).appearance.header, "full");
    assert.equal(readJson(ws.project).appearance?.header, undefined);
    assert.match(plain(chat.visible()).join("\n"), /Saved appearance\.header → full · global/);
  } finally {
    if (previous === undefined) delete process.env.MUSTER_CONFIG_HOME;
    else process.env.MUSTER_CONFIG_HOME = previous;
    await ws.cleanup();
  }
});

// Spec: MUS-SPEC-14-4D (docs/spec/clauses/14-settings.md#mus-spec-14-4d--muster-settings-without-a-terminal-points-at-muster-config)
test("muster settings without a TTY prints the list and a hint", { timeout: 120_000 }, async () => {
  const ws = await workspace();
  try {
    await muster(ws, ["init"]);
    const result = await muster(ws, ["settings"]);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /chat\.access\s+auto-edit\s+default/);
    assert.match(result.stdout, /needs a terminal/);
  } finally {
    await ws.cleanup();
  }
});
