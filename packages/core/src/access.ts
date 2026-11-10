/**
 * How much a turn may do without asking. One mode per chat, mapped onto each
 * runtime's own controls (Codex sandbox + approval policy, Claude Code
 * permission mode, pi tool set).
 */
export type AccessMode = "read-only" | "ask" | "auto-edit" | "full";

export const ACCESS_MODES: readonly AccessMode[] = ["read-only", "ask", "auto-edit", "full"];

export function isAccessMode(value: unknown): value is AccessMode {
  return typeof value === "string" && (ACCESS_MODES as readonly string[]).includes(value);
}

export interface ApprovalRequest {
  /** Provider item id; unique per request. */
  readonly id: string;
  readonly kind: "command" | "edit" | "permissions";
  /** The command line, or what the edit/permission is about. */
  readonly title: string;
  readonly reason?: string;
  readonly cwd?: string;
}

/** once / for this session / deny and continue / deny and stop the turn. */
export type ApprovalDecision = "accept" | "acceptForSession" | "decline" | "cancel";

export type CodexSandbox = "read-only" | "workspace-write" | "danger-full-access";

export function codexSandboxForAccess(mode: AccessMode | undefined, fallback?: CodexSandbox): CodexSandbox | undefined {
  switch (mode) {
    case "read-only": return "read-only";
    case "ask":
    case "auto-edit": return "workspace-write";
    case "full": return "danger-full-access";
    default: return fallback;
  }
}

export function claudePermissionModeForAccess(mode: AccessMode | undefined): string | undefined {
  switch (mode) {
    case "read-only": return "plan";
    case "ask": return "default";
    case "auto-edit": return "acceptEdits";
    case "full": return "bypassPermissions";
    default: return undefined;
  }
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

/** Codex app-server approval requests → one provider-neutral shape; undefined for other server requests. */
export function codexApprovalRequest(method: string, params: Record<string, unknown>): ApprovalRequest | undefined {
  const id = text(params.approvalId) ?? text(params.itemId) ?? `${method}:${Date.now()}`;
  const reason = text(params.reason);
  const cwd = text(params.cwd);
  if (method === "item/commandExecution/requestApproval") {
    const command = Array.isArray(params.command) ? params.command.join(" ") : text(params.command) ?? "a command";
    return { id, kind: "command", title: command, ...(reason ? { reason } : {}), ...(cwd ? { cwd } : {}) };
  }
  if (method === "item/fileChange/requestApproval") {
    const root = text(params.grantRoot);
    return { id, kind: "edit", title: root ? `write under ${root}` : "file changes", ...(reason ? { reason } : {}) };
  }
  if (method === "item/permissions/requestApproval") {
    return { id, kind: "permissions", title: reason ?? "extra permissions", ...(reason ? { reason } : {}) };
  }
  return undefined;
}

/**
 * `/bin/zsh -lc 'pytest -q'` → `pytest -q`: what the shell ran, with the
 * wrapper's own quoting undone (inside "…" a backslash escapes \ " $ and `;
 * inside '…' a quote is written '\'').
 */
export function unwrapShellCommand(command: string): string {
  const trimmed = command.trim();
  const quoted = trimmed.match(/^(?:\S*\/)?(?:ba|z)?sh\s+-l?c\s+(['"])([\s\S]*)\1$/);
  if (quoted) {
    const body = quoted[1] === '"'
      ? quoted[2]!.replace(/\\(["\\$`])/g, "$1")
      : quoted[2]!.replace(/'\\''/g, "'");
    return body.trim();
  }
  const bare = trimmed.match(/^(?:\S*\/)?(?:ba|z)?sh\s+-l?c\s+(\S+)$/);
  return (bare?.[1] ?? trimmed).trim();
}

const GIT_SAFE_SUBCOMMANDS = new Set(["add", "commit", "stash", "checkout", "switch", "branch", "restore", "reset", "mv", "rm", "tag", "merge", "rebase", "cherry-pick", "revert", "status", "diff", "log", "show", "init", "worktree", "apply", "am", "notes", "fetch", "pull"]);

/**
 * Auto-edit's one escalation: git that stays on this machine (Codex keeps
 * `.git` read-only in the workspace sandbox, so a commit needs approval).
 * Every `&&`/`;`/`|` segment must be a local git subcommand; `git push` and
 * anything else is not.
 */
export function isWorkspaceGitCommand(command: string, cwd: string | undefined, workspace: string): boolean {
  if (cwd && !(cwd === workspace || cwd.startsWith(`${workspace}/`))) return false;
  const quoted = command.trim().match(/^(?:\S*\/)?(?:ba|z)?sh\s+-l?c\s+(['"])([\s\S]*)\1$/);
  const body = quoted ? quoted[2]! : command;
  if (/[`$<>]|\$\(/.test(body)) return false;
  const segments = body.split(/&&|;|\|\||\n/).map((segment) => segment.trim()).filter(Boolean);
  if (!segments.length) return false;
  return segments.every((segment) => {
    const words = segment.split(/\s+/);
    if (words[0] !== "git") return false;
    const sub = words.slice(1).find((word) => !word.startsWith("-"));
    return Boolean(sub && GIT_SAFE_SUBCOMMANDS.has(sub));
  });
}
