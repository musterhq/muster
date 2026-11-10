# Muster UX Contract — The Daily-Driver Redesign Spec

Owner-ratified 2026-08-28. This document is BINDING for every UI change. A
change that violates it is a bug regardless of tests passing. Decisions here
were made explicitly by the owner; do not relitigate them.

**The product in one line: Claude Code's UX + Codex's models and ecosystem +
Cursor's inline diff, in one terminal, losing nothing the owner already has.**

## Ratified decisions

1. **Visuals: replicate Claude Code exactly.** Default terminal foreground for
   prose. Dim warm gray for ALL chrome (gutters, borders, results, hints). One
   coral accent (`217;119;87`) used rarely: bullets, the active selection.
   Color must MEAN something; if a colored element carries no state, remove the
   color. Banner art at most once per launch, small. No cyan, no lime, no
   lavender anywhere in the chat surface.
2. **Mid-session provider switching: muster owns continuity.** The transcript
   is muster's; switching codex↔claude mid-session continues the SAME muster
   conversation, seeding the new provider's fresh native thread with the
   running context (recent transcript + summary via applicationContext). The
   prior native thread remains resumable if the user switches back.
3. **Command surface: full catalog stays; dailies ranked first** in every
   completion surface. Nothing hidden, nothing removed.

## Vocabulary law

Never invent a noun. Provider concepts use the provider's exact words; work
concepts use the worker's words.

- Codex reasoning = **"Effort"** with the app's labels, mapped 1:1 to the
  verified config values (machine-checked 2026-08-28, codex-cli 0.150.0-alpha.8):
  Light=`low` · Medium=`medium` · High=`high` · Extra High=`xhigh` ·
  Max=`max` · Ultra=`ultra` (Ultra hint: "Consumes usage limits faster" — keep
  their honest hint). The setting IS `model_reasoning_effort`; muster applies
  it per-session via `configOverrides` on the app-server run (never edits the
  user's config.toml silently) and shows the app default when unset.
- Claude reasoning = **"Extended thinking"**, Claude's semantics. Never show
  codex effort tiers on a claude turn.
- Orchestration = **tasks** and **agents** in every user-visible string. The
  engine's internal names (kanban, mission) must not leak to the UI. Primary
  trigger is natural language ("split this into tasks and run them in
  parallel"); slash commands are shortcuts.

## Model catalog (real lineup, provider-marked)

- codex: **GPT-5.6 Sol / Terra / Luna** (`gpt-5.6-sol|terra|luna`) + GPT-5.5;
  active model read from `~/.codex/config.toml`.
- claude: **Fable 5 / Opus 5 / Sonnet 5 / Haiku 4.5** via the claude CLI.
- The composer picker mirrors the Codex app exactly: **Model · Effort · Speed**
  anchored at the composer (see owner's screenshot), arrow-driven, current
  value ✓-marked, one-line consequence hints.

## The transcript contract (Claude Code grammar)

- Everything flows into NATIVE scrollback, additively, forever (flow mode —
  already shipped; never reintroduce windowing).
- `> ` dim gutter for user turns; `●` blocks for assistant prose; `⏺ Action(target)`
  with `  ⎿ dim result` for every tool action; long results collapse with an
  honest count.
- **Thinking is visible**: provider reasoning summaries paint dim-italic into
  the transcript as they stream (codex `item/reasoning/summaryTextDelta`;
  claude thinking summaries). If the provider sends none, show nothing —
  never fake it.
- **History replays ONLY when invoked, and then IN FULL** (owner-ratified
  2026-08-30, superseding the always-replay rule): a plain launch is CLEAN
  like the reference — no auto-replay. /resume, /codex resume, and /history
  replay the transcript (into the sink, not console.log — engine-line routing
  swallows that) — and when they do, EVERY message renders. No "… N earlier"
  cap, no collapsing, no pruning; flow mode owns native scrollback. Dim
  separator with true totals; the same `> `/`●` grammar.
- Nothing internal ever prints raw: run records, memory receipts, stderr —
  chips or the session log, always.
- **Esc interrupts the running turn** (codex: `turn/interrupt`; claude:
  SIGINT), landing as a visible "interrupted" line. This is a keystroke, not a
  command.

## Inline diff (Cursor grade)

Diff cards stream mid-turn (shipped) and remain receipted. Next grade: the
current turn's cumulative diff is always inspectable (`ctrl+d` toggles a live
diff panel of the turn), red/green painted, per-file, from the workspace
observer — never from provider self-report.

## One place for capabilities

`/tools` becomes THE capabilities surface: an arrow-driven overlay listing —
native toolsets, **inherited codex/claude MCP servers (status-marked),
inherited plugins (documents/pdf/spreadsheets/presentations/computer-use/…),
skills** — every row actionable in ≤2 keystrokes: enable/attach/authenticate/
insert-into-prompt. Computer-use shows its real enable state and how to flip
it. No tables that end in "run this other command."

## Directory awareness

- `muster` in a directory lists/creates sessions BELONGING to that directory
  first (muster sessions by workspace + codex rollouts by cwd).
- Resuming a session whose workspace ≠ cwd shows a one-line banner:
  "this conversation belongs to ~/other/repo — [enter] work there · [c] continue here".
- New sessions bind to cwd; the binding is visible in the wordmark line.

## Definition of done (owner's law)

Not suites. A scripted REAL-USER protocol in a real PTY, frames judged by eye
against this contract, every scenario: launch feel · resume codex thread with
visible history · thinking painting mid-turn · esc interrupt · mid-session
codex→claude switch with continuity · effort change via composer picker
reflected in the actual run · /tools to a usable capability in ≤5 keystrokes ·
directory-mismatch banner · an edit turn with live diff · /help sanity. Suites
are the regression floor only.

## Micro-nuance law — the polish DNA (owner-ratified addendum, 2026-08-28)

Color carries MEANING, never decoration. The reference is Claude Code's own
rendering; every muster surface applies the same semantic layer:

1. THINKING IS A LAYER: reasoning text renders violet-tinted italic with a ∴
   marker — distinguishable from the answer at a glance, before reading (the
   live spinner owns ✻, so a summary never reads as a stale status row).
2. INLINE SEMANTICS IN PROSE (owner-corrected 2026-08-29, FINAL): prose is
   NEAR-MONOCHROME like the reference, with ONE sanctioned inline color:
   `code spans` — the important words — render in Claude Code's soft
   blue-violet (165;180;252), no background. Links underline only. NOTHING
   else is colored inside sentences — no path/branch/command tinting ever
   again ("create/update" spray). Color is for state, plus this one identity.
3. MARKDOWN RENDERS: bold→bold, italic→italic, headers distinct, fenced code
   on a subtle background with NO language label row, tables as aligned
   columns (bold header, dim rule, no raw pipes). List markers and the
   assistant ● are DEFAULT foreground — never accent. Raw ** or ` glyphs in
   painted prose are a bug.
4. STATUS BY COLOR ON ACTION BULLETS: ⏺ pending=dim, success=warm green,
   failure=red — readable before the words.
5. WARNINGS ARE A SYSTEM: ⚠ + yellow + one concrete action. Errors: red +
   the cure. Never prose apologies.
6. THE WORKING LINE HAS PERSONALITY: sparkle glyph + verb + elapsed; the
   spinner row is allowed exactly this much whimsy and no more.
7. USER TURNS SIT ON A SUBTLE BACKGROUND BAND spanning the row — the
   distinction mechanism. The composer is a THIN DIM-GRAY ROUNDED BOX
   (owner-corrected 2026-08-28: Claude Code's input HAS a border — subtle,
   muted, never accent-colored; grows with multiline input; ❯ inside).
   Neither the loud orange box nor a naked prompt: the quiet middle.
Applies to: chat transcript, task view, board cards, history replay, chips,
/status, doctor — every painted surface, one renderer, zero drift.


## LAYOUT LAW — FINAL (settled by side-by-side reference frames, 2026-08-28)
Content anchors at the TOP. The composer is PINNED TO THE BOTTOM of the
terminal at all times — dim thin rounded box, dim placeholder, effort
indicator (● Medium · /model) right-aligned on the row above it. The void
between content and input is correct and calm BECAUSE the input chrome is
quiet. Flip-flopped twice; never again.
