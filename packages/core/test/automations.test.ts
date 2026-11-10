import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  createAutomation,
  createToolRegistry,
  desktopNotifier,
  listAutomations,
  MAX_ACTIVE_AUTOMATIONS,
  registerBuiltinTools,
  runAutomationsTick,
  type AutomationNotice,
} from "../src/index.js";

async function workspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), "muster-automations-"));
}

function recorder() {
  const delivered: Array<{ via: string; notice: AutomationNotice }> = [];
  return {
    delivered,
    deliverers: {
      terminal: (notice: AutomationNotice) => { delivered.push({ via: "terminal", notice }); },
      desktop: (notice: AutomationNotice) => { delivered.push({ via: "desktop", notice }); },
    },
  };
}

const minutes = (base: Date, count: number) => new Date(base.getTime() + count * 60_000);

// Spec: MUS-SPEC-16-1A (docs/spec/clauses/16-automations.md#mus-spec-16-1a--remind-me-in-5-minutes-fires-exactly-once)
test("a reminder in 5m fires once when the clock reaches it", async () => {
  const cwd = await workspace();
  const t0 = new Date("2026-11-09T10:00:00.000Z");
  const job = await createAutomation({ kind: "reminder", text: "stretch", when: "in 5m", deliver: "terminal", now: t0, cwd });
  assert.equal(job.at, "2026-11-09T10:05:00.000Z");
  const { delivered, deliverers } = recorder();

  assert.equal((await runAutomationsTick({ cwd, now: minutes(t0, 4), deliverers })).length, 0);
  assert.equal(delivered.length, 0);

  const fired = await runAutomationsTick({ cwd, now: minutes(t0, 5), deliverers });
  assert.deepEqual(fired.map((result) => [result.job.id, result.status]), [[job.id, "completed"]]);
  assert.deepEqual(delivered.map((entry) => [entry.via, entry.notice.text]), [["terminal", "stretch"]]);

  await runAutomationsTick({ cwd, now: minutes(t0, 6), deliverers });
  assert.equal(delivered.length, 1, "delivered exactly once");

  const [listed] = await listAutomations(cwd);
  assert.ok(listed.completedAt, "one-off job is done");
  assert.equal(listed.lastStatus, "completed");
});

// Spec: MUS-SPEC-16-1B (docs/spec/clauses/16-automations.md#mus-spec-16-1b--times-are-understood-or-refused)
test("relative and ISO times are parsed and nonsense is refused", async () => {
  const cwd = await workspace();
  const now = new Date("2026-11-09T10:00:00.000Z");
  const at = async (when: string) => (await createAutomation({ kind: "reminder", text: "x", when, now, cwd })).at;
  assert.equal(await at("in 90s"), "2026-11-09T10:01:30.000Z");
  assert.equal(await at("in 2h"), "2026-11-09T12:00:00.000Z");
  assert.equal(await at("in 1d"), "2026-11-10T10:00:00.000Z");
  assert.equal(await at("in 5 minutes"), "2026-11-09T10:05:00.000Z");
  assert.equal(await at("2026-11-09T18:30:00+05:30"), "2026-11-09T13:00:00.000Z");
  await assert.rejects(() => at("yesterday"), /in 5m|ISO/);
  await assert.rejects(() => at("in 5 parsecs"), /in 5m|ISO/);
  await assert.rejects(() => at("2026-11-08T10:00:00Z"), /in the past/);
});

// Spec: MUS-SPEC-16-1C (docs/spec/clauses/16-automations.md#mus-spec-16-1c--cron-in-a-time-zone)
test("cron routines honour a time zone", async () => {
  const cwd = await workspace();
  const now = new Date("2026-11-09T00:00:00.000Z");
  const job = await createAutomation({ kind: "run", text: "summarize my inbox", cron: "0 9 * * *", tz: "Asia/Kolkata", now, cwd });
  assert.equal(job.nextRunAt, "2026-11-09T03:30:00.000Z");
  assert.equal(job.tz, "Asia/Kolkata");
  await assert.rejects(
    () => createAutomation({ kind: "run", text: "x", cron: "0 9 * * *", tz: "Mars/Olympus", now, cwd }),
    /time zone/i,
  );
});

// Spec: MUS-SPEC-16-2B (docs/spec/clauses/16-automations.md#mus-spec-16-2b--missed-runs-catch-up-once)
test("missed runs catch up once, not in a burst", async () => {
  const cwd = await workspace();
  const created = new Date("2026-11-09T08:58:00.000Z");
  const routine = await createAutomation({ kind: "reminder", text: "every five", cron: "*/5 * * * *", now: created, cwd });
  const late = await createAutomation({ kind: "reminder", text: "late one", when: "in 2m", now: created, cwd });
  const { delivered, deliverers } = recorder();
  const wake = new Date("2026-11-09T10:02:00.000Z"); // asleep for an hour

  const first = await runAutomationsTick({ cwd, now: wake, deliverers });
  assert.deepEqual(first.map((result) => result.job.id).sort(), [routine.id, late.id].sort());
  assert.deepEqual(delivered.map((entry) => entry.notice.text).sort(), ["every five", "late one"]);

  const second = await runAutomationsTick({ cwd, now: new Date(wake.getTime() + 5_000), deliverers });
  assert.equal(second.length, 0);
  assert.equal(delivered.length, 2);
  const listed = (await listAutomations(cwd)).find((job) => job.id === routine.id)!;
  assert.ok(new Date(listed.nextRunAt!) > wake, "next run is in the future");
});

// Spec: MUS-SPEC-16-3A (docs/spec/clauses/16-automations.md#mus-spec-16-3a--desktop-notifications-never-go-through-a-shell)
test("desktop delivery passes the message as an argument, never as script", async () => {
  const hostile = "\"; rm -rf ~ # $(whoami)";
  const notice: AutomationNotice = { jobId: "sched_x", kind: "reminder", title: "Muster reminder", text: hostile, firedAt: "2026-11-09T10:00:00.000Z" };
  for (const platform of ["darwin", "linux"] as const) {
    const calls: Array<{ command: string; args: readonly string[] }> = [];
    const notify = desktopNotifier({ platform, launch: async (command, args) => { calls.push({ command, args }); } });
    await notify(notice);
    assert.equal(calls.length, 1);
    const [call] = calls;
    assert.equal(call.command, platform === "darwin" ? "osascript" : "notify-send");
    assert.ok(call.args.includes(hostile), "message is its own argv entry, verbatim");
    assert.ok(call.args.includes("Muster reminder"), "title is its own argv entry");
    const spliced = call.args.filter((arg) => arg !== hostile && arg.includes(hostile));
    assert.deepEqual(spliced, [], "message never spliced into script source");
  }
  const unsupported = desktopNotifier({ platform: "win32", launch: async () => {} });
  await assert.rejects(() => unsupported(notice), /not supported/);
});

// Spec: MUS-SPEC-16-3B (docs/spec/clauses/16-automations.md#mus-spec-16-3b--channel-delivery-says-when-it-is-not-wired)
test("channel delivery reports not configured until a sender exists", async () => {
  const cwd = await workspace();
  const t0 = new Date("2026-11-09T10:00:00.000Z");
  const job = await createAutomation({ kind: "reminder", text: "standup", when: "in 1m", deliver: "channel:telegram-main/peer-1", now: t0, cwd });
  const [result] = await runAutomationsTick({ cwd, now: minutes(t0, 1), deliverers: {} });
  assert.equal(result.status, "failed");
  assert.match(result.detail ?? "", /channel delivery not configured \(telegram-main\/peer-1\)/);
  const [listed] = await listAutomations(cwd);
  assert.equal(listed.id, job.id);
  assert.equal(listed.lastStatus, "failed");
  assert.match(listed.lastDetail ?? "", /channel delivery not configured/);

  const sent: Array<[string, string]> = [];
  await createAutomation({ kind: "reminder", text: "retro", when: "in 1m", deliver: "channel:telegram-main/peer-1", now: t0, cwd });
  const results = await runAutomationsTick({
    cwd,
    now: minutes(t0, 2),
    deliverers: { channel: (channelId, notice) => { sent.push([channelId, notice.text]); } },
  });
  assert.deepEqual(results.map((entry) => entry.status), ["completed"]);
  assert.deepEqual(sent, [["telegram-main/peer-1", "retro"]]);
});

// Spec: MUS-SPEC-16-4B (docs/spec/clauses/16-automations.md#mus-spec-16-4b--agent-scheduling-is-governed)
test("schedule_manage caps message length and active jobs", async () => {
  const cwd = await workspace();
  const registry = createToolRegistry();
  registerBuiltinTools(registry);
  const call = (args: Record<string, unknown>) => registry.execute("schedule_manage", args, { cwd });

  const long = await call({ action: "create", kind: "reminder", when: "in 5m", message: "x".repeat(2000) });
  assert.equal(long.ok, false);
  assert.match(long.ok ? "" : long.error, /500 characters/);
  assert.equal((await listAutomations(cwd)).length, 0);

  for (let index = 0; index < MAX_ACTIVE_AUTOMATIONS; index += 1) {
    const created = await call({ action: "create", kind: "reminder", when: "in 1h", message: `job ${index}` });
    assert.equal(created.ok, true, created.ok ? "" : created.error);
  }
  const over = await call({ action: "create", kind: "reminder", when: "in 1h", message: "one too many" });
  assert.equal(over.ok, false);
  assert.match(over.ok ? "" : over.error, new RegExp(`${MAX_ACTIVE_AUTOMATIONS} active`));
  assert.equal((await listAutomations(cwd)).length, MAX_ACTIVE_AUTOMATIONS);
});
