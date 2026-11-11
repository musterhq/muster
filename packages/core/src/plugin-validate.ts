/**
 * `muster plugins validate`: the gate a code plugin must pass before it goes
 * in a catalog. Each defect is a named finding:
 *
 *   manifest                   an invalid muster.plugin.json field
 *   imports-outside-plugin     a relative or absolute import that leaves the plugin folder
 *   side-effect-on-import      importing the entry wrote a file (or tried to touch one it may not)
 *   missing-register           the entry has no register export
 *   load-failed                the entry could not be imported or register threw
 *   tool-without-input-schema  a tool registered with no inputSchema object
 *   undeclared-registration    a registration whose permission is not declared
 *
 * The entry is imported only inside a throwaway host with no permissions (no
 * env, no network, read access to the plugin folder and a fresh temp folder,
 * write access to that temp folder only). Side effects are found by listing
 * the plugin folder and the temp folder before and after the import.
 */
import { mkdtemp, readdir, readFile, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { createPluginHost, type PluginRegistration } from "./plugin-host.js";
import { readCodePluginManifest } from "./plugin-manifest.js";

export interface PluginFinding {
  readonly code: "manifest" | "imports-outside-plugin" | "side-effect-on-import" | "missing-register" | "load-failed" | "tool-without-input-schema" | "undeclared-registration";
  readonly message: string;
  readonly field?: string;
}

export interface PluginValidation {
  readonly id?: string;
  readonly findings: readonly PluginFinding[];
  readonly registrations: readonly PluginRegistration[];
}

const SOURCE_EXTENSIONS = new Set([".js", ".mjs", ".cjs"]);
const SPECIFIERS = [
  /\bimport\s+(?:[^'";]*?\s+from\s+)?["']([^"']+)["']/g,
  /\bexport\s+[^'";]*?\s+from\s+["']([^"']+)["']/g,
  /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
  /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
];

async function sourceFiles(root: string, dir = root, depth = 0): Promise<string[]> {
  if (depth > 12) return [];
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...await sourceFiles(root, path, depth + 1));
    else if (entry.isFile() && SOURCE_EXTENSIONS.has(extname(entry.name))) found.push(path);
  }
  return found;
}

/** Every file under `dir` with its size and mtime, for a before/after diff. */
async function snapshot(dir: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  const visit = async (current: string, depth: number): Promise<void> => {
    if (depth > 12) return;
    for (const entry of await readdir(current, { withFileTypes: true }).catch(() => [])) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) await visit(path, depth + 1);
      else {
        const info = await stat(path).catch(() => undefined);
        files.set(relative(dir, path), info ? `${info.size}:${info.mtimeMs}` : "?");
      }
    }
  };
  await visit(dir, 0);
  return files;
}

function changes(before: Map<string, string>, after: Map<string, string>): string[] {
  const changed: string[] = [];
  for (const [path, signature] of after) if (before.get(path) !== signature) changed.push(path);
  for (const path of before.keys()) if (!after.has(path)) changed.push(`${path} (deleted)`);
  return changed.sort();
}

export async function validateCodePlugin(dir: string): Promise<PluginValidation> {
  const root = await realpath(resolve(dir)).catch(() => resolve(dir));
  const report = await readCodePluginManifest(root);
  const findings: PluginFinding[] = report.errors.map((error) => ({ code: "manifest", field: error.field, message: error.message }));
  if (!report.manifest) return { ...(report.id ? { id: report.id } : {}), findings, registrations: [] };
  const manifest = report.manifest;

  // Static: imports that leave the folder.
  for (const file of await sourceFiles(root)) {
    const text = await readFile(file, "utf8").catch(() => "");
    for (const pattern of SPECIFIERS) {
      for (const match of text.matchAll(pattern)) {
        const specifier = match[1]!;
        const target = specifier.startsWith("file:") ? undefined : specifier.startsWith(".") ? resolve(dirname(file), specifier) : isAbsolute(specifier) ? specifier : null;
        if (target === null) continue;
        const rel = target === undefined ? ".." : relative(root, target);
        if (rel.startsWith("..") || isAbsolute(rel)) {
          findings.push({ code: "imports-outside-plugin", message: `${relative(root, file)} imports ${specifier}, outside the plugin folder` });
        }
      }
    }
  }

  // Dynamic: import the entry in a throwaway host and look for side effects.
  const scratch = await realpath(await mkdtemp(join(tmpdir(), "muster-plugin-validate-")));
  const host = createPluginHost({ root, manifest, workspace: scratch, mode: "validate", timeoutMs: Math.min(manifest.timeoutMs ?? 10_000, 10_000) });
  let registrations: PluginRegistration[] = [];
  try {
    const before = new Map([...await snapshot(root)].map(([path, signature]) => [`plugin/${path}`, signature]));
    for (const [path, signature] of await snapshot(scratch)) before.set(`temp/${path}`, signature);
    let imported: { hasRegister: boolean } | undefined;
    try {
      imported = await host.importOnly();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      findings.push(/ERR_ACCESS_DENIED|restricted|ERR_PLUGIN_PERMISSION/.test(message)
        ? { code: "side-effect-on-import", message: `importing the entry tried something a plugin may not do: ${message.slice(0, 300)}` }
        : { code: "load-failed", message: `the entry could not be imported: ${message.slice(0, 300)}` });
    }
    const after = new Map([...await snapshot(root)].map(([path, signature]) => [`plugin/${path}`, signature]));
    for (const [path, signature] of await snapshot(scratch)) after.set(`temp/${path}`, signature);
    for (const path of changes(before, after)) findings.push({ code: "side-effect-on-import", message: `importing the entry wrote ${path}` });
    if (imported && !imported.hasRegister) findings.push({ code: "missing-register", message: "the entry has no register(ctx) export" });
    if (imported?.hasRegister) {
      try {
        registrations = [...await host.registerOnly()];
      } catch (error) {
        findings.push({ code: "load-failed", message: `register(ctx) threw: ${(error instanceof Error ? error.message : String(error)).slice(0, 300)}` });
      }
    }
  } finally {
    await host.stop();
    await rm(scratch, { recursive: true, force: true });
  }

  const declared = new Set(manifest.permissions);
  for (const registration of registrations) {
    const needs = registration.kind === "tool" ? "tools" : registration.kind === "command" ? "commands" : `hooks:${registration.name}`;
    if (!declared.has(needs)) findings.push({ code: "undeclared-registration", message: `${registration.kind} ${registration.name} needs permission ${needs}, which is not declared` });
    const schema = registration.inputSchema;
    if (registration.kind === "tool" && (!schema || typeof schema !== "object" || Array.isArray(schema))) {
      findings.push({ code: "tool-without-input-schema", message: `tool ${registration.name} has no inputSchema object` });
    }
  }
  return { id: manifest.id, findings, registrations };
}
