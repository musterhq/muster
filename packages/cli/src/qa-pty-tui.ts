import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  createMusterAutocompleteProvider,
  createMusterChatEditor,
  createMusterChatHarness,
  formatUserLine,
  isBareCompletionTrigger,
  isClearComposerKey,
  renderMusterComposer,
  renderTranscriptWindow,
  type MusterAutocompleteOptions,
} from "./chat-tui.js";
import type { RuntimeDoctorStatus } from "@musterhq/core";

const execFileAsync = promisify(execFile);

export interface QaPtyTuiCase {
  readonly id: string;
  readonly status: RuntimeDoctorStatus;
  readonly summary: string;
  readonly screen?: string;
  readonly evidence: Record<string, unknown>;
}

export interface QaPtyTuiResult {
  readonly suite: "pty_tui";
  readonly status: RuntimeDoctorStatus;
  readonly artifactDir: string;
  readonly manifestPath: string;
  readonly casesPath: string;
  readonly screensDir: string;
  readonly cases: readonly QaPtyTuiCase[];
  readonly summary: string;
}

const COMMANDS = [
  { name: "help", usage: "/help", description: "show full chat help", aliases: ["?"] },
  { name: "commands", usage: "/commands", description: "show compact command catalog" },
  { name: "shortcuts", usage: "/shortcuts", description: "show keyboard and routing shortcuts" },
  { name: "status", usage: "/status", description: "show runtime, model, session, token usage" },
  { name: "sessions", usage: "/sessions [limit]", description: "list recent named chats" },
  { name: "resume", usage: "/resume <name|id>", description: "switch to a prior named chat or session id" },
  { name: "name", usage: "/name <name>", description: "switch current reference name" },
  { name: "history", usage: "/history [limit]", description: "show current chat history" },
  { name: "memory", usage: "/memory <query>", description: "search scoped memory" },
  { name: "tools", usage: "/tools [toolset]", description: "list built-in toolsets and tools" },
  { name: "skills", usage: "/skills", description: "show installed and active skills" },
  { name: "plugins", usage: "/plugins", description: "show plugin policy and configured packs" },
  { name: "mcp", usage: "/mcp", description: "show configured MCP servers" },
  { name: "agents", usage: "/agents", description: "list configured runtimes and @agent ids" },
  { name: "tokens", usage: "/tokens [limit]", description: "show token ledger" },
  { name: "new", usage: "/new [name]", description: "start/switch to a fresh named chat" },
  { name: "reset", usage: "/reset", description: "clear provider handles for this named chat" },
  { name: "clear", usage: "/clear", description: "clear the terminal screen" },
  { name: "exit", usage: "/exit", description: "leave chat" },
] as const;

const CATALOG: MusterAutocompleteOptions = {
  commands: COMMANDS,
  toolsets: ["workspace", "memory", "web", "developer"],
  recentSessions: () => ["release-audit", "frappe-context", "daily-ops"],
  providers: () => [
    { value: "codex", label: "* codex", description: "selected · Codex CLI · warm app-server when available" },
    { value: "claude-code", label: "  claude-code", description: "Claude Code local auth" },
    { value: "groq", label: "  groq", description: "fast lightweight prompts · needs GROQ_API_KEY" },
  ],
  models: ({ providerId }) => providerId === "groq"
    ? [{ value: "llama-3.3-70b-versatile", description: "fast cloud route" }]
    : [{ value: "gpt-5.6-sol", description: "selected" }, { value: "gpt-5.6-sol-medium", description: "deeper" }],
  runtimes: () => [{ value: "native" }, { value: "claude-code" }, { value: "codex" }],
  clouds: () => [{ value: "openrouter" }, { value: "anthropic" }, { value: "groq" }],
  speeds: () => [{ value: "fast" }, { value: "session" }, { value: "deep" }],
  skills: () => [{ value: "api-contract-testing" }, { value: "adversarial-ux-test" }],
  plugins: () => [{ value: "web-frameworks" }, { value: "frappe-federated-bridge" }, { value: "mcp-bridge" }],
  mcpServers: () => [{ value: "git" }, { value: "browser" }, { value: "github" }, { value: "notion" }],
  agents: async () => ["review", "research", "qa"],
};

export async function runPtyTuiQa(input: {
  readonly artifactDir: string;
  readonly cliEntry?: string;
}): Promise<QaPtyTuiResult> {
  const artifactDir = input.artifactDir;
  const screensDir = join(artifactDir, "screens");
  await mkdir(screensDir, { recursive: true });
  const cases: QaPtyTuiCase[] = [];

  cases.push(await caseSlashOverlayStable());
  cases.push(await caseEscapeClosesOverlay());
  cases.push(await caseHistoryNavigation());
  cases.push(await casePromptVisibleAfterOutput());
  cases.push(await caseAgentOverlay());
  cases.push(await caseLargeOverlayScroll());
  cases.push(await caseSelectedRowContrast());
  cases.push(await caseProviderModelSpeedWorkflow());
  cases.push(caseCrampedTranscriptReceipts());
  cases.push(caseKeyClassifier());
  cases.push(await caseResponsiveWidths());
  cases.push(await caseRealPtyInteraction(artifactDir, input.cliEntry ?? process.argv[1]));

  for (const testCase of cases) {
    if (testCase.screen) await writeFile(join(screensDir, `${testCase.id}.txt`), `${testCase.screen}\n`, "utf8");
  }

  const status: RuntimeDoctorStatus = cases.every((testCase) => testCase.status === "passed") ? "passed" : "failed";
  const summary = status === "passed"
    ? "PTY/TUI hostile interaction checks passed in the render harness and a real OS pseudo-terminal"
    : "PTY/TUI hostile interaction checks found unstable overlays, rails, history, contrast, provider workflow, prompt persistence, or real PTY behavior";
  const manifestPath = join(artifactDir, "manifest.json");
  const casesPath = join(artifactDir, "cases.jsonl");
  await writeFile(casesPath, `${cases.map((testCase) => JSON.stringify(withoutScreen(testCase))).join("\n")}\n`, "utf8");
  await writeFile(manifestPath, `${JSON.stringify({
    schemaVersion: 1,
    kind: "muster-qa",
    suite: "pty_tui",
    status,
    summary,
    caseCount: cases.length,
    artifacts: { cases: "cases.jsonl", screens: "screens/" },
  }, null, 2)}\n`, "utf8");
  return { suite: "pty_tui", status, artifactDir, manifestPath, casesPath, screensDir, cases, summary };
}

async function caseSlashOverlayStable(): Promise<QaPtyTuiCase> {
  const harness = createMusterChatHarness({ ...CATALOG, width: 110 });
  harness.input("/");
  await settleAutocomplete();
  for (let index = 0; index < 8; index += 1) harness.input("\x1b[B");
  const screen = stripAnsi(harness.visible(110).join("\n"));
  const lines = screen.split("\n");
  const commandRows = lines.filter((line) => /^\s*(?:→\s+|\s{2})\/[a-z]/i.test(line));
  const composerIndex = lines.findIndex((line) => /^❯/.test(line));
  const firstCommandIndex = lines.findIndex((line) => commandRows.includes(line));
  const evidence = {
    commandRows: commandRows.length,
    selectedRows: commandRows.filter((line) => line.trimStart().startsWith("→")).length,
    composerRows: lines.filter((line) => /^❯/.test(line)).length,
    hasMovedSelection: /\/status|\/sessions|\/resume|\/name|\/history/.test(screen),
    popupBorderless: !strayBoxGlyphs(screen),
    listAboveComposer: firstCommandIndex >= 0 && firstCommandIndex < composerIndex,
  };
  return makeCase("slash_overlay_stable", evidence.commandRows === 14 && evidence.selectedRows === 1 && evidence.composerRows === 1 && evidence.hasMovedSelection && evidence.popupBorderless && evidence.listAboveComposer, "slash popup stays one borderless list above the boxed composer through repeated Down arrows", screen, evidence);
}

async function caseEscapeClosesOverlay(): Promise<QaPtyTuiCase> {
  const harness = createMusterChatHarness({ ...CATALOG });
  harness.input("/");
  await settleAutocomplete();
  harness.input("\x1b");
  const screen = stripAnsi(harness.visible(100).join("\n"));
  const evidence = { text: harness.text(), helpRows: count(screen, "/help"), hasRuledPrompt: /^❯/m.test(screen), strayGlyphs: strayBoxGlyphs(screen) };
  return makeCase("escape_closes_bare_completion", evidence.text === "" && evidence.helpRows === 0 && evidence.hasRuledPrompt && !evidence.strayGlyphs, "Escape closes bare slash popup and returns to the empty ruled prompt", screen, evidence);
}

async function caseHistoryNavigation(): Promise<QaPtyTuiCase> {
  const harness = createMusterChatHarness({
    ...CATALOG,
    onSubmit: async (text, sink) => {
      sink.appendLine(`echo:${text}`);
      return true;
    },
  });
  harness.type("first prompt");
  await harness.submit();
  harness.type("second prompt");
  await harness.submit();
  harness.input("\x1b[A");
  const firstRecall = harness.text();
  harness.input("\x1b[A");
  const secondRecall = harness.text();
  harness.input("\x1b[B");
  const downRecall = harness.text();
  const screen = stripAnsi(harness.visible(100).join("\n"));
  const passed = firstRecall === "second prompt" && secondRecall === "first prompt" && downRecall === "second prompt";
  return makeCase("history_navigation", passed, "Up/Down replays prior prompts when completion is closed", screen, { firstRecall, secondRecall, downRecall });
}

async function casePromptVisibleAfterOutput(): Promise<QaPtyTuiCase> {
  const harness = createMusterChatHarness({
    ...CATALOG,
    onSubmit: async (_text, sink) => {
      sink.appendLine("timings total=120ms provider=80ms recall=4ms prompt=3ms persist=2ms planning=1ms");
      sink.appendLine("memory backend=sqlite-fts5 recalled=1 candidates=1 scopes=user:goblin");
      sink.appendLine("done");
      return true;
    },
  });
  harness.type("show status");
  await harness.submit();
  const screen = stripAnsi(harness.visible(100).join("\n"));
  const evidence = {
    composerText: harness.text(),
    // Derived from the renderer's own gutter (formatUserLine), never a literal
    // glyph: the wave-2 transcript restyle moved the user turn from "›" to "> "
    // and a hard-coded fixture reported that restyle as a product failure.
    promptVisible: screen.includes(stripAnsi(formatUserLine("show status"))),
    timingsVisible: screen.includes("timings total=120ms"),
    memoryVisible: screen.includes("memory backend=sqlite-fts5"),
    doneVisible: screen.includes("done"),
  };
  const passed = evidence.composerText === "" && evidence.promptVisible && evidence.timingsVisible && evidence.memoryVisible && evidence.doneVisible;
  return makeCase("prompt_visible_after_output", passed, "submitted prompt remains visible after output and composer clears", screen, evidence);
}

async function caseAgentOverlay(): Promise<QaPtyTuiCase> {
  const harness = createMusterChatHarness({ ...CATALOG });
  harness.input("@");
  await settleAutocomplete();
  harness.input("\x1b[B");
  const screen = stripAnsi(harness.visible(100).join("\n"));
  const evidence = { reviewRows: count(screen, "@review"), reviewVisible: screen.includes("@review"), laterAgentVisible: screen.includes("@research") || screen.includes("@qa") };
  return makeCase("agent_overlay_navigation", evidence.reviewRows === 1 && evidence.reviewVisible && evidence.laterAgentVisible, "@agent popup is visible and navigable", screen, evidence);
}

async function caseLargeOverlayScroll(): Promise<QaPtyTuiCase> {
  const editor = createMusterChatEditor(fakeTui(120, 50));
  const manyCommands = Array.from({ length: 30 }, (_, index) => ({
    name: `cmd${String(index + 1).padStart(2, "0")}`,
    usage: `/cmd${String(index + 1).padStart(2, "0")}`,
    description: `command ${index + 1}`,
  }));
  editor.setAutocompleteProvider(createMusterAutocompleteProvider({ ...CATALOG, commands: manyCommands }));
  editor.handleInput("/");
  await settleAutocomplete();
  for (let index = 0; index < 20; index += 1) editor.handleInput("\x1b[B");
  const screen = stripAnsi(renderMusterComposer(editor, 110).join("\n"));
  const rows = screen.split("\n").filter((line) => /cmd\d\d/.test(line));
  const evidence = { rowCount: rows.length, noCountRow: !/^\s*\d+\/\d+\s*$/m.test(screen), firstRow: rows[0], lastRow: rows.at(-1) };
  return makeCase("large_overlay_scroll_window", rows.length === 14 && evidence.noCountRow && /cmd14/.test(rows[0] ?? "") && /cmd27/.test(rows.at(-1) ?? ""), "large completion lists stay bounded with no count row", screen, evidence);
}

async function caseSelectedRowContrast(): Promise<QaPtyTuiCase> {
  const priorForceColor = process.env.FORCE_COLOR;
  process.env.FORCE_COLOR = "1";
  try {
    const editor = createMusterChatEditor(fakeTui(100, 40));
    editor.setAutocompleteProvider(createMusterAutocompleteProvider(CATALOG));
    editor.handleInput("/");
    await settleAutocomplete();
    const rendered = renderMusterComposer(editor, 90).join("\n");
    const selectedLine = rendered.split("\n").find((line) => line.includes("/help")) ?? "";
    const evidence = {
      // The reference's selection identity: the row goes periwinkle, NO band.
      hasPeriwinkle: selectedLine.includes("\u001b[38;2;176;184;248m"),
      hasReadableForeground: selectedLine.includes("/help"),
      noBand: !selectedLine.includes("\u001b[48;2;48;45;43m"),
    };
    return makeCase("selected_row_contrast", evidence.hasPeriwinkle && evidence.hasReadableForeground && evidence.noBand, "selected completion row paints periwinkle with no background band", stripAnsi(rendered), evidence);
  } finally {
    if (priorForceColor === undefined) delete process.env.FORCE_COLOR;
    else process.env.FORCE_COLOR = priorForceColor;
  }
}

async function caseProviderModelSpeedWorkflow(): Promise<QaPtyTuiCase> {
  const harness = createMusterChatHarness({ ...CATALOG, width: 120 });
  harness.openPicker("/provider");
  await settleAutocomplete();
  const providerScreen = stripAnsi(harness.visible(120).join("\n"));
  harness.input("\x1b[B");
  harness.input("\x1b[B");
  harness.input("\t");
  const providerText = harness.text();
  harness.openPicker("/model");
  await settleAutocomplete();
  const modelScreen = stripAnsi(harness.visible(120).join("\n"));
  harness.input("\t");
  const modelText = harness.text();
  harness.openPicker("/speed");
  await settleAutocomplete();
  harness.input("\x1b[B");
  harness.input("\t");
  const speedText = harness.text();
  const screen = [providerScreen, modelScreen, stripAnsi(harness.visible(120).join("\n"))].join("\n---\n");
  const evidence = {
    providerOverlay: providerScreen.includes("codex") && providerScreen.includes("groq") && count(providerScreen, "codex") >= 1,
    providerApplied: providerText === "/provider groq",
    modelOverlay: modelScreen.includes("gpt-5.6-sol"),
    modelApplied: modelText === "/model gpt-5.6-sol",
    speedApplied: speedText === "/speed session",
  };
  return makeCase(
    "provider_model_speed_workflow",
    Object.values(evidence).every(Boolean),
    "provider, model, and speed pickers apply selected values without duplicate panes",
    screen,
    evidence,
  );
}

function caseCrampedTranscriptReceipts(): QaPtyTuiCase {
  const rendered = renderTranscriptWindow([
    // The real user row, produced by the renderer, so the pin logic is tested
    // against the shipped gutter rather than a copy of it.
    formatUserLine("Reply with exactly: ok"),
    "timings total=8335ms provider=8259ms recall=11ms prompt=5ms persist=56ms planning=2ms",
    "memory backend=sqlite-fts5 recalled=0 candidates=0 scopes=tenant:f2,user:goblin",
    "assistant body line that would otherwise crowd out receipts",
    "ok",
  ], 72, 4).map(stripAnsi);
  const screen = rendered.join("\n");
  const evidence = {
    promptVisible: screen.includes("Reply with exactly"),
    timingsVisible: screen.includes("timings total=8335ms"),
    memoryVisible: screen.includes("memory backend=sqlite-fts5"),
    finalVisible: screen.includes("ok"),
  };
  return makeCase("cramped_transcript_receipts", Object.values(evidence).every(Boolean), "cramped transcript pins prompt, timing, memory receipt, and final answer", screen, evidence);
}

function caseKeyClassifier(): QaPtyTuiCase {
  const evidence = {
    bareSlash: isBareCompletionTrigger("/"),
    bareAgent: isBareCompletionTrigger("@"),
    slashCommandNotBare: !isBareCompletionTrigger("/status"),
    agentTextNotBare: !isBareCompletionTrigger("@review fix this"),
    ctrlU: isClearComposerKey("\x15"),
    plainU: !isClearComposerKey("u"),
  };
  return makeCase("key_classifier", Object.values(evidence).every(Boolean), "Escape and Ctrl+U guards only trigger on the intended composer states", undefined, evidence);
}

async function caseResponsiveWidths(): Promise<QaPtyTuiCase> {
  const widths = [80, 120, 200];
  const checks: Record<string, unknown>[] = [];
  for (const width of widths) {
    const harness = createMusterChatHarness({ ...CATALOG, width });
    harness.input("/");
    await settleAutocomplete();
    const lines = stripAnsi(harness.visible(width).join("\n")).split("\n");
    checks.push({
      width,
      hasRuledPrompt: lines.some((line) => /^❯/.test(line)),
      popupBorderless: !strayBoxGlyphs(lines.join("\n")),
      hasSuggestions: lines.some((line) => line.includes("/help")),
      maxLineWidth: Math.max(...lines.map((line) => line.length)),
    });
  }
  const passed = checks.every((entry) => entry.hasRuledPrompt && entry.popupBorderless && entry.hasSuggestions && Number(entry.maxLineWidth) <= Number(entry.width));
  return makeCase("responsive_widths", passed, "ruled composer and suggestions survive 80, 120, and 200 column widths", checks.map((entry) => JSON.stringify(entry)).join("\n"), { checks });
}

async function caseRealPtyInteraction(artifactDir: string, cliEntry: string): Promise<QaPtyTuiCase> {
  const session = `muster-qa-${process.pid}-${randomUUID().slice(0, 8)}`;
  const workspace = join(artifactDir, "real-pty-workspace");
  await mkdir(workspace, { recursive: true });
  const evidence: Record<string, unknown> = { backend: "tmux", cliEntry };
  const screens: string[] = [];
  try {
    const version = (await execFileAsync("tmux", ["-V"], { timeout: 5_000 })).stdout.trim();
    evidence.backendVersion = version;
    const nodeArgs = process.execArgv.map((arg, index, args) => args[index - 1] === "--import" && arg === "tsx" ? import.meta.resolve("tsx") : arg);
    const command = [
      "env",
      `HOME=${shellQuote(workspace)}`,
      "MUSTER_SKIP_ONBOARDING=1",
      "NO_COLOR=",
      "FORCE_COLOR=1",
      "TERM=xterm-256color",
      shellQuote(process.execPath),
      ...nodeArgs.map(shellQuote),
      shellQuote(cliEntry),
      "--skip-onboarding",
    ].join(" ");
    evidence.stage = "start-session";
    await tmux(["new-session", "-d", "-s", session, "-x", "120", "-y", "40", "-c", workspace, command]);
    evidence.stage = "wait-baseline";
    const baseline = await waitForPtyScreen(session, (screen) => {
      const visible = stripAnsi(screen);
      return /^(?:│ )?❯/m.test(visible);
    });
    screens.push(`baseline\n${stripAnsi(baseline)}`);

    evidence.stage = "open-completion";
    await tmux(["send-keys", "-t", session, "-l", "/"]);
    const overlay = await waitForPtyScreen(session, (screen) => hasSlashCompletionRows(screen) && composerValue(screen) === "/");
    await delay(250);
    const persistentOverlay = await capturePtyScreen(session);
    const selectedBefore = selectedSuggestion(overlay);
    evidence.stage = "navigate-completion";
    for (let index = 0; index < 5; index += 1) await tmux(["send-keys", "-t", session, "Down"]);
    const navigated = await waitForPtyScreen(session, (screen) => {
      const selected = selectedSuggestion(screen);
      return Boolean(selected && selected !== selectedBefore);
    });
    screens.push(`overlay\n${stripAnsi(overlay)}`, `navigated\n${stripAnsi(navigated)}`);

    evidence.stage = "clear-completion";
    await tmux(["send-keys", "-t", session, "C-u"]);
    await waitForPtyScreen(session, (screen) => !hasSlashCompletionRows(screen) && composerValue(screen) === "");

    evidence.stage = "submit-first-history-command";
    await submitPtyText(session, "/name pty-one");
    await waitForPtyScreen(session, (screen) => stripAnsi(screen).includes("session=pty-one") && composerValue(screen) === "");
    evidence.stage = "submit-second-history-command";
    await submitPtyText(session, "/name pty-two");
    await waitForPtyScreen(session, (screen) => stripAnsi(screen).includes("session=pty-two") && composerValue(screen) === "");
    evidence.stage = "navigate-history";
    await tmux(["send-keys", "-t", session, "Up"]);
    const historyLatest = await waitForPtyScreen(session, (screen) => composerValue(screen) === "/name pty-two");
    await tmux(["send-keys", "-t", session, "Up"]);
    const historyOlder = await waitForPtyScreen(session, (screen) => composerValue(screen) === "/name pty-one");
    await tmux(["send-keys", "-t", session, "Down"]);
    const historyForward = await waitForPtyScreen(session, (screen) => composerValue(screen) === "/name pty-two");
    screens.push(`history\n${stripAnsi(historyForward)}`);

    evidence.stage = "escape-completion";
    await tmux(["send-keys", "-t", session, "C-u"]);
    await tmux(["send-keys", "-t", session, "-l", "/"]);
    await waitForPtyScreen(session, (screen) => hasSlashCompletionRows(screen) && composerValue(screen) === "/");
    await tmux(["send-keys", "-t", session, "Escape"]);
    const escaped = await waitForPtyScreen(session, (screen) => !hasSlashCompletionRows(screen) && composerValue(screen) === "");
    await delay(500);
    const afterEscape = await capturePtyScreen(session);
    screens.push(`escaped\n${stripAnsi(afterEscape)}`);

    Object.assign(evidence, {
      overlayCount: slashCompletionRowCount(persistentOverlay),
      overlayPersisted: hasSlashCompletionRows(persistentOverlay),
      selectedBefore,
      selectedAfter: selectedSuggestion(navigated),
      escapedComposer: composerValue(escaped),
      historyLatest: composerValue(historyLatest),
      historyOlder: composerValue(historyOlder),
      historyForward: composerValue(historyForward),
      popupBorderless: !strayBoxGlyphs(navigated),
      composerAliveAfterEscape: composerValue(afterEscape) === "" && /^(?:│ )?❯/m.test(stripAnsi(afterEscape)),
    });
    const passed = evidence.overlayCount === 1
      && evidence.overlayPersisted === true
      && typeof evidence.selectedBefore === "string"
      && typeof evidence.selectedAfter === "string"
      && evidence.selectedAfter !== evidence.selectedBefore
      && evidence.escapedComposer === ""
      && evidence.historyLatest === "/name pty-two"
      && evidence.historyOlder === "/name pty-one"
      && evidence.historyForward === "/name pty-two"
      && evidence.popupBorderless === true
      && evidence.composerAliveAfterEscape === true;
    return makeCase(
      "real_pty_interaction",
      passed,
      "real tmux PTY keeps one overlay, navigates selection, closes on Escape, and replays command history",
      screens.join("\n\n---\n\n"),
      evidence,
    );
  } catch (error) {
    evidence.error = error instanceof Error ? error.message : String(error);
    return makeCase(
      "real_pty_interaction",
      false,
      "real OS pseudo-terminal interaction could not be verified",
      screens.join("\n\n---\n\n") || undefined,
      evidence,
    );
  } finally {
    await execFileAsync("tmux", ["kill-session", "-t", session], { timeout: 5_000 }).catch(() => undefined);
  }
}

async function submitPtyText(session: string, value: string): Promise<void> {
  await tmux(["send-keys", "-t", session, "C-u"]);
  await tmux(["send-keys", "-t", session, "-l", value]);
  await tmux(["send-keys", "-t", session, "Enter"]);
}

async function waitForPtyScreen(
  session: string,
  predicate: (screen: string) => boolean,
  timeoutMs = process.env.CI ? 60_000 : 15_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let latest = "";
  do {
    latest = await capturePtyScreen(session);
    if (predicate(latest)) return latest;
    await delay(50);
  } while (Date.now() < deadline);
  const tail = stripAnsi(latest).split("\n").filter((line) => line.trim()).slice(-12).join("\n").trim();
  throw new Error(
    `Timed out waiting for terminal state. Last composer=${JSON.stringify(composerValue(latest))}; screen tail=${JSON.stringify(tail)}`,
  );
}

async function capturePtyScreen(session: string): Promise<string> {
  return (await execFileAsync("tmux", ["capture-pane", "-p", "-e", "-t", session], {
    timeout: 5_000,
    maxBuffer: 2 * 1024 * 1024,
  })).stdout;
}

async function tmux(args: readonly string[]): Promise<void> {
  await execFileAsync("tmux", [...args], { timeout: 5_000, maxBuffer: 2 * 1024 * 1024 });
}

function composerValue(screen: string): string | undefined {
  const lines = stripAnsi(screen).split("\n");
  let line: string | undefined;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (/^(?:│ )?❯/.test(lines[index])) {
      line = lines[index];
      break;
    }
  }
  if (!line) return undefined;
  return line.slice(line.indexOf("❯") + 1).trim();
}

/** The reference draws NO box glyphs anywhere — any occurrence is stray. */
/**
 * Box frame glyphs in the popup/composer region. The status bar under the
 * composer (after the last rule) uses `│` as a separator by design and is
 * not part of the popup, so it is excluded.
 */
function strayBoxGlyphs(screen: string): boolean {
  const lines = stripAnsi(screen).split("\n");
  let lastRule = -1;
  lines.forEach((line, index) => { if (/^─{8,}\s*$/.test(line.trim())) lastRule = index; });
  const region = lastRule >= 0 ? lines.slice(0, lastRule + 1) : lines;
  return /[╭╮╰╯│]/u.test(region.join("\n"));
}

function selectedSuggestion(screen: string): string | undefined {
  const selected = screen.split("\n").find((line) => line.includes("\u001b[38;2;176;184;248m") && stripAnsi(line).trimStart().startsWith("→"));
  return stripAnsi(selected ?? "").match(/→\s+(\/[^\s]+)/)?.[1];
}

function slashCompletionRowCount(screen: string): number {
  return stripAnsi(screen).split("\n").filter((line) => /^\s*(?:→\s+|\s{2})\/help\b/.test(line)).length;
}

function hasSlashCompletionRows(screen: string): boolean {
  return slashCompletionRowCount(screen) > 0;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function makeCase(id: string, passed: boolean, summary: string, screen: string | undefined, evidence: Record<string, unknown>): QaPtyTuiCase {
  return { id, status: passed ? "passed" : "failed", summary, screen, evidence };
}

function withoutScreen(testCase: QaPtyTuiCase): Omit<QaPtyTuiCase, "screen"> {
  return { id: testCase.id, status: testCase.status, summary: testCase.summary, evidence: testCase.evidence };
}

function fakeTui(columns: number, rows: number) {
  return {
    terminal: { columns, rows },
    requestRender() {},
  } as Parameters<typeof createMusterChatEditor>[0];
}

async function settleAutocomplete(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 55));
}

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-9;]*m/g, "");
}

function count(value: string, needle: string): number {
  return (value.match(new RegExp(escapeRegExp(needle), "g")) ?? []).length;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
