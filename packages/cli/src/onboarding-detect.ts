import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** What onboarding learned about one model route on this machine. */
export interface ProviderStatus {
  /** Short badge shown in the provider row (14 columns). */
  readonly badge: string;
  /** True when the route can be used right now without further setup. */
  readonly ready: boolean;
}

export type DetectedProviders = Readonly<Record<string, ProviderStatus>>;

export interface DetectEnvironment {
  readonly env?: NodeJS.ProcessEnv;
  readonly home?: string;
  /** Resolves the version string, or undefined when the command is missing. */
  readonly run?: (command: string) => Promise<string | undefined>;
  readonly exists?: (path: string) => boolean;
}

function defaultRun(command: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(command, ["--version"], { timeout: 2000 }, (error, stdout, stderr) => {
      if (error) resolve(undefined);
      else resolve((stdout || stderr).trim() || "installed");
    });
  });
}

/**
 * Read-only look at the machine: is `codex` / `claude` installed, is there a login
 * file or API key. It never reads credential contents, only whether they exist.
 */
export async function detectProviders(environment: DetectEnvironment = {}): Promise<DetectedProviders> {
  const env = environment.env ?? process.env;
  const home = environment.home ?? homedir();
  const run = environment.run ?? defaultRun;
  const exists = environment.exists ?? existsSync;
  const [codex, claude] = await Promise.all([run("codex"), run("claude")]);
  const result: Record<string, ProviderStatus> = {};
  if (codex === undefined) result.codex = { badge: "not installed", ready: false };
  else if (exists(join(home, ".codex", "auth.json"))) result.codex = { badge: "ready", ready: true };
  else result.codex = { badge: "needs login", ready: false };
  if (claude === undefined) result.claude = { badge: "not installed", ready: false };
  else if (exists(join(home, ".claude", ".credentials.json")) || exists(join(home, ".claude.json"))) result.claude = { badge: "ready", ready: true };
  else result.claude = { badge: "needs login", ready: false };
  result.openai = env.OPENAI_API_KEY ? { badge: "key found", ready: true } : { badge: "no key", ready: false };
  result.anthropic = env.ANTHROPIC_API_KEY ? { badge: "key found", ready: true } : { badge: "no key", ready: false };
  return result;
}
