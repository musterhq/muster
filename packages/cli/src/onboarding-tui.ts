import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { emitKeypressEvents } from "node:readline";
import {
  addCodexCliProvider,
  addPresetProvider,
  enableBuiltinPlugin,
  ensureDefaultConfig,
  listBuiltinMcpServers,
  listBuiltinPlugins,
  loadConfig,
  rosterMcpConfigFromCatalogEntry,
  saveConfig,
  setRuntimeProvider,
  DEFAULT_CODEX_MODEL,
  type McpServerConfig,
  type MemoryWritePolicy,
} from "@musterhq/core";
import { detectProviders, type DetectedProviders } from "./onboarding-detect.js";
import { formatSeconds, providerConfigFor, verifyRoute, verifyTargetFor, type RouteVerifier, type VerifyOutcome, type VerifyTarget } from "./onboarding-verify.js";
import { initGatewayConfig, saveGatewayConfig, type GatewayConfig } from "@musterhq/gateway";
import { buildPlan, detectMigrationOffers, formatPlan, offerHeadline, type MigrationOffer } from "./migrate.js";

type StepId = "purpose" | "style" | "provider" | "integrations" | "channels" | "memory" | "finish";
type Tone = "lavender" | "cyan" | "peach" | "lime";

interface Choice {
  readonly id: string;
  readonly label: string;
  readonly detail: string;
  readonly badge: string;
  readonly tone: Tone;
  readonly impact: string;
  readonly controls: readonly Control[];
  /**
   * Persona-audit fix: this screen used to print credential FIELDS
   * ("Bot token/env: SLACK_BOT_TOKEN") that looked enterable but had no input
   * mechanic behind them — onboarding cannot accept typed text, only
   * selections. Each selected path now names the exact, already-shipped command
   * that does the configuring, so nothing on screen promises an interaction
   * that does not exist.
   */
  readonly configureLater?: readonly string[];
}

interface Control {
  readonly label: string;
  readonly value: string;
}

interface Step {
  readonly id: StepId;
  readonly eyebrow: string;
  readonly title: string;
  readonly body: string;
  readonly choices: readonly Choice[];
}

interface OnboardingState {
  stepIndex: number;
  cursor: number;
  selected: Record<StepId, Set<string>>;
  saved?: boolean;
  /** Set while the quit prompt ("discard your choices?") is showing. */
  confirmQuit?: boolean;
  /** Result of the read-only provider scan; undefined until it finishes. */
  detected?: DetectedProviders;
  /** Set after save: the checklist stays up until a key is pressed. */
  awaitingAck?: boolean;
  applied?: OnboardingApplyResult;
  /**
   * Live verification of the model step. Results outlive the step: the finish
   * screen and the saved profile report them, and a failed route is never
   * written as the default.
   */
  verify?: VerificationState;
  /** Another agent setup found on this machine, offered on the first step (read-only until the user applies). */
  migration?: MigrationOfferState;
}

interface MigrationOfferState {
  readonly offer: MigrationOffer;
  readonly others: readonly MigrationOffer[];
  dismissed?: boolean;
  /** The plan from `muster migrate <source>`, while the review panel is open. */
  review?: string[];
}

interface VerificationState {
  running: boolean;
  /** Route ids in the order they were checked (failed ones left with Enter stay listed with their fix). */
  order: string[];
  /** Failed routes the user dismissed with `k`: neither listed nor counted on the finish screen. */
  skipped?: Set<string>;
  targets: Record<string, VerifyTarget>;
  results: Record<string, VerifyOutcome>;
}

interface OnboardingApplyResult {
  readonly workspaceProfilePath: string;
  readonly globalProfilePath: string;
  readonly configPath: string;
  readonly gatewayPath?: string;
  readonly configured: readonly string[];
  readonly nextActions: readonly SetupAction[];
  /** The route written as the runtime default; null when none was verified. */
  readonly defaultRoute: string | null;
}

interface SetupAction {
  readonly kind: "provider" | "plugin" | "mcp" | "channel" | "memory" | "frappe";
  readonly id: string;
  readonly label: string;
  readonly command?: string;
  readonly url?: string;
  readonly env?: readonly string[];
  readonly note: string;
}

const RESET = "\x1b[0m";
const ANSI: Record<Tone | "dim" | "text" | "border" | "selection" | "warn", string> = {
  lavender: "38;2;181;166;255",
  cyan: "38;2;41;211;255",
  peach: "38;2;247;198;106",
  lime: "38;2;104;245;168",
  dim: "38;2;142;161;181",
  text: "38;2;245;247;250",
  border: "38;2;41;211;255",
  selection: "38;2;7;16;23;48;2;104;245;168",
  warn: "38;2;247;198;106",
};

const steps: readonly Step[] = [
  {
    id: "purpose",
    eyebrow: "01 / shape",
    title: "Welcome to Muster.",
    body: "Let's build the assistant that remembers your work, protects your context, and spends fewer tokens getting useful answers.",
    choices: [
      choice("code", "Build with code", "Repo search, tests, code review, fixes, release notes, Codex and Claude Code routing.", "developer", "lavender", "Muster will bias toward repo-aware tools, tests, and direct shell actions before long model reasoning.", controls("Autonomy", "Ask before major actions", "Output style", "Concise")),
      choice("apps", "Connect work apps", "Google Drive, GitHub, browser, web search, and MCP tools.", "integrations", "cyan", "Read-only setup is safer; deeper indexing gives richer answers but requires more permissions.", controls("Permission", "Read-only first", "Context depth", "Balanced index")),
      choice("frappe", "Set up Frappe / ERPNext", "Site URL, installed apps, DocTypes, fields, workflows, reports, scripts.", "bench-aware", "peach", "Frappe answers will prefer module, DocType, field, and workflow context instead of generic ERP guesses.", controls("Context depth", "Deep graph index", "Permission", "Read-only first"), frappeCommands()),
      choice("memory", "Personal memory", "Preferences, project facts, named sessions, and scoped recall with receipts.", "recall", "lime", "Muster will ask what is worth remembering and use scoped recall to reduce repeated explanations.", controls("Recall strictness", "High", "Durable writes", "Ask before saving")),
      choice("research", "Research the web", "Fresh sources, browser checks, Playwright paths, and artifact-ready summaries.", "source-grounded", "cyan", "Source receipts make fresh answers auditable instead of relying on stale docs.", controls("Source receipts", "Always show", "Browser actions", "Approval-gated")),
      choice("team", "Team workflows", "Agents, subagents, scheduled checks, dashboards, and channel surfaces.", "operations", "lavender", "Team defaults prepare dashboards, channel routing, and approval gates before automation.", controls("Automation", "Draft first", "Subagents", "Ask before delegation")),
    ],
  },
  {
    id: "style",
    eyebrow: "02 / priorities",
    title: "What should Muster optimize for?",
    body: "Tune the assistant's behavior. Every priority has an operational tradeoff.",
    choices: [
      choice("speed", "Fast answers", "Prefer direct tools and short context when the task is simple.", "low latency", "cyan", "Short tasks prefer tools and compact prompts; deep analysis may be asked for explicitly.", controls("Priority weight", "5/5", "Conflict policy", "Balance automatically")),
      choice("accuracy", "Accuracy", "Use receipts, sources, and eval gates before trusting generated context.", "evidence", "lavender", "More evidence checks can cost a little time but reduce confident wrong answers.", controls("Evidence level", "Strict", "Eval gates", "Before promotion")),
      choice("tokens", "Use fewer tokens", "Retrieve targeted memory instead of stuffing old transcripts into every prompt.", "less waste", "lime", "Retrieval runs before prompt stuffing, so fewer old tokens are sent and receipts explain what was recalled.", controls("Token budget", "Balanced", "Recall first", "Enabled")),
      choice("privacy", "Prevent leaks", "Keep tenant, workspace, user, role, and session scopes explicit.", "scope rails", "peach", "Tenant, user, workspace, role, and session scopes stay visible so memory does not bleed across contexts.", controls("Scope visibility", "Always", "Cross-scope recall", "Blocked")),
      choice("local", "Local-first when possible", "Prefer local routes for sensitive work and escalate only when needed.", "quiet mode", "lavender", "Sensitive tasks prefer local/private routes, with cloud escalation kept explicit.", controls("Sensitive route", "Local first", "Escalation", "Ask")),
      choice("explain", "Explain retrieval", "Show why memory was recalled and what was ignored.", "receipts", "cyan", "Receipts build trust, but add a little more visible detail after answers.", controls("Receipt detail", "Compact", "Show misses", "When useful")),
    ],
  },
  {
    id: "provider",
    eyebrow: "03 / model",
    title: "Which model routes should Muster prepare?",
    body: "Pick one or many. Muster can keep a fast route, a deeper fallback, and a private self-hosted route.",
    choices: [
      choice("codex", "Codex", "Best default for coding, repo work, terminal tasks, and fast operational loops.", "recommended", "cyan", "Use for fast daily coding turns; route changes are recorded instead of hidden.", controls("Use for", "Default route", "Budget guard", "Balanced cost"), ["codex login"]),
      choice("claude", "Claude Code", "Familiar coding assistant flow with strong planning and editing behavior.", "coding", "lavender", "Use as a strong coding route or deep fallback when edits need more planning.", controls("Use for", "Deep work", "Budget guard", "Best quality"), ["claude login"]),
      choice("openai", "OpenAI API", "Direct cloud models with configurable presets and token accounting.", "cloud", "cyan", "Direct API routes simplify model choice and token accounting.", controls("Model preset", "GPT-5.6", "Use for", "Default/fallback"), ["export OPENAI_API_KEY=...", "muster provider add openai --model gpt-5.6"]),
      choice("anthropic", "Anthropic API", "Claude models through API keys and governed runtime routes.", "cloud", "peach", "Anthropic can be kept as a reasoning-heavy fallback or main route.", controls("Model preset", "Claude Sonnet", "Use for", "Deep work"), ["export ANTHROPIC_API_KEY=...", "muster provider add anthropic"]),
      choice("selfhosted", "Self-hosted endpoint", "Private OpenAI-compatible routes for teams that already run a reliable model gateway.", "private", "lime", "Maximum locality, but quality and latency depend on the endpoint you operate.", controls("Use for", "Sensitive tasks", "Escalation", "Ask"), ["muster provider add-openai-compatible private https://models.internal.example/v1 served-model"]),
      choice("hybrid", "Hybrid", "Fast default model with stronger fallback, recorded as evidence.", "balanced", "lavender", "Hybrid mode improves reliability but makes route policy more important.", controls("Primary", "Fast route", "Fallback", "Deep route")),
    ],
  },
  {
    id: "integrations",
    eyebrow: "04 / senses",
    title: "Choose your assistant's senses.",
    body: "Every selected app gets a guided setup path. Credentials should be saved only after confirmation.",
    choices: [
      choice("frappe", "Frappe / ERPNext", "Site URL, app list, modules, DocTypes, fields, workflows, reports, scripts.", "plugin", "peach", "Deep graph indexing improves module/field accuracy but takes more setup than a light docs-only index.", controls("Permission", "Read-only first", "Context depth", "Deep graph index"), frappeCommands()),
      choice("drive", "Google Drive", "Docs, Sheets, Slides context with file-aware retrieval.", "oauth", "cyan", "Drive context makes documents useful but should start with scoped read access.", controls("Connection", "Open OAuth", "Scope", "Workspace only"), ["muster mcp oauth setup google-drive"]),
      choice("github", "GitHub", "Repos, issues, pull requests, release notes, and CI context.", "dev", "lavender", "GitHub access powers repo work; write operations should remain approval-gated.", controls("Permission", "Read-only first", "PR writes", "Ask"), ["muster plugins setup github"]),
      choice("browser", "Browser + Playwright", "Inspect web apps, test flows, capture visual evidence.", "qa", "lime", "Browser QA adds evidence but should ask before sensitive actions.", controls("Screenshots", "On QA", "Actions", "Approval-gated"), ["muster mcp install browser"]),
      choice("web", "Web search", "Fresh source-grounded answers without pretending stale docs are current.", "fresh", "cyan", "Web search improves freshness and should include source receipts.", controls("Sources", "Always cite", "Recency", "Prefer current"), ["muster plugins setup web-search"]),
      choice("mcp", "MCP bridge", "Bring external tools into Muster with policy and setup guidance.", "tools", "peach", "MCP expands power quickly; least-privilege policies keep it safe.", controls("Permission", "Ask before write", "Risk", "Show before enabling"), ["muster mcp catalog", "muster mcp install <id>"]),
      choice("artifacts", "Artifact Studio", "Reports, dashboards, generated docs, and shareable outputs.", "output", "lime", "Artifact mode turns answers into deliverables, but needs output review.", controls("Output", "Preview first", "Sharing", "Manual"), ["muster artifacts contract"]),
    ],
  },
  {
    id: "channels",
    eyebrow: "05 / channels",
    title: "Where should your assistant talk?",
    body: "Pick channels separately. Each surface has a different auth model and setup window.",
    choices: [
      choice("google-chat", "Google Chat", "Workspace app endpoint, exact authentication audience, and Google-signed requests.", "workspace", "cyan", "Workspace bots are powerful; start with mentioned spaces before broad visibility.", controls("Reply mode", "Draft first", "Visibility", "Mentioned spaces"), channelCommands("google-chat")),
      choice("slack", "Slack", "Bot token, app-level token, and Socket Mode install.", "bot", "lavender", "Draft-first keeps humans in control; auto-reply should be limited to low-risk channels.", controls("Reply mode", "Draft first", "Visibility", "Selected channels"), channelCommands("slack")),
      choice("teams", "Microsoft Teams", "Bot app ID, tenant ID, client secret, and Teams app package.", "enterprise", "peach", "Teams setup benefits from explicit tenant and org install choices.", controls("Reply mode", "Manual first", "Install scope", "Team"), channelCommands("teams")),
      choice("whatsapp", "WhatsApp (personal · groups)", "Link a dedicated number, then choose group JIDs and mention activation.", "linked device", "lime", "This unofficial protocol sits in a Meta ToS gray zone and the linked number can be banned; use a dedicated number.", controls("Activation", "Mention", "Groups", "Allowlist"), channelCommands("whatsapp")),
      choice("discord", "Discord", "Bot token, application ID, public key, and guild/channel defaults.", "community", "lavender", "Discord can move fast; selected guild/channel scope prevents surprise reach.", controls("Reply mode", "Draft first", "Visibility", "Selected channels"), channelCommands("discord")),
      choice("telegram", "Telegram", "Bot token, live Bot API check, long-poll local test, and webhook URL.", "chat", "cyan", "Telegram is a strong everyday chat surface when the Bot API is reachable; keep sends explicit until the bot is trusted.", controls("Reply mode", "Manual first", "Test mode", "Long-poll"), channelCommands("telegram")),
    ],
  },
  {
    id: "memory",
    eyebrow: "06 / memory contract",
    title: "How should Muster remember?",
    body: "Memory is scoped, searchable, receipt-backed context. It should lower token waste and reduce repeated explanation.",
    choices: [
      choice("chat", "Remember this chat", "Keep short-term continuity for the current session.", "session", "cyan", "Session recall improves continuity without becoming durable personal memory.", controls("Recall strictness", "Balanced", "Retention", "This chat")),
      choice("project", "Remember project context", "Persist repo, app, and deployment facts in workspace/tenant scopes.", "project", "lavender", "Project recall helps future work but must stay scoped to this workspace.", controls("Recall strictness", "High", "Retention", "This project")),
      choice("preferences", "Remember my preferences", "Tone, workflow, provider, and answer preferences.", "personal", "peach", "Preference memory personalizes the interface without leaking work data.", controls("Recall strictness", "Balanced", "Retention", "Until removed")),
      choice("site", "Remember app/site context", "Index Frappe or web-app context with graph links and receipts.", "plugin context", "lime", "Site memory helps app-aware answers but should be rebuilt when metadata changes.", controls("Index depth", "Graph", "Refresh", "On demand")),
      choice("ask", "Ask before saving", "Show what will be remembered before writing durable memory.", "consent", "cyan", "Durable memory writes require confirmation, reducing accidental personalization.", controls("Durable writes", "Ask first", "Receipt detail", "Compact"), ["muster memory status"]),
      choice("auto", "Save automatically", "Let Muster write durable memory without asking each time.", "hands-off", "peach", "Fastest personalization, but memory can fill with facts you never reviewed.", controls("Durable writes", "Automatic", "Receipt detail", "Compact")),
      choice("never", "Never save automatically", "Use the assistant without durable memory writes.", "private", "lavender", "Maximum privacy, but Muster will not personalize future sessions unless context is re-provided.", controls("Durable writes", "Disabled", "Retention", "None"), ["muster memory status"]),
    ],
  },
];

function choice(id: string, label: string, detail: string, badge: string, tone: Tone, impact: string, controls: readonly Control[], configureLater: readonly string[] = []): Choice {
  return { id, label, detail, badge, tone, impact, controls, configureLater };
}

function controls(firstLabel: string, firstValue: string, secondLabel: string, secondValue: string): readonly Control[] {
  return [{ label: firstLabel, value: firstValue }, { label: secondLabel, value: secondValue }];
}

/**
 * `muster frappe connect` is the shipped path (CLI usage line: `muster frappe
 * connect <https-site-origin>`); it opens the site's onboarding page and stores
 * the verified binding, so no token is ever typed into this screen.
 */
function frappeCommands(): readonly string[] {
  return ["muster frappe connect https://erp.example.com", "muster frappe doctor"];
}

/**
 * The exact commands `applyOnboardingProfile` records as next actions for each
 * channel — same strings, one source of intent, so the screen cannot promise a
 * setup path the profile does not write down.
 */
function channelCommands(id: string): readonly string[] {
  const commands: Record<string, readonly string[]> = {
    slack: ["muster channels setup slack --bot-token-env SLACK_BOT_TOKEN --app-token-env SLACK_APP_TOKEN"],
    whatsapp: ["muster channels setup whatsapp --account default --activation mention --groups <group-jid>", "muster channels login whatsapp"],
    "google-chat": ["muster channels ready gchat --audience https://your-domain.example/v1/adapters/gchat --no-start"],
    teams: ["muster channels setup teams --hmac-secret-env TEAMS_HMAC_SECRET --public-url https://your-domain.example"],
    discord: ["muster channels setup discord --bot-token-env DISCORD_BOT_TOKEN --public-key-env DISCORD_PUBLIC_KEY --public-url https://your-domain.example"],
    telegram: ["muster channels setup telegram --bot-token-env TELEGRAM_BOT_TOKEN --public-url https://your-domain.example"],
  };
  return commands[id] ?? [];
}

export async function runMusterOnboardingTui(args: readonly string[] = [], options: { cwd?: string; input?: NodeJS.ReadStream; output?: NodeJS.WriteStream; detect?: () => Promise<DetectedProviders>; verify?: RouteVerifier; home?: string; detectMigrations?: () => Promise<MigrationOffer[]> } = {}): Promise<{ saved: boolean; handoffToChat: boolean }> {
  const output = options.output ?? process.stdout;
  const input = options.input ?? process.stdin;
  const width = Math.max(88, output.columns ?? 112);
  const state = initialState();
  const cwd = options.cwd ?? process.cwd();
  const useColor = shouldUseOnboardingColor(args, input, output);
  const verifier = options.verify ?? verifyRoute;
  const detection = (options.detect ?? detectProviders)().catch(() => undefined);
  if (args.includes("--preview") || !input.isTTY || !output.isTTY) {
    // `--verify` alone means "verify my routes": open on the model step, the one it checks.
    const previewStep = readPreviewStep(args) ?? (args.includes("--verify") ? steps.findIndex((step) => step.id === "provider") : undefined);
    if (previewStep !== undefined) state.stepIndex = previewStep;
    state.detected = await detection;
    const stepId = currentStep(state).id;
    // The model step previews the machine's best guess, not every row ticked.
    if ((stepId === "provider" || stepId === "finish") && state.detected) preselectDetectedProviders(state);
    else preselectCurrentStep(state);
    if (args.includes("--verify") && (stepId === "provider" || stepId === "finish")) {
      await verifySelectedRoutes(state, verifier, () => undefined);
      if (stepId === "finish") skipFailedRoutes(state);
    }
    output.write(`${renderOnboarding(state, width, useColor)}\n`);
    return { saved: false, handoffToChat: false };
  }

  emitKeypressEvents(input);
  const wasRaw = input.isRaw;
  input.setRawMode(true);
  output.write("\x1b[?1049h\x1b[?25l");
  let lastFrame = "";
  const render = () => {
    const frame = renderOnboarding(state, width, useColor);
    if (frame === lastFrame) return;
    lastFrame = frame;
    output.write(`\x1b[H\x1b[2J${frame}\x1b[J`);
  };
  render();
  // Detection runs behind the first paint; keys work immediately and the rows fill in when it lands.
  void detection.then((detected) => {
    if (!detected || state.saved) return;
    state.detected = detected;
    preselectDetectedProviders(state);
    render();
  });
  // Other agent setups are looked for read-only, behind the first paint like provider detection.
  const migrationHome = options.home ?? onboardingHome();
  const migrations = (options.detectMigrations ?? (() => detectMigrationOffers({ home: migrationHome, cwd })))().catch(() => [] as MigrationOffer[]);
  void migrations.then((offers) => {
    if (!offers.length || state.saved) return;
    state.migration = { offer: offers[0]!, others: offers.slice(1) };
    render();
  });
  const result = await new Promise<{ saved: boolean; handoffToChat: boolean }>((resolve) => {
    const onKeypress = async (_chunk: string, key: { name?: string; ctrl?: boolean }) => {
      if (state.awaitingAck) {
        cleanup();
        resolve({ saved: true, handoffToChat: !args.includes("--no-chat") });
        return;
      }
      const migration = state.migration;
      if (migration?.review) {
        // The review panel only reads; Esc (or q) closes it.
        if (key.name === "escape" || key.name === "q") {
          migration.review = undefined;
          render();
        }
        return;
      }
      if (migration && !migration.dismissed && state.stepIndex === 0 && !state.confirmQuit) {
        if (key.name === "r") {
          const plan = await buildPlan(migration.offer.source, { home: migrationHome, cwd }).catch(() => undefined);
          migration.review = plan ? formatPlan(plan, { home: migrationHome, mode: "review" }) : [`Could not read the ${migration.offer.source} setup.`];
          render();
          return;
        }
        if (key.name === "k") {
          // Skip: dismiss the offer; nothing is written.
          migration.dismissed = true;
          render();
          return;
        }
      }
      if (state.confirmQuit) {
        if (key.name === "y") {
          cleanup();
          resolve({ saved: false, handoffToChat: false });
          return;
        }
        state.confirmQuit = false;
        render();
        return;
      }
      if ((key.ctrl && key.name === "c") || key.name === "q") {
        if (hasAnySelection(state)) {
          state.confirmQuit = true;
          render();
          return;
        }
        cleanup();
        resolve({ saved: false, handoffToChat: false });
        return;
      }
      let handled = true;
      if (key.name === "s") {
        // Owner requirement: onboarding must never gate coding. Skip applies
        // coding defaults for every step the user has not touched and opens
        // chat immediately; `muster onboard` re-opens customization anytime.
        applyCodingDefaults(state);
        state.applied = await applyOnboardingProfile(state, cwd);
        state.saved = true;
        state.awaitingAck = true;
        state.stepIndex = steps.length;
        state.confirmQuit = false;
        render();
        return;
      }
      const onModelStep = currentStep(state).id === "provider";
      const showingResults = onModelStep && state.verify && !state.verify.running;
      if (onModelStep && state.verify?.running && key.name !== "escape") return;
      if (key.name === "up") moveCursor(state, -1);
      else if (key.name === "down") moveCursor(state, 1);
      else if (key.name === "space") {
        toggleCurrent(state);
        // A changed selection has not been verified.
        if (onModelStep) state.verify = undefined;
      } else if (key.name === "escape") {
        if (onModelStep) state.verify = undefined;
        back(state);
      } else if (showingResults && key.name === "e") {
        editFailedRoutes(state);
      } else if (showingResults && key.name === "k") {
        const dismissed = state.verify!.skipped ?? new Set<string>();
        for (const id of failedRouteIds(state)) dismissed.add(id);
        state.verify!.skipped = dismissed;
        skipFailedRoutes(state);
        next(state);
      } else if (showingResults && key.name === "r") {
        retryFailedRoutes(state);
        void verifySelectedRoutes(state, verifier, render);
      } else if (key.name === "return" || key.name === "enter") {
        if (currentStep(state).id === "finish") {
          state.applied = await applyOnboardingProfile(state, cwd);
          state.saved = true;
          state.awaitingAck = true;
          state.confirmQuit = false;
          render();
          return;
        } else if (onModelStep && unverifiedSelectedRoutes(state).length) {
          // Nothing is "done" until it answered: verify before leaving the step.
          void verifySelectedRoutes(state, verifier, render);
        } else {
          if (onModelStep) skipFailedRoutes(state);
          next(state);
        }
      } else {
        handled = false;
      }
      if (handled) render();
    };
    const cleanup = () => {
      input.off("keypress", onKeypress);
      input.setRawMode(wasRaw);
      output.write("\x1b[?25h\x1b[?1049l\n");
    };
    input.on("keypress", onKeypress);
  });
  return result;
}

/** Selected model-step rows that are live routes and have no result yet. */
function unverifiedSelectedRoutes(state: OnboardingState): VerifyTarget[] {
  const targets: VerifyTarget[] = [];
  for (const item of choicesFor(providerStep(), state)) {
    if (!state.selected.provider.has(item.id) || state.verify?.results[item.id]) continue;
    const target = verifyTargetFor(item.id, item.label, state.detected?.[item.id]);
    if (target) targets.push(target);
  }
  return targets;
}

/**
 * Check every unverified selected route at once. Each result redraws as it
 * lands, so a slow route never hides a fast one's answer.
 */
async function verifySelectedRoutes(state: OnboardingState, verifier: RouteVerifier, render: () => void): Promise<void> {
  const pending = unverifiedSelectedRoutes(state);
  if (!pending.length) return;
  const verify: VerificationState = state.verify ?? { running: true, order: [], targets: {}, results: {} };
  verify.running = true;
  for (const target of pending) {
    verify.targets[target.id] = target;
    if (!verify.order.includes(target.id)) verify.order.push(target.id);
  }
  state.verify = verify;
  render();
  await Promise.all(pending.map(async (target) => {
    const outcome = await verifier(target).catch((error: unknown): VerifyOutcome => ({ ok: false, error: error instanceof Error ? error.message : String(error) }));
    if (state.verify !== verify) return;
    verify.results[target.id] = outcome;
    render();
  }));
  if (state.verify !== verify) return;
  verify.running = false;
  render();
}

function failedRouteIds(state: OnboardingState): string[] {
  return Object.entries(state.verify?.results ?? {}).filter(([, outcome]) => !outcome.ok).map(([id]) => id);
}

/** Skip: a failed route leaves the selection (it stays in the report). */
function skipFailedRoutes(state: OnboardingState): void {
  for (const id of failedRouteIds(state)) state.selected.provider.delete(id);
}

function editFailedRoutes(state: OnboardingState): void {
  const failed = failedRouteIds(state);
  const index = choicesFor(providerStep(), state).findIndex((item) => item.id === failed[0]);
  state.verify = undefined;
  if (index >= 0) state.cursor = index;
}

function retryFailedRoutes(state: OnboardingState): void {
  for (const id of failedRouteIds(state)) delete state.verify!.results[id];
}

/**
 * Coding-first defaults for the `s` skip path: only fills steps the user left
 * untouched, so a partial walk-through keeps every explicit choice.
 */
function applyCodingDefaults(state: OnboardingState): void {
  const defaults: Record<StepId, readonly string[]> = {
    purpose: ["code"],
    style: ["speed", "tokens"],
    provider: ["codex", "claude"],
    integrations: [],
    channels: [],
    memory: ["chat", "project", "ask"],
    finish: [],
  };
  for (const [stepId, choices] of Object.entries(defaults) as Array<[StepId, readonly string[]]>) {
    if (state.selected[stepId] && state.selected[stepId].size === 0) {
      for (const id of choices) state.selected[stepId].add(id);
    }
  }
}

export function onboardingProfilePath(cwd = process.cwd()): string {
  return join(cwd, ".muster", "onboarding-profile.json");
}

export function globalOnboardingProfilePath(home = onboardingHome()): string {
  return join(home, ".muster", "onboarding-profile.json");
}

export function hasCompletedMusterOnboarding(cwd = process.cwd()): boolean {
  return existsSync(globalOnboardingProfilePath()) || existsSync(onboardingProfilePath(cwd));
}

export function onboardingHome(): string {
  return process.env.MUSTER_ONBOARDING_HOME || homedir();
}

export function shouldUseOnboardingColor(args: readonly string[] = [], input: Pick<NodeJS.ReadStream, "isTTY"> = process.stdin, output: Pick<NodeJS.WriteStream, "isTTY"> = process.stdout): boolean {
  if (args.includes("--no-color") || args.includes("--color=never")) return false;
  if (args.includes("--color") || args.includes("--force-color") || args.includes("--color=always")) return true;
  const colorArg = args.find((arg) => arg.startsWith("--color="));
  if (colorArg === "--color=always" || colorArg === "--color=force") return true;
  if (colorArg === "--color=never" || colorArg === "--color=false") return false;
  if (process.env.FORCE_COLOR && process.env.FORCE_COLOR !== "0") return true;
  if (process.env.NO_COLOR) return false;
  return Boolean(input.isTTY && output.isTTY);
}

/** Columns the "So far:" rail claims when the terminal can afford it. */
const SUMMARY_RAIL_WIDTH = 30;
/** Below this inner width the rail stacks under the body instead of vanishing. */
const SUMMARY_RAIL_MIN_INNER = 84;
/** Every step is optional; the header says so on every step, not just the first. */
export const ONBOARDING_OPTIONAL_HINT = "every step optional — s starts coding now";

export function renderOnboarding(state: OnboardingState = initialState(), width = 112, useColor = false): string {
  const step = currentStep(state);
  if (state.migration?.review) return renderMigrationReview(state.migration, width, useColor);
  if (step.id === "finish") return renderFinish(state, width, useColor);
  const choices = choicesFor(step, state);
  const selectedChoices = choices.filter((item) => state.selected[step.id].has(item.id));
  const active = choices[state.cursor] ?? choices[0]!;
  const bodyWidth = Math.max(70, width - 4);
  const inner = bodyWidth - 4;
  const railWidth = inner >= SUMMARY_RAIL_MIN_INNER ? SUMMARY_RAIL_WIDTH : 0;
  // 3 columns pay for the " │ " gutter between the body and the rail.
  const mainWidth = railWidth ? inner - railWidth - 3 : inner;
  const main = [
    `${paint(step.eyebrow.toUpperCase(), "cyan", useColor)} ${progressLabel(state)}  ${paint(ONBOARDING_OPTIONAL_HINT, "dim", useColor)}`,
    "",
    ...wrap(step.title, mainWidth).map((line) => paint(line, "text", useColor)),
    ...wrap(step.body, mainWidth).map((line) => paint(line, "dim", useColor)),
    "",
    ...migrationOfferLines(state, mainWidth, useColor),
    ...renderChoices(step, state, mainWidth, useColor),
    "",
    ...(step.id === "provider" && state.verify
      ? renderVerifyPanel(state, mainWidth, useColor)
      : renderSetupSurface(selectedChoices, active, mainWidth, useColor, step.id === "provider" ? state.detected : undefined)),
  ];
  const rail = summaryRailLines(state, railWidth || inner, useColor);
  const body = railWidth
    ? zipRail(main, rail, mainWidth, useColor)
    : [...main, "", ...rail];
  if (state.confirmQuit) {
    return [
      borderTop("Muster onboarding", bodyWidth, useColor),
      ...body.map((line) => frame(line, bodyWidth, useColor)),
      frame("", bodyWidth, useColor),
      frame(`${paint("Discard your choices and quit?", "warn", useColor)}  ${paint("y", "lime", useColor)} discard  ${paint("any other key", "lime", useColor)} keep going`, bodyWidth, useColor),
      borderBottom(bodyWidth, useColor),
    ].join("\n");
  }
  return [
    borderTop("Muster onboarding", bodyWidth, useColor),
    ...body.map((line) => frame(line, bodyWidth, useColor)),
    frame("", bodyWidth, useColor),
    frame(`${paint("s", "lime", useColor)} start coding now (defaults)  ${paint("Space", "lime", useColor)} select  ${paint("Enter", "lime", useColor)} continue/save  ${paint("Esc", "lime", useColor)} back  ${paint("q", "lime", useColor)} quit`, bodyWidth, useColor),
    borderBottom(bodyWidth, useColor),
  ].join("\n");
}

function migrationOfferLines(state: OnboardingState, width: number, useColor: boolean): string[] {
  const migration = state.migration;
  if (!migration || migration.dismissed || state.stepIndex !== 0) return [];
  const also = migration.others.length ? ` (also found: ${migration.others.map((offer) => offer.source).join(", ")})` : "";
  return [
    ...wrap(`${offerHeadline(migration.offer)}${also}`, width).map((line) => paint(line, "peach", useColor)),
    `${paint("r", "lime", useColor)} review  ${paint("k", "lime", useColor)} skip  ${paint("(reads only; nothing is copied until you apply)", "dim", useColor)}`,
    "",
  ];
}

function renderMigrationReview(migration: MigrationOfferState, width: number, useColor: boolean): string {
  const bodyWidth = Math.max(70, width - 4);
  const inner = bodyWidth - 4;
  return [
    borderTop(`Bring over: ${migration.offer.source}`, bodyWidth, useColor),
    ...migration.review!.map((line) => frame(truncate(line, inner), bodyWidth, useColor)),
    frame("", bodyWidth, useColor),
    frame(`${paint("Esc", "lime", useColor)} back  apply with: muster migrate ${migration.offer.source} --apply  (undo any run with muster migrate undo <run-id>)`, bodyWidth, useColor),
    borderBottom(bodyWidth, useColor),
  ].join("\n");
}

/**
 * The running summary. The persona audit found each step amnesiac about the
 * ones before it, so a user five screens deep could not see what they had
 * already chosen. This rail carries every prior step's selections — including
 * the ones deliberately left empty, which are stated as skipped rather than
 * hidden — so the profile being assembled is legible at all times.
 */
export function summaryRailLines(state: OnboardingState, width: number, useColor: boolean): string[] {
  const lines = [paint("So far:", "cyan", useColor)];
  const upto = Math.min(state.stepIndex, steps.length);
  if (upto === 0) {
    lines.push(...wrap("Nothing chosen yet — this rail fills in as you go.", width).map((line) => paint(line, "dim", useColor)));
    return lines;
  }
  for (let index = 0; index < upto; index += 1) {
    const previous = steps[index]!;
    lines.push(paint(truncate(previous.eyebrow, width), "dim", useColor));
    const labels = labelsFor(state, previous.id);
    if (!labels.length) {
      lines.push(paint(truncate("  — skipped", width), "warn", useColor));
      continue;
    }
    for (const label of labels) {
      for (const [row, line] of wrap(label, width - 2).entries()) {
        lines.push(paint(`  ${row === 0 ? "" : "  "}${line}`, "text", useColor));
      }
    }
  }
  return lines;
}

/** Lay the body and the rail side by side inside the same frame. */
function zipRail(main: readonly string[], rail: readonly string[], mainWidth: number, useColor: boolean): string[] {
  const rows: string[] = [];
  for (let index = 0; index < Math.max(main.length, rail.length); index += 1) {
    const left = main[index] ?? "";
    const right = rail[index] ?? "";
    const pad = Math.max(0, mainWidth - visible(left));
    rows.push(`${left}${" ".repeat(pad)} ${paint("│", "border", useColor)} ${right}`);
  }
  return rows;
}

function renderChoices(step: Step, state: OnboardingState, width: number, useColor: boolean): string[] {
  const rows: string[] = [];
  const choices = choicesFor(step, state);
  // The provider step carries longer detected labels ("Anthropic-compatible proxy").
  const labelWidth = Math.max(24, ...choices.map((item) => item.label.length));
  const badgeWidth = Math.max(14, ...choices.map((item) => item.badge.length));
  for (let index = 0; index < choices.length; index += 1) {
    const detected = step.id === "provider" ? state.detected?.[choices[index]!.id] : undefined;
    const item = detected ? { ...choices[index]!, badge: detected.badge, tone: (detected.ready ? "lime" : "peach") as Tone } : choices[index]!;
    const checked = state.selected[step.id].has(item.id);
    const focused = index === state.cursor;
    const marker = checked ? "✓" : "◇";
    const text = `${marker} ${item.label.padEnd(labelWidth)} ${item.badge.padEnd(badgeWidth)} ${item.detail}`;
    const selectedRow = truncate(text, width).padEnd(width);
    rows.push(focused ? paint(selectedRow, "selection", useColor) : `${paint(marker, item.tone, useColor)} ${paint(item.label.padEnd(labelWidth), "text", useColor)} ${paint(item.badge.padEnd(badgeWidth), item.tone, useColor)} ${paint(truncate(item.detail, Math.max(0, width - labelWidth - badgeWidth - 4)), "dim", useColor)}`);
  }
  return rows;
}

/** Live results of the model step: one row per route, the real error on failure. */
function renderVerifyPanel(state: OnboardingState, width: number, useColor: boolean): string[] {
  const verify = state.verify!;
  const done = verify.order.filter((id) => verify.results[id]);
  const replied = done.filter((id) => verify.results[id]!.ok).length;
  const failed = done.length - replied;
  const lines = [verify.running
    ? `${paint("Verifying", "cyan", useColor)} ${verify.order.length} route${verify.order.length === 1 ? "" : "s"} with one tiny real request each…`
    : `${paint("Verified", "cyan", useColor)} ${replied} of ${verify.order.length} route${verify.order.length === 1 ? "" : "s"} replied`];
  for (const id of verify.order) {
    const label = verify.targets[id]?.label ?? id;
    const outcome = verify.results[id];
    const line = outcome ? verifyLine(label, outcome) : `… ${label} · waiting for a reply`;
    const tone = !outcome ? "dim" : outcome.ok ? "lime" : "warn";
    // Keep "replied in 1.9 s" together when a long route line wraps.
    for (const [row, part] of wrap(line.replace(/replied in (\S+) s$/, "replied\u00a0in\u00a0$1\u00a0s"), width - 2).entries()) lines.push(paint((row === 0 ? part : `  ${part}`).replace(/\u00a0/g, " "), tone, useColor));
  }
  if (!verify.running) {
    lines.push("");
    lines.push(failed
      ? `${paint("e", "lime", useColor)} Edit  ${paint("k", "lime", useColor)} Skip  ${paint("r", "lime", useColor)} Retry  ${paint("· failed routes are never the default", "dim", useColor)}`
      : `${paint("Enter", "lime", useColor)} continue  ${paint("— every selected route answered", "dim", useColor)}`);
  }
  return lines;
}

function verifyLine(label: string, outcome: VerifyOutcome): string {
  return outcome.ok
    ? `✓ ${label} · ${outcome.model ? `${outcome.model} · ` : ""}replied in ${formatSeconds(outcome.ms)}`
    : `✗ ${label} · ${outcome.error}`;
}

function renderSetupSurface(selectedChoices: readonly Choice[], active: Choice, width: number, useColor: boolean, detected?: DetectedProviders): string[] {
  if (!selectedChoices.length) {
    return [
      paint("Selected setup", "cyan", useColor),
      ...wrap("Pick one or more options to see their controls, impact, and the exact command that configures them.", width).map((line) => paint(line, "dim", useColor)),
      ...wrap(`Preview ${active.impact}`, width).map((line, row) => (row === 0 ? paint(line, active.tone, useColor) : paint(line, "dim", useColor))),
    ];
  }
  const lines = [`${paint("Selected setup", "cyan", useColor)} ${selectedChoices.length} selected path${selectedChoices.length === 1 ? "" : "s"}`];
  for (const item of selectedChoices.slice(0, 6)) {
    // The impact sentence wraps instead of truncating: it is the only place the
    // screen explains what a selection actually does, so narrowing the body for
    // the summary rail must not cost the user half the explanation.
    lines.push(paint(item.label, item.tone, useColor));
    for (const line of wrap(item.impact, Math.max(20, width - 2))) lines.push(`  ${paint(line, "dim", useColor)}`);
    for (const control of item.controls) lines.push(`  ${control.label}: ${paint(control.value, "lime", useColor)}`);
    // Honest next action, never a fake input: the command is printed in full
    // (wrapped, never truncated) so it can be copied and run verbatim.
    for (const command of detected?.[item.id]?.ready ? [] : (item.configureLater ?? []).slice(0, 4)) {
      const rows = wrap(`configure later: ${command}`, Math.max(20, width - 2));
      for (const [row, line] of rows.entries()) lines.push(`  ${row === 0 ? "" : "  "}${paint(line, "peach", useColor)}`);
    }
  }
  if (selectedChoices.length > 6) lines.push(paint(`+${selectedChoices.length - 6} more selected paths`, "warn", useColor));
  return lines;
}

function renderFinish(state: OnboardingState, width: number, useColor: boolean): string {
  const bodyWidth = Math.max(70, width - 4);
  const lines = [
    borderTop("Muster profile", bodyWidth, useColor),
    ...renderCapabilities(state, bodyWidth, useColor),
    frame("", bodyWidth, useColor),
    frame(`Purpose:      ${labelsFor(state, "purpose").join(", ") || "Personal assistant"}`, bodyWidth, useColor),
    frame("", bodyWidth, useColor),
    ...profileImpacts(state).map((impact) => frame(`${paint("Impact", "lime", useColor)} ${impact}`, bodyWidth, useColor)),
    frame("", bodyWidth, useColor),
    ...renderAppliedSetup(state, bodyWidth, useColor),
    ...(state.saved ? [] : plannedWrites(state).map((line, index) => frame(`${index === 0 ? paint("Will write", "cyan", useColor) : "          "} ${line}`, bodyWidth, useColor))),
    frame(state.confirmQuit ? `${paint("Discard your choices and quit?", "warn", useColor)}  ${paint("y", "lime", useColor)} discard  ${paint("any other key", "lime", useColor)} keep going` : state.saved ? paint(state.awaitingAck ? "Saved. Press any key to continue." : "Saved profile and applied available setup.", "lime", useColor) : `${paint("Enter", "lime", useColor)} save/apply setup  ${paint("Esc", "lime", useColor)} back  ${paint("q", "lime", useColor)} quit`, bodyWidth, useColor),
    borderBottom(bodyWidth, useColor),
  ];
  return lines.join("\n");
}

interface Capability {
  readonly ready: boolean;
  readonly text: string;
  /** `?`: not failed, but not proven either. */
  readonly unverified?: boolean;
}

const VERIFY_COMMAND = "muster onboard --preview --step provider --verify";

/**
 * The finish screen's honest summary: a capability is ready only when it was
 * proven (a route answered) or needs no setup (memory policy). Every missing
 * one carries the exact command that fixes it.
 */
export function capabilitySummary(state: OnboardingState): Capability[] {
  const items: Capability[] = [];
  const verify = state.verify;
  const defaultRoute = chooseDefaultRoute(state);
  const labelOf = (id: string) => verify?.targets[id]?.label ?? choicesFor(providerStep(), state).find((item) => item.id === id)?.label ?? id;
  if (defaultRoute && verify?.results[defaultRoute]?.ok) items.push({ ready: true, text: `chat · default route ${labelOf(defaultRoute)}` });
  else if (defaultRoute) items.push({ ready: false, unverified: true, text: `chat · default route ${labelOf(defaultRoute)}, not verified · check: ${VERIFY_COMMAND}` });
  else items.push({ ready: false, text: `chat · no verified model route · fix: ${firstRouteFix(state) ?? VERIFY_COMMAND}` });

  const routeIds = [...new Set([...(verify?.order ?? []), ...choicesFor(providerStep(), state).filter((item) => state.selected.provider.has(item.id)).map((item) => item.id)])]
    .filter((id) => !verify?.skipped?.has(id) || state.selected.provider.has(id));
  for (const id of routeIds) {
    const outcome = verify?.results[id];
    if (outcome?.ok) items.push({ ready: true, text: verifyLine(labelOf(id), outcome).slice(2) });
    else if (outcome) items.push({ ready: false, text: `${labelOf(id)} · ${outcome.error} · fix: ${routeFix(id, state)}` });
    else if (verifyTargetFor(id, labelOf(id), state.detected?.[id])) items.push({ ready: false, unverified: true, text: `${labelOf(id)} · not verified · check: ${VERIFY_COMMAND}` });
    else if (id !== "hybrid") items.push({ ready: false, text: `${labelOf(id)} · fix: ${routeFix(id, state)}` });
  }
  items.push({ ready: true, text: `memory (${memoryPolicyForSelections(state)})` });
  for (const stepId of ["integrations", "channels"] as const) {
    const step = steps.find((item) => item.id === stepId)!;
    for (const item of step.choices.filter((choice) => state.selected[stepId].has(choice.id))) {
      const command = item.configureLater?.[0];
      items.push({ ready: false, text: `${item.label}${command ? ` · fix: ${command}` : " · not set up yet"}` });
    }
  }
  return items;
}

function renderCapabilities(state: OnboardingState, width: number, useColor: boolean): string[] {
  const items = capabilitySummary(state);
  const ready = items.filter((item) => item.ready).length;
  const lines = [frame(`${paint(`Ready ${ready}/${items.length}`, ready === items.length ? "lime" : "peach", useColor)}  ${paint("only what answered or needs no setup counts as ready", "dim", useColor)}`, width, useColor)];
  for (const item of items) {
    const mark = item.ready ? "✓" : item.unverified ? "?" : "✗";
    const rows = wrap(`${mark} ${item.text}`, width - 6);
    for (const [index, row] of rows.entries()) lines.push(frame(paint(index === 0 ? row : `  ${row}`, item.ready ? "lime" : item.unverified ? "dim" : "warn", useColor), width, useColor));
  }
  return lines;
}

/** The exact command that makes a model route work. */
function routeFix(id: string, state: OnboardingState): string {
  const status = state.detected?.[id];
  if (id === "codex") return status?.badge === "not installed" ? "npm install -g @openai/codex" : "codex login";
  if (id === "claude") return status?.badge === "not installed" ? "npm install -g @anthropic-ai/claude-code" : "claude auth login";
  if (id === "anthropic-proxy") return `check ANTHROPIC_BASE_URL and ${status?.keyEnv ?? "ANTHROPIC_AUTH_TOKEN"}, then ${VERIFY_COMMAND}`;
  if (id === "anthropic") return "export ANTHROPIC_API_KEY=<your key>";
  if (id === "openai") return "export OPENAI_API_KEY=<your key>";
  if (id === "ollama") return "ollama serve";
  if (id === "lmstudio") return "lms server start";
  if (status?.codexProvider) {
    const result = state.verify?.results[id];
    if (result && !result.ok && /is not served by/.test(result.error)) return `muster chat --model ${status.codexProvider}:<model> with a model it serves`;
    return `check [model_providers.${status.codexProvider}] in $CODEX_HOME/config.toml`;
  }
  return choicesFor(providerStep(), state).find((item) => item.id === id)?.configureLater?.[0] ?? VERIFY_COMMAND;
}

function firstRouteFix(state: OnboardingState): string | undefined {
  const failed = state.verify?.order.find((id) => state.verify?.results[id]?.ok === false);
  return failed ? routeFix(failed, state) : undefined;
}

/** Routes that can become the runtime default, best first. Claude Code is reached with /runtime claude-code instead. */
const DEFAULT_ROUTE_PRIORITY = ["codex", "anthropic-proxy", "anthropic", "openai", "lmstudio", "ollama"];

/**
 * The route saved as the default. After live verification only a route that
 * answered qualifies — a failing route is never the default. Without
 * verification (the `s` shortcut) the previous Codex-first rule applies.
 */
export function chooseDefaultRoute(state: OnboardingState): string | null {
  const selected = state.selected.provider;
  if (state.verify) return DEFAULT_ROUTE_PRIORITY.find((id) => selected.has(id) && state.verify!.results[id]?.ok) ?? null;
  return !selected.size || selected.has("codex") || selected.has("hybrid") ? "codex" : null;
}

function providerStep(): Step {
  return steps.find((step) => step.id === "provider")!;
}

/**
 * The rows of a step. The model step adds one row per route found on this
 * machine (env gateways, Codex model providers, local servers) right after the
 * subscription CLIs, so the best guesses sit at the top.
 */
function choicesFor(step: Pick<Step, "id" | "choices">, state: OnboardingState): readonly Choice[] {
  if (step.id !== "provider" || !state.detected) return step.choices;
  const detected = state.detected;
  const known = new Set(step.choices.map((item) => item.id));
  const base = step.choices.map((item) => (detected[item.id]?.detail ? { ...item, detail: detected[item.id]!.detail! } : item));
  const extras = Object.entries(detected)
    .filter(([id]) => !known.has(id))
    .map(([id, status]) => choice(id, status.label ?? id, status.detail ?? "Detected on this machine.", status.badge, "cyan", detectedImpact(status), [], status.ready ? [] : [routeFix(id, state)]));
  const at = base.findIndex((item) => item.id === "claude") + 1;
  return [...base.slice(0, at), ...extras, ...base.slice(at)];
}

function detectedImpact(status: { readonly kind?: string; readonly keyEnv?: string }): string {
  if (status.kind === "anthropic-http") return `Claude models through the gateway in ANTHROPIC_BASE_URL. The key stays in ${status.keyEnv ?? "ANTHROPIC_AUTH_TOKEN"} and is read only when a request is sent.`;
  if (status.kind === "codex-provider") return "Runs Codex's full tool loop on the gateway defined in your Codex config.";
  if (status.kind === "local-openai") return "Private model on this machine. Verifying it loads the model into memory, so it is not ticked by default.";
  return "Detected on this machine.";
}

function initialState(): OnboardingState {
  return {
    stepIndex: 0,
    cursor: 0,
    selected: {
      purpose: new Set(),
      style: new Set(),
      provider: new Set(),
      integrations: new Set(),
      channels: new Set(),
      memory: new Set(),
      finish: new Set(),
    },
  };
}

function currentStep(state: OnboardingState): Step | { id: "finish"; eyebrow: string; title: string; body: string; choices: readonly Choice[] } {
  if (state.stepIndex >= steps.length) return { id: "finish", eyebrow: "ready", title: "Finish", body: "", choices: [] };
  return steps[state.stepIndex]!;
}

/** Detected, ready routes start ticked so the common case is one Enter. */
export function preselectDetectedProviders(state: OnboardingState): void {
  if (!state.detected || state.selected.provider.size) return;
  // Local servers are listed but not ticked: verifying one loads a model into memory.
  for (const [id, status] of Object.entries(state.detected)) if (status.ready && status.kind !== "local-openai") state.selected.provider.add(id);
}

function hasAnySelection(state: OnboardingState): boolean {
  return Object.values(state.selected).some((set) => set.size > 0);
}

function moveCursor(state: OnboardingState, delta: number): void {
  const choices = choicesFor(currentStep(state), state);
  if (!choices.length) return;
  state.cursor = (state.cursor + delta + choices.length) % choices.length;
}

const MEMORY_POLICY_IDS: ReadonlySet<string> = new Set(["ask", "never", "auto"]);

function toggleCurrent(state: OnboardingState): void {
  const step = currentStep(state);
  const item = choicesFor(step, state)[state.cursor];
  if (!item) return;
  const set = state.selected[step.id];
  if (set.has(item.id)) set.delete(item.id);
  else {
    // The three write policies are one choice, not three toggles.
    if (step.id === "memory" && MEMORY_POLICY_IDS.has(item.id)) for (const id of MEMORY_POLICY_IDS) set.delete(id);
    set.add(item.id);
  }
}

function preselectCurrentStep(state: OnboardingState): void {
  const step = currentStep(state);
  if (!step.choices.length) return;
  for (const choice of step.choices) {
    // Exclusive memory write policy: pre-select the consent-first one only.
    if (step.id === "memory" && MEMORY_POLICY_IDS.has(choice.id) && choice.id !== "ask") continue;
    state.selected[step.id].add(choice.id);
  }
}

function next(state: OnboardingState): void {
  if (state.stepIndex < steps.length) {
    state.stepIndex += 1;
    state.cursor = 0;
  }
}

function back(state: OnboardingState): void {
  if (state.stepIndex > 0) {
    state.stepIndex -= 1;
    state.cursor = 0;
  }
}

export function onboardingStateForSelections(selections: Partial<Record<StepId, readonly string[]>>): OnboardingState {
  const state = initialState();
  for (const [stepId, ids] of Object.entries(selections) as Array<[StepId, readonly string[]]>) {
    if (!state.selected[stepId]) continue;
    for (const id of ids) state.selected[stepId].add(id);
  }
  state.stepIndex = steps.length;
  return state;
}

export async function applyOnboardingProfile(state: OnboardingState, cwd: string, home = onboardingHome()): Promise<OnboardingApplyResult> {
  const configPath = await ensureDefaultConfig(cwd);
  const configured: string[] = [];
  const nextActions = new Map<string, SetupAction>();
  const addAction = (action: SetupAction) => nextActions.set(`${action.kind}:${action.id}:${action.command ?? action.url ?? action.label}`, action);

  const defaultRoute = await applyProviderSelections(state, cwd, configured, addAction);
  await applyPluginSelections(state, cwd, configured, addAction);
  await applyMcpSelections(state, cwd, configured, addAction);
  const gatewayPath = await applyChannelSelections(state, cwd, configured, addAction);
  await applyMemorySelections(state, cwd, configured);

  const applied: OnboardingApplyResult = {
    workspaceProfilePath: onboardingProfilePath(cwd),
    globalProfilePath: globalOnboardingProfilePath(home),
    configPath,
    gatewayPath,
    configured,
    nextActions: [...nextActions.values()],
    defaultRoute,
  };
  await saveOnboardingProfile(state, cwd, applied);
  await saveGlobalOnboardingProfile(state, applied);
  return applied;
}

async function applyProviderSelections(state: OnboardingState, cwd: string, configured: string[], addAction: (action: SetupAction) => void): Promise<string | null> {
  const selected = state.selected.provider;
  const results = state.verify?.results ?? {};
  const failed = (id: string) => results[id]?.ok === false;
  // Ready = answered a live check, or (unverified) detected as logged in / keyed.
  const ready = (id: string) => results[id]?.ok === true || (results[id] === undefined && state.detected?.[id]?.ready === true);
  const defaultRoute = chooseDefaultRoute(state);
  if ((!selected.size || selected.has("codex") || selected.has("hybrid")) && !failed("codex")) {
    await addCodexCliProvider({ id: "codex", defaultModel: DEFAULT_CODEX_MODEL }, cwd).catch(async () => undefined);
    configured.push("provider:codex");
  }
  if (!ready("codex") && (selected.has("codex") || defaultRoute === "codex" || failed("codex"))) {
    addAction({ kind: "provider", id: "codex", label: "Codex CLI login", command: routeFix("codex", state), url: "https://github.com/openai/codex", note: "Uses local Codex subscription auth; if codex is not installed/logged in, run the login once." });
  }
  if (selected.has("openai") && !failed("openai")) {
    const detected = state.detected?.openai;
    await addPresetProvider("openai", { ...(detected?.baseUrl ? { baseUrl: detected.baseUrl } : {}), ...(detected?.model ? { model: detected.model } : {}) }, cwd);
    configured.push("provider:openai");
    if (!ready("openai")) addAction({ kind: "provider", id: "openai", label: "OpenAI API key", command: "export OPENAI_API_KEY=...", url: "https://platform.openai.com/api-keys", env: ["OPENAI_API_KEY"], note: "Native OpenAI API route is configured and becomes usable once the env var exists." });
  }
  if (selected.has("anthropic") && !failed("anthropic")) {
    await addPresetProvider("anthropic", state.detected?.anthropic?.model ? { model: state.detected.anthropic.model } : {}, cwd);
    configured.push("provider:anthropic");
    if (!ready("anthropic")) addAction({ kind: "provider", id: "anthropic", label: "Anthropic API key", command: "export ANTHROPIC_API_KEY=...", url: "https://console.anthropic.com/settings/keys", env: ["ANTHROPIC_API_KEY"], note: "Native Claude API route is configured and becomes usable once the env var exists." });
  }
  if (selected.has("claude")) {
    configured.push("provider:claude-code-ready");
    if (!ready("claude")) addAction({ kind: "provider", id: "claude-code", label: "Claude Code login", command: routeFix("claude", state), url: "https://docs.anthropic.com/en/docs/claude-code/setup", note: "Muster will route Claude Code workflows through local Claude Code auth when available." });
  }
  if (selected.has("selfhosted")) {
    configured.push("provider:selfhosted:manual");
    addAction({ kind: "provider", id: "selfhosted", label: "Self-hosted OpenAI-compatible endpoint", command: "muster provider add-openai-compatible private https://models.internal.example/v1 served-model", url: "https://platform.openai.com/docs/api-reference", note: "Add your team's gateway URL and model name when the endpoint is ready. Muster keeps Codex as the default route until this is configured." });
  }
  // Detected gateways and local servers are saved as provider entries that hold
  // the env var NAME of their key, never the value.
  for (const id of selected) {
    const status = state.detected?.[id];
    if (!status || failed(id) || ["codex", "claude", "openai", "anthropic"].includes(id)) continue;
    if (status.kind === "codex-provider") {
      configured.push(`provider:${id}`);
      continue;
    }
    const target = verifyTargetFor(id, status.label ?? id, status);
    const provider = target ? providerConfigFor(target) : undefined;
    if (!provider) continue;
    const config = await loadConfig(cwd);
    await saveConfig({ ...config, providers: { ...config.providers, [provider.id]: provider } }, cwd);
    configured.push(`provider:${id}`);
  }
  if (defaultRoute) {
    const providerId = defaultRoute;
    const config = await loadConfig(cwd);
    const model = defaultRoute === "codex" ? DEFAULT_CODEX_MODEL : config.providers[providerId]?.defaultModel;
    if (config.providers[providerId]) {
      await setRuntimeProvider({ runtimeId: "native", providerId, model }, cwd);
      configured.push(`runtime:native->${providerId}/${model}`);
    }
  }
  return defaultRoute;
}

async function applyPluginSelections(state: OnboardingState, cwd: string, configured: string[], addAction: (action: SetupAction) => void): Promise<void> {
  const pluginIds = pluginsForSelections(state);
  const catalog = listBuiltinPlugins();
  for (const id of pluginIds) {
    const plugin = catalog.find((entry) => entry.id === id || entry.aliases?.includes(id));
    if (!plugin) continue;
    if (plugin.risk === "high") {
      // High-risk plugins are never enabled silently; the user opts in explicitly.
      addAction({ kind: "plugin", id: plugin.id, label: `${plugin.id} (high risk, not enabled)`, command: `muster plugins enable ${plugin.id}`, note: "High-risk plugins need an explicit enable; review muster plugins inspect first." });
      continue;
    }
    await enableBuiltinPlugin(plugin.id, cwd);
    configured.push(`plugin:${plugin.id}`);
    const env = setupEnv(plugin.setup);
    for (const url of plugin.setup?.setupUrls ?? []) {
      addAction({ kind: "plugin", id: plugin.id, label: `${plugin.id} setup`, url, env, command: `muster plugins setup ${plugin.id}`, note: plugin.setup?.notes?.[0] ?? "Review setup and credentials before using this integration." });
    }
    if (env.length) {
      addAction({ kind: "plugin", id: plugin.id, label: `${plugin.id} credentials`, env, command: `muster plugins check ${plugin.id}`, note: `Set ${env.join(" or ")} when you are ready to connect ${plugin.id}.` });
    }
  }
}

async function applyMcpSelections(state: OnboardingState, cwd: string, configured: string[], addAction: (action: SetupAction) => void): Promise<void> {
  const ids = mcpForSelections(state);
  const catalog = listBuiltinMcpServers();
  let config = await loadConfig(cwd);
  const servers = { ...(config.tools?.mcp?.servers ?? {}) };
  for (const id of ids) {
    const entry = catalog.find((candidate) => candidate.id === id);
    if (!entry) continue;
    const missing = setupEnv(entry);
    const server = mcpConfigFromCatalogEntry(entry, cwd);
    if (server && !missing.length) {
      servers[safeConfigKey(entry.id)] = server;
      configured.push(`mcp:${entry.id}`);
      if (entry.auth === "oauth") {
        addAction({ kind: "mcp", id: entry.id, label: `${entry.id} OAuth`, command: `muster mcp oauth setup ${entry.id}`, url: entry.setupUrls?.[0], note: "OAuth MCP is installed; finish browser authentication before using its tools." });
      }
    } else {
      addAction({ kind: "mcp", id: entry.id, label: `${entry.id} MCP setup`, command: entry.commandHint, url: entry.setupUrls?.[0], env: missing, note: missing.length ? `Needs ${missing.join(" or ")} before automatic install.` : "Manual MCP command required." });
    }
  }
  config = await loadConfig(cwd);
  await saveConfig({ ...config, tools: { ...(config.tools ?? {}), mcp: { ...(config.tools?.mcp ?? {}), servers } } }, cwd);
}

async function applyChannelSelections(state: OnboardingState, cwd: string, configured: string[], addAction: (action: SetupAction) => void): Promise<string | undefined> {
  if (!state.selected.channels.size) return undefined;
  const result = await initGatewayConfig(cwd);
  let gateway: GatewayConfig = result.config;
  const entries: Array<[string, SetupAction]> = [
    ["google-chat", { kind: "channel", id: "gchat", label: "Google Chat app", command: "muster channels ready gchat --audience https://your-domain.example/v1/adapters/gchat --no-start", url: "https://console.cloud.google.com/apis/library/chat.googleapis.com", note: "Set the Google Chat API Authentication Audience to this exact HTTPS endpoint. Muster verifies Google-signed bearer requests; no shared signing secret is used." }],
    ["slack", { kind: "channel", id: "slack", label: "Slack app", command: "muster channels setup slack --bot-token-env SLACK_BOT_TOKEN --app-token-env SLACK_APP_TOKEN", url: "https://api.slack.com/apps", env: ["SLACK_BOT_TOKEN", "SLACK_APP_TOKEN"], note: "Create a Slack app, enable Socket Mode, set env vars, then run the setup command. HTTP webhook mode remains available with --mode http." }],
    ["teams", { kind: "channel", id: "teams", label: "Microsoft Teams app", command: "muster channels setup teams --hmac-secret-env TEAMS_HMAC_SECRET --public-url https://your-domain.example", url: "https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade", env: ["TEAMS_HMAC_SECRET"], note: "Register the bot/app, then add the gateway webhook URL." }],
    ["whatsapp", { kind: "channel", id: "whatsapp", label: "WhatsApp (personal · groups)", command: "muster channels setup whatsapp --account default --activation mention --groups <group-jid> && muster channels login whatsapp", url: "https://docs.openclaw.ai/whatsapp", note: "Unofficial protocol; Meta ToS gray zone; the linked number can be banned — recommend a dedicated number." }],
    ["discord", { kind: "channel", id: "discord", label: "Discord interactions", command: "muster channels setup discord --bot-token-env DISCORD_BOT_TOKEN --public-key-env DISCORD_PUBLIC_KEY --public-url https://your-domain.example", url: "https://discord.com/developers/applications", env: ["DISCORD_BOT_TOKEN", "DISCORD_PUBLIC_KEY"], note: "Configure the Discord interaction endpoint to the gateway URL." }],
    ["telegram", { kind: "channel", id: "telegram", label: "Telegram bot", command: "muster channels setup telegram --bot-token-env TELEGRAM_BOT_TOKEN --public-url https://your-domain.example", url: "https://core.telegram.org/bots/tutorial", env: ["TELEGRAM_BOT_TOKEN"], note: "Optional where available; configure webhook only after Bot API access is reachable." }],
  ];
  for (const [choiceId, action] of entries) {
    if (!state.selected.channels.has(choiceId)) continue;
    configured.push(`channel:${action.id}:gateway-ready`);
    addAction(action);
  }
  gateway = { ...gateway, commands: { ...(gateway.commands ?? {}), entries: { ...(gateway.commands?.entries ?? {}) } } };
  return saveGatewayConfig(gateway, cwd);
}

/**
 * Turn the memory step into an ENFORCED policy, not a persona sentence.
 *
 * The persona string stays (the model should also know the rule), but the
 * binding artefact is `config.memory.policy`, which `addMemory` checks on every
 * durable write: "never" refuses anything the user did not explicitly ask for,
 * "ask" refuses anything without a consent receipt. A user who selects "Never
 * save automatically" is now protected by a thrown MemoryPolicyError rather
 * than by a model's willingness to obey prose.
 */
export function memoryPolicyForSelections(state: OnboardingState): MemoryWritePolicy {
  if (state.selected.memory.has("never")) return "never";
  if (state.selected.memory.has("auto")) return "auto";
  return "ask";
}

async function applyMemorySelections(state: OnboardingState, cwd: string, configured: string[]): Promise<void> {
  const config = await loadConfig(cwd);
  const policy = memoryPolicyForSelections(state);
  await saveConfig({
    ...config,
    memory: { policy },
    identity: {
      ...(config.identity ?? {}),
      name: "Muster",
      description: "Personal assistant with scoped memory, token-aware retrieval, and explicit integration setup.",
      persona: policy === "never"
        ? "Do not write durable memory unless the user explicitly asks."
        : "Use scoped memory with receipts and ask before durable personal memory writes.",
    },
  }, cwd);
  configured.push("memory:scoped-policy", `memory:policy=${policy}`);
}

async function saveOnboardingProfile(state: OnboardingState, cwd: string, applied: OnboardingApplyResult): Promise<void> {
  const path = onboardingProfilePath(cwd);
  await mkdir(dirname(path), { recursive: true });
  const profile = {
    version: 1,
    createdAt: new Date().toISOString(),
    selections: Object.fromEntries(Object.entries(state.selected).map(([key, value]) => [key, [...value]])),
    impacts: profileImpacts(state),
    configured: applied.configured,
    nextActions: applied.nextActions,
    defaultRoute: applied.defaultRoute,
    verification: verificationRecords(state),
    configPath: applied.configPath,
    gatewayPath: applied.gatewayPath,
  };
  await writeFile(path, `${JSON.stringify(profile, null, 2)}\n`, "utf8");
}

/** What the model step proved, for the profile. Never contains a key. */
function verificationRecords(state: OnboardingState): Array<Record<string, unknown>> {
  const verify = state.verify;
  if (!verify) return [];
  return verify.order.filter((id) => verify.results[id]).map((id) => {
    const outcome = verify.results[id]!;
    const label = verify.targets[id]?.label ?? id;
    return outcome.ok ? { id, label, ok: true, ms: outcome.ms, ...(outcome.model ? { model: outcome.model } : {}) } : { id, label, ok: false, error: outcome.error };
  });
}

async function saveGlobalOnboardingProfile(state: OnboardingState, applied: OnboardingApplyResult): Promise<void> {
  const path = applied.globalProfilePath;
  await mkdir(dirname(path), { recursive: true });
  const profile = {
    version: 1,
    completedAt: new Date().toISOString(),
    lastWorkspaceProfilePath: applied.workspaceProfilePath,
    selections: Object.fromEntries(Object.entries(state.selected).map(([key, value]) => [key, [...value]])),
    configured: applied.configured,
    nextActions: applied.nextActions,
  };
  await writeFile(path, `${JSON.stringify(profile, null, 2)}\n`, "utf8");
}

function labelsFor(state: OnboardingState, stepId: StepId): string[] {
  const step = steps.find((item) => item.id === stepId);
  const selected = state.selected[stepId];
  return step ? choicesFor(step, state).filter((item) => selected.has(item.id)).map((item) => item.label) : [];
}

/** What Enter will write, computed from the same selection helpers the apply step uses. */
export function plannedWrites(state: OnboardingState): string[] {
  const catalog = listBuiltinPlugins();
  const plugins = pluginsForSelections(state).map((id) => catalog.find((entry) => entry.id === id || entry.aliases?.includes(id))).filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));
  const enabled = plugins.filter((entry) => entry.risk !== "high").map((entry) => entry.id);
  const optIn = plugins.filter((entry) => entry.risk === "high").map((entry) => entry.id);
  const lines = [`config: <workspace>/.muster/config.json, profile: ~/.muster/onboarding-profile.json`];
  const defaultRoute = chooseDefaultRoute(state);
  const routeLabel = defaultRoute ? state.verify?.targets[defaultRoute]?.label ?? choicesFor(providerStep(), state).find((item) => item.id === defaultRoute)?.label ?? defaultRoute : undefined;
  lines.push(routeLabel ? `default model route: ${routeLabel}${state.verify?.results[defaultRoute!]?.ok ? " (verified)" : " (not verified)"}` : "default model route: none verified, left unchanged");
  lines.push(`memory write policy: ${memoryPolicyForSelections(state)}`);
  if (enabled.length) lines.push(`plugins enabled: ${enabled.join(", ")}`);
  if (optIn.length) lines.push(`plugins left off (high risk, enable yourself): ${optIn.join(", ")}`);
  const mcp = mcpForSelections(state);
  if (mcp.length) lines.push(`MCP servers: ${mcp.join(", ")}`);
  if (state.selected.channels.size) lines.push(`gateway config for: ${[...state.selected.channels].join(", ")}`);
  return lines;
}

function profileImpacts(state: OnboardingState): string[] {
  const impacts = ["Nothing is saved until you press Enter on the finish screen."];
  if (state.selected.style.has("tokens")) impacts.push("Low-token retrieval will run before old context is added.");
  if (state.selected.style.has("privacy")) impacts.push("Tenant/user/workspace/session scopes stay visible.");
  if (state.selected.integrations.has("frappe")) impacts.push("Frappe answers will prefer module, DocType, field, and workflow context.");
  if (state.selected.channels.size) impacts.push("Channel replies default to controlled setup, not blind auto-send.");
  if (state.selected.memory.has("ask")) impacts.push("Durable memory writes require confirmation.");
  return impacts.slice(0, 6);
}

function renderAppliedSetup(state: OnboardingState, width: number, useColor: boolean): string[] {
  if (!state.applied) return [];
  const lines = [
    frame(`${paint("Configured", "lime", useColor)} ${state.applied.configured.slice(0, 8).join(", ") || "profile"}`, width, useColor),
    frame(`${paint("Config", "cyan", useColor)} ${state.applied.configPath}`, width, useColor),
  ];
  if (state.applied.gatewayPath) lines.push(frame(`${paint("Gateway", "cyan", useColor)} ${state.applied.gatewayPath}`, width, useColor));
  for (const action of state.applied.nextActions.slice(0, 14)) {
    const target = action.command ?? action.url ?? action.label;
    lines.push(frame(`${paint("Next", "peach", useColor)} ${action.label}: ${target}`, width, useColor));
  }
  if (state.applied.nextActions.length > 14) lines.push(frame(paint(`+${state.applied.nextActions.length - 14} more setup actions saved in onboarding profile`, "warn", useColor), width, useColor));
  lines.push(frame("", width, useColor));
  return lines;
}

function pluginsForSelections(state: OnboardingState): string[] {
  const ids = new Set<string>();
  // A purpose adds only packs that are not their own pick: GitHub comes from the
  // senses step, Codex and Claude Code from the model step.
  if (state.selected.purpose.has("code")) ids.add("developer-tools");
  if (state.selected.purpose.has("apps")) ["google-workspace", "github", "browser", "web-search", "mcp-bridge"].forEach((id) => ids.add(id));
  if (state.selected.purpose.has("frappe") || state.selected.integrations.has("frappe")) ["frappe-federated-bridge", "web-frameworks"].forEach((id) => ids.add(id));
  if (state.selected.purpose.has("research") || state.selected.integrations.has("web")) ["web-search", "research-lab", "codex-web-search"].forEach((id) => ids.add(id));
  if (state.selected.purpose.has("team")) ["daily-ops", "mcp-bridge"].forEach((id) => ids.add(id));
  if (state.selected.integrations.has("drive")) ids.add("google-workspace");
  if (state.selected.integrations.has("github")) ids.add("github");
  if (state.selected.integrations.has("browser")) ids.add("browser");
  if (state.selected.integrations.has("mcp")) ids.add("mcp-bridge");
  if (state.selected.integrations.has("artifacts")) ids.add("artifact-studio");
  if (state.selected.provider.has("codex")) ["codex", "codex-native-tools"].forEach((id) => ids.add(id));
  if (state.selected.provider.has("claude")) ids.add("claude-code");
  if (state.selected.provider.has("openai")) ids.add("openai");
  if (state.selected.provider.has("anthropic")) ids.add("anthropic");
  if (state.selected.provider.has("selfhosted")) ids.add("vllm");
  const channelPluginMap: Record<string, string> = {
    "google-chat": "google-chat",
    slack: "slack",
    teams: "teams",
    whatsapp: "whatsapp",
    discord: "discord",
    telegram: "telegram",
  };
  for (const channel of state.selected.channels) ids.add(channelPluginMap[channel] ?? channel);
  return [...ids];
}

function mcpForSelections(state: OnboardingState): string[] {
  const ids = new Set<string>();
  if (state.selected.integrations.has("github") || state.selected.purpose.has("apps")) ids.add("github");
  if (state.selected.integrations.has("browser")) ids.add("browser");
  if (state.selected.integrations.has("web") || state.selected.purpose.has("research")) ids.add("parallel-search");
  if (state.selected.integrations.has("drive")) ids.add("google-drive");
  if (state.selected.integrations.has("artifacts")) ids.add("sqlite");
  if (state.selected.integrations.has("mcp")) ["git", "sqlite", "browser", "parallel-search", "notion", "linear"].forEach((id) => ids.add(id));
  if (state.selected.purpose.has("apps")) ["google-drive", "notion"].forEach((id) => ids.add(id));
  return [...ids];
}

function setupEnv(entry: { readonly requiresEnv?: readonly string[]; readonly requiresAnyEnv?: readonly (readonly string[])[] } | undefined): string[] {
  if (!entry) return [];
  return [...(entry.requiresEnv ?? []), ...(entry.requiresAnyEnv ?? []).map((group) => group.join("|"))];
}

function mcpConfigFromCatalogEntry(entry: ReturnType<typeof listBuiltinMcpServers>[number], cwd: string): McpServerConfig | undefined {
  return rosterMcpConfigFromCatalogEntry(entry, { cwd });
}

function safeConfigKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "entry";
}

function readPreviewStep(args: readonly string[]): number | undefined {
  const value = args[args.indexOf("--step") + 1];
  if (!value) return undefined;
  if (value === "finish") return steps.length;
  const index = steps.findIndex((step) => step.id === value);
  return index >= 0 ? index : undefined;
}

function progressLabel(state: OnboardingState): string {
  return `[${Math.min(state.stepIndex + 1, steps.length)}/${steps.length}]`;
}

function borderTop(title: string, width: number, useColor: boolean): string {
  const label = ` ${title} `;
  const left = Math.max(1, Math.floor((width - label.length - 2) / 2));
  const right = Math.max(1, width - label.length - left - 2);
  return paint(`╭${"─".repeat(left)}${label}${"─".repeat(right)}╮`, "border", useColor);
}

function borderBottom(width: number, useColor: boolean): string {
  return paint(`╰${"─".repeat(width - 2)}╯`, "border", useColor);
}

function frame(value: string, width: number, useColor: boolean): string {
  const raw = stripAnsi(value);
  const pad = Math.max(0, width - 4 - visible(raw));
  return `${paint("│", "border", useColor)} ${value}${" ".repeat(pad)} ${paint("│", "border", useColor)}`;
}

function wrap(value: string, width: number): string[] {
  // Split on ordinary whitespace only, so a no-break space keeps a unit together.
  const words = value.split(/[ \t\n]+/);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (visible(next) > width && current) {
      lines.push(current);
      current = word;
    } else {
      current = next;
    }
  }
  if (current) lines.push(current);
  return lines;
}

function truncate(value: string, width: number): string {
  return visible(value) <= width ? value : `${value.slice(0, Math.max(0, width - 1))}…`;
}

function visible(value: string): number {
  return stripAnsi(value).length;
}

function stripAnsi(value: string): string {
  return value.replace(/\x1b\[[0-9;]*m/g, "");
}

function paint(value: string, tone: Tone | "dim" | "text" | "border" | "selection" | "warn", useColor: boolean): string {
  if (!useColor) return value;
  return `\x1b[${ANSI[tone]}m${value}${RESET}`;
}
