/**
 * Typed hook bus — the extensibility seam, in-repo only (no runtime plugin
 * installs; see docs/teardowns/OPENCLAW_TEARDOWN.md "plugin runtime").
 * Decision hooks may pass, block (terminal), or rewrite their payload.
 * A handler that throws or exceeds its timeout counts as "pass" and its
 * warning is collected on the outcome — hooks must never wedge a turn.
 */

export type HookName =
  | "prompt.build"
  | "turn.start"
  | "turn.end"
  | "tool.before"
  | "tool.after"
  | "outbound.before"
  | "compaction.before"
  | "session.start"
  | "session.end";

export interface HookDecision<T> {
  readonly action: "pass" | "block" | "rewrite";
  readonly patch?: T;
  readonly reason?: string;
}

export type HookHandler<T> = (payload: T) => HookDecision<T> | Promise<HookDecision<T>>;

export interface HookRegistration {
  readonly priority?: number;
  readonly timeoutMs?: number;
}

export interface HookOutcome<T> {
  readonly action: "pass" | "block";
  readonly payload: T;
  readonly blockedBy?: string;
  readonly reason?: string;
  readonly warnings: string[];
}

interface RegisteredHook {
  readonly id: string;
  readonly handler: HookHandler<unknown>;
  readonly priority: number;
  readonly timeoutMs: number;
  readonly seq: number;
}

const DEFAULT_TIMEOUT_MS = 5_000;

export interface HookBus {
  on<T>(name: HookName, handler: HookHandler<T>, options?: HookRegistration & { id?: string }): () => void;
  emit<T>(name: HookName, payload: T): Promise<HookOutcome<T>>;
  count(name?: HookName): number;
}

export function createHookBus(): HookBus {
  const hooks = new Map<HookName, RegisteredHook[]>();
  let sequence = 0;

  return {
    on(name, handler, options = {}) {
      const entry: RegisteredHook = {
        id: options.id ?? `${name}#${sequence}`,
        handler: handler as HookHandler<unknown>,
        priority: options.priority ?? 0,
        timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        seq: sequence += 1,
      };
      const list = hooks.get(name) ?? [];
      list.push(entry);
      list.sort((a, b) => b.priority - a.priority || a.seq - b.seq);
      hooks.set(name, list);
      return () => {
        const current = hooks.get(name) ?? [];
        hooks.set(name, current.filter((item) => item !== entry));
      };
    },

    async emit<T>(name: HookName, payload: T): Promise<HookOutcome<T>> {
      const warnings: string[] = [];
      let current = payload;
      for (const hook of hooks.get(name) ?? []) {
        let decision: HookDecision<unknown>;
        try {
          decision = await withTimeout(Promise.resolve(hook.handler(current)), hook.timeoutMs);
        } catch (error) {
          warnings.push(`hook ${hook.id} ${error instanceof Error && error.message === "hook_timeout" ? `timed out after ${hook.timeoutMs}ms` : `failed: ${error instanceof Error ? error.message : String(error)}`}; treated as pass`);
          continue;
        }
        if (decision.action === "block") {
          return { action: "block", payload: current, blockedBy: hook.id, reason: decision.reason, warnings };
        }
        if (decision.action === "rewrite" && decision.patch !== undefined) {
          current = decision.patch as T;
        }
      }
      return { action: "pass", payload: current, warnings };
    },

    count(name) {
      if (name) return (hooks.get(name) ?? []).length;
      let total = 0;
      for (const list of hooks.values()) total += list.length;
      return total;
    },
  };
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("hook_timeout")), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

/** Hook ids a code plugin registers under: `plugin:<id>`. */
export const PLUGIN_HOOK_PREFIX = "plugin:";

/** One line for a policy block: `blocked by plugin <id>: <reason>` for plugin hooks, else the reason. */
export function describePolicyBlock(block: { readonly hookId?: string; readonly reason?: string }): string {
  const reason = block.reason ?? "blocked by policy";
  if (block.hookId?.startsWith(PLUGIN_HOOK_PREFIX)) return `blocked by plugin ${block.hookId.slice(PLUGIN_HOOK_PREFIX.length)}: ${reason}`;
  return reason;
}

/** Process-wide default bus used by executeRun when no bus is supplied. */
export const defaultHookBus = createHookBus();
