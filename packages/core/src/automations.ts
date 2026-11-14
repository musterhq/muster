/**
 * Automations (#165): reminders and routines that run themselves and deliver
 * somewhere. A job is a reminder (deliver a fixed message, no model call) or a
 * run (execute a prompt, deliver the answer); it fires once (`at`) or on a
 * cron (optionally in a time zone). Every tick goes through the scheduler's
 * at-most-once SQLite claims, so `muster daemon`, an open chat and
 * `muster schedule run-due` can all tick without double-delivering.
 */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { addSchedule, listSchedules, recordManualRun, runDueSchedules, type AutomationKind, type DueJobRun, type ScheduleJob } from "./scheduler.js";
import { dataDir } from "./store.js";

export type { AutomationKind } from "./scheduler.js";

/** Longest message/prompt a job may carry. */
export const MAX_AUTOMATION_TEXT = 500;
/** Most active (not done, not disabled) jobs an agent may leave scheduled. */
export const MAX_ACTIVE_AUTOMATIONS = 20;

export const WHEN_FORMS = 'use "in 90s", "in 5m", "in 2h", "in 1d" (or "in 5 minutes"), or an ISO time like 2026-11-09T18:30:00+05:30';

const UNIT_MS: Record<string, number> = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };

function unitOf(word: string): string | undefined {
  const unit = word.toLowerCase();
  if (/^(s|sec|secs|second|seconds)$/.test(unit)) return "s";
  if (/^(m|min|mins|minute|minutes)$/.test(unit)) return "m";
  if (/^(h|hr|hrs|hour|hours)$/.test(unit)) return "h";
  if (/^(d|day|days)$/.test(unit)) return "d";
  return undefined;
}

/** `in 5m` / `in 2 hours` / `5m` / an ISO time → the instant it names. Refuses the past and nonsense. */
export function parseWhen(text: string, now: Date = new Date()): Date {
  const trimmed = text.trim();
  const relative = trimmed.match(/^(?:in\s+)?(\d+(?:\.\d+)?)\s*([a-z]+)$/i);
  if (relative) {
    const unit = unitOf(relative[2]!);
    const amount = Number(relative[1]);
    if (unit && amount > 0) return new Date(now.getTime() + Math.round(amount * UNIT_MS[unit]!));
    throw new Error(`Cannot read "${text}" as a time: ${WHEN_FORMS}.`);
  }
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(trimmed)) {
    const at = new Date(trimmed);
    if (!Number.isNaN(at.getTime())) {
      if (at.getTime() <= now.getTime()) throw new Error(`"${text}" is in the past.`);
      return at;
    }
  }
  throw new Error(`Cannot read "${text}" as a time: ${WHEN_FORMS}.`);
}

export function parseDelivery(value: string | undefined): string {
  const deliver = (value ?? "terminal").trim();
  if (deliver === "terminal" || deliver === "desktop") return deliver;
  if (/^channel:[A-Za-z0-9._-]+\/\S+$/.test(deliver)) return deliver;
  if (deliver.startsWith("channel:")) throw new Error(`Channel delivery needs a recipient: channel:<channel>/<peer>, for example channel:telegram/123456789 or channel:matrix/!room:example.org (got ${deliver}).`);
  throw new Error(`Unknown delivery "${deliver}": use terminal, desktop or channel:<channel>/<peer>.`);
}

export interface CreateAutomationInput {
  readonly kind: AutomationKind;
  /** The reminder message, or the prompt for a run. */
  readonly text: string;
  /** One-off time (`in 5m`, ISO). Exactly one of when/cron. */
  readonly when?: string;
  readonly cron?: string;
  readonly tz?: string;
  readonly deliver?: string;
  readonly profile?: string;
  readonly now?: Date;
  readonly cwd?: string;
  /** Agent-created jobs obey the active-job cap. */
  readonly enforceActiveCap?: boolean;
  /** Create the job switched off (imported jobs wait for the user to enable them). */
  readonly disabled?: boolean;
}

export function isActiveAutomation(job: ScheduleJob): boolean {
  return !job.completedAt && !job.disabled;
}

export async function createAutomation(input: CreateAutomationInput): Promise<ScheduleJob> {
  const cwd = input.cwd ?? process.cwd();
  const now = input.now ?? new Date();
  const text = input.text.trim();
  if (!text) throw new Error("A job needs a message (reminder) or prompt (run).");
  if (text.length > MAX_AUTOMATION_TEXT) {
    throw new Error(`Message is ${text.length} characters; the limit is ${MAX_AUTOMATION_TEXT} characters.`);
  }
  if (input.kind !== "reminder" && input.kind !== "run") throw new Error(`Unknown kind "${String(input.kind)}": use reminder or run.`);
  const hasWhen = Boolean(input.when?.trim());
  const hasCron = Boolean(input.cron?.trim());
  if (hasWhen === hasCron) throw new Error("Give exactly one of when (one-off) or cron (recurring).");
  const deliver = parseDelivery(input.deliver);
  if (input.enforceActiveCap) {
    const active = (await listSchedules(cwd)).filter(isActiveAutomation).length;
    if (active >= MAX_ACTIVE_AUTOMATIONS) {
      throw new Error(`There are already ${MAX_ACTIVE_AUTOMATIONS} active jobs (the limit is ${MAX_ACTIVE_AUTOMATIONS} active); remove one first.`);
    }
  }
  return addSchedule(hasCron ? input.cron!.trim() : "", text, {
    cwd,
    now,
    kind: input.kind,
    tz: input.tz?.trim() || undefined,
    deliver,
    profile: input.profile,
    at: hasWhen ? parseWhen(input.when!, now) : undefined,
    disabled: input.disabled,
  });
}

export async function listAutomations(cwd = process.cwd()): Promise<ScheduleJob[]> {
  return listSchedules(cwd);
}

// ── Delivery ────────────────────────────────────────────────────────────────

export interface AutomationNotice {
  readonly jobId: string;
  readonly kind: AutomationKind;
  readonly title: string;
  readonly text: string;
  readonly firedAt: string;
}

export interface AutomationDeliverers {
  readonly terminal?: (notice: AutomationNotice) => void | Promise<void>;
  readonly desktop?: (notice: AutomationNotice) => void | Promise<void>;
  /** Gateway send path; absent = "channel delivery not configured". */
  readonly channel?: (channelId: string, notice: AutomationNotice) => void | Promise<void>;
}

export async function deliverNotice(deliver: string | undefined, notice: AutomationNotice, deliverers: AutomationDeliverers): Promise<void> {
  const target = deliver ?? "terminal";
  if (target === "terminal") {
    if (!deliverers.terminal) throw new Error("terminal delivery not available here");
    await deliverers.terminal(notice);
    return;
  }
  if (target === "desktop") {
    if (!deliverers.desktop) throw new Error("desktop delivery not available here");
    await deliverers.desktop(notice);
    return;
  }
  if (target.startsWith("channel:")) {
    const channelId = target.slice("channel:".length);
    if (!deliverers.channel) throw new Error(`channel delivery not configured (${channelId})`);
    await deliverers.channel(channelId, notice);
    return;
  }
  throw new Error(`Unknown delivery "${target}"`);
}

export type ProcessLauncher = (command: string, args: readonly string[]) => Promise<void>;

const execFileLauncher: ProcessLauncher = (command, args) => new Promise((resolve, reject) => {
  // execFile: no shell — every argument reaches the program verbatim.
  execFile(command, [...args], { timeout: 10_000 }, (error) => (error ? reject(error) : resolve()));
});

/**
 * Desktop notification without a shell and without splicing the message into
 * script source: AppleScript reads title/message from argv in its run handler;
 * notify-send gets them after `--`.
 */
export function desktopNotifier(options: { platform?: NodeJS.Platform; launch?: ProcessLauncher } = {}): (notice: AutomationNotice) => Promise<void> {
  const platform = options.platform ?? process.platform;
  const launch = options.launch ?? execFileLauncher;
  return async (notice) => {
    if (platform === "darwin") {
      await launch("osascript", [
        "-e", "on run argv",
        "-e", "display notification (item 2 of argv) with title (item 1 of argv)",
        "-e", "end run",
        "--", notice.title, notice.text,
      ]);
      return;
    }
    if (platform === "linux") {
      await launch("notify-send", ["--app-name=Muster", "--", notice.title, notice.text]);
      return;
    }
    throw new Error(`desktop notifications are not supported on ${platform}`);
  };
}

// ── Ticking ─────────────────────────────────────────────────────────────────

export interface AutomationRunOutcome {
  readonly runId: string;
  readonly status: "completed" | "failed";
  readonly text?: string;
  readonly detail?: string;
}

export interface AutomationTickOptions {
  readonly cwd?: string;
  readonly now?: Date;
  readonly deliverers: AutomationDeliverers;
  /** Executes a `run` job (and legacy prompt/flow jobs). Absent → such jobs fail visibly. */
  readonly runPrompt?: (job: ScheduleJob) => Promise<AutomationRunOutcome>;
  /** Jobs this ticker may claim; others stay due for another ticker. */
  readonly only?: (job: ScheduleJob) => boolean;
}

function noticeFor(job: ScheduleJob, text: string, firedAt: Date): AutomationNotice {
  const kind = job.kind ?? "run";
  return { jobId: job.id, kind, title: kind === "reminder" ? "Muster reminder" : "Muster routine", text, firedAt: firedAt.toISOString() };
}

async function executeAutomation(job: ScheduleJob, options: AutomationTickOptions, firedAt: Date): Promise<AutomationRunOutcome> {
  if (job.kind === "reminder") {
    await deliverNotice(job.deliver, noticeFor(job, job.prompt, firedAt), options.deliverers);
    return { runId: `remind_${randomUUID().slice(0, 8)}`, status: "completed", detail: `delivered to ${job.deliver ?? "terminal"}` };
  }
  if (!options.runPrompt) throw new Error("prompt runs happen in `muster daemon` or `muster schedule run-due`");
  const outcome = await options.runPrompt(job);
  if (job.deliver && outcome.text?.trim()) {
    const text = outcome.text.trim();
    await deliverNotice(job.deliver, noticeFor(job, text.length > 2_000 ? `${text.slice(0, 2_000)}…` : text, firedAt), options.deliverers);
  }
  return outcome;
}

/** Run everything due once. Claims are at-most-once across processes. */
export async function runAutomationsTick(options: AutomationTickOptions): Promise<DueJobRun[]> {
  const now = options.now ?? new Date();
  const results = await runDueSchedules(
    (job) => executeAutomation(job, options, now),
    { cwd: options.cwd, now, only: options.only },
  );
  // Disabled jobs are reported as skipped by the scheduler; a tick log is about runs.
  return results.filter((result) => result.status !== "skipped" || result.detail !== "disabled");
}

/** `/schedule run <id>`: run one job now, outside its schedule. A one-off completes. */
export async function runAutomationNow(id: string, options: AutomationTickOptions): Promise<DueJobRun> {
  const job = (await listSchedules(options.cwd)).find((entry) => entry.id === id);
  if (!job) throw new Error(`No automation ${id}.`);
  const now = options.now ?? new Date();
  let outcome: AutomationRunOutcome;
  try {
    outcome = await executeAutomation(job, options, now);
  } catch (error) {
    outcome = { runId: "", status: "failed", detail: error instanceof Error ? error.message : String(error) };
  }
  await recordManualRun(id, { status: outcome.status, runId: outcome.runId || undefined, detail: outcome.detail }, { cwd: options.cwd, now });
  return { job, runId: outcome.runId || undefined, status: outcome.status, detail: outcome.detail };
}

/** One daemon log line per run. */
export function formatAutomationRun(result: DueJobRun, now: Date = new Date()): string {
  const kind = result.job.kind ?? "run";
  const where = result.job.deliver ? ` -> ${result.job.deliver}` : "";
  const detail = result.status === "completed" ? "" : ` (${result.detail ?? result.status})`;
  return `${now.toISOString()} ${result.job.id} ${kind}${where}: ${oneLine(result.job.prompt, 80)} [${result.status}]${detail}`;
}

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

// ── Table ───────────────────────────────────────────────────────────────────

/** `2026-11-10 10:17` in this machine's zone: the clock the reminder card and the user read. */
function shortTime(iso: string | undefined): string {
  if (!iso) return "-";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const two = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())} ${two(date.getHours())}:${two(date.getMinutes())}`;
}

/** The automations table shared by `muster schedule list`, `/schedule list` and the tool. */
export function formatAutomationsTable(jobs: readonly ScheduleJob[], width = Number.POSITIVE_INFINITY): string[] {
  if (!jobs.length) return ["No automations."];
  const rows = jobs.map((job) => [
    job.id,
    job.kind ?? "run",
    job.at ? "once" : `${job.cron}${job.tz ? ` ${job.tz}` : ""}`,
    // A one-off that already ran has no next run: it is done (ENABLED is about routines).
    job.completedAt ? "done" : shortTime(job.at ?? job.nextRunAt),
    shortTime(job.lastRunAt),
    job.lastStatus ? `${job.lastStatus}${job.lastStatus === "failed" && job.lastDetail ? `: ${oneLine(job.lastDetail, 40)}` : ""}` : "-",
    job.completedAt ? "-" : job.disabled ? "no" : "yes",
    job.deliver ?? "log",
    oneLine(job.flowId ? `flow ${job.flowId}` : job.prompt, 48),
  ]);
  const header = ["ID", "KIND", "WHEN", "NEXT RUN", "LAST RUN", "RESULT", "ENABLED", "DELIVER", "WHAT"];
  const widths = header.map((title, column) => Math.max(title.length, ...rows.map((row) => row[column]!.length)));
  // WHAT takes what is left of the row, so the table never wraps.
  const before = widths.slice(0, -1).reduce((sum, size) => sum + size + 2, 0);
  const whatWidth = Math.max(8, width - before);
  const fit = (cell: string) => (cell.length > whatWidth ? `${cell.slice(0, whatWidth - 1)}…` : cell);
  const render = (row: readonly string[]) => row.map((cell, column) => (column === row.length - 1 ? fit(cell) : cell.padEnd(widths[column]!))).join("  ").trimEnd();
  return [render(header), ...rows.map(render)];
}

/** Exactly what was scheduled, for echoes (CLI, chat, tool result). */
export function describeAutomation(job: ScheduleJob): string {
  const when = job.at ? `at ${shortTime(job.at)}` : `on cron "${job.cron}"${job.tz ? ` (${job.tz})` : ""}, next ${shortTime(job.nextRunAt)}`;
  return `Scheduled ${job.id}: ${job.kind ?? "run"} "${job.prompt}" ${when}, delivered to ${job.deliver ?? "log"}.`;
}

// ── Open-chat presence ──────────────────────────────────────────────────────

function presenceDir(cwd: string): string {
  return join(dataDir(cwd), "chat-presence");
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** An open chat announces itself so the daemon leaves terminal reminders to it. Returns the release. */
export function recordChatPresence(cwd = process.cwd(), pid = process.pid): () => void {
  const dir = presenceDir(cwd);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, String(pid));
  writeFileSync(file, new Date().toISOString());
  return () => { try { unlinkSync(file); } catch { /* already gone */ } };
}

export function chatPresent(cwd = process.cwd()): boolean {
  let entries: string[];
  try { entries = readdirSync(presenceDir(cwd)); } catch { return false; }
  return entries.some((name) => /^\d+$/.test(name) && pidAlive(Number(name)));
}

/** The daemon's claim filter: terminal reminders go to an open chat when one is running. */
export function daemonJobFilter(cwd = process.cwd()): (job: ScheduleJob) => boolean {
  return (job) => !(job.kind === "reminder" && (job.deliver ?? "terminal") === "terminal" && chatPresent(cwd));
}

/** An open chat fires reminders; prompt runs stay with the daemon. */
export function chatJobFilter(job: ScheduleJob): boolean {
  return job.kind === "reminder";
}
