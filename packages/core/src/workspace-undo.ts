/**
 * Undo a turn: put back every file the observer saw change, by reverse-applying
 * its recorded diffs newest first. A file whose current bytes no longer match
 * the turn's last recorded state was changed afterwards and is left alone.
 */
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { countDiffLines } from "./workspace-undo-stat.js";
import { hashBytes, type WorkspacePatchEvent } from "./workspace-observer.js";

export interface UndoFileResult {
  readonly path: string;
  readonly additions: number;
  readonly deletions: number;
  /** removed: the turn created the file; restored: the turn deleted it; reverted: the turn edited it. */
  readonly effect: "removed" | "restored" | "reverted";
}

export interface UndoResult {
  readonly restored: readonly UndoFileResult[];
  readonly skipped: readonly { readonly path: string; readonly reason: string }[];
}

async function currentHash(root: string, path: string): Promise<string | null> {
  try {
    return hashBytes(await readFile(join(root, path)));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function gitApplyReverse(root: string, diff: string): Promise<{ ok: boolean; error: string }> {
  return new Promise((resolve) => {
    const child = spawn("git", ["apply", "-R", "--whitespace=nowarn", "-"], { cwd: root, stdio: ["pipe", "ignore", "pipe"] });
    let error = "";
    child.stderr.on("data", (chunk: Buffer) => { error += chunk.toString(); });
    child.on("error", (spawnError) => resolve({ ok: false, error: spawnError.message }));
    child.on("close", (code) => resolve({ ok: code === 0, error: error.trim() }));
    child.stdin.end(diff.endsWith("\n") ? diff : `${diff}\n`);
  });
}

export async function undoWorkspacePatches(events: readonly WorkspacePatchEvent[]): Promise<UndoResult> {
  const byPath = new Map<string, WorkspacePatchEvent[]>();
  for (const event of [...events].sort((left, right) => left.sequence - right.sequence)) {
    const key = `${event.root}\u0000${event.path}`;
    const list = byPath.get(key) ?? [];
    list.push(event);
    byPath.set(key, list);
  }
  const restored: UndoFileResult[] = [];
  const skipped: Array<{ path: string; reason: string }> = [];
  for (const list of byPath.values()) {
    const last = list[list.length - 1]!;
    const { root, path } = last;
    if (list.some((event) => event.diff === null || event.diff === undefined)) {
      skipped.push({ path, reason: list.find((event) => !event.diff)?.diffOmitted ? `no diff recorded (${list.find((event) => !event.diff)!.diffOmitted})` : "no diff recorded" });
      continue;
    }
    if ((await currentHash(root, path)) !== last.afterHash) {
      skipped.push({ path, reason: "changed since the turn" });
      continue;
    }
    let failed: string | undefined;
    for (const event of [...list].reverse()) {
      const applied = await gitApplyReverse(root, event.diff!);
      if (!applied.ok) {
        failed = applied.error || "git apply -R failed";
        break;
      }
    }
    if (failed) {
      skipped.push({ path, reason: failed });
      continue;
    }
    const totals = list.reduce((sum, event) => {
      const stat = countDiffLines(event.diff!);
      return { additions: sum.additions + stat.additions, deletions: sum.deletions + stat.deletions };
    }, { additions: 0, deletions: 0 });
    const first = list[0]!;
    const effect = first.changeKind === "add" || (first.beforeHash === null && first.changeKind !== "rename")
      ? "removed"
      : last.changeKind === "delete" ? "restored" : "reverted";
    restored.push({ path, ...totals, effect });
  }
  return { restored, skipped };
}
