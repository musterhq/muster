import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { dataDir } from "./store.js";
import { SchedulerStore } from "./scheduler-store.js";

export interface ScheduleJob {
  readonly id: string;
  readonly cron: string;
  readonly prompt: string;
  /** When set, run-due executes runFlow on this saved flow instead of executeRun on the prompt. */
  readonly flowId?: string;
  readonly profile?: string;
  readonly createdAt: string;
  readonly lastRunAt?: string;
  readonly lastRunId?: string;
  readonly lastStatus?: "completed" | "failed";
  readonly disabled?: boolean;
  /**
   * The next occurrence this job is due, ISO. Due detection compares this to
   * now (not "does the current minute match"), so a missed tick is not a lost
   * occurrence — it's caught the next time run-due fires. Advanced to the next
   * FUTURE occurrence before running, so a backlog never bursts (at-most-once).
   */
  readonly nextRunAt?: string;
}

export function schedulesPath(cwd = process.cwd()): string {
  return join(dataDir(cwd), "schedules.json");
}

function parseField(field: string, min: number, max: number): Set<number> | "any" {
  if (field === "*") return "any";
  const values = new Set<number>();
  for (const part of field.split(",")) {
    if (!/^(?:\*|\d+(?:-\d+)?)(?:\/\d+)?$/.test(part)) throw new Error(`Invalid cron value: ${part}`);
    const [rangePart, stepPart] = part.split("/");
    const step = stepPart ? Number.parseInt(stepPart, 10) : 1;
    if (!Number.isFinite(step) || step < 1) throw new Error(`Invalid cron step: ${part}`);
    let start = min;
    let end = max;
    if (rangePart !== "*" && rangePart !== "") {
      if (rangePart.includes("-")) {
        const [low, high] = rangePart.split("-").map((value) => Number.parseInt(value, 10));
        if (!Number.isFinite(low) || !Number.isFinite(high) || low < min || high > max || low > high) {
          throw new Error(`Invalid cron range: ${part}`);
        }
        start = low;
        end = high;
      } else {
        const value = Number.parseInt(rangePart, 10);
        if (!Number.isFinite(value) || value < min || value > max) throw new Error(`Invalid cron value: ${part}`);
        if (!stepPart) {
          values.add(value);
          continue;
        }
        start = value;
      }
    }
    for (let current = start; current <= end; current += step) values.add(current);
  }
  return values;
}

export function parseCron(expression: string): { matches(date: Date): boolean } {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error(`Cron expression must have 5 fields (minute hour day-of-month month day-of-week): "${expression}"`);
  const [minute, hour, dom, month, dow] = [
    parseField(fields[0], 0, 59),
    parseField(fields[1], 0, 23),
    parseField(fields[2], 1, 31),
    parseField(fields[3], 1, 12),
    parseField(fields[4], 0, 6),
  ];
  return {
    matches(date: Date): boolean {
      const check = (field: Set<number> | "any", value: number) => field === "any" || field.has(value);
      return check(minute, date.getMinutes())
        && check(hour, date.getHours())
        && check(dom, date.getDate())
        && check(month, date.getMonth() + 1)
        && check(dow, date.getDay());
    },
  };
}

/**
 * The first minute STRICTLY AFTER `from` that satisfies the cron. Forward-scans
 * minute by minute (bounded to a year so an unsatisfiable expression throws
 * instead of looping forever). This is the at-most-once / no-lost-occurrence
 * primitive: advance to this before running and a backlog of missed ticks
 * collapses to a single next occurrence rather than bursting.
 */
export function computeNextRun(cron: string, from: Date): Date {
  const parsed = parseCron(cron);
  const next = new Date(from);
  next.setSeconds(0, 0);
  next.setMinutes(next.getMinutes() + 1);
  const maxMinutes = 366 * 24 * 60;
  for (let i = 0; i < maxMinutes; i += 1) {
    if (parsed.matches(next)) return new Date(next);
    next.setMinutes(next.getMinutes() + 1);
  }
  throw new Error(`Cron "${cron}" has no matching time within a year.`);
}

function openStore(cwd: string): SchedulerStore {
  // Opening migrates a legacy schedules.json once, atomically; the JSON file
  // is kept untouched as the backup. Corrupt/malformed JSON throws here.
  return SchedulerStore.open(cwd, schedulesPath(cwd), parseCron);
}

export async function addSchedule(cron: string, prompt: string, options: { profile?: string; cwd?: string; flowId?: string; now?: Date } = {}): Promise<ScheduleJob> {
  parseCron(cron);
  const cwd = options.cwd ?? process.cwd();
  const createdAt = options.now ?? new Date();
  const job: ScheduleJob = {
    id: `sched_${randomUUID().slice(0, 8)}`,
    cron,
    prompt,
    flowId: options.flowId,
    profile: options.profile,
    createdAt: createdAt.toISOString(),
    nextRunAt: computeNextRun(cron, createdAt).toISOString(),
  };
  const store = openStore(cwd);
  try { store.insertJob(job); } finally { store.close(); }
  return job;
}

export async function listSchedules(cwd = process.cwd()): Promise<ScheduleJob[]> {
  const store = openStore(cwd);
  try { return store.listJobs(); } finally { store.close(); }
}

export async function removeSchedule(id: string, cwd = process.cwd()): Promise<boolean> {
  const store = openStore(cwd);
  try { return store.removeJob(id); } finally { store.close(); }
}

export interface DueJobRun {
  readonly job: ScheduleJob;
  readonly runId?: string;
  readonly status: "completed" | "failed" | "skipped";
  readonly detail?: string;
}

/**
 * Executes every job that is DUE (nextRunAt <= now) — not merely "the current
 * minute matches" — so a missed tick (host asleep, a skipped cron minute, a
 * restart) is caught the next time this runs rather than lost. Claiming is a
 * single synchronous SQLite transaction: each due job's nextRunAt is advanced
 * to its next FUTURE occurrence and a "running" receipt persisted BEFORE any
 * runner is awaited — at-most-once per occurrence even under concurrent
 * run-due invocations, and a backlog collapses to one occurrence (no burst).
 * A job whose previous run is still in flight is skipped (even at the next
 * minute). After a crash/restart its unresolved receipt is marked
 * interrupted (outcome unknown) and never implicitly replayed. There is no
 * daemon: invoke from external cron
 * (e.g. `* * * * * cd <repo> && pnpm hc schedule run-due`).
 */
export async function runDueSchedules(
  runner: (job: ScheduleJob) => Promise<{ runId: string; status: "completed" | "failed" }>,
  options: { now?: Date; cwd?: string } = {},
): Promise<DueJobRun[]> {
  const cwd = options.cwd ?? process.cwd();
  const now = options.now ?? new Date();
  const store = openStore(cwd);
  let claims: ReturnType<SchedulerStore["claimDue"]>;
  try { claims = store.claimDue(now, computeNextRun); } finally { store.close(); }
  const { claimed, skipped } = claims;
  const resolveRun: SchedulerStore["resolveRun"] = (claim, result, at) => {
    const resultStore = openStore(cwd);
    try { resultStore.resolveRun(claim, result, at); } finally { resultStore.close(); }
  };
  const results: DueJobRun[] = skipped.map(({ job, detail }) => ({ job, status: "skipped", detail }));

  // Claims are committed; run each and resolve ONLY that claim's receipt and
  // job row — a concurrent add/remove is never overwritten.
  for (const claim of claimed) {
    try {
      const result = await runner(claim.job);
      resolveRun(claim, result, now);
      results.push({ job: claim.job, runId: result.runId, status: result.status });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      resolveRun(claim, { status: "failed", detail }, now);
      results.push({ job: claim.job, status: "failed", detail });
    }
  }
  return results;
}
