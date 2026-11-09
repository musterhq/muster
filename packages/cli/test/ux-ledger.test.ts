import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import type { BackendEcosystem, InheritedPlugin } from "@musterhq/core";
import { buildCapabilityOverlayOptions } from "../src/capabilities-overlay.js";
import { CHAT_COMMANDS, directPluginCommand, dynamicPluginCommands, pickerClassInvocations } from "../src/chat-command-catalog.js";
import { unknownSlashCommandMessage } from "../src/command-suggestion.js";
import { threadConflictCure } from "../src/thread-conflict.js";

const execFileAsync = promisify(execFile);
const cliPath = resolve(import.meta.dirname, "..", "src", "index.ts");
const tsxImport = import.meta.resolve("tsx");
const packageVersion = (JSON.parse(await readFile(resolve(import.meta.dirname, "..", "package.json"), "utf8")) as { version: string }).version;

test("unknown in-chat command suggests the nearest slash command on one line", async () => {
  assert.equal(unknownSlashCommandMessage("modle", CHAT_COMMANDS.flatMap((command) => [command.name, ...(command.aliases ?? [])])), "unknown command /modle — did you mean /model?");
  const cwd = await mkdtemp(join(tmpdir(), "muster-unknown-chat-"));
  const result = await runCli(["chat", "/modle"], cwd);
  assert.equal(result.stdout.trim(), "unknown command /modle — did you mean /model?");
});

test("unknown shell command suggests the nearest command and distant input points to help", async () => {
  const typo = await runCliFailure(["modle"]);
  assert.equal(typo.code, 1);
  assert.equal(typo.stderr.trim().split(/\r?\n/).at(-1), "unknown command modle — did you mean model?");
  const distant = await runCliFailure(["zzzzzzzz"]);
  assert.equal(distant.stderr.trim().split(/\r?\n/).at(-1), "unknown command zzzzzzzz — try muster --help");
});

test("working-set overlay stays compact and keeps the not-installed catalog behind /tools all", () => {
  const active = ["documents", "pdf", "spreadsheets", "presentations", "computer-use"].map((name): InheritedPlugin => ({
    backend: "codex", id: `${name}@fixture`, status: "active", displayName: title(name), shortDescription: `Use ${title(name)} files`,
  }));
  const unavailable = Array.from({ length: 240 }, (_, index): InheritedPlugin => ({
    backend: "codex", id: `catalog-${index}@fixture`, status: "unreachable", detail: "not installed",
  }));
  const extraInstalled = Array.from({ length: 30 }, (_, index): InheritedPlugin => ({
    backend: "codex", id: `installed-${index}@fixture`, status: "active", shortDescription: `Use installed plugin ${index}`,
  }));
  const ecosystem: BackendEcosystem = {
    codex: {
      available: true,
      plugins: [...active, ...extraInstalled, ...unavailable],
      mcpServers: [
        { backend: "codex", name: "local-docs", transport: "http", status: "active", directlyReachable: false },
        { backend: "codex", name: "login-needed", transport: "http", status: "needs-auth", directlyReachable: false },
        ...Array.from({ length: 20 }, (_, index) => ({ backend: "codex" as const, name: `down-${index}`, transport: "http" as const, status: "unreachable" as const, directlyReachable: false })),
      ],
      computerUse: { installed: true, enabled: true, configDeclared: true, detail: "installed, enabled" },
      errors: [],
    },
    claude: { available: false, mcpServers: [], errors: [] },
    discoveredAt: "2026-08-28T00:00:00.000Z",
  };
  const working = buildCapabilityOverlayOptions(ecosystem, {
    toolsets: ["core", "full", "files", "web", "memory", "sessions", "shell", "results", "discovery"],
    skills: [{ value: "release-check", description: "Check a release" }, { value: "review", description: "Review changes" }],
  });
  assert.ok(working.length <= 25, `working set has ${working.length} rows`);
  assert.equal(working.find((row) => row.label === "Documents")?.description, "Use Documents files");
  assert.doesNotMatch(working.map((row) => row.description).join("\n"), /installed, enabled/);
  assert.equal(working.at(-1)?.label, "…240 more not installed");
  assert.match(working.at(-1)?.description ?? "", /\+27 more available · \/tools all/);
  const full = buildCapabilityOverlayOptions(ecosystem, { toolsets: [], skills: [], all: true });
  assert.ok(full.some((row) => row.label === "catalog-239"));
});

test("active inherited plugins register slash commands and construct direct prompts", () => {
  const commands = dynamicPluginCommands([
    { backend: "codex", id: "pdf@runtime", status: "active", displayName: "PDF", shortDescription: "Create and edit PDFs" },
    { backend: "codex", id: "documents@runtime", status: "active", displayName: "Documents", shortDescription: "Create and edit documents" },
    { backend: "codex", id: "spreadsheets@runtime", status: "disabled", displayName: "Spreadsheets", shortDescription: "Edit workbooks" },
  ]);
  assert.deepEqual(commands.map((command) => [command.name, command.description]), [["pdf", "Create and edit PDFs"], ["documents", "Create and edit documents"]]);
  assert.deepEqual(directPluginCommand("pdf", "summarize report.pdf", commands), { kind: "prompt", text: "Use the PDF plugin. summarize report.pdf" });
  assert.deepEqual(directPluginCommand("pdf", "", commands), { kind: "insert", text: "use the PDF plugin to " });
  assert.equal(unknownSlashCommandMessage("pfd", [...CHAT_COMMANDS.map((command) => command.name), ...commands.map((command) => command.name)]), "unknown command /pfd — did you mean /pdf?");
});

test("static slash descriptions contain no internal jargon and remain concise", () => {
  const banned = ["read-model indexing controls", "eval gates", "guided workflow"];
  for (const command of CHAT_COMMANDS) {
    assert.ok(command.description.length <= 60, `${command.name} description is ${command.description.length} chars`);
    for (const phrase of banned) assert.doesNotMatch(command.description.toLowerCase(), new RegExp(phrase));
  }
});

test("picker-class audit enumerates every bare name/id invocation as choices, never Usage", () => {
  const idCommands = CHAT_COMMANDS.filter((command) => /<(?:name|id|taskId|cardId|id-prefix)/i.test(command.usage));
  assert.ok(idCommands.length > 0);
  assert.ok(idCommands.every((command) => command.bareBehavior === "picker" && command.pickerInvocations?.length));
  assert.deepEqual(pickerClassInvocations(), [
    "/provider",
    "/schedule remove",
    "/schedule run",
    "/tasks why",
    "/tasks assign",
    "/resume",
    "/codex",
    "/name",
  ]);
  for (const invocation of pickerClassInvocations()) assert.doesNotMatch(invocation, /Usage:/);
});

test("help has no banner and reports the package version", async () => {
  for (const argument of ["--help", "-h", "help"]) {
    const result = await runCli([argument]);
    assert.match(result.stdout, new RegExp(`^Muster v${packageVersion.replace(/\./g, "\\.")}\\n`));
    assert.doesNotMatch(result.stdout, /██|╔|So far:/);
  }
});

test("thread conflict cure distinguishes native and imported Codex conversations", () => {
  assert.equal(threadConflictCure(false), "/reset clears this conversation's provider thread");
  assert.match(threadConflictCure(true), /--fork/);
});

function title(value: string): string {
  return value.split("-").map((part) => part[0]?.toUpperCase() + part.slice(1)).join(" ");
}

async function runCli(args: readonly string[], cwd = process.cwd()): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(process.execPath, ["--import", tsxImport, cliPath, ...args], {
    cwd,
    env: { ...process.env, NO_COLOR: "1", MUSTER_ONBOARDING_HOME: join(cwd, ".home") },
    timeout: 20_000,
    maxBuffer: 4 * 1024 * 1024,
  });
}

async function runCliFailure(args: readonly string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    await runCli(args);
    throw new Error("expected command to fail");
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; code?: number };
    return { stdout: failure.stdout ?? "", stderr: failure.stderr ?? "", code: failure.code ?? 0 };
  }
}
