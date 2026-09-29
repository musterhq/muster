import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { addSchedule, listSchedules, parseCron, removeSchedule, runDueSchedules, schedulesPath } from "../src/index.js";

test("parseCron matches simple and complex expressions", () => {
  const everyMinute = parseCron("* * * * *");
  assert.equal(everyMinute.matches(new Date("2026-06-10T09:41:00")), true);

  const noonDaily = parseCron("0 12 * * *");
  assert.equal(noonDaily.matches(new Date("2026-06-10T12:00:00")), true);
  assert.equal(noonDaily.matches(new Date("2026-06-10T12:01:00")), false);

  const everyFive = parseCron("*/5 * * * *");
  assert.equal(everyFive.matches(new Date("2026-06-10T09:10:00")), true);
  assert.equal(everyFive.matches(new Date("2026-06-10T09:11:00")), false);

  const weekdayMornings = parseCron("30 9 * * 1-5");
  assert.equal(weekdayMornings.matches(new Date("2026-06-10T09:30:00")), true); // a Wednesday
  assert.equal(weekdayMornings.matches(new Date("2026-06-14T09:30:00")), false); // a Sunday

  const listField = parseCron("0 9,18 * * *");
  assert.equal(listField.matches(new Date("2026-06-10T18:00:00")), true);
  assert.equal(listField.matches(new Date("2026-06-10T17:00:00")), false);
});

test("parseCron rejects malformed expressions with a clear message", () => {
  assert.throws(() => parseCron("* * * *"), /5 fields/);
  assert.throws(() => parseCron("99 * * * *"), /Invalid cron value/);
  assert.throws(() => parseCron("1-99 * * * *"), /Invalid cron range/);
  assert.throws(() => parseCron("*/0 * * * *"), /Invalid cron step/);
});

test("addSchedule validates the cron expression up front", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-sched-"));
  await assert.rejects(() => addSchedule("not a cron", "do things", { cwd }), /5 fields/);
});

test("runDueSchedules runs due jobs, advances nextRunAt, and does not double-fire", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-sched-run-"));
  const created = new Date("2026-06-10T09:40:00");
  await addSchedule("* * * * *", "always due", { cwd, now: created });
  await addSchedule("0 0 1 1 *", "new year only", { cwd, now: created });

  const now = new Date("2026-06-10T09:41:30");
  const ran: string[] = [];
  const results = await runDueSchedules(async (job) => {
    ran.push(job.prompt);
    return { runId: "run_x", status: "completed" };
  }, { now, cwd });

  assert.deepEqual(ran, ["always due"]);
  assert.equal(results.length, 1);
  assert.equal(results[0].status, "completed");

  // Re-running in the same minute must NOT double-fire — nextRunAt advanced past now.
  const second = await runDueSchedules(async () => {
    throw new Error("should not run again — nextRunAt is in the future");
  }, { now: new Date("2026-06-10T09:41:55"), cwd });
  assert.equal(second.length, 0, "no job is due again this minute");

  const jobs = await listSchedules(cwd);
  const due = jobs.find((job) => job.prompt === "always due");
  assert.equal(due?.lastStatus, "completed");
  assert.equal(due?.lastRunId, "run_x");
  assert.ok(new Date(due!.nextRunAt!) > now, "nextRunAt advanced to a future occurrence");
});

test("runDueSchedules catches a missed occurrence and fast-forwards (no burst)", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-sched-missed-"));
  // Created at 09:00; nextRunAt = 09:05. Then run-due is not invoked for an hour
  // (host asleep). At 10:02 the job is overdue by ~12 missed */5 ticks.
  await addSchedule("*/5 * * * *", "every five", { cwd, now: new Date("2026-06-10T09:00:00") });
  let runs = 0;
  const results = await runDueSchedules(async () => {
    runs += 1;
    return { runId: "r", status: "completed" };
  }, { now: new Date("2026-06-10T10:02:00"), cwd });

  assert.equal(runs, 1, "a backlog of missed ticks runs ONCE, never bursts");
  assert.equal(results[0].status, "completed");
  const job = (await listSchedules(cwd))[0];
  // Fast-forwarded to the next FUTURE */5 after 10:02 → 10:05, not replaying 09:05..10:00.
  assert.equal(new Date(job.nextRunAt!).toISOString(), new Date("2026-06-10T10:05:00").toISOString());
});

test("runDueSchedules records runner failures without losing the job", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-sched-fail-"));
  await addSchedule("* * * * *", "will fail", { cwd, now: new Date("2026-06-10T09:59:00") });
  const results = await runDueSchedules(async () => {
    throw new Error("provider exploded");
  }, { now: new Date("2026-06-10T10:00:00"), cwd });
  assert.equal(results[0].status, "failed");
  assert.match(results[0].detail ?? "", /provider exploded/);
  const jobs = await listSchedules(cwd);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].lastStatus, "failed");
});

test("removeSchedule reports whether anything was removed", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-sched-rm-"));
  const job = await addSchedule("* * * * *", "temp", { cwd });
  assert.equal(await removeSchedule(job.id, cwd), true);
  assert.equal(await removeSchedule(job.id, cwd), false);
});

test("missing schedules.json yields no jobs; a corrupt one throws instead of silently dropping schedules", async () => {
  const missingCwd = await mkdtemp(join(tmpdir(), "muster-sched-missing-"));
  assert.deepEqual(await listSchedules(missingCwd), [], "absent file is an empty schedule, not an error");

  const corruptCwd = await mkdtemp(join(tmpdir(), "muster-sched-corrupt-"));
  const path = schedulesPath(corruptCwd);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, "{ this is not valid json");
  await assert.rejects(() => listSchedules(corruptCwd), /Corrupt JSON/);
});

test("two concurrent runDueSchedules invocations fire a due job exactly once; overlap is skipped even at the next minute", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-sched-race-"));
  await addSchedule("* * * * *", "raced", { cwd, now: new Date("2026-06-10T09:40:00") });

  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let runnerCalls = 0;
  const runner = async () => {
    runnerCalls += 1;
    await gate;
    return { runId: "run_race", status: "completed" as const };
  };

  const now = new Date("2026-06-10T09:41:00");
  const first = runDueSchedules(runner, { now, cwd });
  const second = runDueSchedules(runner, { now, cwd });

  // While the winner's runner is still blocked, the NEXT minute must not
  // start an overlapping run — it is skipped, not queued.
  const nextMinute = await runDueSchedules(runner, { now: new Date("2026-06-10T09:42:00"), cwd });
  assert.equal(runnerCalls, 1, "only one invocation claimed the occurrence");
  assert.equal(nextMinute[0]?.status, "skipped");
  assert.match(nextMinute[0]?.detail ?? "", /still in progress/);

  release();
  const [a, b] = await Promise.all([first, second]);
  const statuses = [...a, ...b].map((r) => r.status).sort();
  assert.deepEqual(statuses, ["completed"], "loser saw nothing due");

  // Once the prior run resolved, the following minute fires normally again.
  const after = await runDueSchedules(async () => ({ runId: "run_2", status: "completed" as const }), { now: new Date("2026-06-10T09:43:00"), cwd });
  assert.equal(after[0]?.status, "completed");
});

test("add/remove while a runner is in flight is never overwritten by the run result", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-sched-concurrent-mut-"));
  const doomed = await addSchedule("* * * * *", "doomed", { cwd, now: new Date("2026-06-10T09:40:00") });

  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const running = runDueSchedules(async () => {
    await gate;
    return { runId: "run_doomed", status: "completed" as const };
  }, { now: new Date("2026-06-10T09:41:00"), cwd });

  // Mutate while the runner is blocked: the result write must touch only the
  // claimed job's row, so these survive intact.
  const added = await addSchedule("0 12 * * *", "added mid-run", { cwd, now: new Date("2026-06-10T09:41:10") });
  assert.equal(await removeSchedule(doomed.id, cwd), true);

  release();
  const results = await running;
  assert.equal(results[0]?.status, "completed", "in-flight run still resolves");

  const jobs = await listSchedules(cwd);
  assert.deepEqual(jobs.map((job) => job.id), [added.id], "removal held; added job survived the result write");
  assert.equal(jobs[0].lastRunAt, undefined, "result never bled onto the concurrently added job");
});
