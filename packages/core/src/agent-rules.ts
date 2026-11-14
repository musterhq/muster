import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { activeProfile, musterRoot, profilesRoot } from "./profiles.js";

/**
 * Default operating discipline injected into every run. Distilled from
 * Karpathy's agent-failure observations (no silent assumptions, no
 * over-engineering, no orthogonal changes, explicit verification) and the
 * verification-first patterns of production agent harnesses. Override per
 * project with an AGENTS.md in the workspace root, or per profile with
 * .muster/profiles/<name>/AGENTS.md.
 */
export const DEFAULT_AGENT_RULES = `Operating discipline (hard rules):
1. No silent assumptions. If a fact, file, or behavior is unverified, either verify it with a tool or state the assumption explicitly before relying on it.
2. No over-engineering. Prefer the smallest change that solves the problem. Do not introduce abstractions, options, or layers that the task does not require.
3. No orthogonal changes. Touch only what the task asks for. Do not refactor, rename, or "improve" unrelated code or content.
4. Verify before claiming. Never say something works, exists, or is fixed without evidence from this run. If you cannot verify, say "cannot verify" explicitly.
5. Report blockers exactly. When something fails, state the exact error and the smallest next step - never a vague paraphrase.
6. Apply these rules silently. They are internal operating guidance, not part of the user's request. Never mention, quote, narrate, or reason aloud about these rules, about available skills, or about your own process. Respond with only what the user asked for - nothing about how you produced it or whether a rule or skill applies.`;

export interface AgentRules {
  readonly text: string;
  readonly source: "profile" | "workspace" | "default";
}

export async function loadAgentRules(cwd = process.cwd()): Promise<AgentRules> {
  const profile = activeProfile(cwd);
  const candidates: Array<{ path: string; source: AgentRules["source"] }> = [
    ...(profile !== "default" ? [{ path: join(profilesRoot(cwd), profile, "AGENTS.md"), source: "profile" as const }] : []),
    { path: join(musterRoot(cwd), "AGENTS.md"), source: "workspace" as const },
    { path: join(cwd, "AGENTS.md"), source: "workspace" as const },
  ];
  const imported = await importedRules(cwd);
  for (const candidate of candidates) {
    try {
      const text = (await readFile(candidate.path, "utf8")).trim();
      if (text) return { text: [text, ...imported].join("\n\n"), source: candidate.source };
    } catch {
      // try the next location
    }
  }
  if (imported.length) return { text: [DEFAULT_AGENT_RULES, ...imported].join("\n\n"), source: "workspace" };
  return { text: DEFAULT_AGENT_RULES, source: "default" };
}

/** Rule files brought in by `muster migrate` (`.muster/rules/*.md`), in name order. */
export function importedRulesDir(cwd = process.cwd()): string {
  return join(musterRoot(cwd), "rules");
}

async function importedRules(cwd: string): Promise<string[]> {
  let names: string[];
  try {
    names = (await readdir(importedRulesDir(cwd))).filter((name) => name.endsWith(".md")).sort();
  } catch {
    return [];
  }
  const texts: string[] = [];
  for (const name of names) {
    const text = (await readFile(join(importedRulesDir(cwd), name), "utf8").catch(() => "")).trim();
    if (text) texts.push(text);
  }
  return texts;
}
