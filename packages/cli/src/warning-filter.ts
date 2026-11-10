// Node prints "ExperimentalWarning: SQLite is an experimental feature…" the
// moment `node:sqlite` is linked, which happens for every muster command. This
// module must not import anything that loads SQLite: the entry installs it
// before it imports the rest of the CLI.

export function isSqliteExperimentalWarning(warning: Error): boolean {
  return warning.name === "ExperimentalWarning" && /\bSQLite\b/.test(warning.message);
}

let installed = false;

// Replaces Node's default warning printer with one that drops only the SQLite
// experimental warning and prints every other warning the way Node does.
export function installWarningFilter(proc: NodeJS.Process = process): void {
  if (installed) return;
  installed = true;
  proc.removeAllListeners("warning");
  let hinted = false;
  proc.on("warning", (warning: Error & { code?: string; detail?: string }) => {
    if (isSqliteExperimentalWarning(warning)) return;
    if ((proc as NodeJS.Process & { noProcessWarnings?: boolean }).noProcessWarnings || proc.env.NODE_NO_WARNINGS === "1") return;
    if (proc.noDeprecation && warning.name === "DeprecationWarning") return;
    const code = warning.code ? `[${warning.code}] ` : "";
    const trace = proc.traceDeprecation || (proc.execArgv ?? []).includes("--trace-warnings");
    let text = `(node:${proc.pid}) ${code}${trace && warning.stack ? warning.stack : `${warning.name}: ${warning.message}`}\n`;
    if (warning.detail) text += `${warning.detail}\n`;
    if (!trace && !hinted) {
      hinted = true;
      text += `(Use \`node --trace-warnings ...\` to show where the warning was created)\n`;
    }
    proc.stderr.write(text);
  });
}
