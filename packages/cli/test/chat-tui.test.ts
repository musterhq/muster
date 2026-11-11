import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMusterAutocompleteProvider, createMusterChatEditor, createMusterChatHarness, formatWorkingIndicator, isBareCompletionTrigger, isClearComposerKey, renderHeaderWindow, renderMusterComposer, renderTranscriptWindow, TerminalFrameLog, windowTranscript } from "../src/chat-tui.js";
import { capabilityConfirmationText, encodeCapabilitySelection } from "../src/capabilities-overlay.js";

const commands = [
  { name: "help", usage: "/help", description: "show full chat help", aliases: ["?"] },
  { name: "status", usage: "/status", description: "show runtime, model, session, token usage" },
  { name: "providers", usage: "/providers", description: "list configured providers and models" },
  { name: "provider", usage: "/provider <id> [model]", description: "switch active provider for this chat/runtime" },
  { name: "model", usage: "/model <name>", description: "switch active model for the current provider" },
  { name: "runtime", usage: "/runtime [id]", description: "list or switch active runtime" },
  { name: "sessions", usage: "/sessions [limit]", description: "list recent named chats" },
  { name: "resume", usage: "/resume <name|id>", description: "switch to a prior named chat or session id" },
  { name: "tools", usage: "/tools [toolset]", description: "list built-in toolsets and tools" },
  { name: "integrations", usage: "/integrations [id]", description: "guided channel/plugin/MCP setup workflow", aliases: ["integration"] },
] as const;

test("ordinary working status uses the sparkle identity without exposing diagnostic metrics", () => {
  const frames = Array.from({ length: 8 }, (_, index) => formatWorkingIndicator(undefined, index));
  assert.ok(frames.every((frame) => /^✻ (Thinking|Reading|Weighing|Connecting|Shaping|Composing)$/.test(frame)));
  const rotated = Array.from({ length: 96 }, (_, index) => formatWorkingIndicator(undefined, index));
  assert.ok(new Set(rotated).size > 1, "the verb rotates so long waits breathe");
  assert.doesNotMatch(frames.join(" "), /\b\d+(?:\.\d+)?(?:ms|s)\b|latency|p50|p95|cache/i);
});

test("muster TUI completion provider filters slash commands and applies selected command", async () => {
  const provider = createMusterAutocompleteProvider({
    commands,
    toolsets: ["core", "memory"],
    recentSessions: () => ["release-audit"],
    agents: async () => ["review"],
  });

  const suggestions = await provider.getSuggestions(["/sta"], 0, 4, { signal: new AbortController().signal });
  assert.ok(suggestions);
  assert.equal(suggestions.prefix, "/sta");
  assert.deepEqual(suggestions.items.map((item) => item.value), ["/status"]);

  const applied = provider.applyCompletion(["/sta"], 0, 4, suggestions.items[0], suggestions.prefix);
  assert.deepEqual(applied.lines, ["/status"]);
  assert.equal(applied.cursorLine, 0);
  assert.equal(applied.cursorCol, "/status".length);
});

test("muster TUI completion provider completes toolsets, sessions, and agents", async () => {
  const provider = createMusterAutocompleteProvider({
    commands,
    toolsets: ["core", "memory"],
    recentSessions: () => ["release-audit", "daily-plan"],
    providers: () => [{ value: "openai", description: "OpenAI API" }, { value: "codex", description: "Codex CLI" }],
    models: ({ providerId }) => providerId === "openai" ? [{ value: "gpt-5.5" }, { value: "gpt-4.1" }] : [{ value: "gpt-5.5" }],
    runtimes: () => [{ value: "native" }, { value: "claude-code", description: "Claude Code" }],
    clouds: () => [{ value: "openrouter" }, { value: "anthropic" }],
    speeds: () => [{ value: "session" }, { value: "fast" }],
    skills: () => [{ value: "api-contract-testing" }, { value: "adversarial-ux-test", description: "qa · ux · break CLI flows" }, { value: "dashboard-reporting" }],
    plugins: () => [{ value: "artifact-studio", description: "documents · pdf · pptx · xlsx" }, { value: "developer-tools" }],
    pluginReuseProviders: () => [{ value: "codex", description: "provider cache" }, { value: "custom", description: "MUSTER_CUSTOM_PLUGIN_CACHE" }],
    mcpServers: () => [{ value: "git" }, { value: "github" }, { value: "filesystem" }],
    integrations: () => [
      { value: "status", description: "readiness" },
      { value: "telegram", description: "channel · guided setup" },
      { value: "artifact-studio", description: "plugin · docs/pptx/pdf" },
      { value: "parallel-search", description: "mcp · web search" },
    ],
    integrationWorkflows: () => [
      { value: "telegram", description: "channel · guided setup" },
      { value: "artifact-studio", description: "plugin · docs/pptx/pdf" },
      { value: "parallel-search", description: "mcp · web search" },
    ],
    agents: async () => ["review", "research"],
  });
  const signal = new AbortController().signal;

  const tools = await provider.getSuggestions(["/tools me"], 0, 9, { signal });
  assert.equal(tools?.prefix, "/tools me");
  assert.deepEqual(tools?.items.map((item) => item.value), ["memory"]);
  assert.deepEqual(provider.applyCompletion(["/tools me"], 0, 9, tools!.items[0], tools!.prefix).lines, ["/tools memory"]);

  const sessions = await provider.getSuggestions(["/resume rel"], 0, 11, { signal });
  assert.deepEqual(sessions?.items.map((item) => item.value), ["release-audit"]);
  assert.deepEqual(provider.applyCompletion(["/resume rel"], 0, 11, sessions!.items[0], sessions!.prefix).lines, ["/resume release-audit"]);

  const agents = await provider.getSuggestions(["@re"], 0, 3, { signal });
  assert.deepEqual(agents?.items.map((item) => item.value), ["@review", "@research"]);
  assert.deepEqual(provider.applyCompletion(["@re"], 0, 3, agents!.items[0], agents!.prefix).lines, ["@review"]);

  const providers = await provider.getSuggestions(["/provider op"], 0, 12, { signal });
  assert.equal(providers?.prefix, "/provider op");
  assert.deepEqual(providers?.items.map((item) => item.value), ["openai"]);
  assert.deepEqual(provider.applyCompletion(["/provider op"], 0, 12, providers!.items[0], providers!.prefix).lines, ["/provider openai"]);

  const providerModels = await provider.getSuggestions(["/provider openai gpt"], 0, 20, { signal });
  assert.equal(providerModels?.prefix, "/provider openai gpt");
  assert.deepEqual(providerModels?.items.map((item) => item.value), ["gpt-5.5", "gpt-4.1"]);
  assert.deepEqual(provider.applyCompletion(["/provider openai gpt"], 0, 20, providerModels!.items[0], providerModels!.prefix).lines, ["/provider openai gpt-5.5"]);

  const models = await provider.getSuggestions(["/model gpt"], 0, 10, { signal });
  assert.deepEqual(models?.items.map((item) => item.value), ["gpt-5.5"]);

  const bareModels = await provider.getSuggestions(["/model"], 0, 6, { signal });
  assert.deepEqual(provider.applyCompletion(["/model"], 0, 6, bareModels!.items[0], bareModels!.prefix).lines, ["/model gpt-5.5"]);

  const runtimes = await provider.getSuggestions(["/runtime cla"], 0, 12, { signal });
  assert.deepEqual(runtimes?.items.map((item) => item.value), ["claude-code"]);

  const clouds = await provider.getSuggestions(["/cloud open"], 0, 11, { signal });
  assert.deepEqual(clouds?.items.map((item) => item.value), ["openrouter"]);

  const speeds = await provider.getSuggestions(["/speed f"], 0, 8, { signal });
  assert.equal(speeds?.prefix, "/speed f");
  assert.deepEqual(speeds?.items.map((item) => item.value), ["fast"]);
  assert.deepEqual(provider.applyCompletion(["/speed f"], 0, 8, speeds!.items[0], speeds!.prefix).lines, ["/speed fast"]);

  const skills = await provider.getSuggestions(["/skills api"], 0, 11, { signal });
  assert.equal(skills?.prefix, "/skills api");
  assert.deepEqual(skills?.items.map((item) => item.value), ["api-contract-testing"]);
  assert.deepEqual(provider.applyCompletion(["/skills api"], 0, 11, skills!.items[0], skills!.prefix).lines, ["/skills api-contract-testing"]);
  const skillByDescription = await provider.getSuggestions(["/skills ux"], 0, 10, { signal });
  assert.deepEqual(skillByDescription?.items.map((item) => item.value), ["adversarial-ux-test"]);

  const plugins = await provider.getSuggestions(["/plugins art"], 0, 12, { signal });
  assert.deepEqual(plugins?.items.map((item) => item.value), ["artifact-studio"]);
  const pluginByDescription = await provider.getSuggestions(["/plugins pdf"], 0, 12, { signal });
  assert.deepEqual(pluginByDescription?.items.map((item) => item.value), ["artifact-studio"]);
  const barePlugins = await provider.getSuggestions(["/plugins"], 0, 8, { signal });
  assert.deepEqual(provider.applyCompletion(["/plugins"], 0, 8, barePlugins!.items[0], barePlugins!.prefix).lines, ["/plugins artifact-studio"]);
  const reuseProviders = await provider.getSuggestions(["/plugins reuse co"], 0, 17, { signal });
  assert.deepEqual(reuseProviders?.items.map((item) => item.value), ["codex"]);
  assert.deepEqual(provider.applyCompletion(["/plugins reuse"], 0, 14, reuseProviders!.items[0], reuseProviders!.prefix).lines, ["/plugins reuse codex"]);
  assert.deepEqual(provider.applyCompletion(["/plugins reuse co"], 0, 17, reuseProviders!.items[0], reuseProviders!.prefix).lines, ["/plugins reuse codex"]);

  const mcp = await provider.getSuggestions(["/mcp git"], 0, 8, { signal });
  assert.deepEqual(mcp?.items.map((item) => item.value), ["git", "github"]);
  const bareMcp = await provider.getSuggestions(["/mcp"], 0, 4, { signal });
  assert.deepEqual(provider.applyCompletion(["/mcp"], 0, 4, bareMcp!.items[0], bareMcp!.prefix).lines, ["/mcp git"]);

  const integrations = await provider.getSuggestions(["/integrations tel"], 0, 17, { signal });
  assert.equal(integrations?.prefix, "/integrations tel");
  assert.deepEqual(integrations?.items.map((item) => item.value), ["telegram"]);
  assert.deepEqual(provider.applyCompletion(["/integrations tel"], 0, 17, integrations!.items[0], integrations!.prefix).lines, ["/integrations telegram"]);

  const integrationStatus = await provider.getSuggestions(["/integrations st"], 0, 16, { signal });
  assert.equal(integrationStatus?.items[0]?.value, "status");
  assert.deepEqual(provider.applyCompletion(["/integrations st"], 0, 16, integrationStatus!.items[0], integrationStatus!.prefix).lines, ["/integrations status"]);

  const workflowIntegration = await provider.getSuggestions(["/integrations workflow par"], 0, 26, { signal });
  assert.deepEqual(workflowIntegration?.items.map((item) => item.value), ["parallel-search"]);
  assert.deepEqual(provider.applyCompletion(["/integrations workflow par"], 0, 26, workflowIntegration!.items[0], workflowIntegration!.prefix).lines, ["/integrations workflow parallel-search"]);

  const verifyIntegration = await provider.getSuggestions(["/integrations verify tel"], 0, 24, { signal });
  assert.deepEqual(verifyIntegration?.items.map((item) => item.value), ["telegram"]);
  assert.deepEqual(provider.applyCompletion(["/integrations verify tel"], 0, 24, verifyIntegration!.items[0], verifyIntegration!.prefix).lines, ["/integrations verify telegram"]);

  const workflowStatus = await provider.getSuggestions(["/integrations workflow st"], 0, 25, { signal });
  assert.ok(workflowStatus);
  assert.notDeepEqual(workflowStatus.items.map((item) => item.value), ["status"]);
  assert.equal(workflowStatus.items.some((item) => item.value === "status"), false);
});

test("/tools capability selection replaces the command with ready composer text on Enter", async () => {
  const readyPrompt = "use the documents plugin to ";
  const provider = createMusterAutocompleteProvider({
    commands,
    toolsets: [],
    recentSessions: () => [],
    catalog: {
      complete: (request) => request.kind === "toolset"
        ? [{ value: encodeCapabilitySelection(readyPrompt), label: "documents", description: "plugin/codex · active" }]
        : [],
    },
    agents: async () => [],
  });
  const suggestions = await provider.getSuggestions(["/tools doc"], 0, 10, { signal: new AbortController().signal });
  assert.ok(suggestions);
  const applied = provider.applyCompletion(["/tools doc"], 0, 10, suggestions.items[0]!, suggestions.prefix);
  assert.deepEqual(applied.lines, [readyPrompt]);
  assert.equal(applied.cursorCol, readyPrompt.length);

  const harness = createMusterChatHarness({
    commands,
    toolsets: [],
    recentSessions: () => [],
    catalog: { complete: async (request) => request.kind === "toolset" ? [{ value: encodeCapabilitySelection(readyPrompt), label: "documents" }] : [] },
    agents: async () => [],
  });
  harness.type("/tools doc");
  await settleAutocomplete();
  harness.input("\r");
  assert.equal(harness.text(), readyPrompt);
});

test("escape cancels a staged /tools state-changing command", () => {
  const harness = createMusterChatHarness({ commands, toolsets: [], recentSessions: () => [], agents: async () => [] });
  harness.type(capabilityConfirmationText("codex", ["mcp", "enable", "computer-use"]));
  harness.input("\x1b");
  assert.equal(harness.text(), "");
});

test("Ctrl+D is reserved for the live file view and leaves the composer intact", () => {
  const harness = createMusterChatHarness({ commands, toolsets: [], recentSessions: () => [], agents: async () => [] });
  harness.type("draft");
  harness.input("\x04");
  assert.equal(harness.text(), "draft");
  assert.match(harness.transcript().at(-1) ?? "", /no files edited this turn/);
});

test("/tools disabled row needs a selection Enter and a separate submit Enter", async () => {
  const confirmation = capabilityConfirmationText("codex", ["mcp", "enable", "computer-use"]);
  const submitted: string[] = [];
  const harness = createMusterChatHarness({
    commands,
    toolsets: [],
    recentSessions: () => [],
    catalog: { complete: async (request) => request.kind === "toolset" ? [{ value: encodeCapabilitySelection(confirmation), label: "computer-use" }] : [] },
    agents: async () => [],
    onSubmit: async (text) => { submitted.push(text); return true; },
  });
  harness.type("/tools computer");
  await settleAutocomplete();
  harness.input("\r");
  assert.equal(harness.text(), confirmation);
  assert.deepEqual(submitted, [], "selection must not run a state-changing command");
  harness.input("\r");
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(submitted, [confirmation]);
});

test("muster TUI completion provider can be backed by one catalog service", async () => {
  const seen: string[] = [];
  const provider = createMusterAutocompleteProvider({
    commands,
    toolsets: [],
    recentSessions: () => [],
    catalog: {
      complete(request) {
        seen.push(`${request.kind}:${request.fragment}:${request.providerId ?? ""}`);
        if (request.kind === "provider-model") return [{ value: "gpt-5.5", description: "catalog model" }];
        if (request.kind === "agent") return [{ value: "@review", label: "@review", description: "catalog agent" }];
        return [];
      },
    },
    agents: async () => [],
  });
  const signal = new AbortController().signal;

  const model = await provider.getSuggestions(["/provider openai gpt"], 0, 20, { signal });
  assert.deepEqual(model?.items.map((item) => item.value), ["gpt-5.5"]);
  assert.deepEqual(seen, ["provider-model:gpt:openai"]);

  const agent = await provider.getSuggestions(["@re"], 0, 3, { signal });
  assert.deepEqual(agent?.items.map((item) => item.value), ["@review"]);
  assert.deepEqual(seen, ["provider-model:gpt:openai", "agent:re:"]);
});

test("muster composer is two full-width dim rules with a plain caret, growing for multiline input", () => {
  const editor = createMusterChatEditor(fakeTui(120, 40));
  editor.setText("first line\nsecond line");
  const lines = renderMusterComposer(editor, 80);
  const stripped = lines.map((line) => stripAnsi(line));

  assert.match(stripped[0], /^─+$/, "top rule spans the frame");
  assert.match(stripped[1], /^❯ first line/);
  assert.match(stripped[2], /^ {2}second line/);
  assert.match(stripped.at(-1)!, /^─+$/, "bottom rule spans the frame");
  assert.doesNotMatch(stripped.join("\n"), /[╭╮╰╯│]/u, "no box glyphs anywhere — the reference has none");
  assert.doesNotMatch(lines.join("\n"), /217;119;87|224;175;104/, "the caret carries no accent tinge");
  assert.ok(stripped.every((line) => line.length === 80), "composer lines should stay width-stable");
});

test("muster composer keeps autocomplete in the same stable render tree", async () => {
  const terminal = fakeTui(100, 40);
  const editor = createMusterChatEditor(terminal);
  editor.setAutocompleteProvider(createMusterAutocompleteProvider({
    commands,
    toolsets: ["core"],
    recentSessions: () => [],
    agents: async () => [],
  }));

  editor.handleInput("/");
  await new Promise((resolve) => setTimeout(resolve, 40));
  const first = renderMusterComposer(editor, 90).join("\n");
  editor.handleInput("\x1b[B");
  const second = renderMusterComposer(editor, 90).join("\n");

  assert.equal((stripAnsi(first).match(/\/help/g) ?? []).length, 1);
  assert.equal((stripAnsi(second).match(/\/help/g) ?? []).length, 1);
  assert.match(stripAnsi(second), /\(2\/5\)|\/status/);
});

test("muster chat harness keeps one persistent slash overlay through arrow navigation", async () => {
  const harness = createMusterChatHarness({
    commands,
    toolsets: ["core"],
    recentSessions: () => [],
    agents: async () => [],
    width: 100,
  });

  harness.input("/");
  await settleAutocomplete();
  const first = stripAnsi(harness.visible(90).join("\n"));
  for (let index = 0; index < 5; index += 1) harness.input("\x1b[B");
  const navigated = stripAnsi(harness.visible(90).join("\n"));

  assert.equal((first.match(/\/help/g) ?? []).length, 1, "slash should open one completion list");
  assert.equal((navigated.match(/\/help/g) ?? []).length, 1, "arrow navigation must update the same list, not append panes");
  assert.ok(/\/runtime|\/sessions|\/provider/.test(navigated), "selection should move through command rows");
});

test("muster chat harness opens skill and plugin pickers as interactive composer state", async () => {
  const harness = createMusterChatHarness({
    commands,
    toolsets: [],
    recentSessions: () => [],
    skills: () => [{ value: "adversarial-ux-test", description: "qa · ux · break CLI flows" }],
    plugins: () => [{ value: "artifact-studio", description: "documents · pdf · pptx · xlsx" }],
    pluginReuseProviders: () => [{ value: "codex", description: "provider cache" }],
    integrations: () => [{ value: "telegram", description: "channel · guided setup" }],
    agents: async () => [],
    width: 100,
  });

  harness.openPicker("/plugins pdf");
  await settleAutocomplete();
  const pluginScreen = stripAnsi(harness.visible(90).join("\n"));
  assert.equal(harness.text(), "/plugins pdf");
  assert.match(pluginScreen, /artifact-studio/);
  assert.ok(pluginScreen.indexOf("artifact-studio") < pluginScreen.indexOf("❯"));

  harness.openPicker("/skills ux");
  await settleAutocomplete();
  const skillScreen = stripAnsi(harness.visible(90).join("\n"));
  assert.equal(harness.text(), "/skills ux");
  assert.match(skillScreen, /adversarial-ux-test/);

  harness.openPicker("/plugins reuse");
  await settleAutocomplete();
  const reuseScreen = stripAnsi(harness.visible(90).join("\n"));
  assert.equal(harness.text(), "/plugins reuse");
  assert.match(reuseScreen, /codex/);

  harness.openPicker("/integrations tel");
  await settleAutocomplete();
  const integrationScreen = stripAnsi(harness.visible(90).join("\n"));
  assert.equal(harness.text(), "/integrations tel");
  assert.match(integrationScreen, /telegram/);
});

test("muster chat harness escape closes bare completion and restores normal prompt", async () => {
  const harness = createMusterChatHarness({
    commands,
    toolsets: [],
    recentSessions: () => [],
    agents: async () => [],
  });

  harness.input("/");
  await settleAutocomplete();
  assert.match(stripAnsi(harness.visible().join("\n")), /\/help/);
  harness.input("\x1b");
  const screen = stripAnsi(harness.visible().join("\n"));

  assert.equal(harness.text(), "");
  assert.doesNotMatch(screen, /\/help/);
  assert.match(screen, /^❯/m, "the bare prompt returns between the rules");
  assert.doesNotMatch(screen, /[╭╮╰╯│]/u, "no box glyphs anywhere");
});

test("muster chat harness replays prompt history when completion is not open", async () => {
  const harness = createMusterChatHarness({
    commands,
    toolsets: [],
    recentSessions: () => [],
    agents: async () => [],
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
  assert.equal(harness.text(), "second prompt");
  harness.input("\x1b[A");
  assert.equal(harness.text(), "first prompt");
  harness.input("\x1b[B");
  assert.equal(harness.text(), "second prompt");
});

test("muster chat harness keeps submitted prompt visible after output and clears composer", async () => {
  const harness = createMusterChatHarness({
    commands,
    toolsets: [],
    recentSessions: () => [],
    agents: async () => [],
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

  assert.equal(harness.text(), "");
  assert.match(screen, /> show status/);
  assert.match(screen, /timings total=120ms/);
  assert.match(screen, /memory backend=sqlite-fts5/);
  assert.match(screen, /done/);
});

test("muster chat harness shows and navigates @ agent completions", async () => {
  const harness = createMusterChatHarness({
    commands,
    toolsets: [],
    recentSessions: () => [],
    agents: async () => ["review", "research", "runner"],
  });

  harness.input("@");
  await settleAutocomplete();
  const first = stripAnsi(harness.visible(90).join("\n"));
  harness.input("\x1b[B");
  const second = stripAnsi(harness.visible(90).join("\n"));

  assert.match(first, /@review/);
  assert.match(first, /@research/);
  assert.equal((second.match(/@review/g) ?? []).length, 1);
  assert.ok(second.includes("@research") || second.includes("@runner"));
});

test("muster transcript keeps the latest prompt visible after long output", () => {
  const rendered = renderTranscriptWindow([
    "older setup line",
    "\x1b[38;2;142;161;181m>\x1b[0m Where do we deploy the Frappe app?",
    "memory backend=sqlite-fts5 recalled=1 candidates=1",
    "This is a deliberately long assistant answer that wraps across several rows and would otherwise push the prompt out of the visible transcript window.",
    "final answer line",
  ], 52, 3).map(stripAnsi);

  assert.ok(rendered.some((line) => line.includes("Where do we deploy")), "latest user prompt should remain visible");
  assert.ok(rendered.some((line) => line.includes("memory backend=sqlite-fts5")), "retrieval receipt should remain visible");
  assert.ok(rendered.at(-1)?.includes("final answer line"));
});

test("muster transcript pins timing and retrieval receipts in cramped TUI output", () => {
  const rendered = renderTranscriptWindow([
    "\x1b[38;2;142;161;181m>\x1b[0m Reply with exactly: ok",
    "timings total=8335ms provider=8259ms recall=11ms prompt=5ms persist=56ms planning=2ms",
    "memory backend=sqlite-fts5 recalled=0 candidates=0 scopes=tenant:f2,user:goblin",
    "assistant body line that would otherwise crowd out receipts",
    "ok",
  ], 72, 4).map(stripAnsi);

  assert.ok(rendered[0].includes("Reply with exactly"));
  assert.ok(rendered.some((line) => line.includes("timings total=8335ms")));
  assert.ok(rendered.some((line) => line.includes("memory backend=sqlite-fts5")));
  assert.ok(rendered.at(-1)?.includes("ok"));
});

test("muster header collapses before it starves chat transcript rows", () => {
  const header = Array.from({ length: 18 }, (_, index) => `header line ${index}`);
  const rendered = renderHeaderWindow(header, 5);

  assert.equal(rendered.length, 5);
  assert.ok(rendered[0].includes("header line 0"));
  assert.ok(rendered.some((line) => stripAnsi(line).includes("header collapsed")));
  assert.ok(rendered.at(-1)?.includes("header line 17"));
});

test("muster autocomplete popup is borderless above the composer with a 14-row viewport", async () => {
  const editor = createMusterChatEditor(fakeTui(120, 50));
  const manyCommands = Array.from({ length: 30 }, (_, index) => ({
    name: `cmd${String(index + 1).padStart(2, "0")}`,
    usage: `/cmd${String(index + 1).padStart(2, "0")}`,
    description: `command ${index + 1}`,
  }));
  editor.setAutocompleteProvider(createMusterAutocompleteProvider({
    commands: manyCommands,
    toolsets: [],
    recentSessions: () => [],
    agents: async () => [],
  }));

  editor.handleInput("/");
  await new Promise((resolve) => setTimeout(resolve, 40));
  for (let index = 0; index < 20; index += 1) editor.handleInput("\x1b[B");
  const stripped = renderMusterComposer(editor, 110).map(stripAnsi);
  const commandRows = stripped.filter((line) => /cmd\d\d/.test(line));

  assert.equal(commandRows.length, 14);
  assert.equal(stripped.some((line) => /^\s*\d+\/\d+\s*$/.test(line)), false, "no count row — the reference shows none");
  assert.ok(commandRows[0].includes("cmd14"), "centered viewport should start near selected index, not at top");
  assert.ok(commandRows.at(-1)?.includes("cmd27"), "centered viewport should stay bounded to max visible rows");
  assert.ok(commandRows.every((line) => !/[╭╮╰╯│]/.test(line)), "popup rows have no border box");
  assert.ok(stripped.findIndex((line) => line.includes("cmd14")) < stripped.findIndex((line) => line.includes("❯")), "suggestions anchor above the composer");
});

test("muster selected completion row paints periwinkle with no background band", async () => {
  const editor = createMusterChatEditor(fakeTui(100, 40));
  editor.setAutocompleteProvider(createMusterAutocompleteProvider({
    commands,
    toolsets: ["core"],
    recentSessions: () => [],
    agents: async () => [],
  }));

  editor.handleInput("/");
  await new Promise((resolve) => setTimeout(resolve, 40));
  const rendered = renderMusterComposer(editor, 90).join("\n");
  const selectedLine = rendered.split("\n").find((line) => line.includes("/help"));

  assert.ok(selectedLine, "selected /help line should render");
  assert.ok(selectedLine.includes("\u001b[38;2;176;184;248m"), "selected row goes periwinkle — the reference's selection identity");
  assert.equal(selectedLine.includes("\u001b[48;2;48;45;43m"), false, "no background band — the reference has none");
});

test("frame debug log JSON-escapes terminal rows and rotates at five megabytes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "muster-frames-"));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const path = join(root, "logs", "frames.log");
  const log = new TerminalFrameLog(path);
  log.append("\u001b[31mleft[\u001b[0m\nright]");
  const rows = (await readFile(path, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(rows, ["\u001b[31mleft[\u001b[0m", "right]"]);
  await writeFile(path, "x".repeat(TerminalFrameLog.MAX_BYTES - 2), "utf8");
  log.append("next frame");
  assert.equal((await stat(`${path}.1`)).size, TerminalFrameLog.MAX_BYTES - 2);
  assert.ok((await stat(path)).size <= TerminalFrameLog.MAX_BYTES);
});

test("muster transcript starts with resumed history before the first submitted turn", () => {
  const initialLines = ["── history: work · 2 messages (1 user · 1 assistant) ──", "> earlier", "● answer", "── end history ──"];
  const harness = createMusterChatHarness({
    commands,
    toolsets: ["core"],
    recentSessions: () => [],
    agents: async () => [],
    initialLines,
  });

  assert.deepEqual(harness.transcript(), initialLines);
});

test("muster Escape interrupts a running turn and preserves partial transcript", async () => {
  let finishTurn!: () => void;
  const running = new Promise<void>((resolve) => { finishTurn = resolve; });
  let interrupts = 0;
  const harness = createMusterChatHarness({
    commands,
    toolsets: ["core"],
    recentSessions: () => [],
    agents: async () => [],
    onSubmit: async (_text, sink) => {
      sink.appendLine("● partial");
      await running;
      return true;
    },
    onInterrupt: () => {
      interrupts += 1;
      return true;
    },
  });

  harness.type("long turn");
  const submitted = harness.submit();
  await new Promise((resolve) => setTimeout(resolve, 0));
  harness.input("\x1b");
  await new Promise((resolve) => setTimeout(resolve, 0));
  finishTurn();
  await submitted;

  assert.equal(interrupts, 1);
  assert.ok(harness.transcript().some((line) => line.includes("● partial")));
  assert.ok(harness.transcript().some((line) => line.includes("⎋ interrupted")));
});

test("muster escape handling only clears bare completion triggers", () => {
  assert.equal(isBareCompletionTrigger("/"), true);
  assert.equal(isBareCompletionTrigger("@"), true);
  assert.equal(isBareCompletionTrigger(" / "), true);
  assert.equal(isBareCompletionTrigger("/status"), false);
  assert.equal(isBareCompletionTrigger("@review fix this"), false);
  assert.equal(isBareCompletionTrigger("normal text"), false);
});

test("muster composer recognizes Ctrl+U as a line clear key", () => {
  assert.equal(isClearComposerKey("\x15"), true);
  assert.equal(isClearComposerKey("u"), false);
  assert.equal(isClearComposerKey("\x1b"), false);
});

test("muster chat harness lets a pending one-line decision consume enter before the editor", () => {
  let accepted = 0;
  const harness = createMusterChatHarness({
    commands,
    toolsets: ["core"],
    recentSessions: () => [],
    agents: () => [],
    onDecisionKey(data) {
      if (data !== "\r") return false;
      accepted += 1;
      return true;
    },
  });
  harness.input("\r");
  assert.equal(accepted, 1);
  assert.equal(harness.text(), "");
});

async function settleAutocomplete(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 50));
}

function fakeTui(columns: number, rows: number) {
  return {
    terminal: { columns, rows },
    requestRender() {},
  } as Parameters<typeof createMusterChatEditor>[0];
}

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-9;]*m/g, "");
}

test("windowTranscript scrolls in-app for the alternate screen and clamps at the top", () => {
  const rows = Array.from({ length: 100 }, (_, index) => `row ${index}`);
  const tail = windowTranscript(rows, 20, 0);
  assert.equal(tail.visible.at(-1), "row 99", "offset 0 follows the tail");
  assert.equal(tail.visible.length, 20);
  const lifted = windowTranscript(rows, 20, 30);
  assert.equal(lifted.visible.at(-1), "row 69", "offset lifts the viewport off the tail");
  assert.equal(lifted.clamped, 30);
  const past = windowTranscript(rows, 20, 500);
  assert.equal(past.clamped, 80, "clamps to the oldest full viewport");
  assert.equal(past.visible[0], "row 0");
  const short = windowTranscript(rows.slice(0, 5), 20, 10);
  assert.equal(short.clamped, 0, "short transcripts never scroll");
  assert.equal(short.visible.length, 5);
});

// Spec: MUS-SPEC-01-9A (docs/spec/clauses/01-chat-transcript.md#mus-spec-01-9a----history-shows-local-times-with-a-zone-and-each-message-keeps-its-own-time)
test("history times are local with a zone and the prompt keeps the turn's start time", async () => {
  const output = await import("../src/output.js") as { formatLocalTimestamp?: (iso: string, options?: { timeZone?: string; now?: number }) => string };
  assert.equal(typeof output.formatLocalTimestamp, "function");
  const now = Date.parse("2026-11-10T09:00:00.000Z");
  assert.equal(output.formatLocalTimestamp!("2026-11-10T07:22:44.000Z", { timeZone: "Asia/Kolkata", now }), "12:52:44 GMT+5:30");
  assert.equal(output.formatLocalTimestamp!("2026-11-10T07:22:44.000Z", { timeZone: "UTC", now }), "07:22:44 UTC");
  assert.equal(output.formatLocalTimestamp!("2026-11-08T07:22:44.000Z", { timeZone: "Asia/Kolkata", now }), "2026-11-08 12:52:44 GMT+5:30");

  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { openSessionStore } = await import("@musterhq/core");
  const cwd = await mkdtemp(join(tmpdir(), "muster-history-time-"));
  const store = openSessionStore(cwd);
  try {
    const session = store.findOrCreateSession({ channel: "cli-chat", peer: "times" });
    const append = store.appendMessage as (id: string, role: string, content: string, createdAt?: string) => { createdAt: string };
    assert.equal(append.call(store, session.id, "user", "hi", "2026-11-10T07:22:30.000Z").createdAt, "2026-11-10T07:22:30.000Z");
    assert.notEqual(append.call(store, session.id, "assistant", "hello").createdAt, "2026-11-10T07:22:30.000Z");
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});
