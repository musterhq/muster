/**
 * Automations inside an open chat (#165): the chat ticks reminders into its
 * transcript as cards, and `/remind` / `/schedule` manage jobs. Same claims as
 * `muster daemon`, so a reminder is delivered once no matter who ticks.
 */
import {
  chatJobFilter,
  createAutomation,
  describeAutomation,
  desktopNotifier,
  formatAutomationsTable,
  listAutomations,
  recordChatPresence,
  removeSchedule,
  runAutomationNow,
  runAutomationsTick,
  type AutomationDeliverers,
  type AutomationNotice,
} from "@musterhq/core";
import { cardRow, type MusterChatSink } from "./chat-tui.js";

/** How often an open chat checks for due reminders. */
export const CHAT_TICK_MS = 15_000;

function paint(text: string, rgb: string): string {
  if (process.env.NO_COLOR) return text;
  return `\x1b[38;2;${rgb}m${text}\x1b[39m`;
}

function localTime(iso: string): string {
  const date = new Date(iso);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/** The transcript card for a delivered reminder or routine result. */
export function automationCardLines(notice: AutomationNotice): string[] {
  const label = notice.kind === "reminder" ? "Reminder" : "Routine";
  const [first = "", ...more] = notice.text.split(/\r?\n/);
  const lines = [cardRow(`${paint(`◆ ${label}`, "214;170;84")}  ${first}  ${paint(`${localTime(notice.firedAt)} · ${notice.jobId}`, "128;128;128")}`)];
  for (const line of more) lines.push(cardRow(`  ${line}`));
  return ["", ...lines];
}

export interface ChatAutomationsOptions {
  readonly cwd?: string;
  readonly clock?: () => Date;
  /** 0 = no timer (tests tick by hand). */
  readonly intervalMs?: number;
}

export interface ChatAutomationsTicker {
  tick(): Promise<void>;
  stop(): void;
}

/** Start ticking reminders into an open chat; records presence so the daemon defers terminal reminders. */
export function attachChatAutomations(sink: MusterChatSink, options: ChatAutomationsOptions = {}): ChatAutomationsTicker {
  const cwd = options.cwd ?? process.cwd();
  const clock = options.clock ?? (() => new Date());
  const release = recordChatPresence(cwd);
  const notifyDesktop = desktopNotifier();
  const deliverers: AutomationDeliverers = {
    terminal: (notice) => { for (const line of automationCardLines(notice)) sink.appendLine(line); },
    desktop: (notice) => notifyDesktop(notice),
  };
  let busy = false;
  let stopped = false;
  const tick = async () => {
    if (busy || stopped) return;
    busy = true;
    try {
      await runAutomationsTick({ cwd, now: clock(), deliverers, only: chatJobFilter });
    } catch {
      /* a scheduler hiccup never breaks the chat; the next tick retries */
    } finally {
      busy = false;
    }
  };
  const intervalMs = options.intervalMs ?? CHAT_TICK_MS;
  const timer = intervalMs > 0 ? setInterval(() => { void tick(); }, intervalMs) : undefined;
  timer?.unref?.();
  if (intervalMs > 0) void tick();
  return {
    tick,
    stop() {
      if (stopped) return;
      stopped = true;
      if (timer) clearInterval(timer);
      release();
    },
  };
}

export const REMIND_USAGE = "Usage: /remind <when> <message>   e.g. /remind in 10m drink water · /remind 2026-11-09T18:30:00+05:30 call mom";
export const SCHEDULE_USAGE = 'Usage: /schedule [list] | add <when|"cron"> <prompt> | remove <id> | run <id>';

/** Split `in 10m rest…` / `<iso> rest…` / `"cron" rest…` into when + text. */
function splitWhen(args: string): { when?: string; cron?: string; text: string } {
  const trimmed = args.trim();
  const quoted = trimmed.match(/^"([^"]+)"\s+([\s\S]+)$/);
  if (quoted) return { cron: quoted[1], text: quoted[2]!.trim() };
  const relative = trimmed.match(/^(in\s+\d+(?:\.\d+)?\s*[a-z]+)\s+([\s\S]+)$/i);
  if (relative) return { when: relative[1], text: relative[2]!.trim() };
  const iso = trimmed.match(/^(\d{4}-\d{2}-\d{2}T\S+)\s+([\s\S]+)$/);
  if (iso) return { when: iso[1], text: iso[2]!.trim() };
  return { text: trimmed };
}

/** `/remind` and `/schedule`: returns transcript lines. */
export async function handleAutomationCommand(
  name: "remind" | "schedule",
  args: string,
  options: { cwd?: string; now?: Date; deliverers?: AutomationDeliverers } = {},
): Promise<string[]> {
  const cwd = options.cwd ?? process.cwd();
  const now = options.now ?? new Date();
  try {
    if (name === "remind") {
      const parsed = splitWhen(args);
      if (!parsed.when || !parsed.text) return [REMIND_USAGE];
      const job = await createAutomation({ kind: "reminder", text: parsed.text, when: parsed.when, deliver: "terminal", now, cwd });
      return [describeAutomation(job)];
    }
    const [action = "list", ...restParts] = args.trim().split(/\s+/).filter(Boolean);
    const rest = args.trim().slice(action.length).trim();
    if (action === "list") return formatAutomationsTable(await listAutomations(cwd), process.stdout.columns ? process.stdout.columns - 2 : Number.POSITIVE_INFINITY);
    if (action === "add") {
      const parsed = splitWhen(rest);
      if ((!parsed.when && !parsed.cron) || !parsed.text) return [SCHEDULE_USAGE];
      const job = await createAutomation({ kind: "run", text: parsed.text, when: parsed.when, cron: parsed.cron, deliver: "terminal", now, cwd });
      return [describeAutomation(job), "Prompt runs need `muster daemon` (an open chat only fires reminders)."];
    }
    if (action === "remove" && restParts[0]) {
      return [(await removeSchedule(restParts[0], cwd)) ? `Removed ${restParts[0]}` : `No automation ${restParts[0]}`];
    }
    if (action === "run" && restParts[0]) {
      const out: string[] = [];
      const deliverers: AutomationDeliverers = options.deliverers ?? {
        terminal: (notice) => { out.push(...automationCardLines(notice)); },
        desktop: desktopNotifier(),
        channel: async (target, notice) => {
          const slash = target.indexOf("/");
          if (slash <= 0) throw new Error(`Channel delivery needs channel:<channel>/<peer>, got channel:${target}`);
          const { sendToChannel } = await import("@musterhq/gateway");
          await sendToChannel(target.slice(0, slash), target.slice(slash + 1), notice.text, { cwd });
        },
      };
      const result = await runAutomationNow(restParts[0], { cwd, now, deliverers });
      out.push(`${result.job.id}: ${result.status}${result.detail && result.status !== "completed" ? ` (${result.detail})` : ""}`);
      return out;
    }
    return [SCHEDULE_USAGE];
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)];
  }
}
