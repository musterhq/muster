import { spawn } from "node:child_process";

export interface RunSubprocessOptions {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly timeoutMs?: number;
  /** Grace after SIGTERM before SIGKILL. Default 1500ms. */
  readonly killGraceMs?: number;
  readonly maxBuffer?: number;
  /** Called with each complete stdout line as it arrives (streaming JSON output). */
  readonly onStdoutLine?: (line: string) => void;
}

export interface SubprocessResult {
  readonly stdout: string;
  readonly stderr: string;
}

/** An execFile-style error carrying captured output and the timeout/kill flag. */
export interface SubprocessError extends Error {
  stdout?: string;
  stderr?: string;
  code?: string | number | null;
  signal?: NodeJS.Signals | null;
  killed?: boolean;
}

/** ENOENT/EACCES are emitted by spawn before the provider process can accept a turn. */
export function isPreDispatchSpawnError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOENT" || code === "EACCES";
}

/**
 * Spawn a command and collect stdout/stderr, with a NEVER-WEDGE graded teardown:
 * on timeout (or oversized output) the child gets SIGTERM, then SIGKILL after a
 * grace if it ignores SIGTERM, then is unref'd so a stuck child can never keep
 * the host process alive (acpx's terminateAgentProcess; OpenClaw's zombie-port
 * scars #41750/#75366). execFile only ever sends one SIGTERM — a codex/claude
 * child blocked in a native tool or MCP call can outlive it. Resolves like
 * execFile (stdout/stderr on exit 0) and rejects with output attached otherwise.
 */
export function runSubprocess(command: string, args: readonly string[], options: RunSubprocessOptions = {}): Promise<SubprocessResult> {
  const maxBuffer = options.maxBuffer ?? 1024 * 1024 * 16;
  const killGraceMs = options.killGraceMs ?? 1500;
  return new Promise<SubprocessResult>((resolve, reject) => {
    const child = spawn(command, [...args], { cwd: options.cwd, env: options.env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let overflow = false;
    let sigkillTimer: ReturnType<typeof setTimeout> | undefined;

    const fail = (error: SubprocessError): void => {
      if (settled) return;
      settled = true;
      error.stdout = stdout;
      error.stderr = stderr;
      reject(error);
    };

    // Graded teardown: SIGTERM, then SIGKILL after the grace, then detach.
    const terminate = (): void => {
      child.kill("SIGTERM");
      sigkillTimer = setTimeout(() => {
        child.kill("SIGKILL");
        child.unref();
      }, killGraceMs);
    };

    const timer = options.timeoutMs
      ? setTimeout(() => { timedOut = true; terminate(); }, options.timeoutMs)
      : undefined;

    let pendingLine = "";
    const emitLine = (line: string): void => {
      try { options.onStdoutLine?.(line); } catch { /* a listener bug never kills the run */ }
    };
    child.stdout?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stdout += text;
      if (options.onStdoutLine) {
        pendingLine += text;
        let newline = pendingLine.indexOf("\n");
        while (newline >= 0) {
          emitLine(pendingLine.slice(0, newline));
          pendingLine = pendingLine.slice(newline + 1);
          newline = pendingLine.indexOf("\n");
        }
      }
      if (stdout.length > maxBuffer && !overflow) { overflow = true; terminate(); }
    });
    child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

    // A spawn failure (ENOENT/EACCES) emits 'error' — without a listener Node
    // rethrows it as an uncaught exception (same crash class as the MCP fix).
    child.on("error", (error: Error) => {
      if (timer) clearTimeout(timer);
      if (sigkillTimer) clearTimeout(sigkillTimer);
      fail(error as SubprocessError);
    });

    child.on("close", (code, signal) => {
      if (pendingLine) {
        emitLine(pendingLine);
        pendingLine = "";
      }
      if (timer) clearTimeout(timer);
      if (sigkillTimer) clearTimeout(sigkillTimer);
      if (timedOut) {
        const error: SubprocessError = new Error(`Command timed out after ${options.timeoutMs}ms: ${command}`);
        error.killed = true;
        return fail(error);
      }
      if (overflow) {
        return fail(new Error(`Command output exceeded ${maxBuffer} bytes: ${command}`));
      }
      if (code !== 0) {
        const error: SubprocessError = new Error(`Command failed (exit ${code}${signal ? `, ${signal}` : ""}): ${command}`);
        error.code = code;
        error.signal = signal;
        return fail(error);
      }
      if (settled) return;
      settled = true;
      resolve({ stdout, stderr });
    });
  });
}
