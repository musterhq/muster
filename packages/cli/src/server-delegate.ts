/**
 * `muster server ...` — thin delegate to the self-hosted Muster Server.
 *
 * The server ships as a separate package (`muster-server`, from
 * musterhq/muster-code packages/server). This module only locates that
 * executable and forwards every argument verbatim: stdio is inherited, the
 * exit code and any terminating signal are propagated. No shell is involved.
 */

import { spawn } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { delimiter, isAbsolute, join, resolve } from "node:path";

export const SERVER_BIN_NAME = "muster-server";
export const SERVER_BIN_ENV = "MUSTER_SERVER_BIN";
export const SERVER_RELEASES_URL = "https://github.com/musterhq/muster-code/releases";
export const SERVER_DOCS_URL = "https://github.com/musterhq/muster-code/blob/main/docs/server.md";
/** Conventional shell exit code for "command not found". */
export const SERVER_NOT_FOUND_EXIT_CODE = 127;

export const SERVER_USAGE_LINES = [
  "muster server init | start [--host H] [--port P] [--data-dir DIR] [--allowed-host H] [--tls-cert F --tls-key F] | stop | status | doctor",
  "muster server invite [--role R] [--expires D] | users list|role|revoke | token create|revoke",
  "muster server connectors add|list|test|route|remove|import-gateway",
  "muster server cost report [--since D] [--by user|project] | audit verify   # every command takes --json",
];

export interface ServerDelegateEnv {
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
}

function isRunnableFile(path: string, platform: NodeJS.Platform): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    if (platform !== "win32") accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Resolve the muster-server executable: MUSTER_SERVER_BIN first, then PATH. */
export function resolveServerBinary(options: ServerDelegateEnv = {}): string | undefined {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const override = env[SERVER_BIN_ENV]?.trim();
  if (override) {
    // An explicit override is authoritative: never silently fall back to PATH.
    const candidate = resolve(override);
    return isRunnableFile(candidate, platform) ? candidate : undefined;
  }
  const pathValue = env.PATH ?? env.Path ?? "";
  const extensions = platform === "win32"
    ? ["", ...(env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)]
    : [""];
  for (const dir of pathValue.split(delimiter)) {
    if (!dir) continue;
    const base = isAbsolute(dir) ? dir : resolve(dir);
    for (const ext of extensions) {
      const candidate = join(base, `${SERVER_BIN_NAME}${ext}`);
      if (isRunnableFile(candidate, platform)) return candidate;
    }
  }
  return undefined;
}

function platformTarget(platform: NodeJS.Platform, arch: string): string {
  const os = platform === "win32" ? "windows" : platform;
  return `${os}-${arch}`;
}

export function serverInstallSteps(platform: NodeJS.Platform = process.platform, arch: string = process.arch): string[] {
  const asset = `muster-server-<version>-${platformTarget(platform, arch)}.tar.gz`;
  return [
    `Download ${asset} from ${SERVER_RELEASES_URL} and verify it against SHA256SUMS, then extract it and add its bin/ directory to PATH.`,
    `Or run the Docker image: see ${SERVER_DOCS_URL}`,
    `Or point ${SERVER_BIN_ENV} at an existing ${SERVER_BIN_NAME} executable.`,
  ];
}

function renderInstallText(): string {
  return [
    `${SERVER_BIN_NAME} is not installed. Install the self-hosted Muster Server:`,
    ...serverInstallSteps().map((step, index) => `  ${index + 1}. ${step}`),
  ].join("\n");
}

function wantsHelp(args: readonly string[]): boolean {
  return args.includes("--help") || args.includes("-h");
}

function wantsJson(args: readonly string[]): boolean {
  return args.includes("--json");
}

function reportNotInstalled(args: readonly string[]): number {
  if (wantsJson(args)) {
    console.log(JSON.stringify({ ok: false, error: "muster-server not installed", install: serverInstallSteps() }));
  } else {
    console.error(renderInstallText());
  }
  return SERVER_NOT_FOUND_EXIT_CODE;
}

function printServerHelp(): void {
  console.log(["muster server <args...>   # delegates to the self-hosted Muster Server (muster-server)", "", "Usage:", ...SERVER_USAGE_LINES.map((l) => `  ${l}`)].join("\n"));
  console.log(`\nDocs: ${SERVER_DOCS_URL}`);
}

function spawnOptionsFor(binary: string, platform: NodeJS.Platform): { command: string; shell: boolean } {
  // Node refuses to spawn .cmd/.bat without a shell on Windows (CVE-2024-27980).
  const needsShell = platform === "win32" && /\.(cmd|bat)$/i.test(binary);
  return { command: binary, shell: needsShell };
}

function quoteWindowsArg(arg: string): string {
  return /^[A-Za-z0-9_\-./:=@]+$/.test(arg) ? arg : `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1")}"`;
}

/**
 * Run `muster server <args>`. Resolves with the exit code the CLI should use.
 * Interrupts are forwarded to the child; a child killed by a signal maps to 128+n.
 */
export function runServerDelegate(args: readonly string[], options: ServerDelegateEnv = {}): Promise<number> {
  const platform = options.platform ?? process.platform;
  const binary = resolveServerBinary(options);
  if (!binary) {
    if (wantsHelp(args) && !wantsJson(args)) {
      // Help must stay useful without the binary: command list plus install steps.
      printServerHelp();
      console.log(`\n${renderInstallText()}`);
      return Promise.resolve(0);
    }
    return Promise.resolve(reportNotInstalled(args));
  }
  const { command, shell } = spawnOptionsFor(binary, platform);
  const spawnArgs = shell ? args.map(quoteWindowsArg) : [...args];
  return new Promise<number>((resolvePromise) => {
    const child = spawn(shell ? quoteWindowsArg(command) : command, spawnArgs, {
      stdio: "inherit",
      shell,
      env: options.env ?? process.env,
    });
    // Forward interrupts so Ctrl-C / `kill` reach the server, not just this wrapper.
    const forwarded: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];
    const handlers = forwarded.map((signal) => {
      const handler = () => { child.kill(signal); };
      process.on(signal, handler);
      return [signal, handler] as const;
    });
    const cleanup = () => { for (const [signal, handler] of handlers) process.off(signal, handler); };
    child.once("error", (error) => {
      cleanup();
      console.error(`muster server: failed to start ${binary}: ${error.message}`);
      resolvePromise(126);
    });
    child.once("close", (code, signal) => {
      cleanup();
      if (signal) {
        // Conventional 128+n so the parent shell still sees the termination.
        const n = SIGNAL_NUMBERS[signal] ?? 15;
        resolvePromise(128 + n);
        return;
      }
      resolvePromise(code ?? 1);
    });
  });
}

const SIGNAL_NUMBERS: Record<string, number> = { SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGKILL: 9, SIGTERM: 15 };
