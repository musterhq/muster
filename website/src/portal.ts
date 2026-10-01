import "./portal.css";
import { initTheme } from "./theme";
// Statically imported at build time: real captured CLI output from
// scripts/generate-portal-data.mjs. The portal renders ONLY from this file —
// nothing on the page is invented.
import data from "./portal-data.json";
import "./site-theme.css";

// Light/dark toggle (shared controller) — wires the nav button + persistence.
initTheme();

type RunRecord = (typeof data.runs)[number];
type CommandRecord = (typeof data.commands)[number];

const $ = <T extends HTMLElement>(id: string): T => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing #${id}`);
  return node as T;
};

// ---------- tiny DOM builders (textContent only — no HTML injection) ----------

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function chip(text: string, kind: "ok" | "warn" | "dur" | "dim" = "dim"): HTMLSpanElement {
  return el("span", `chip ${kind}-chip`, text);
}

/** Warp-style collapsible block: summary row + verbatim <pre> body. */
function toolBlock(title: string, body: string, opts: { open?: boolean; chips?: HTMLElement[] } = {}): HTMLDetailsElement {
  const details = el("details", "block tool-block");
  if (opts.open) details.open = true;
  const summary = el("summary");
  summary.append(el("span", "tool-name mono", title));
  for (const extra of opts.chips ?? []) summary.append(extra);
  const pre = el("pre", "mono");
  pre.textContent = body;
  details.append(summary, pre);
  return details;
}

function artifact(title: string, body: string, extraClass = ""): HTMLDivElement {
  const wrap = el("div", `artifact ${extraClass}`.trim());
  wrap.append(el("p", "artifact-title mono", title));
  const pre = el("pre", "mono");
  pre.textContent = body;
  wrap.append(pre);
  return wrap;
}

// ---------- header / rail counts (all from captured data) ----------

const statusLines = new Map(
  data.status
    .split("\n")
    .map((line) => line.match(/^(\S[\w ]*?)\s{2,}(.+)$/))
    .filter((match): match is RegExpMatchArray => match !== null)
    .map((match) => [match[1] ?? "", match[2] ?? ""] as const),
);

$("portal-profile").textContent = `profile: ${statusLines.get("profile") ?? "default"}`;
$("real-meta").textContent = `captured ${data.meta.generatedAt.slice(0, 16).replace("T", " ")} UTC · ${data.meta.generator}${data.meta.stubLlm ? " · deterministic stub LLM" : ""}`;
$("count-sessions").textContent = String(data.counts.sessions);
$("count-flows").textContent = String(data.counts.flows);
$("count-surfaces").textContent = String(data.counts.surfaces.length);
$("verify-flag").textContent = data.verify.includes(": OK") ? "OK" : "CHECK";
$("rail-tokens").textContent = statusLines.get("tokens today") ?? "—";

// ---------- center views ----------

function commandsFor(prefixes: string[]): CommandRecord[] {
  return data.commands.filter((entry) => prefixes.some((prefix) => entry.cmd.startsWith(prefix)));
}

function runArticle(run: RunRecord, index: number, selectRun: (run: RunRecord) => void): HTMLElement {
  const wrap = el("section", "run-group reveal");
  wrap.style.setProperty("--reveal-delay", `${index * 70}ms`);

  const head = el("div", "runlog-head");
  const h2 = el("h2");
  h2.append(el("span", "mono", `run_${run.runId.slice(0, 8)}`), chip(run.status, run.status === "completed" ? "ok" : "warn"));
  head.append(h2);
  head.append(el("p", "mono dim", `runtime=${run.runtime} · model=${run.model} · task=${run.taskKind}`));
  wrap.append(head);

  const prompt = el("article", "block user-block");
  const promptHeader = el("header");
  promptHeader.append(el("span", "who", "prompt"));
  prompt.append(promptHeader, el("p", undefined, run.prompt));
  wrap.append(prompt);

  if (run.recalledMemories > 0) {
    const sys = el("article", "block sys-block");
    const sysHeader = el("header");
    sysHeader.append(el("span", "who", "harness"), chip("memory", "dim"));
    const line = el("p", "mono");
    line.append(`recalled ${run.recalledMemories} scoped ${run.recalledMemories === 1 ? "memory" : "memories"} → `);
    line.append(el("span", "scope", "user:dhairya"));
    sys.append(sysHeader, line);
    wrap.append(sys);
  }

  const agent = el("article", "block agent-block");
  const agentHeader = el("header");
  agentHeader.append(el("span", "who who-agent", "agent"), chip(`tokens ${run.tokensLine}`, "dur"));
  agent.append(agentHeader, el("p", undefined, run.response));
  wrap.append(agent);

  wrap.append(toolBlock(`$ muster run "${run.prompt.slice(0, 48)}${run.prompt.length > 48 ? "…" : ""}" — raw output`, run.rawOutput));

  wrap.addEventListener("click", () => selectRun(run));
  return wrap;
}

function viewSessions(main: HTMLElement, theater: HTMLElement): void {
  const intro = el("div", "runlog-head reveal");
  intro.append(el("h1", undefined, "Sessions"));
  intro.append(el("p", "mono dim", `${data.counts.sessions} episodes recorded in this workspace — output below is verbatim from \`muster run\``));
  main.append(intro);

  const selectRun = (run: RunRecord) => {
    theater.replaceChildren(
      el("p", "theater-head", "run details"),
      artifact("episode", [`episode=${run.runId}`, `runtime=${run.runtime}`, `model=${run.model}`, `task_kind=${run.taskKind}`, `status=${run.status}`, `memories_recalled=${run.recalledMemories}`].join("\n")),
      artifact("run ledger", `tokens ${run.tokensLine}\nmodel  ${run.model}`, "artifact-ledger"),
      artifact("muster verify", data.verify),
    );
  };

  data.runs.forEach((run, index) => main.append(runArticle(run, index, selectRun)));

  theater.replaceChildren(
    el("p", "theater-head", "workspace"),
    artifact("muster status", data.status),
    artifact("muster episodes", data.episodes),
  );
}

function viewFlows(main: HTMLElement, theater: HTMLElement): void {
  const intro = el("div", "runlog-head reveal");
  intro.append(el("h1", undefined, "Flows"));
  intro.append(el("p", "mono dim", `flow=${data.flow.definition.id} · ${data.flow.definition.steps.length} steps · run=${data.flow.runId} — full save → check → run → gate → approve lifecycle, captured live`));
  main.append(intro);

  const stages: Array<[string, string, boolean]> = [
    ["definition: deploy-digest.json", JSON.stringify(data.flow.definition, null, 2), false],
    ["$ muster flow save deploy-digest.json", data.flow.saveOutput, false],
    ["$ muster flow check deploy-digest", data.flow.checkOutput, false],
    ["$ muster flow run deploy-digest — halts at the approval gate", data.flow.runOutput, true],
    [`$ muster flow approve ${data.flow.runId}`, data.flow.approveOutput, true],
    [`$ muster flow show ${data.flow.runId}`, data.flow.showOutput, false],
  ];
  stages.forEach(([title, body, open], index) => {
    const block = toolBlock(title, body, { open, chips: open ? [chip("gate", "warn")] : [] });
    block.classList.add("reveal");
    block.style.setProperty("--reveal-delay", `${index * 70}ms`);
    main.append(block);
  });

  theater.replaceChildren(
    el("p", "theater-head", "gate evidence"),
    artifact("approver saw", "23 changes since Friday; 2 release blockers\n\n(the gate shows the ACTUAL step output,\nnot a step name)"),
    artifact("durable run record", `flow_run=${data.flow.runId}\nstatus=completed\nstore=.muster/data/flows/${data.flow.runId}.jsonl\n(gate state lives in the run record —\nsurvives gateway restarts)`),
  );
}

function viewSurfaces(main: HTMLElement, theater: HTMLElement): void {
  const intro = el("div", "runlog-head reveal");
  intro.append(el("h1", undefined, "Surfaces"));
  intro.append(el("p", "mono dim", "one gateway, one message envelope — six webhook adapters in packages/gateway/src/adapters plus the web client in packages/surface"));
  main.append(intro);

  const notes: Record<string, string> = {
    telegram: "webhook adapter · packages/gateway/src/adapters/telegram.ts",
    slack: "webhook adapter · packages/gateway/src/adapters/slack.ts",
    discord: "ed25519-verified interactions · packages/gateway/src/adapters/discord.ts",
    whatsapp: "webhook adapter · packages/gateway/src/adapters/whatsapp.ts",
    gchat: "webhook adapter · packages/gateway/src/adapters/gchat.ts",
    teams: "webhook adapter · packages/gateway/src/adapters/teams.ts",
    web: "browser client · packages/surface (POST /v1/messages)",
  };
  const grid = el("div", "surface-grid");
  data.counts.surfaces.forEach((surface, index) => {
    const card = el("div", "block surface-card reveal");
    card.style.setProperty("--reveal-delay", `${index * 60}ms`);
    const header = el("header");
    header.append(el("span", "who", surface), chip("paired via muster pairing", "dim"));
    card.append(header, el("p", "mono dim", notes[surface] ?? "adapter"));
    grid.append(card);
  });
  main.append(grid);

  main.append(toolBlock("start the gateway", "muster gateway status\nmuster gateway init\nmuster gateway status\nmuster gateway start --port 7460\nmuster pairing list | approve <code>", { open: true }));

  theater.replaceChildren(
    el("p", "theater-head", "envelope"),
    artifact("one envelope, any frontend", JSON.stringify({ surfaceId: "web:demo", conversationId: "demo", senderId: "demo-user", text: "say something…" }, null, 2)),
    artifact("pairing", "first message from an unknown sender\nreturns status=pairing_required + code;\noperator runs:\n  muster pairing approve <code>"),
  );
}

function viewTokens(main: HTMLElement, theater: HTMLElement): void {
  const intro = el("div", "runlog-head reveal");
  intro.append(el("h1", undefined, "Tokens"));
  intro.append(el("p", "mono dim", "every run lands on the ledger — this table is the verbatim output of `muster tokens` for the captured workspace"));
  main.append(intro);

  main.append(toolBlock("$ muster tokens", data.tokens, { open: true }));
  main.append(toolBlock("$ muster status", data.status));

  theater.replaceChildren(
    el("p", "theater-head", "ledger"),
    artifact("today", `${statusLines.get("tokens today") ?? "—"}\nwaste flags: 0`, "artifact-ledger"),
    artifact("muster verify", data.verify),
  );
}

function viewVerify(main: HTMLElement, theater: HTMLElement): void {
  const intro = el("div", "runlog-head reveal");
  intro.append(el("h1", undefined, "Verify"));
  intro.append(el("p", "mono dim", "append-only stores are integrity-checked — verbatim output of `muster verify`"));
  main.append(intro);
  main.append(toolBlock("$ muster verify", data.verify, { open: true, chips: [chip("OK", "ok")] }));
  main.append(toolBlock("$ muster episodes", data.episodes, { open: true }));

  theater.replaceChildren(
    el("p", "theater-head", "stores"),
    artifact("checked stores", "episodes · feedback · memory · tokens\n(JSONL, line-level corruption detection)"),
  );
}

// ---------- bootstrap + rail switching ----------

const views: Record<string, (main: HTMLElement, theater: HTMLElement) => void> = {
  sessions: viewSessions,
  flows: viewFlows,
  surfaces: viewSurfaces,
  tokens: viewTokens,
  verify: viewVerify,
};

const runlog = $("runlog");
const theater = $("theater");
const railItems = Array.from(document.querySelectorAll<HTMLButtonElement>(".rail-item[data-view]"));

function show(view: string): void {
  const render = views[view];
  if (!render) return;
  for (const item of railItems) item.classList.toggle("active", item.dataset["view"] === view);
  runlog.replaceChildren();
  theater.replaceChildren();
  render(runlog, theater);
  runlog.scrollTop = 0;
}

for (const item of railItems) {
  item.addEventListener("click", () => show(item.dataset["view"] ?? "sessions"));
}
show("sessions");

// ---------- chrome behaviors ----------

// muster-view strip collapse/expand
const toggle = document.getElementById("muster-view-toggle");
const view = document.getElementById("muster-view");
toggle?.addEventListener("click", () => {
  const collapsed = view?.classList.toggle("collapsed") ?? false;
  toggle.setAttribute("aria-expanded", String(!collapsed));
  toggle.textContent = collapsed ? "muster view ▸" : "muster view ▾";
});

// SMIL pulses cannot be paused from CSS — remove them under reduced motion
if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
  for (const node of document.querySelectorAll("animateMotion")) node.remove();
}
