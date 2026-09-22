import { chmodSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { dataDir } from "./store.js";
import type { ScheduleJob } from "./scheduler.js";

/**
 * Durable scheduler persistence on node:sqlite. Every mutation runs inside a
 * synchronous BEGIN IMMEDIATE transaction, so two concurrent run-due
 * invocations (same process or separate processes sharing the file, WAL +
 * busy_timeout=5000) serialize on the write lock: the first claims a due
 * occurrence and advances next_run_at; the second sees nothing due. Results
 * update only the claiming job's row and receipt — a concurrent add/remove is
 * never overwritten (unlike the legacy whole-file JSON rewrite).
 */

export interface RunReceipt {
  readonly runKey: string;
  readonly jobId: string;
  /** The cron occurrence (ISO) this receipt claims — at most one receipt per (job, occurrence). */
  readonly scheduledAt: string;
  readonly claimedAt: string;
  readonly pid: number;
  readonly status: "running" | "completed" | "failed" | "interrupted";
  readonly runId?: string;
  readonly detail?: string;
}

export interface ClaimedRun {
  readonly job: ScheduleJob;
  readonly runKey: string;
}

export interface SkippedRun {
  readonly job: ScheduleJob;
  readonly detail: string;
}

export function schedulerDbPath(cwd = process.cwd()): string {
  return join(dataDir(cwd), "schedules.sqlite");
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  cron TEXT NOT NULL,
  prompt TEXT NOT NULL,
  flow_id TEXT,
  profile TEXT,
  created_at TEXT NOT NULL,
  next_run_at TEXT,
  last_run_at TEXT,
  last_run_id TEXT,
  last_status TEXT,
  disabled INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS run_receipts (
  run_key TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  scheduled_at TEXT NOT NULL,
  claimed_at TEXT NOT NULL,
  pid INTEGER NOT NULL,
  status TEXT NOT NULL,
  run_id TEXT,
  detail TEXT
);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

type Row = Record<string, string | number | null>;

function rowToJob(row: Row): ScheduleJob {
  const job: {
    -readonly [K in keyof ScheduleJob]?: ScheduleJob[K];
  } = {
    id: row.id as string,
    cron: row.cron as string,
    prompt: row.prompt as string,
    createdAt: row.created_at as string,
  };
  if (row.flow_id != null) job.flowId = row.flow_id as string;
  if (row.profile != null) job.profile = row.profile as string;
  if (row.next_run_at != null) job.nextRunAt = row.next_run_at as string;
  if (row.last_run_at != null) job.lastRunAt = row.last_run_at as string;
  if (row.last_run_id != null) job.lastRunId = row.last_run_id as string;
  if (row.last_status != null) job.lastStatus = row.last_status as "completed" | "failed";
  if (row.disabled) job.disabled = true;
  return job as ScheduleJob;
}

function rowToReceipt(row: Row): RunReceipt {
  const receipt: {
    -readonly [K in keyof RunReceipt]?: RunReceipt[K];
  } = {
    runKey: row.run_key as string,
    jobId: row.job_id as string,
    scheduledAt: row.scheduled_at as string,
    claimedAt: row.claimed_at as string,
    pid: row.pid as number,
    status: row.status as RunReceipt["status"],
  };
  if (row.run_id != null) receipt.runId = row.run_id as string;
  if (row.detail != null) receipt.detail = row.detail as string;
  return receipt as RunReceipt;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means it exists but we cannot signal it — still alive.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function optionalString(value: unknown, path: string, id: string, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new Error(`Malformed schedules file ${path}: job ${id} has non-string ${field}`);
  return value;
}

function optionalIsoDate(value: unknown, path: string, id: string, field: string): string | null {
  const text = optionalString(value, path, id, field);
  if (text !== null && Number.isNaN(Date.parse(text))) {
    throw new Error(`Malformed schedules file ${path}: job ${id} has unparseable date ${field} "${text}"`);
  }
  return text;
}

/**
 * Validate a legacy schedules.json payload. Throws on any malformed entry —
 * duplicate ids, non-boolean disabled, unparseable dates, invalid cron — so
 * migration is fail-closed and never silently drops or mangles a job.
 */
function validateLegacyJobs(parsed: unknown, path: string, validateCron: (cron: string) => void): Row[] {
  if (!Array.isArray(parsed)) throw new Error(`Malformed schedules file ${path}: expected a JSON array of jobs`);
  const seen = new Set<string>();
  return parsed.map((entry, index) => {
    if (typeof entry !== "object" || entry === null) throw new Error(`Malformed schedules file ${path}: entry ${index} is not an object`);
    const job = entry as Record<string, unknown>;
    for (const field of ["id", "cron", "prompt", "createdAt"] as const) {
      if (typeof job[field] !== "string" || (job[field] as string).length === 0) {
        throw new Error(`Malformed schedules file ${path}: entry ${index} is missing required string "${field}"`);
      }
    }
    const rawId = job.id as string;
    if (seen.has(rawId)) throw new Error(`Malformed schedules file ${path}: duplicate job id "${rawId}"`);
    seen.add(rawId);
    try {
      validateCron(job.cron as string);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`Malformed schedules file ${path}: job ${rawId} has invalid cron: ${detail}`);
    }
    if (job.disabled !== undefined && typeof job.disabled !== "boolean") {
      throw new Error(`Malformed schedules file ${path}: job ${rawId} has non-boolean disabled`);
    }
    if (Number.isNaN(Date.parse(job.createdAt as string))) {
      throw new Error(`Malformed schedules file ${path}: job ${rawId} has unparseable date createdAt "${job.createdAt}"`);
    }
    const id = job.id as string;
    const lastStatus = optionalString(job.lastStatus, path, id, "lastStatus");
    if (lastStatus !== null && lastStatus !== "completed" && lastStatus !== "failed") {
      throw new Error(`Malformed schedules file ${path}: job ${id} has invalid lastStatus "${lastStatus}"`);
    }
    return {
      id,
      cron: job.cron as string,
      prompt: job.prompt as string,
      flow_id: optionalString(job.flowId, path, id, "flowId"),
      profile: optionalString(job.profile, path, id, "profile"),
      created_at: job.createdAt as string,
      next_run_at: optionalIsoDate(job.nextRunAt, path, id, "nextRunAt"),
      last_run_at: optionalIsoDate(job.lastRunAt, path, id, "lastRunAt"),
      last_run_id: optionalString(job.lastRunId, path, id, "lastRunId"),
      last_status: lastStatus,
      disabled: job.disabled === true ? 1 : 0,
    };
  });
}

export class SchedulerStore {
  private constructor(
    private readonly db: DatabaseSync,
    private readonly legacyJsonPath: string,
    private readonly validateCron: (cron: string) => void,
  ) {}

  /**
   * Open a short-lived store for a working directory. Runs the one-shot
   * legacy schedules.json import on every open until it succeeds: a corrupt
   * or malformed file throws (visibly, on every call) instead of dropping
   * jobs, and the original JSON file is left untouched as the backup.
   */
  static open(cwd: string, legacyJsonPath: string, validateCron: (cron: string) => void): SchedulerStore {
    const path = schedulerDbPath(cwd);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const db = new DatabaseSync(path);
    try {
      chmodSync(path, 0o600);
      // busy_timeout is connection-local and must be active before the lock-taking WAL pragma.
      db.exec("PRAGMA busy_timeout = 5000;");
      db.exec("PRAGMA journal_mode = WAL;");
      db.exec(SCHEMA);
      const store = new SchedulerStore(db, legacyJsonPath, validateCron);
      store.migrateLegacyJson();
      return store;
    } catch (error) { db.close(); throw error; }
  }

  close(): void { this.db.close(); }

  private getMeta(key: string): string | undefined {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as Row | undefined;
    return row?.value as string | undefined;
  }

  private migrateLegacyJson(): void {
    if (this.getMeta("legacy_json_migrated")) return;
    let raw: string | undefined;
    try {
      raw = readFileSync(this.legacyJsonPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    let rows: Row[] = [];
    if (raw !== undefined) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`Corrupt JSON in ${this.legacyJsonPath}: ${detail}`);
      }
      rows = validateLegacyJobs(parsed, this.legacyJsonPath, this.validateCron);
    }
    // All-or-nothing import; a concurrent migrator loses the race harmlessly
    // (marker re-checked under the write lock). Original JSON stays as backup.
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (!this.getMeta("legacy_json_migrated")) {
        const insert = this.db.prepare(
          `INSERT INTO jobs (id, cron, prompt, flow_id, profile, created_at, next_run_at, last_run_at, last_run_id, last_status, disabled)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        );
        for (const row of rows) {
          insert.run(
            row.id, row.cron, row.prompt, row.flow_id, row.profile, row.created_at,
            row.next_run_at, row.last_run_at, row.last_run_id, row.last_status, row.disabled,
          );
        }
        this.db.prepare("INSERT INTO meta (key, value) VALUES ('legacy_json_migrated', ?)").run(new Date().toISOString());
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  insertJob(job: ScheduleJob): void {
    this.db.prepare(
      `INSERT INTO jobs (id, cron, prompt, flow_id, profile, created_at, next_run_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(job.id, job.cron, job.prompt, job.flowId ?? null, job.profile ?? null, job.createdAt, job.nextRunAt ?? null);
  }

  listJobs(): ScheduleJob[] {
    return (this.db.prepare("SELECT * FROM jobs ORDER BY rowid").all() as Row[]).map(rowToJob);
  }

  removeJob(id: string): boolean {
    return this.db.prepare("DELETE FROM jobs WHERE id = ?").run(id).changes > 0;
  }

  listReceipts(): RunReceipt[] {
    return (this.db.prepare("SELECT * FROM run_receipts ORDER BY claimed_at, run_key").all() as Row[]).map(rowToReceipt);
  }

  /**
   * Atomically claim every due job: advance next_run_at to the next FUTURE
   * occurrence and persist a "running" receipt BEFORE the caller awaits any
   * runner. A job with a live unresolved "running" receipt is skipped (even at
   * the next minute) without advancing, so the occurrence fires once the prior
   * run resolves. A "running" receipt whose pid is gone (host/process restart)
   * is marked interrupted — outcome unknown, never implicitly replayed: its
   * occurrence was already advanced past when it was claimed.
   */
  claimDue(now: Date, computeNext: (cron: string, from: Date) => Date): { claimed: ClaimedRun[]; skipped: SkippedRun[] } {
    const claimed: ClaimedRun[] = [];
    const skipped: SkippedRun[] = [];
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const running = new Map<string, RunReceipt>();
      const runningRows = this.db.prepare("SELECT * FROM run_receipts WHERE status = 'running'").all() as Row[];
      const markInterrupted = this.db.prepare("UPDATE run_receipts SET status = 'interrupted', detail = ? WHERE run_key = ?");
      for (const row of runningRows) {
        const receipt = rowToReceipt(row);
        if (pidAlive(receipt.pid)) {
          running.set(receipt.jobId, receipt);
        } else {
          markInterrupted.run(`claiming process ${receipt.pid} is gone; run outcome unknown`, receipt.runKey);
        }
      }

      const advance = this.db.prepare("UPDATE jobs SET next_run_at = ? WHERE id = ?");
      const insertReceipt = this.db.prepare(
        "INSERT INTO run_receipts (run_key, job_id, scheduled_at, claimed_at, pid, status) VALUES (?, ?, ?, ?, ?, 'running')",
      );
      for (const row of this.db.prepare("SELECT * FROM jobs ORDER BY rowid").all() as Row[]) {
        const job = rowToJob(row);
        if (job.disabled) {
          skipped.push({ job, detail: "disabled" });
          continue;
        }
        // Legacy jobs (created before nextRunAt) derive it from their last run/creation.
        const nextRunAt = job.nextRunAt
          ? new Date(job.nextRunAt)
          : computeNext(job.cron, new Date(job.lastRunAt ?? job.createdAt));
        if (nextRunAt > now) continue; // not due yet
        if (running.has(job.id)) {
          skipped.push({ job, detail: `previous run still in progress (${running.get(job.id)!.runKey})` });
          continue;
        }
        const scheduledAt = nextRunAt.toISOString();
        advance.run(computeNext(job.cron, now).toISOString(), job.id);
        const runKey = `${job.id}@${scheduledAt}`;
        insertReceipt.run(runKey, job.id, scheduledAt, now.toISOString(), process.pid);
        claimed.push({ job, runKey });
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return { claimed, skipped };
  }

  /**
   * Resolve a claimed run: update ONLY this claim's receipt and job row.
   * A job removed while the runner was in flight simply matches zero rows —
   * concurrent adds/removes are never overwritten.
   */
  resolveRun(
    claim: ClaimedRun,
    result: { status: "completed" | "failed"; runId?: string; detail?: string },
    at: Date,
  ): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("UPDATE run_receipts SET status = ?, run_id = ?, detail = ? WHERE run_key = ?")
        .run(result.status, result.runId ?? null, result.detail ?? null, claim.runKey);
      this.db.prepare("UPDATE jobs SET last_run_at = ?, last_run_id = ?, last_status = ? WHERE id = ?")
        .run(at.toISOString(), result.runId ?? null, result.status, claim.job.id);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}
