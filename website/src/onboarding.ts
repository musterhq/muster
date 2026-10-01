import "./onboarding.css";
import "./site-theme.css";

type StepId = "purpose" | "style" | "provider" | "integrations" | "channels" | "memory" | "finish";

interface Choice {
  id: string;
  label: string;
  detail: string;
  badge?: string;
  color: "lavender" | "cyan" | "peach" | "lime";
  followUps?: string[];
}

interface Step {
  id: StepId;
  eyebrow: string;
  title: string;
  body: string;
  mode: "multi" | "single" | "finish";
  choices: Choice[];
}

const steps: Step[] = [
  {
    id: "purpose",
    eyebrow: "01 / shape",
    title: "What should your assistant be able to do?",
    body: "Pick one, pick five, pick all of it. Muster will build a profile around what you actually want instead of dumping commands at you.",
    mode: "multi",
    choices: [
      {
        id: "code",
        label: "Build with code",
        detail: "Repo search, tests, code review, fixes, release notes, Codex and Claude Code routing.",
        badge: "developer",
        color: "lavender",
        followUps: ["Repo-aware defaults", "Fast shell tasks", "PR and release workflows"],
      },
      {
        id: "apps",
        label: "Connect work apps",
        detail: "Google Drive, chat surfaces, GitHub, browser, web search, and MCP tools.",
        badge: "integrations",
        color: "cyan",
        followUps: ["OAuth setup guides", "Scoped app memory", "Tool permissions"],
      },
      {
        id: "frappe",
        label: "Set up Frappe / ERPNext",
        detail: "Site URL, installed apps, DocTypes, fields, workflows, reports, and module docs.",
        badge: "bench-aware",
        color: "peach",
        followUps: ["DocType graph", "Module context", "Tenant-safe retrieval"],
      },
      {
        id: "memory",
        label: "Personal memory",
        detail: "Preferences, project facts, named sessions, and scoped recall with receipts.",
        badge: "recall",
        color: "lime",
        followUps: ["Less repeated context", "Memory receipts", "Ask-before-save mode"],
      },
      {
        id: "research",
        label: "Research the web",
        detail: "Fresh sources, browser checks, Playwright paths, and artifact-ready summaries.",
        badge: "source-grounded",
        color: "cyan",
        followUps: ["Web search", "Browser QA", "Artifact handoff"],
      },
      {
        id: "team",
        label: "Team workflows",
        detail: "Agents, subagents, scheduled checks, dashboards, channel surfaces, and MCPs.",
        badge: "operations",
        color: "lavender",
        followUps: ["Subagent routing", "Dashboard status", "Channel adapters"],
      },
    ],
  },
  {
    id: "style",
    eyebrow: "02 / priorities",
    title: "What should Muster optimize for?",
    body: "These choices tune the assistant's behavior. The interesting part is that the product can market the guarantee while configuring it.",
    mode: "multi",
    choices: [
      { id: "speed", label: "Fast answers", detail: "Prefer direct tools and short context when the task is simple.", badge: "low latency", color: "cyan" },
      { id: "accuracy", label: "Accuracy", detail: "Use receipts, sources, and eval gates before trusting generated context.", badge: "evidence", color: "lavender" },
      { id: "tokens", label: "Use fewer tokens", detail: "Retrieve targeted memory instead of stuffing old transcripts into every prompt.", badge: "less waste", color: "lime" },
      { id: "privacy", label: "Prevent leaks", detail: "Keep tenant, workspace, user, role, and session scopes explicit.", badge: "scope rails", color: "peach" },
      { id: "local", label: "Local-first when possible", detail: "Prefer local routes for sensitive work and escalate only when needed.", badge: "quiet mode", color: "lavender" },
      { id: "explain", label: "Explain retrieval", detail: "Show why memory was recalled and what was ignored.", badge: "receipts", color: "cyan" },
    ],
  },
  {
    id: "provider",
    eyebrow: "03 / model",
    title: "Which model routes should Muster prepare?",
    body: "Pick one or many. Muster can keep a fast daily route, a deeper fallback, and a private self-hosted route without asking people to memorize model names.",
    mode: "multi",
    choices: [
      { id: "codex", label: "Codex", detail: "Best default for coding, repo work, terminal tasks, and fast operational loops.", badge: "recommended", color: "cyan" },
      { id: "claude", label: "Claude Code", detail: "Familiar coding assistant flow with strong planning and editing behavior.", badge: "coding", color: "lavender" },
      { id: "openai", label: "OpenAI API", detail: "Direct cloud models with configurable presets and token accounting.", badge: "cloud", color: "cyan" },
      { id: "anthropic", label: "Anthropic API", detail: "Claude models through API keys and governed runtime routes.", badge: "cloud", color: "peach" },
      { id: "selfhosted", label: "Self-hosted endpoint", detail: "Private OpenAI-compatible routes for teams that already run a reliable model gateway.", badge: "private", color: "lime" },
      { id: "hybrid", label: "Hybrid", detail: "Fast default model with stronger fallback, recorded as evidence.", badge: "balanced", color: "lavender" },
    ],
  },
  {
    id: "integrations",
    eyebrow: "04 / senses",
    title: "Choose your assistant's senses.",
    body: "Every selected app gets a guided setup path. Credentials are not persisted by the onboarding prototype.",
    mode: "multi",
    choices: [
      { id: "frappe", label: "Frappe / ERPNext", detail: "Site URL, app list, modules, DocTypes, fields, workflows, reports, scripts.", badge: "plugin", color: "peach" },
      { id: "drive", label: "Google Drive", detail: "Docs, Sheets, Slides context with file-aware retrieval.", badge: "oauth", color: "cyan" },
      { id: "github", label: "GitHub", detail: "Repos, issues, pull requests, release notes, and CI context.", badge: "dev", color: "lavender" },
      { id: "browser", label: "Browser + Playwright", detail: "Inspect web apps, test flows, capture visual evidence.", badge: "qa", color: "lime" },
      { id: "web", label: "Web search", detail: "Fresh source-grounded answers without pretending stale docs are current.", badge: "fresh", color: "cyan" },
      { id: "mcp", label: "MCP bridge", detail: "Bring external tools into Muster with policy and setup guidance.", badge: "tools", color: "peach" },
      { id: "artifacts", label: "Artifact Studio", detail: "Reports, dashboards, generated docs, and shareable outputs.", badge: "output", color: "lime" },
    ],
  },
  {
    id: "channels",
    eyebrow: "05 / channels",
    title: "Where should your assistant talk?",
    body: "Pick each channel separately. Every surface has a different auth model, so Muster should open the right credential window instead of hiding them inside one bundled card.",
    mode: "multi",
    choices: [
      { id: "google-chat", label: "Google Chat", detail: "Workspace bot endpoint, signing secret, and app authentication.", badge: "workspace", color: "cyan" },
      { id: "slack", label: "Slack", detail: "Bot token, signing secret, app-level token, and channel install.", badge: "bot", color: "lavender" },
      { id: "teams", label: "Microsoft Teams", detail: "Bot app ID, tenant ID, client secret, and Teams app package.", badge: "enterprise", color: "peach" },
      { id: "whatsapp", label: "WhatsApp", detail: "Business phone ID, access token, verify token, and webhook secret.", badge: "business", color: "lime" },
      { id: "discord", label: "Discord", detail: "Bot token, application ID, public key, and guild/channel defaults.", badge: "community", color: "lavender" },
      { id: "telegram", label: "Telegram", detail: "Bot token and webhook URL where Telegram is available.", badge: "regional", color: "cyan" },
    ],
  },
  {
    id: "memory",
    eyebrow: "06 / memory contract",
    title: "How should Muster remember?",
    body: "Memory is not a transcript dump. It is scoped, searchable, receipt-backed context that should lower token waste and reduce repeated explanation.",
    mode: "multi",
    choices: [
      { id: "chat", label: "Remember this chat", detail: "Keep short-term continuity for the current session.", badge: "session", color: "cyan" },
      { id: "project", label: "Remember project context", detail: "Persist repo, app, and deployment facts in workspace/tenant scopes.", badge: "project", color: "lavender" },
      { id: "preferences", label: "Remember my preferences", detail: "Tone, workflow, provider, and answer preferences.", badge: "personal", color: "peach" },
      { id: "site", label: "Remember app/site context", detail: "Index Frappe or web-app context with graph links and receipts.", badge: "plugin context", color: "lime" },
      { id: "ask", label: "Ask before saving", detail: "Show what will be remembered before writing durable memory.", badge: "consent", color: "cyan" },
      { id: "never", label: "Never save automatically", detail: "Use the assistant without durable memory writes.", badge: "private", color: "lavender" },
    ],
  },
  { id: "finish", eyebrow: "ready", title: "Your assistant is taking shape.", body: "", mode: "finish", choices: [] },
];

const easterEggs = new Map<string, string>([
  ["memory", "Future-you just got a helper."],
  ["frappe", "Bench-aware mode unlocked."],
  ["tokens", "Token discipline enabled. No ceremony when a small answer will do."],
  ["privacy", "Boundaries matter. Scope rails are on."],
  ["local", "Quiet mode. Nice."],
]);

const rootEl = document.querySelector<HTMLDivElement>("#onboarding-root");
if (!rootEl) throw new Error("Missing onboarding root.");
const root: HTMLDivElement = rootEl;

let stepIndex = 0;
let selected = 0;
let transition = "intro";
const answers = new Map<StepId, Set<string>>();
for (const step of steps) answers.set(step.id, new Set());

function currentStep(): Step {
  const step = steps[stepIndex];
  if (!step) throw new Error(`Invalid onboarding step index: ${stepIndex}`);
  return step;
}

function choiceSelected(choice: Choice): boolean {
  return answers.get(currentStep().id)?.has(choice.id) ?? false;
}

function toggleChoice(choice: Choice): void {
  const step = currentStep();
  const set = answers.get(step.id);
  if (!set) return;
  if (step.mode === "single") {
    set.clear();
    set.add(choice.id);
  } else if (set.has(choice.id)) {
    set.delete(choice.id);
  } else {
    set.add(choice.id);
  }
  render("select-pop");
}

function go(delta: number): void {
  const step = currentStep();
  if (step.mode === "finish") return;
  selected = (selected + delta + step.choices.length) % step.choices.length;
  render(delta > 0 ? "rail-down" : "rail-up");
}

function next(): void {
  if (stepIndex < steps.length - 1) {
    stepIndex += 1;
    selected = 0;
    transition = "slide-forward";
    render(transition);
  }
}

function back(): void {
  if (stepIndex > 0) {
    stepIndex -= 1;
    selected = 0;
    transition = "slide-back";
    render(transition);
  }
}

function selectedLabels(): string[] {
  return steps
    .flatMap((step) => step.choices.filter((choice) => answers.get(step.id)?.has(choice.id)).map((choice) => choice.label));
}

function render(effect = "intro"): void {
  const step = currentStep();
  const picked = selectedLabels();
  const activeChoice = step.choices[selected];
  const proofBadges = buildProofBadges();
  root.innerHTML = `
    <div class="aurora-field" aria-hidden="true">
      <span class="orb orb-one"></span>
      <span class="orb orb-two"></span>
      <span class="orb orb-three"></span>
    </div>
    <section class="desktop-frame ${effect}">
      <header class="desktop-topbar">
        <div class="traffic"><i></i><i></i><i></i></div>
        <div class="window-title">muster onboarding prototype</div>
        <a href="/" class="site-link">website palette</a>
      </header>
      <div class="terminal-stage">
        <aside class="journey-panel">
          <div class="brand-lockup">
            <span class="brand-mark">M</span>
            <div>
              <p>Muster</p>
              <span>personal assistant setup</span>
            </div>
          </div>
          <div class="progress-list">
            ${steps.slice(0, -1).map((item, index) => `
              <div class="progress-item ${index === stepIndex ? "active" : ""} ${index < stepIndex ? "done" : ""}">
                <span>${String(index + 1).padStart(2, "0")}</span>
                <p>${item.id === "style" ? "priorities" : item.id}</p>
              </div>
            `).join("")}
          </div>
          <div class="token-card">
            <span>why this matters</span>
            <strong>Less context stuffing. More targeted recall.</strong>
            <p>Scoped SQLite retrieval and memory receipts help lower token waste while reducing cross-tenant leaks.</p>
          </div>
        </aside>

        <section class="terminal-card">
          <div class="animated-rail"></div>
          ${step.mode === "finish" ? renderFinish(picked, proofBadges) : renderStep(step, activeChoice, proofBadges)}
        </section>

        <aside class="detail-panel">
          ${renderDetail(step, activeChoice)}
        </aside>
      </div>
    </section>
  `;

  root.querySelectorAll<HTMLButtonElement>("[data-choice]").forEach((button, index) => {
    button.addEventListener("click", () => {
      const choice = step.choices[index];
      if (!choice) return;
      selected = index;
      toggleChoice(choice);
    });
  });
  root.querySelector<HTMLButtonElement>("[data-next]")?.addEventListener("click", next);
  root.querySelector<HTMLButtonElement>("[data-back]")?.addEventListener("click", back);
  root.querySelector<HTMLButtonElement>("[data-restart]")?.addEventListener("click", () => {
    for (const set of answers.values()) set.clear();
    stepIndex = 0;
    selected = 0;
    render("slide-back");
  });
}

function renderStep(step: Step, activeChoice: Choice | undefined, proofBadges: string[]): string {
  const selectedChoices = step.choices.filter((choice) => answers.get(step.id)?.has(choice.id));
  return `
    <div class="terminal-header">
      <span>${step.eyebrow}</span>
      <div class="chip-tray">${selectedLabels().slice(0, 5).map((label) => `<b>${label}</b>`).join("")}</div>
    </div>
    <div class="copy-block">
      <h1>${stepIndex === 0 ? "Welcome to Muster." : step.title}</h1>
      ${stepIndex === 0 ? `<h2>Let's build the assistant that remembers your work, protects your context, and spends fewer tokens getting useful answers.</h2>` : ""}
      <p>${step.body}</p>
    </div>
    <div class="choice-grid ${step.id === "integrations" || step.id === "channels" ? "dense" : ""}">
      ${step.choices.map((choice, index) => `
        <button class="choice-card ${choice.color} ${index === selected ? "focused" : ""} ${choiceSelected(choice) ? "selected" : ""}" data-choice="${choice.id}" type="button">
          <span class="choice-state">${choiceSelected(choice) ? "✓" : step.mode === "single" ? "○" : "◇"}</span>
          <span class="choice-main">
            <strong>${choice.label}</strong>
            <small>${choice.detail}</small>
          </span>
          <em>${choice.badge ?? ""}</em>
        </button>
      `).join("")}
    </div>
    <div class="proof-strip">
      ${proofBadges.map((badge) => `<span>${badge}</span>`).join("")}
    </div>
    ${renderSetupDrawer(step, selectedChoices)}
    <footer class="terminal-actions">
      <button type="button" data-back ${stepIndex === 0 ? "disabled" : ""}>Esc back</button>
      <p>Space select · Enter continue · Tab details · ↑↓ move</p>
      <button type="button" data-next>Continue</button>
    </footer>
    ${activeChoice ? `<div class="toast">${easterEggs.get(activeChoice.id) ?? "Selection staged. Muster will turn this into setup, not homework."}</div>` : ""}
  `;
}

function renderSetupDrawer(step: Step, selectedChoices: Choice[]): string {
  if (!selectedChoices.length) {
    return `
      <section class="setup-drawer idle">
        <div>
          <span>next surface</span>
          <strong>Select one or more options to open guided setup.</strong>
        </div>
        <p>No commands. No guessing. The real onboarding should ask for only the fields needed by the things selected here.</p>
      </section>
    `;
  }
  const panels = selectedChoices.map((choice) => renderSetupPanel(step, choice)).join("");
  return `
    <section class="setup-drawer">
      <header>
        <div>
          <span>guided setup</span>
          <strong>${selectedChoices.length} selected ${selectedChoices.length === 1 ? "path" : "paths"}</strong>
        </div>
        <p>Prototype fields are local-only. Real Muster should save only after explicit confirmation.</p>
      </header>
      <div class="setup-panels">${panels}</div>
    </section>
  `;
}

function renderSetupPanel(step: Step, choice: Choice): string {
  if (step.id === "purpose") {
    return `
      <article class="setup-panel ${choice.color}">
        <h4>${choice.label}</h4>
        <p>${choice.detail}</p>
        <div class="setup-options">
          ${(choice.followUps ?? []).map((item) => `<label><input type="checkbox" checked /> ${item}</label>`).join("")}
        </div>
        ${controlDeck(step, choice)}
      </article>
    `;
  }
  if (step.id === "style") {
    return `
      <article class="setup-panel ${choice.color}">
        <h4>${choice.label}</h4>
        <p>${choice.detail}</p>
        <div class="setup-meter">
          <span>relaxed</span><input type="range" min="1" max="5" value="${choice.id === "speed" ? "5" : "4"}" /><span>strict</span>
        </div>
        ${controlDeck(step, choice)}
      </article>
    `;
  }
  if (step.id === "provider") {
    return `
      <article class="setup-panel ${choice.color}">
        <h4>${choice.label}</h4>
        <p>${choice.detail}</p>
        <div class="field-grid">
          <label>Mode<select><option>Fast daily work</option><option>Balanced</option><option>Deep reasoning</option><option>Cheapest reliable</option><option>Ask each time</option></select></label>
          <label>Model preset<select>${providerPresets(choice.id).map((item) => `<option>${item}</option>`).join("")}</select></label>
          ${choice.id === "selfhosted" ? `<label>Endpoint<input placeholder="https://models.internal.example/v1" /></label>` : `<label>API key env<input placeholder="${providerEnv(choice.id)}" /></label>`}
        </div>
        ${controlDeck(step, choice)}
      </article>
    `;
  }
  if (step.id === "integrations") {
    return `
      <article class="setup-panel ${choice.color}">
        <h4>${choice.label}</h4>
        <p>${choice.detail}</p>
        ${integrationFields(choice.id)}
        ${controlDeck(step, choice)}
      </article>
    `;
  }
  if (step.id === "channels") {
    return `
      <article class="setup-panel ${choice.color}">
        <h4>${choice.label}</h4>
        <p>${choice.detail}</p>
        ${channelFields(choice.id)}
        ${controlDeck(step, choice)}
      </article>
    `;
  }
  if (step.id === "memory") {
    return `
      <article class="setup-panel ${choice.color}">
        <h4>${choice.label}</h4>
        <p>${choice.detail}</p>
        <div class="setup-options">
          <label><input type="checkbox" checked /> Show memory receipt after recall</label>
          <label><input type="checkbox" ${choice.id === "never" ? "" : "checked"} /> Ask before durable write</label>
          <label><input type="checkbox" checked /> Keep tenant/user/session scopes visible</label>
        </div>
        ${controlDeck(step, choice)}
      </article>
    `;
  }
  return "";
}

function controlDeck(step: Step, choice: Choice): string {
  const impact = impactText(step, choice);
  if (step.id === "purpose") {
    return `
      <div class="control-deck">
        <label>Autonomy<select><option>Ask before major actions</option><option>Act on safe tasks</option><option>Autopilot after approval</option></select></label>
        <label>Output style<select><option>Concise</option><option>Step-by-step</option><option>Executive summary</option></select></label>
        <p><strong>Impact</strong>${impact}</p>
      </div>
    `;
  }
  if (step.id === "style") {
    return `
      <div class="control-deck">
        <label>Priority weight<input type="range" min="1" max="5" value="${choice.id === "speed" ? "5" : "4"}" /></label>
        <label>When conflicting<select><option>Ask me</option><option>Favor this priority</option><option>Balance automatically</option></select></label>
        <p><strong>Impact</strong>${impact}</p>
      </div>
    `;
  }
  if (step.id === "provider") {
    return `
      <div class="control-deck">
        <label>Use for<select><option>Default route</option><option>Fallback only</option><option>Deep work only</option><option>Ask each run</option></select></label>
        <label>Budget guard<select><option>Balanced cost</option><option>Lowest cost</option><option>Best quality</option><option>Local if sensitive</option></select></label>
        <p><strong>Impact</strong>${impact}</p>
      </div>
    `;
  }
  if (step.id === "integrations") {
    return `
      <div class="control-deck">
        <label>Permission<select><option>Read-only first</option><option>Ask before write</option><option>Trusted workspace writes</option></select></label>
        <label>Context depth<select><option>Light index</option><option>Balanced index</option><option>Deep graph index</option></select></label>
        <p><strong>Impact</strong>${impact}</p>
      </div>
    `;
  }
  if (step.id === "channels") {
    return `
      <div class="control-deck">
        <label>Reply mode<select><option>Draft first</option><option>Auto-reply low risk</option><option>Manual only</option></select></label>
        <label>Visibility<select><option>Only mentioned threads</option><option>Selected channels</option><option>Workspace-wide digest</option></select></label>
        <p><strong>Impact</strong>${impact}</p>
      </div>
    `;
  }
  if (step.id === "memory") {
    return `
      <div class="control-deck">
        <label>Recall strictness<input type="range" min="1" max="5" value="${choice.id === "never" ? "5" : "4"}" /></label>
        <label>Retention<select><option>This project</option><option>30 days</option><option>Until I remove it</option><option>Never durable</option></select></label>
        <p><strong>Impact</strong>${impact}</p>
      </div>
    `;
  }
  return "";
}

function impactText(step: Step, choice: Choice): string {
  if (step.id === "purpose" && choice.id === "code") return "Muster will bias toward repo-aware tools, tests, and direct shell actions before long model reasoning.";
  if (step.id === "purpose" && choice.id === "frappe") return "Muster will prepare app/module/DocType context so Frappe questions retrieve field evidence instead of generic ERP guesses.";
  if (step.id === "purpose" && choice.id === "memory") return "Muster will ask what is worth remembering and use scoped recall to reduce repeated explanations.";
  if (step.id === "style" && choice.id === "speed") return "Short tasks prefer tools and compact prompts, which lowers latency but may ask before deep analysis.";
  if (step.id === "style" && choice.id === "tokens") return "Retrieval runs before prompt stuffing, so fewer old tokens are sent and receipts explain what was recalled.";
  if (step.id === "style" && choice.id === "privacy") return "Tenant, user, workspace, role, and session scopes stay visible so memory does not bleed across contexts.";
  if (step.id === "provider") return "This affects which model handles fast turns, deep turns, and fallbacks; route changes are recorded instead of hidden.";
  if (step.id === "integrations" && choice.id === "frappe") return "Deep graph indexing improves module/field accuracy but takes more setup than a light docs-only index.";
  if (step.id === "integrations") return "Read-only setup is safer; deeper indexing gives richer answers but requires more permissions.";
  if (step.id === "channels") return "Draft-first keeps humans in control; auto-reply is faster but should be limited to low-risk channels.";
  if (step.id === "memory" && choice.id === "never") return "Maximum privacy, but Muster will not personalize future sessions unless you re-provide context.";
  if (step.id === "memory") return "Higher recall strictness reduces weird stale hits; broader retention improves personalization over time.";
  return "This changes the default assistant behavior and will appear in the generated profile before anything is saved.";
}

function providerPresets(id: string): string[] {
  if (id === "codex") return ["gpt-5.5 fast", "gpt-5.5 balanced", "gpt-5.5 deep"];
  if (id === "claude") return ["Claude Code default", "Claude Sonnet", "Claude Opus"];
  if (id === "openai") return ["GPT-5.5", "GPT-5.5 mini", "GPT-4.1"];
  if (id === "anthropic") return ["Claude Sonnet", "Claude Haiku", "Claude Opus"];
  if (id === "selfhosted") return ["served-model", "private fast route", "private deep route"];
  return ["Fast primary + deep fallback", "Cloud + private fallback", "Ask per task"];
}

function providerEnv(id: string): string {
  if (id === "anthropic" || id === "claude") return "ANTHROPIC_API_KEY";
  if (id === "openai" || id === "codex" || id === "hybrid") return "OPENAI_API_KEY";
  return "API_KEY_ENV";
}

function integrationFields(id: string): string {
  if (id === "frappe") {
    return `
      <div class="field-grid">
        <label>Site URL<input placeholder="https://erp.example.com" /></label>
        <label>Auth mode<select><option>API token</option><option>One-time admin login</option></select></label>
        <label>API token / env<input placeholder="FRAPPE_API_TOKEN" /></label>
        <label>Module focus<input placeholder="Accounts, HR, Stock, custom app" /></label>
      </div>
      <a class="setup-link" href="#">Open /app/user to create token</a>
    `;
  }
  if (id === "drive" || id === "github") {
    return `
      <div class="field-grid">
        <label>Connection<select><option>Open OAuth in browser</option><option>Paste token/env var</option><option>Configure later</option></select></label>
        <label>Scope<select><option>Workspace only</option><option>User + workspace</option><option>Ask every time</option></select></label>
      </div>
      <a class="setup-link" href="#">Open secure sign-in flow</a>
    `;
  }
  if (id === "browser" || id === "web") {
    return `
      <div class="setup-options">
        <label><input type="checkbox" checked /> Enable source receipts</label>
        <label><input type="checkbox" checked /> Keep browser actions approval-gated</label>
        <label><input type="checkbox" /> Capture screenshots during QA</label>
      </div>
    `;
  }
  return `
    <div class="field-grid">
      <label>Setup mode<select><option>Use built-in pack</option><option>Connect MCP server</option><option>Configure later</option></select></label>
      <label>Permission level<select><option>Read-only first</option><option>Ask before write</option><option>Trusted workspace</option></select></label>
    </div>
  `;
}

function channelFields(id: string): string {
  if (id === "slack") {
    return `
      <div class="field-grid">
        <label>Bot token/env<input placeholder="SLACK_BOT_TOKEN" /></label>
        <label>Signing secret/env<input placeholder="SLACK_SIGNING_SECRET" /></label>
        <label>App token/env<input placeholder="SLACK_APP_TOKEN" /></label>
        <label>Default channel<input placeholder="#team-ai" /></label>
      </div>
      <a class="setup-link" href="#">Open Slack app configuration</a>
    `;
  }
  if (id === "teams") {
    return `
      <div class="field-grid">
        <label>Bot app ID<input placeholder="TEAMS_BOT_APP_ID" /></label>
        <label>Tenant ID<input placeholder="AZURE_TENANT_ID" /></label>
        <label>Client secret/env<input placeholder="TEAMS_CLIENT_SECRET" /></label>
        <label>Install scope<select><option>Team</option><option>Organization</option><option>Personal</option></select></label>
      </div>
      <a class="setup-link" href="#">Open Azure Bot registration</a>
    `;
  }
  if (id === "whatsapp") {
    return `
      <div class="field-grid">
        <label>Phone number ID<input placeholder="WHATSAPP_PHONE_NUMBER_ID" /></label>
        <label>Access token/env<input placeholder="WHATSAPP_ACCESS_TOKEN" /></label>
        <label>Verify token/env<input placeholder="WHATSAPP_VERIFY_TOKEN" /></label>
        <label>Webhook secret/env<input placeholder="WHATSAPP_WEBHOOK_SECRET" /></label>
      </div>
      <a class="setup-link" href="#">Open Meta WhatsApp setup</a>
    `;
  }
  if (id === "telegram") {
    return `
      <div class="field-grid">
        <label>Bot token/env<input placeholder="TELEGRAM_BOT_TOKEN" /></label>
        <label>Webhook URL<input placeholder="https://example.com/webhook/telegram" /></label>
      </div>
      <a class="setup-link" href="#">Open BotFather setup</a>
    `;
  }
  if (id === "google-chat") {
    return `
      <div class="field-grid">
        <label>Project ID<input placeholder="GOOGLE_CLOUD_PROJECT" /></label>
        <label>Signing secret/env<input placeholder="GOOGLE_CHAT_SIGNING_SECRET" /></label>
        <label>Service account<input placeholder="GOOGLE_APPLICATION_CREDENTIALS" /></label>
        <label>Space default<input placeholder="spaces/..." /></label>
      </div>
      <a class="setup-link" href="#">Open Google Chat API setup</a>
    `;
  }
  return `
    <div class="field-grid">
      <label>Bot token/env<input placeholder="DISCORD_BOT_TOKEN" /></label>
      <label>Application ID<input placeholder="DISCORD_APPLICATION_ID" /></label>
      <label>Public key<input placeholder="DISCORD_PUBLIC_KEY" /></label>
      <label>Default guild/channel<input placeholder="guild/channel id" /></label>
    </div>
    <a class="setup-link" href="#">Open Discord developer portal</a>
  `;
}

function renderFinish(picked: string[], proofBadges: string[]): string {
  const purpose = labelsFor("purpose").join(" + ") || "Personal assistant";
  const provider = labelsFor("provider")[0] ?? "Codex";
  const integrations = labelsFor("integrations");
  const channels = labelsFor("channels");
  const memory = labelsFor("memory").join(", ") || "Scoped session memory";
  return `
    <div class="terminal-header">
      <span>profile generated</span>
      <div class="chip-tray">${picked.slice(0, 6).map((label) => `<b>${label}</b>`).join("")}</div>
    </div>
    <div class="finish-hero">
      <span class="success-ring">✓</span>
      <h1>Your assistant is ready to become useful.</h1>
      <p>It knows what to remember, what to protect, what to connect, and when to avoid wasting tokens.</p>
    </div>
    <div class="profile-grid">
      <article><span>Purpose</span><strong>${purpose}</strong></article>
      <article><span>Provider</span><strong>${provider}</strong></article>
      <article><span>Memory</span><strong>${memory}</strong></article>
      <article><span>Integrations</span><strong>${integrations.length ? integrations.join(", ") : "Configure later"}</strong></article>
      <article><span>Channels</span><strong>${channels.length ? channels.join(", ") : "Configure later"}</strong></article>
    </div>
    <div class="impact-summary">
      ${profileImpacts().map((item) => `<span>${item}</span>`).join("")}
    </div>
    <div class="proof-strip final">
      ${proofBadges.map((badge) => `<span>${badge}</span>`).join("")}
    </div>
    <div class="launch-grid">
      <button type="button">Start chatting</button>
      <button type="button">Configure selected apps</button>
      <button type="button">Run health check</button>
      <button type="button">Open dashboard</button>
    </div>
    <footer class="terminal-actions">
      <button type="button" data-back>Back</button>
      <p>Easter egg: press restart when product asks for one more first impression.</p>
      <button type="button" data-restart>Restart ride</button>
    </footer>
  `;
}

function profileImpacts(): string[] {
  const impacts = ["Muster will show setup before saving anything."];
  if (answers.get("style")?.has("tokens")) impacts.push("Low-token retrieval will run before old context is added.");
  if (answers.get("style")?.has("privacy")) impacts.push("Tenant/user/workspace/session scopes stay visible.");
  if (answers.get("integrations")?.has("frappe")) impacts.push("Frappe answers will prefer module, DocType, field, and workflow context.");
  if (answers.get("channels")?.size) impacts.push("Channel replies default to controlled setup, not blind auto-send.");
  if (answers.get("memory")?.has("ask")) impacts.push("Durable memory writes require confirmation.");
  return impacts.slice(0, 5);
}

function renderDetail(step: Step, activeChoice: Choice | undefined): string {
  const selectedInStep = labelsFor(step.id);
  const selectedChoices = step.choices.filter((choice) => answers.get(step.id)?.has(choice.id));
  if (step.id === "finish") {
    return `
      <p class="panel-kicker">handoff</p>
      <h3>No commands dumped.</h3>
      <p>The real implementation should write config/profile state, then open guided setup links only when an external provider needs auth.</p>
      <div class="link-card">Frappe setup opens <strong>/app/user</strong></div>
      <div class="link-card">OAuth setup opens provider auth links</div>
      <div class="link-card">MCP setup shows safe install choices</div>
    `;
  }
  return `
    <p class="panel-kicker">live preview</p>
    <h3>${activeChoice?.label ?? "Move through options"}</h3>
    <p>${activeChoice?.detail ?? "The detail panel changes with the highlighted option."}</p>
    ${selectedChoices.length ? `
      <div class="side-setup">
        <p class="panel-kicker">selected setup</p>
        ${selectedChoices.slice(0, 2).map((choice) => renderSideSetupPanel(step, choice)).join("")}
        ${selectedChoices.length > 2 ? `<small>+${selectedChoices.length - 2} more selected paths in the main setup drawer</small>` : ""}
      </div>
    ` : `
      <div class="side-setup empty">
        <p class="panel-kicker">selected setup</p>
        <strong>Pick options to open fields, links, and setup modes here.</strong>
      </div>
    `}
    <div class="mini-terminal">
      <span>$ muster onboarding</span>
      <span class="dim">transition: ${transitionName()}</span>
      <span class="ok">selected: ${selectedInStep.length || 0}</span>
      <span class="dim">step: ${step.id}</span>
    </div>
    <div class="follow-list">
      ${(activeChoice?.followUps ?? ["Guided setup", "Profile write", "Health check"]).map((item) => `<span>${item}</span>`).join("")}
    </div>
    <div class="transition-stack">
      <p class="panel-kicker">transition stack</p>
      <span>Aurora rail sweep</span>
      <span>Panel slide forward/back</span>
      <span>Selection bloom</span>
      <span>Chip tray carry-over</span>
      <span>Success ring pulse</span>
    </div>
    <div class="feature-callout">
      <strong>Marketing woven into setup</strong>
      <p>Every choice reinforces token savings, scoped memory, leak prevention, or app-aware assistance.</p>
    </div>
  `;
}

function renderSideSetupPanel(step: Step, choice: Choice): string {
  if (step.id === "provider") {
    return `
      <article class="side-setup-card">
        <strong>${choice.label}</strong>
        <label>Mode<select><option>Fast daily work</option><option>Balanced</option><option>Deep reasoning</option></select></label>
        <label>Key/env<input placeholder="${choice.id === "selfhosted" ? "https://models.internal.example/v1" : providerEnv(choice.id)}" /></label>
        <p class="impact-mini">${impactText(step, choice)}</p>
      </article>
    `;
  }
  if (step.id === "integrations" && choice.id === "frappe") {
    return `
      <article class="side-setup-card">
        <strong>Frappe / ERPNext</strong>
        <label>Site URL<input placeholder="https://erp.example.com" /></label>
        <label>Auth mode<select><option>API token</option><option>One-time admin login</option><option>Configure later</option></select></label>
        <label>Token/env<input placeholder="FRAPPE_API_TOKEN" /></label>
        <label>Module focus<input placeholder="Accounts, HR, Stock, custom app" /></label>
        <a href="#">Open /app/user</a>
        <p class="impact-mini">${impactText(step, choice)}</p>
      </article>
    `;
  }
  if (step.id === "channels") {
    return `
      <article class="side-setup-card">
        <strong>${choice.label}</strong>
        ${sideChannelFields(choice.id)}
        <p class="impact-mini">${impactText(step, choice)}</p>
      </article>
    `;
  }
  if (step.id === "integrations") {
    return `
      <article class="side-setup-card">
        <strong>${choice.label}</strong>
        <label>Setup<select><option>Open guided auth</option><option>Use env var</option><option>Configure later</option></select></label>
        <label>Scope<select><option>Workspace only</option><option>User + workspace</option></select></label>
        <p class="impact-mini">${impactText(step, choice)}</p>
      </article>
    `;
  }
  if (step.id === "memory") {
    return `
      <article class="side-setup-card">
        <strong>${choice.label}</strong>
        <label><input type="checkbox" checked /> Show receipts</label>
        <label><input type="checkbox" checked /> Ask before durable write</label>
        <p class="impact-mini">${impactText(step, choice)}</p>
      </article>
    `;
  }
  return `
    <article class="side-setup-card">
      <strong>${choice.label}</strong>
      <label><input type="checkbox" checked /> Enable this path</label>
      <label><input type="checkbox" checked /> Add to profile summary</label>
      <p class="impact-mini">${impactText(step, choice)}</p>
    </article>
  `;
}

function sideChannelFields(id: string): string {
  if (id === "slack") return `<label>Bot token/env<input placeholder="SLACK_BOT_TOKEN" /></label><label>Signing secret<input placeholder="SLACK_SIGNING_SECRET" /></label><a href="#">Open Slack setup</a>`;
  if (id === "teams") return `<label>App ID<input placeholder="TEAMS_BOT_APP_ID" /></label><label>Tenant<input placeholder="AZURE_TENANT_ID" /></label><a href="#">Open Azure setup</a>`;
  if (id === "whatsapp") return `<label>Phone ID<input placeholder="WHATSAPP_PHONE_NUMBER_ID" /></label><label>Token/env<input placeholder="WHATSAPP_ACCESS_TOKEN" /></label><a href="#">Open Meta setup</a>`;
  if (id === "telegram") return `<label>Bot token/env<input placeholder="TELEGRAM_BOT_TOKEN" /></label><label>Webhook URL<input placeholder="https://.../telegram" /></label><a href="#">Open BotFather</a>`;
  if (id === "google-chat") return `<label>Project ID<input placeholder="GOOGLE_CLOUD_PROJECT" /></label><label>Signing secret<input placeholder="GOOGLE_CHAT_SIGNING_SECRET" /></label><a href="#">Open Google Chat setup</a>`;
  return `<label>Bot token/env<input placeholder="DISCORD_BOT_TOKEN" /></label><label>Application ID<input placeholder="DISCORD_APPLICATION_ID" /></label><a href="#">Open Discord setup</a>`;
}

function labelsFor(stepId: StepId): string[] {
  const step = steps.find((item) => item.id === stepId);
  const ids = answers.get(stepId) ?? new Set();
  return step?.choices.filter((choice) => ids.has(choice.id)).map((choice) => choice.label) ?? [];
}

function buildProofBadges(): string[] {
  const badges = ["Scoped memory", "Token ledger", "Leak-resistant"];
  if (answers.get("style")?.has("tokens")) badges.push("Low-token mode");
  if (answers.get("style")?.has("privacy")) badges.push("Tenant rails");
  if (answers.get("memory")?.size) badges.push("Receipts");
  if (answers.get("integrations")?.has("frappe")) badges.push("Frappe graph context");
  if (answers.get("channels")?.size) badges.push("Channel auth");
  return badges.slice(0, 6);
}

function transitionName(): string {
  if (transition === "slide-forward") return "panel slide + aurora sweep";
  if (transition === "slide-back") return "reverse slide";
  return "selection bloom";
}

document.addEventListener("keydown", (event) => {
  if (event.key === "ArrowDown") {
    event.preventDefault();
    go(1);
  } else if (event.key === "ArrowUp") {
    event.preventDefault();
    go(-1);
  } else if (event.key === " " && currentStep().mode !== "finish") {
    event.preventDefault();
    const choice = currentStep().choices[selected];
    if (choice) toggleChoice(choice);
  } else if (event.key === "Enter") {
    event.preventDefault();
    next();
  } else if (event.key === "Escape") {
    event.preventDefault();
    back();
  }
});

render();
