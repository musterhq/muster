import { access, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { execFile, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { piToolEventToAgentToolEvent, type AgentToolEvent } from "./tool-events.js";

const execFileAsync = promisify(execFile);

export const PI_CODING_AGENT_PACKAGE = "@earendil-works/pi-coding-agent";
export const PI_CODING_AGENT_VERSION = "0.79.1";
export const PI_CODING_AGENT_NPX_SPEC = `${PI_CODING_AGENT_PACKAGE}@${PI_CODING_AGENT_VERSION}`;

const REQUIRED_SDK_EXPORTS = [
  "createAgentSession",
  "AgentSession",
  "SessionManager",
  "DefaultResourceLoader",
  "SettingsManager",
  "createReadOnlyTools",
  "createCodingTools",
  "runPrintMode",
  "InteractiveMode"
] as const;

const DEFAULT_PI_ACTIVE_TOOLS = ["read", "grep", "find", "ls"] as const;

/** pi's tools for a sandbox: read-only gets the read set; a writable workspace also edits, writes and runs commands. */
export function piToolsForSandbox(sandbox?: "read-only" | "workspace-write" | "danger-full-access"): string[] {
  return sandbox === "read-only" ? [...DEFAULT_PI_ACTIVE_TOOLS] : ["read", "bash", "edit", "write", "grep", "find", "ls"];
}

export interface PiRuntimeStatus {
  readonly rootPath: string;
  readonly installed: boolean;
  readonly configFiles: string[];
  readonly workflowFiles: string[];
  readonly cliAvailable: boolean;
  readonly npxAvailable: boolean;
  readonly packageName: string;
  readonly packageVersion: string;
  readonly integrationMode: "embedded_sdk";
  readonly sdkLoadable: boolean;
  readonly sdkExports: string[];
  readonly missingSdkExports: string[];
  readonly adapterState: "sdk_missing" | "sdk_ready" | "sdk_ready_with_pi_home";
  readonly nextActions: string[];
}

export interface PiAgentRunInput {
  readonly prompt: string;
  readonly cwd?: string;
  readonly provider?: string;
  readonly model?: string;
  readonly thinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
  readonly tools?: readonly string[];
  readonly timeoutMs?: number;
  readonly transport?: "sdk" | "cli";
  /** Tool activity (bash commands, file tools) as provider-neutral events. */
  readonly onToolEvent?: (event: AgentToolEvent) => void;
  readonly sessionMode?: PiSessionMode;
  readonly sessionDir?: string;
  readonly agentDir?: string;
  /**
   * Optional live streaming hook: called with each assistant text delta as
   * message_update events arrive from the embedded Pi session. Cheap — it is
   * derived from the subscription runPiEmbeddedAgent already holds.
   */
  readonly onDelta?: (text: string) => void;
}

export interface PiCliDiagnosticRunInput extends PiAgentRunInput {
  readonly command?: string;
  readonly noSession?: boolean;
}

export interface PiInteractiveRunInput {
  readonly prompt?: string;
  readonly cwd?: string;
  readonly provider?: string;
  readonly model?: string;
  readonly thinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
  readonly tools?: readonly string[];
  readonly sessionMode?: PiSessionMode;
  readonly sessionDir?: string;
  readonly sessionId?: string;
  readonly agentDir?: string;
  readonly allowNonTty?: boolean;
  readonly verbose?: boolean;
}

export interface PiInteractiveRunResult {
  readonly status: "completed" | "failed" | "blocked";
  readonly command: string;
  readonly args: string[];
  readonly cwd: string;
  readonly packageName: string;
  readonly packageVersion: string;
  readonly exitCode?: number;
  readonly signal?: NodeJS.Signals;
  readonly reason?: string;
}

export interface PiAgentRunResult {
  readonly status: "completed" | "failed";
  readonly transport: "sdk" | "cli";
  readonly command?: string;
  readonly args?: string[];
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
  readonly packageName: string;
  readonly packageVersion: string;
  readonly sessionMode?: PiSessionMode;
  readonly sessionId?: string;
  readonly sessionFile?: string;
  readonly sessionDir?: string;
  readonly activeTools?: string[];
  readonly eventTypes?: string[];
  readonly eventCounts?: Record<string, number>;
  readonly eventTrace?: PiEventTrace[];
  readonly errorMessage?: string;
  /** True only when setup failed before session.prompt() could dispatch the turn. */
  readonly fallbackEligible?: boolean;
}

export type PiSessionMode = "memory" | "create" | "continue";

export type PiEventTraceKind = "session" | "prompt" | "pi_event" | "tool" | "error";

export interface PiEventTrace {
  readonly index: number;
  readonly at: string;
  readonly kind: PiEventTraceKind;
  readonly type: string;
  readonly status?: "started" | "updated" | "completed" | "failed";
  readonly message?: string;
  readonly toolCallId?: string;
  readonly toolName?: string;
  readonly detail?: string;
}

export interface PiModelInfo {
  readonly provider: string;
  readonly providerName: string;
  readonly id: string;
  readonly name: string;
  readonly available: boolean;
  readonly authSource?: string;
  readonly authLabel?: string;
  readonly api?: string;
  readonly reasoning: boolean;
  readonly input: string[];
  readonly contextWindow: number;
  readonly maxTokens: number;
  readonly usingOAuth: boolean;
}

export interface PiModelListInput {
  readonly agentDir?: string;
  readonly provider?: string;
  readonly availableOnly?: boolean;
}

export interface PiToolInfo {
  readonly name: string;
  readonly description: string;
  readonly active: boolean;
  readonly source: string;
  readonly scope: string;
  readonly origin: string;
  readonly parameterKeys: string[];
  readonly promptGuidelines: string[];
}

export interface PiToolRegistryStatus {
  readonly cwd: string;
  readonly agentDir: string;
  readonly sessionId: string;
  readonly activeTools: string[];
  readonly tools: PiToolInfo[];
}

export interface PiToolInspectInput {
  readonly cwd?: string;
  readonly agentDir?: string;
  readonly tools?: readonly string[];
}

export interface PiCommandInfo {
  readonly name: string;
  readonly invocation: string;
  readonly description: string;
  readonly source: "extension" | "prompt" | "skill";
  readonly scope: string;
  readonly origin: string;
  readonly sourcePath?: string;
}

export interface PiCommandCatalogStatus {
  readonly cwd: string;
  readonly agentDir: string;
  readonly sessionId: string;
  readonly commands: PiCommandInfo[];
}

export interface PiCommandInspectInput {
  readonly cwd?: string;
  readonly agentDir?: string;
  readonly tools?: readonly string[];
}

export async function inspectPiRuntime(input: { readonly homeDir?: string } = {}): Promise<PiRuntimeStatus> {
  const home = input.homeDir ?? homedir();
  const rootPath = join(home, ".pi");
  const [cliAvailable, npxAvailable, sdk] = await Promise.all([
    canExecute("pi", ["--version"]),
    canExecute("npx", ["--version"]),
    inspectPiSdkExports()
  ]);
  const installed = await exists(rootPath);
  const configFiles: string[] = [];
  const workflowFiles: string[] = [];

  if (installed) {
    const entries = await readdir(rootPath, { recursive: true }).catch(() => []);
    const files = entries.map(String);
    configFiles.push(...files.filter((file) => /(^|\/)(config|settings|models|auth).*\.(json|ya?ml|toml)$/i.test(file)));
    workflowFiles.push(...files.filter((file) => /(^|\/)(workflow|flow|agent|task|skill).*\.(json|ya?ml|toml|ts|js|py|md)$/i.test(file)));
  }

  return {
    rootPath,
    installed,
    configFiles,
    workflowFiles,
    cliAvailable,
    npxAvailable,
    packageName: PI_CODING_AGENT_PACKAGE,
    packageVersion: PI_CODING_AGENT_VERSION,
    integrationMode: "embedded_sdk",
    sdkLoadable: sdk.loadable,
    sdkExports: sdk.exports,
    missingSdkExports: sdk.missingExports,
    adapterState: sdk.loadable ? (installed ? "sdk_ready_with_pi_home" : "sdk_ready") : "sdk_missing",
    nextActions: sdk.loadable
      ? [
          "Create Muster runs through Pi's createAgentSession() embedded SDK path.",
          "Inject Muster tools, context graph, memory hooks, eval hooks, and TUI event renderers around the real AgentSession.",
          "Use the Pi CLI only as an explicit diagnostic transport, never as the default harness runtime."
        ]
      : [
          `Install ${PI_CODING_AGENT_NPX_SPEC} and its sibling pi packages in @musterhq/core.`,
          "Do not ship a fake local runner while the embedded Pi SDK is unavailable."
        ]
  };
}

export async function readPiCandidateFile(path: string): Promise<string> {
  return readFile(path, "utf8");
}

export async function runPiAgent(input: PiAgentRunInput): Promise<PiAgentRunResult> {
  if (input.transport === "cli") return runPiCliDiagnostic(input);
  return runPiEmbeddedAgent(input);
}

export async function runPiInteractive(input: PiInteractiveRunInput = {}): Promise<PiInteractiveRunResult> {
  const cwd = input.cwd ?? process.cwd();
  const command = process.execPath;
  const args = [resolvePiCliPath(), ...buildPiInteractiveArgs(input)];
  if (!input.allowNonTty && (!process.stdin.isTTY || !process.stdout.isTTY)) {
    return {
      status: "blocked",
      command,
      args,
      cwd,
      packageName: PI_CODING_AGENT_PACKAGE,
      packageVersion: PI_CODING_AGENT_VERSION,
      reason: "Pi interactive mode requires an attached TTY. Use `muster pi ask` for non-interactive runs."
    };
  }

  const child = spawn(command, args, {
    cwd,
    stdio: "inherit",
    env: buildPiInteractiveEnv(input)
  });
  const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  return {
    status: result.code === 0 ? "completed" : "failed",
    command,
    args,
    cwd,
    packageName: PI_CODING_AGENT_PACKAGE,
    packageVersion: PI_CODING_AGENT_VERSION,
    exitCode: result.code ?? undefined,
    signal: result.signal ?? undefined
  };
}

/** The env var pi reads for each common provider's key. */
const PI_PROVIDER_KEY_ENV: Record<string, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  google: "GEMINI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  groq: "GROQ_API_KEY",
  xai: "XAI_API_KEY",
  mistral: "MISTRAL_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
  together: "TOGETHER_API_KEY",
  fireworks: "FIREWORKS_API_KEY",
};

/**
 * pi's "No API key found" ends with advice for its own TUI (`/login`), which
 * Muster does not have. Say which key is missing and what to run instead.
 */
export function explainPiError(message: string): string {
  const match = message.match(/^No API key found for (?:"([^"]+)"|the selected model|([\w.-]+))/);
  if (!match) return message;
  const provider = (match[1] ?? match[2])?.replace(/\.+$/, "");
  if (provider) {
    const env = PI_PROVIDER_KEY_ENV[provider];
    return `No API key for pi provider ${provider}: ${env ? `set ${env}` : "set its API key in the environment"}, or pick another provider with /model <provider>/<model> (muster pi models lists them).`;
  }
  return "pi has no model it can use: no API key is set for any pi provider. Set one, for example ANTHROPIC_API_KEY or OPENAI_API_KEY, then run muster pi models to see which providers are available.";
}

/** Shown on `/runtime pi` when no pi model has credentials, so the first turn does not fail unexplained. */
export function piNoKeyWarning(models: ReadonlyArray<{ readonly available: boolean }>): string | undefined {
  if (models.some((model) => model.available)) return undefined;
  return "pi has no API key for any provider yet: set one, for example ANTHROPIC_API_KEY or OPENAI_API_KEY (muster pi models lists providers).";
}

export async function listPiModels(input: PiModelListInput = {}): Promise<PiModelInfo[]> {
  const pi = await import("@earendil-works/pi-coding-agent");
  const agentDir = input.agentDir ?? (process.env.MUSTER_PI_AGENT_DIR || join(homedir(), ".pi", "agent"));
  const { modelRegistry } = createPiModelRegistry(pi, agentDir);
  const sourceModels = input.availableOnly ? modelRegistry.getAvailable() : modelRegistry.getAll();
  return sourceModels
    .filter((model) => !input.provider || model.provider === input.provider)
    .map((model) => {
      const authStatus = modelRegistry.getProviderAuthStatus(model.provider);
      return {
        provider: model.provider,
        providerName: modelRegistry.getProviderDisplayName(model.provider),
        id: model.id,
        name: model.name,
        available: modelRegistry.hasConfiguredAuth(model),
        authSource: authStatus.source,
        authLabel: authStatus.label,
        api: model.api,
        reasoning: model.reasoning,
        input: [...model.input],
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
        usingOAuth: modelRegistry.isUsingOAuth(model)
      };
    })
    .sort((left, right) => {
      const providerOrder = left.provider.localeCompare(right.provider);
      return providerOrder || left.id.localeCompare(right.id);
    });
}

export async function inspectPiTools(input: PiToolInspectInput = {}): Promise<PiToolRegistryStatus> {
  const pi = await import("@earendil-works/pi-coding-agent");
  const cwd = input.cwd ?? process.cwd();
  const agentDir = input.agentDir ?? (process.env.MUSTER_PI_AGENT_DIR || join(homedir(), ".pi", "agent"));
  const settingsManager = pi.SettingsManager.create(cwd, agentDir);
  const sessionManager = pi.SessionManager.inMemory(cwd);
  const resourceLoader = new pi.DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager
  });
  await resourceLoader.reload();
  const { authStorage, modelRegistry } = createPiModelRegistry(pi, agentDir);
  const { session } = await pi.createAgentSession({
    cwd,
    agentDir,
    authStorage,
    modelRegistry,
    tools: [...(input.tools?.length ? input.tools : DEFAULT_PI_ACTIVE_TOOLS)],
    sessionManager,
    settingsManager,
    resourceLoader
  });
  const catalogSession =
    input.tools?.length
      ? (
          await pi.createAgentSession({
            cwd,
            agentDir,
            authStorage,
            modelRegistry,
            sessionManager: pi.SessionManager.inMemory(cwd),
            settingsManager,
            resourceLoader
          })
        ).session
      : session;
  try {
    const activeTools = session.getActiveToolNames();
    const active = new Set(activeTools);
    return {
      cwd,
      agentDir,
      sessionId: session.sessionId,
      activeTools,
      tools: catalogSession
        .getAllTools()
        .map((tool) => ({
          name: tool.name,
          description: tool.description,
          active: active.has(tool.name),
          source: tool.sourceInfo.source,
          scope: tool.sourceInfo.scope,
          origin: tool.sourceInfo.origin,
          parameterKeys: extractParameterKeys(tool.parameters),
          promptGuidelines: [...(tool.promptGuidelines ?? [])]
        }))
        .sort((left, right) => left.name.localeCompare(right.name))
    };
  } finally {
    if (catalogSession !== session) catalogSession.dispose();
    session.dispose();
  }
}

export async function inspectPiCommands(input: PiCommandInspectInput = {}): Promise<PiCommandCatalogStatus> {
  const pi = await import("@earendil-works/pi-coding-agent");
  const cwd = input.cwd ?? process.cwd();
  const agentDir = input.agentDir ?? (process.env.MUSTER_PI_AGENT_DIR || join(homedir(), ".pi", "agent"));
  const settingsManager = pi.SettingsManager.create(cwd, agentDir);
  const sessionManager = pi.SessionManager.inMemory(cwd);
  const resourceLoader = new pi.DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager
  });
  await resourceLoader.reload();
  const { authStorage, modelRegistry } = createPiModelRegistry(pi, agentDir);
  const { session } = await pi.createAgentSession({
    cwd,
    agentDir,
    authStorage,
    modelRegistry,
    tools: [...(input.tools?.length ? input.tools : DEFAULT_PI_ACTIVE_TOOLS)],
    sessionManager,
    settingsManager,
    resourceLoader
  });

  try {
    return {
      cwd,
      agentDir,
      sessionId: session.sessionId,
      commands: collectPiCommands(session)
    };
  } finally {
    session.dispose();
  }
}

export async function runPiEmbeddedAgent(input: PiAgentRunInput): Promise<PiAgentRunResult> {
  if (!input.prompt.trim()) throw new Error("Pi prompt is required.");
  const started = Date.now();
  const eventTypes: string[] = [];
  const eventCounts: Record<string, number> = {};
  const eventTrace: PiEventTrace[] = [];
  let traceIndex = 0;
  const appendTrace = (item: Omit<PiEventTrace, "index" | "at">) => {
    eventTrace.push({ index: ++traceIndex, at: new Date().toISOString(), ...item });
  };
  const sessionMode = input.sessionMode ?? "memory";
  let promptDispatched = false;
  try {
    const pi = await import("@earendil-works/pi-coding-agent");
    const cwd = input.cwd ?? process.cwd();
    const agentDir = input.agentDir ?? (process.env.MUSTER_PI_AGENT_DIR || join(homedir(), ".pi", "agent"));
    const settingsManager = pi.SettingsManager.create(cwd, agentDir);
    const { authStorage, modelRegistry } = createPiModelRegistry(pi, agentDir);
    const selectedModel = resolvePiModel(modelRegistry, input.provider, input.model);
    const sessionManager = createPiSessionManager(pi.SessionManager, {
      cwd,
      sessionMode,
      sessionDir: input.sessionDir
    });
    const resourceLoader = new pi.DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager
    });
    await resourceLoader.reload();
    const { session } = await pi.createAgentSession({
      cwd,
      agentDir,
      authStorage,
      modelRegistry,
      model: selectedModel,
      thinkingLevel: input.thinking,
      tools: [...(input.tools?.length ? input.tools : DEFAULT_PI_ACTIVE_TOOLS)],
      sessionManager,
      settingsManager,
      resourceLoader
    });
    await prewarmPiSessionFile(sessionManager);
    appendTrace({
      kind: "session",
      type: "session_created",
      status: "completed",
      message: `Pi session ${session.sessionId}`,
      detail: buildPiSessionLabel({
        sessionMode,
        sessionId: session.sessionId,
        sessionFile: session.sessionFile,
        sessionDir: sessionManager.getSessionDir(),
        activeTools: session.getActiveToolNames(),
        eventCounts
      })
    });
    let emittedAssistantChars = 0;
    const toolArgs = new Map<string, Record<string, unknown>>();
    const unsubscribe = session.subscribe((event) => {
      eventTypes.push(event.type);
      eventCounts[event.type] = (eventCounts[event.type] ?? 0) + 1;
      eventTrace.push(normalizePiEvent(event, ++traceIndex));
      if (input.onToolEvent && (event.type === "tool_execution_start" || event.type === "tool_execution_end")) {
        if (event.type === "tool_execution_start" && event.args && typeof event.args === "object") toolArgs.set(event.toolCallId, event.args as Record<string, unknown>);
        const mapped = piToolEventToAgentToolEvent(event, toolArgs.get(event.toolCallId));
        if (event.type === "tool_execution_end") toolArgs.delete(event.toolCallId);
        if (mapped) {
          try { input.onToolEvent(mapped); } catch { /* a surface bug never fails the turn */ }
        }
      }
      if (input.onDelta && (event.type === "message_update" || event.type === "message_end")) {
        const text = extractAssistantTextFromEvent(event);
        if (text !== undefined) {
          if (text.length < emittedAssistantChars) emittedAssistantChars = 0; // new assistant message started
          const delta = text.slice(emittedAssistantChars);
          if (delta) {
            emittedAssistantChars = text.length;
            input.onDelta(delta);
          }
        }
      }
    });
    try {
      let responseText = "";
      let promptError: string | undefined;
      appendTrace({
        kind: "prompt",
        type: "prompt_start",
        status: "started",
        message: "Prompt submitted to Pi AgentSession"
      });
      try {
        promptDispatched = true;
        await session.prompt(input.prompt);
        responseText = extractLatestAssistantText(session.messages);
      } catch (error) {
        promptError = error instanceof Error ? error.message : String(error);
        appendTrace({
          kind: "error",
          type: "prompt_error",
          status: "failed",
          message: promptError
        });
      }
      appendTrace({
        kind: "prompt",
        type: "prompt_end",
        status: responseText && !promptError ? "completed" : "failed",
        message: responseText ? "Assistant text captured from Pi session" : "Pi session ended without assistant text"
      });
      return {
        status: responseText && !promptError ? "completed" : "failed",
        transport: "sdk",
        stdout: responseText,
        stderr: "",
        durationMs: Date.now() - started,
        packageName: PI_CODING_AGENT_PACKAGE,
        packageVersion: PI_CODING_AGENT_VERSION,
        sessionMode,
        sessionId: session.sessionId,
        sessionFile: session.sessionFile,
        sessionDir: sessionManager.getSessionDir(),
        activeTools: session.getActiveToolNames(),
        eventTypes,
        eventCounts,
        eventTrace,
        errorMessage: promptError ? explainPiError(promptError) : (responseText ? undefined : session.state.errorMessage ? explainPiError(session.state.errorMessage) : "Pi SDK completed without assistant text."),
        fallbackEligible: false,
      };
    } finally {
      unsubscribe();
      session.dispose();
    }
  } catch (error) {
    return {
      status: "failed",
      transport: "sdk",
      stdout: "",
      stderr: "",
      durationMs: Date.now() - started,
      packageName: PI_CODING_AGENT_PACKAGE,
      packageVersion: PI_CODING_AGENT_VERSION,
      sessionMode,
      eventTypes,
      eventCounts,
      eventTrace,
      errorMessage: explainPiError(error instanceof Error ? error.message : String(error)),
      fallbackEligible: !promptDispatched,
    };
  }
}

/**
 * Diagnostic-only transport. Muster's product runtime must use runPiEmbeddedAgent().
 */
export async function runPiCliDiagnostic(input: PiCliDiagnosticRunInput): Promise<PiAgentRunResult> {
  if (!input.prompt.trim()) throw new Error("Pi prompt is required.");
  const command = input.command ?? ((await canExecute("pi", ["--version"])) ? "pi" : "npx");
  const piArgs = buildPiCliArgs(input);
  const args = command === "npx" ? ["--yes", PI_CODING_AGENT_NPX_SPEC, ...piArgs] : piArgs;
  const started = Date.now();
  try {
    const result = await execFileAsync(command, args, {
      cwd: input.cwd ?? process.cwd(),
      timeout: input.timeoutMs ?? 120_000,
      maxBuffer: 1024 * 1024 * 8
    });
    return {
      status: "completed",
      transport: "cli",
      command,
      args,
      stdout: result.stdout.trim(),
      stderr: result.stderr.trim(),
      durationMs: Date.now() - started,
      packageName: PI_CODING_AGENT_PACKAGE,
      packageVersion: PI_CODING_AGENT_VERSION
    };
  } catch (error) {
    const detail = error as Error & { stdout?: string; stderr?: string };
    return {
      status: "failed",
      transport: "cli",
      command,
      args,
      stdout: detail.stdout?.trim() ?? "",
      stderr: detail.stderr?.trim() ?? "",
      durationMs: Date.now() - started,
      packageName: PI_CODING_AGENT_PACKAGE,
      packageVersion: PI_CODING_AGENT_VERSION,
      errorMessage: detail.message
    };
  }
}

export function buildPiCliArgs(input: PiCliDiagnosticRunInput): string[] {
  const args = ["--mode", "text", "--print"];
  if (input.noSession ?? true) args.push("--no-session");
  const tools = input.tools?.length ? input.tools : ["read", "grep", "find", "ls"];
  args.push("--tools", tools.join(","));
  if (input.provider) args.push("--provider", input.provider);
  if (input.model) args.push("--model", input.model);
  if (input.thinking) args.push("--thinking", input.thinking);
  args.push(input.prompt);
  return args;
}

export const buildPiAgentArgs = buildPiCliArgs;
export const runPiCodingAgent = runPiCliDiagnostic;

export function buildPiInteractiveArgs(input: PiInteractiveRunInput = {}): string[] {
  const args: string[] = [];
  if (input.sessionMode === "memory") args.push("--no-session");
  if (input.sessionMode === "continue") args.push("--continue");
  if (input.sessionId) args.push("--session-id", input.sessionId);
  if (input.sessionDir) args.push("--session-dir", input.sessionDir);
  const tools = input.tools?.length ? input.tools : DEFAULT_PI_ACTIVE_TOOLS;
  args.push("--tools", tools.join(","));
  if (input.provider) args.push("--provider", input.provider);
  if (input.model) args.push("--model", input.model);
  if (input.thinking) args.push("--thinking", input.thinking);
  if (input.verbose) args.push("--verbose");
  if (input.prompt?.trim()) args.push(input.prompt.trim());
  return args;
}

export function buildPiSessionLabel(result: Pick<PiAgentRunResult, "sessionMode" | "sessionId" | "sessionFile" | "sessionDir" | "activeTools" | "eventCounts">): string {
  const events = Object.entries(result.eventCounts ?? {})
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, count]) => `${name}:${count}`)
    .join(",");
  return [
    `mode=${result.sessionMode ?? "unknown"}`,
    `session=${result.sessionId ?? "-"}`,
    `file=${result.sessionFile ?? "-"}`,
    `dir=${result.sessionDir ?? "-"}`,
    `tools=${result.activeTools?.join(",") ?? "-"}`,
    `events=${events || "-"}`
  ].join(" ");
}

export function summarizePiEventTrace(trace: readonly PiEventTrace[], limit = 8): string {
  if (!trace.length) return "trace=-";
  return trace
    .slice(-Math.max(1, limit))
    .map((event) => {
      const tool = event.toolName ? `:${event.toolName}` : "";
      const status = event.status ? `=${event.status}` : "";
      return `${event.index}:${event.type}${tool}${status}`;
    })
    .join(" ");
}

function createPiSessionManager(
  SessionManager: typeof import("@earendil-works/pi-coding-agent").SessionManager,
  options: { readonly cwd: string; readonly sessionMode: PiSessionMode; readonly sessionDir?: string }
) {
  if (options.sessionMode === "memory") return SessionManager.inMemory(options.cwd);
  if (options.sessionMode === "create") return SessionManager.create(options.cwd, options.sessionDir);
  return SessionManager.continueRecent(options.cwd, options.sessionDir);
}

function collectPiCommands(session: import("@earendil-works/pi-coding-agent").AgentSession): PiCommandInfo[] {
  const extensionCommands = session.extensionRunner.getRegisteredCommands().map((command) => ({
    name: command.invocationName,
    invocation: `/${command.invocationName}`,
    description: command.description ?? "",
    source: "extension" as const,
    scope: command.sourceInfo.scope,
    origin: command.sourceInfo.origin,
    sourcePath: sourcePathFromInfo(command.sourceInfo)
  }));
  const promptCommands = session.promptTemplates.map((prompt) => ({
    name: prompt.name,
    invocation: `/${prompt.name}`,
    description: prompt.description ?? "",
    source: "prompt" as const,
    scope: prompt.sourceInfo.scope,
    origin: prompt.sourceInfo.origin,
    sourcePath: sourcePathFromInfo(prompt.sourceInfo)
  }));
  const skillCommands = session.resourceLoader.getSkills().skills.map((skill) => ({
    name: `skill:${skill.name}`,
    invocation: `/skill:${skill.name}`,
    description: skill.description ?? "",
    source: "skill" as const,
    scope: skill.sourceInfo.scope,
    origin: skill.sourceInfo.origin,
    sourcePath: sourcePathFromInfo(skill.sourceInfo)
  }));
  return [...extensionCommands, ...promptCommands, ...skillCommands].sort((left, right) => {
    const nameOrder = left.name.localeCompare(right.name);
    return nameOrder || left.source.localeCompare(right.source);
  });
}

function sourcePathFromInfo(sourceInfo: { readonly path: string; readonly source: string }): string {
  return sourceInfo.path || sourceInfo.source;
}

function buildPiInteractiveEnv(input: PiInteractiveRunInput): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...(input.agentDir ? { PI_CODING_AGENT_DIR: input.agentDir } : {}),
    ...(input.sessionDir ? { PI_CODING_AGENT_SESSION_DIR: input.sessionDir } : {})
  };
}

function resolvePiCliPath(): string {
  return join(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))), "cli.js");
}

function createPiModelRegistry(pi: typeof import("@earendil-works/pi-coding-agent"), agentDir: string) {
  const authStorage = pi.AuthStorage.create(join(agentDir, "auth.json"));
  const modelRegistry = pi.ModelRegistry.create(authStorage, join(agentDir, "models.json"));
  return { authStorage, modelRegistry };
}

function resolvePiModel(
  modelRegistry: import("@earendil-works/pi-coding-agent").ModelRegistry,
  provider?: string,
  modelId?: string
) {
  if (!provider && !modelId) return undefined;
  if (!provider || !modelId) {
    throw new Error("Pi provider and model must be passed together. Use `muster pi models` to discover valid pairs.");
  }
  const model = modelRegistry.find(provider, modelId);
  if (!model) {
    const known = modelRegistry
      .getAll()
      .filter((candidate) => candidate.provider === provider)
      .slice(0, 8)
      .map((candidate) => candidate.id)
      .join(", ");
    throw new Error(
      `Pi model not found for provider=${provider} model=${modelId}.` +
        (known ? ` Known ${provider} models include: ${known}.` : " Run `muster pi models` to discover providers and models.")
    );
  }
  return model;
}

async function prewarmPiSessionFile(sessionManager: Pick<import("@earendil-works/pi-coding-agent").SessionManager, "getHeader" | "getSessionFile">): Promise<void> {
  const sessionFile = sessionManager.getSessionFile();
  if (!sessionFile) return;
  if (await exists(sessionFile)) return;
  const header = sessionManager.getHeader();
  if (!header) return;
  await mkdir(dirname(sessionFile), { recursive: true });
  await writeFile(sessionFile, `${JSON.stringify(header)}\n`, { encoding: "utf8", flag: "wx" }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
  });
}

async function inspectPiSdkExports(): Promise<{ loadable: boolean; exports: string[]; missingExports: string[] }> {
  try {
    const pi = await import("@earendil-works/pi-coding-agent");
    const exported = Object.keys(pi).sort();
    return {
      loadable: true,
      exports: exported,
      missingExports: REQUIRED_SDK_EXPORTS.filter((name) => !(name in pi))
    };
  } catch {
    return {
      loadable: false,
      exports: [],
      missingExports: [...REQUIRED_SDK_EXPORTS]
    };
  }
}

function normalizePiEvent(event: import("@earendil-works/pi-coding-agent").AgentSessionEvent, index: number): PiEventTrace {
  const base = {
    index,
    at: new Date().toISOString(),
    type: event.type
  };
  if (event.type === "tool_execution_start") {
    return {
      ...base,
      kind: "tool",
      status: "started",
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      detail: summarizeToolArgs(event.args)
    };
  }
  if (event.type === "tool_execution_update") {
    return {
      ...base,
      kind: "tool",
      status: "updated",
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      detail: summarizeToolArgs(event.args)
    };
  }
  if (event.type === "tool_execution_end") {
    return {
      ...base,
      kind: "tool",
      status: event.isError ? "failed" : "completed",
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      detail: event.isError ? "tool result marked as error" : "tool result completed"
    };
  }
  if (event.type === "agent_start" || event.type === "turn_start" || event.type === "message_start") {
    return { ...base, kind: "pi_event", status: "started", detail: summarizePiMessageEvent(event) };
  }
  if (event.type === "agent_end" || event.type === "turn_end" || event.type === "message_end") {
    return { ...base, kind: "pi_event", status: "completed", detail: summarizePiMessageEvent(event) };
  }
  if (event.type === "message_update" || event.type === "queue_update") {
    return { ...base, kind: "pi_event", status: "updated", detail: summarizePiMessageEvent(event) };
  }
  if (event.type === "compaction_end" || event.type === "auto_retry_end") {
    return { ...base, kind: "pi_event", status: "success" in event && event.success === false ? "failed" : "completed" };
  }
  if (event.type === "auto_retry_start" || event.type === "compaction_start") {
    return { ...base, kind: "pi_event", status: "started" };
  }
  return { ...base, kind: "pi_event" };
}

function summarizeToolArgs(args: unknown): string {
  if (!isRecord(args)) return "args=-";
  const keys = Object.keys(args).sort();
  return keys.length ? `args=${keys.join(",")}` : "args=-";
}

function summarizePiMessageEvent(event: unknown): string | undefined {
  if (!isRecord(event)) return undefined;
  const message = event.message;
  if (!isRecord(message)) return undefined;
  const role = typeof message.role === "string" ? message.role : undefined;
  const content = message.content;
  const contentKind = Array.isArray(content) ? `parts:${content.length}` : typeof content;
  return [role ? `role=${role}` : undefined, `content=${contentKind}`].filter(Boolean).join(" ");
}

function extractParameterKeys(schema: unknown): string[] {
  if (!isRecord(schema)) return [];
  const properties = schema.properties;
  if (!isRecord(properties)) return [];
  return Object.keys(properties).sort();
}

/** Pull the assistant text out of a message_update/message_end event, if it carries one. */
function extractAssistantTextFromEvent(event: unknown): string | undefined {
  if (!isRecord(event)) return undefined;
  const message = event.message;
  if (!isRecord(message) || message.role !== "assistant") return undefined;
  if (typeof message.content === "string") return message.content;
  if (Array.isArray(message.content)) {
    return message.content
      .map((part) => {
        const item = part as { readonly type?: string; readonly text?: string };
        return item.type === "text" && item.text ? item.text : "";
      })
      .join("");
  }
  return undefined;
}

function extractLatestAssistantText(messages: readonly unknown[]): string {
  for (const message of [...messages].reverse()) {
    const candidate = message as { readonly role?: string; readonly content?: unknown };
    if (candidate.role !== "assistant") continue;
    if (typeof candidate.content === "string") return candidate.content.trim();
    if (Array.isArray(candidate.content)) {
      return candidate.content
        .map((part) => {
          const item = part as { readonly type?: string; readonly text?: string };
          return item.type === "text" && item.text ? item.text : "";
        })
        .join("")
        .trim();
    }
  }
  return "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function canExecute(command: string, args: string[]): Promise<boolean> {
  return execFileAsync(command, args, { timeout: 5000 }).then(
    () => true,
    () => false
  );
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false
  );
}
