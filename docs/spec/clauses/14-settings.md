# 14 — Settings: one registry, `muster config`, `/settings`

Every user-facing setting is one typed row in `SETTINGS` (`packages/core/src/settings.ts`): a dotted key, type (enum / boolean / string / number), default, enum options each with a one-line description, a description, the scopes it may be saved in (project `.muster/config.json`, global `~/.muster/config.json`) and an optional verify hook. The value lives at the key's dotted path in the config JSON; project beats global beats default. `muster config …`, the `/settings` panel (also `muster settings`) and chat's starting state all read the same table, so a key cannot exist in one surface and not the others. Secrets are never values: a setting only ever stores an env-var name. Design: `deep-setup-settings.md` §6 "Settings" (issue #148, phase 2). Each case names the one test that proves it. Evidence is a receipt from a real run, or UNVERIFIED.

## MUS-SPEC-14-1A — The registry describes every setting completely

- **Precondition:** none.
- **Action:** read `SETTINGS`.
- **Expected result:** it holds at least `chat.access`, `chat.liveDiff`, `chat.reasoningMode`, `chat.speed`, `models.default`, `memory.policy`, `appearance.statusBar`, `appearance.header`; every row has a dotted key, a label, a tab (Models, Permissions, Appearance or Memory), a description and a default scope among its allowed scopes; every enum has two or more options, each with a description, and its default is one of them; every default passes the row's own validation.
- **Test:** `packages/core/test/settings.test.ts` › "every registered setting is typed, documented and has a valid default"
- **Environment:** none.
- **Known gaps:** Context, Tools, Channels, Secrets, Updates and Advanced tabs are not in the registry yet.
- **Evidence:** `npx tsx --test packages/core/test/settings.test.ts` → pass 2/2 (red before: `SETTINGS` not exported), 2026-11-09.

## MUS-SPEC-14-1B — Values layer project over global over default and persist in the config files

- **Precondition:** a temp project with a default `.muster/config.json`; `MUSTER_CONFIG_HOME` points at an empty temp dir.
- **Action:** set `chat.access` to `ask` globally, then `read-only` in the project, then reset the project value; try `chat.access=yolo`, a key-shaped string for `models.default`, and `memory.policy` globally; set `memory.policy=ask` in the project.
- **Expected result:** the resolved value and its source follow project → global → default at each step and the JSON files hold exactly what was set; `yolo` fails naming `read-only, ask, auto-edit, full`; the key-shaped string fails saying settings store env-var names, never secrets, and is written nowhere; the global `memory.policy` fails as project-only; `loadConfig` then reports `memory.policy = ask`.
- **Test:** `packages/core/test/settings.test.ts` › "values layer project over global over default, persist in the config files and refuse bad values"
- **Environment:** temp dirs.
- **Known gaps:** `memory.policy` and `routing.maxCostUsdPerRun` are project-only because the runtime reads them through `loadConfig`, which does not merge the global file.
- **Evidence:** same run, pass.

## MUS-SPEC-14-2A — `muster config` lists, gets, sets, resets and locates settings

- **Precondition:** `muster init` in a temp workspace; `MUSTER_CONFIG_HOME` in a temp dir.
- **Action:** run `muster config path`, `config set chat.access ask`, `config get chat.access`, `config list`, `config list --json`, `config reset chat.access`, `config get chat.access`.
- **Expected result:** `path` prints the project and global file paths; `set` prints `Saved chat.access → ask · project`; `get` prints `ask`; `list` shows a `•` row for `chat.access` with its value and source; `list --json` has `{ key: "chat.access", value: "ask", default: "auto-edit", source: "project" }` with the enum options; after `reset`, `get` prints `auto-edit` and the project file no longer has the key.
- **Test:** `packages/cli/test/settings.test.ts` › "muster config path, set, get, list, list --json and reset work against the config files"
- **Environment:** real CLI via `tsx`, temp workspace.
- **Known gaps:** none.
- **Evidence:** `npx tsx --test packages/cli/test/settings.test.ts` → pass 7/7 (red before: "unknown command config"), 2026-11-09; live `muster config list` output in `~/.muster-work/review/screens/settings/config-list.txt`.

## MUS-SPEC-14-2B — Bad values and unknown keys fail with the allowed values; `validate` checks hand edits

- **Precondition:** as 14-2A.
- **Action:** `config set chat.access yolo`; `config get chat.nope`; hand-edit the project file to `"chat": { "liveDiff": "maybe" }` and run `config validate`; fix it and run `config validate` again.
- **Expected result:** the set exits non-zero naming `read-only, ask, auto-edit, full` and the file is unchanged; the get exits non-zero with `Unknown setting chat.nope`; the first validate exits non-zero naming `chat.liveDiff` and `true, false`; the second prints that both files are valid.
- **Test:** `packages/cli/test/settings.test.ts` › "bad values and unknown keys fail naming the allowed values and validate catches hand edits"
- **Environment:** real CLI via `tsx`, temp workspace.
- **Known gaps:** none.
- **Evidence:** same run, pass; live: `muster config set chat.access yolo` → "Invalid value \"yolo\" for chat.access. Allowed: read-only, ask, auto-edit, full." exit 1.

## MUS-SPEC-14-3A — Chat starts from the configured defaults; flags and slash commands still win per session

- **Precondition:** `config set chat.access ask`, `chat.speed fast`, `chat.liveDiff false`, `chat.reasoningMode full` in a temp workspace.
- **Action:** ask chat for its command menu (`muster chat --complete / --describe`), then again with `--access full`.
- **Expected result:** the menu's current values read access `ask`, speed `fast`, live-diff `off` and reasoning summaries `full`; with `--access full` access reads `full` and the others are unchanged.
- **Test:** `packages/cli/test/settings.test.ts` › "chat starts from the configured access, speed, live-diff and reasoning defaults and --access still overrides"
- **Environment:** real CLI via `tsx`, temp workspace.
- **Known gaps:** `appearance.header` and `appearance.statusBar` are only proven in the live tmux run.
- **Evidence:** same run, pass; live tmux: chat launched on Sonnet 5.5 (models.default) with the status bar hidden (`14-chat-start-from-config.png`).

## MUS-SPEC-14-4A — `/settings` opens a tabbed panel; an enum change saves immediately with a toast

- **Precondition:** chat harness with a temp workspace; `/settings` routed to `sink.openSettings`.
- **Action:** submit `/settings`; press → to Permissions; press Enter on Access; pick `ask` from the sub-list.
- **Expected result:** the panel shows the tabs Models, Permissions, Appearance and Memory with rows `Label  value`; the focused row's description is at the bottom; the sub-list shows all four access modes, each with its description; after picking, the project file has `chat.access = "ask"`, the panel shows `Saved chat.access → ask · project`, the row is marked `•`, and the chat is told about the change.
- **Test:** `packages/cli/test/settings.test.ts` › "/settings shows tabs and descriptions and an enum pick saves to the project file with a toast"
- **Environment:** `createMusterChatHarness`, temp workspace.
- **Known gaps:** none.
- **Evidence:** same run, pass; live tmux `02…05-*.png` (enum sub-list, toast, • marker).

## MUS-SPEC-14-4B — Typing searches every tab; Space toggles a boolean; Esc backs out one level

- **Precondition:** as 14-4A, panel open.
- **Action:** type `diff`; press Space; press Esc; press Esc again.
- **Expected result:** the tab row shows match counts (`Appearance (1)`) and the only result is Live diff; Space writes `chat.liveDiff = false` and toasts it; the first Esc clears the search and returns to the tabs; the second closes the panel and the chat composer is back.
- **Test:** `packages/cli/test/settings.test.ts` › "typing searches across tabs with counts, Space toggles a boolean and Esc backs out a level at a time"
- **Environment:** `createMusterChatHarness`, temp workspace.
- **Known gaps:** none.
- **Evidence:** same run, pass; live tmux `06-appearance-toggle.png`, `07-search-diff.png`, `08-search-mode.png`.

## MUS-SPEC-14-4C — The scope toggle writes the global file

- **Precondition:** as 14-4A, panel open.
- **Action:** press Tab (scope → global), go to Appearance, change Header to `full`.
- **Expected result:** the header shows `global` as the active scope; `$MUSTER_CONFIG_HOME/config.json` has `appearance.header = "full"`, the project file does not, and the toast ends `· global`.
- **Test:** `packages/cli/test/settings.test.ts` › "the scope toggle saves to the global config"
- **Environment:** `createMusterChatHarness`, temp workspace and temp global dir.
- **Known gaps:** none.
- **Evidence:** same run, pass; live tmux `09-global-scope.png`, `10-memory-project-only.png`.

## MUS-SPEC-14-4D — `muster settings` without a terminal points at `muster config`

- **Precondition:** `muster init` in a temp workspace; stdout is not a TTY.
- **Action:** run `muster settings`.
- **Expected result:** it prints the settings list (as `muster config list`) and a hint that the panel needs a terminal; exit code 0.
- **Test:** `packages/cli/test/settings.test.ts` › "muster settings without a TTY prints the list and a hint"
- **Environment:** real CLI via `tsx`, temp workspace.
- **Known gaps:** the full-screen panel outside chat is proven in the live tmux run only.
- **Evidence:** same run, pass; live tmux `17-muster-settings-outside-chat.png`.

## MUS-SPEC-14-2C — Every key saves to the project unless `--global` is given

- **Precondition:** `muster init` in a temp workspace; `MUSTER_CONFIG_HOME` in a temp dir; a chat open with `/settings`.
- **Action:** `muster config set chat.liveDiff false` (no flag); `muster config set appearance.header full --global`; read the Speed row's description. In chat, change Access in `/settings` and close the panel.
- **Expected result:** the first writes the project file and says `· project`, like the panel's default and `config set chat.access`; the global file is untouched; `--global` writes the global file. Speed is described by what it trades (fast skips recall and skills), not as "how much context each turn loads". A change made in the panel applies to the open chat and the status bar shows it as soon as the panel closes.
- **Test:** `packages/cli/test/settings.test.ts` › "config set saves every key to the project unless --global is given, like the panel"
- **Environment:** real CLI via `tsx`, temp workspace.
- **Known gaps:** the status-bar repaint after the panel closes is proven in the live tmux run only.
- **Evidence:** live, 2026-11-10: Access changed to full in `/settings` (project) → on close the bar shows `⚠ full access` at once. Red→green: settings.test.ts.

## MUS-SPEC-14-2D — `validate` warns about ignored keys and names JSON errors

- **Precondition:** `muster init`; the global file holds `routing.maxCostUsdPerRun` (project-only; earlier Muster versions wrote it there).
- **Action:** `muster config validate`; then break the project file (a missing comma on line 3, so the parser stops on line 4) and run `config validate` and `config list`.
- **Expected result:** the first validate exits 0 and prints a warning that `routing.maxCostUsdPerRun` is ignored in the global file (no `✗`). With the broken file, validate exits non-zero saying the file is not valid JSON and naming line 4; `config list` warns that it skipped that file instead of ignoring it silently.
- **Test:** `packages/cli/test/settings.test.ts` › "validate warns about keys a file ignores and names a JSON error with its line"
- **Environment:** real CLI via `tsx`, temp workspace and `MUSTER_CONFIG_HOME`.
- **Known gaps:** none.
- **Evidence:** live, 2026-11-10 on the real `~/.muster/config.json` (read-only): `! routing.maxCostUsdPerRun: is project-only and is ignored in the global file …`, exit 0 (before: `✗ …`, exit 1). Red→green: settings.test.ts.
