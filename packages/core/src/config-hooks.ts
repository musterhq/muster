/**
 * Hooks a user writes in `.muster/config.json` → `hooks`, layered over the
 * in-process hook bus for one run. A rule is declarative (a `match` regex and
 * `action: "block"`) or a `command` that receives the event as JSON on stdin
 * and blocks with exit code 2 (stderr is the reason) or a JSON decision on
 * stdout. Failures and timeouts pass unless the rule is `failClosed`.
 */
import { spawn } from "node:child_process";
import { createHookBus, type HookBus, type HookDecision, type HookName } from "./hooks.js";

export interface HookRule {
  readonly id?: string;
  /** Regex tested against the event's subject (command, prompt, response). */
  readonly match?: string;
  readonly flags?: string;
  readonly action?: "block";
  readonly reason?: string;
  readonly command?: string;
  readonly timeoutMs?: number;
  /** Treat a failing or timed-out command as a block (security-critical rules). */
  readonly failClosed?: boolean;
}

export type HookRules = Partial<Record<HookName, readonly HookRule[]>>;

/** What a rule's `match` is tested against for each event payload. */
function subjectOf(payload: Record<string, unknown>): string {
  for (const key of ["title", "prompt", "responseText"]) {
    const value = payload[key];
    if (typeof value === "string") return value;
  }
  return JSON.stringify(payload);
}

function runCommandHook(rule: HookRule, payload: unknown, cwd: string): Promise<HookDecision<unknown>> {
  const timeoutMs = rule.timeoutMs ?? 5_000;
  return new Promise((resolve) => {
    const fail = (reason: string): void => resolve(rule.failClosed ? { action: "block", reason } : { action: "pass", reason });
    let child;
    try {
      child = spawn("/bin/sh", ["-c", rule.command!], { cwd, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, MUSTER_HOOK_EVENT: String((payload as { event?: unknown }).event ?? "") } });
    } catch (error) {
      fail(`hook ${rule.id ?? "command"} could not start: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      fail(`hook ${rule.id ?? "command"} timed out after ${timeoutMs}ms`);
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on("error", (error) => { clearTimeout(timer); fail(error.message); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 2) return resolve({ action: "block", reason: stderr.trim() || "blocked" });
      if (code !== 0) return fail(`hook ${rule.id ?? "command"} exited ${code}`);
      const text = stdout.trim();
      if (!text) return resolve({ action: "pass" });
      try {
        const parsed = JSON.parse(text) as { decision?: string; reason?: string; patch?: unknown };
        if (parsed.decision === "block") return resolve({ action: "block", reason: parsed.reason ?? "blocked" });
        if (parsed.decision === "rewrite" && parsed.patch !== undefined) return resolve({ action: "rewrite", patch: parsed.patch });
      } catch {
        /* plain output is informational */
      }
      resolve({ action: "pass" });
    });
    child.stdin.on("error", () => { /* a hook that ignores stdin is fine */ });
    child.stdin.end(JSON.stringify(payload));
  });
}

/**
 * A bus for one run: the config rules first (in file order), then whatever the
 * base bus holds. Rules never leak into other runs on the shared default bus.
 */
export function withConfigHooks(base: HookBus, rules: HookRules | undefined, cwd: string): HookBus {
  if (!rules || !Object.values(rules).some((list) => list?.length)) return base;
  const local = createHookBus();
  for (const [name, list] of Object.entries(rules) as Array<[HookName, readonly HookRule[] | undefined]>) {
    (list ?? []).forEach((rule, index) => {
      const id = rule.id ?? `${name}#${index + 1}`;
      local.on(name, async (payload: Record<string, unknown>) => {
        if (rule.match) {
          let matched = false;
          try {
            matched = new RegExp(rule.match, rule.flags).test(subjectOf(payload));
          } catch {
            matched = false;
          }
          if (!matched) return { action: "pass" };
          if (!rule.command) return rule.action === "block" ? { action: "block", reason: rule.reason ?? "blocked by policy" } : { action: "pass" };
        }
        if (rule.command) return runCommandHook(rule, payload, cwd) as Promise<HookDecision<Record<string, unknown>>>;
        return rule.action === "block" ? { action: "block", reason: rule.reason ?? "blocked by policy" } : { action: "pass" };
      }, { id, timeoutMs: (rule.timeoutMs ?? 5_000) + 1_000 });
    });
  }
  return {
    on: (name, handler, options) => base.on(name, handler, options),
    count: (name) => local.count(name) + base.count(name),
    async emit(name, payload) {
      const first = await local.emit(name, payload);
      if (first.action === "block") return first;
      const second = await base.emit(name, first.payload);
      return { ...second, warnings: [...first.warnings, ...second.warnings] };
    },
  };
}
