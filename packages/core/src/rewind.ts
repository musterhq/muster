/**
 * Rewind: go back to just before an earlier turn. The files that turn and
 * every later turn changed are put back (newest first, via the observer's
 * recorded diffs), and the provider conversation forgets those turns.
 */
import type { WorkspacePatchEvent } from "./workspace-observer.js";
import { undoWorkspacePatches, type UndoResult } from "./workspace-undo.js";

export interface RecordedTurn {
  readonly prompt: string;
  /** Muster's run id: rewinding forgets the turn's automatic memory (forgetTurnMemories). */
  readonly runId?: string;
  /** Provider ids, when the runtime reports them (Codex app-server). */
  readonly providerTurnId?: string;
  readonly threadId?: string;
  readonly patches: readonly WorkspacePatchEvent[];
}

export interface RewindResult {
  /** The prompt of the turn rewound to, for the composer. */
  readonly prompt: string;
  readonly files: UndoResult;
  /** reverted: the provider thread dropped the turns; fresh: the caller must start a new provider thread. */
  readonly conversation: "reverted" | "fresh";
  /** Turns kept before the target. */
  readonly remainingTurns: number;
}

export async function rewindTurns(
  turns: readonly RecordedTurn[],
  targetIndex: number,
  options: { readonly revertThread?: (threadId: string, beforeTurnId: string) => Promise<boolean> } = {},
): Promise<RewindResult> {
  const target = turns[targetIndex];
  if (!target) throw new Error(`No turn ${targetIndex + 1} to rewind to.`);
  const files = await undoWorkspacePatches(turns.slice(targetIndex).flatMap((turn) => turn.patches));
  let conversation: RewindResult["conversation"] = "fresh";
  if (target.threadId && target.providerTurnId && options.revertThread) {
    const reverted = await options.revertThread(target.threadId, target.providerTurnId).catch(() => false);
    if (reverted) conversation = "reverted";
  }
  return { prompt: target.prompt, files, conversation, remainingTurns: targetIndex };
}
