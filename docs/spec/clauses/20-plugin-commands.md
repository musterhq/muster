# 20 — Plugin slash commands

Installed plugins' `commands/*.md` (front matter `description`, `argument-hint`; a Markdown prompt with `$ARGUMENTS`, `$1`…) become chat slash commands. Using one runs a turn with the expanded prompt. Shell snippets (`` !`cmd` ``) are never executed. Each case names the one test that proves it. Evidence is a receipt from a real run, or UNVERIFIED.

## MUS-SPEC-20-1A — A plugin command shows in the slash menu

- **Precondition:** plugin `reviewer` installed with `commands/review-pr.md` (`description: Review a pull request`, `argument-hint: <number>`).
- **Action:** `muster chat --complete "/rev" --describe`.
- **Expected result:** a `/review-pr` row whose label carries the argument hint and whose description names the plugin: `Review a pull request · reviewer`.
- **Test:** `packages/cli/test/plugin-commands.test.ts` › "plugin commands appear in the slash menu and expand into the turn's prompt"
- **Environment:** real CLI, local plugin bundle, fake `codex`.
- **Known gaps:** a plugin command whose name collides with a built-in is reachable as `/<plugin>:<name>`.
- **Evidence:** UNVERIFIED

## MUS-SPEC-20-1B — Using it runs a turn with the expanded prompt; shell snippets are not run

- **Precondition:** as above; the body is `Review PR $ARGUMENTS. First number: $1.` followed by a line `` !`git log -1` ``.
- **Action:** `muster chat "/review-pr 123 urgent"`.
- **Expected result:** the provider receives `Review PR 123 urgent. First number: 123.` and the snippet line replaced by a note that shell snippets in plugin commands are not executed; no `git log` runs.
- **Test:** same as 20-1A.

## MUS-SPEC-20-1C — Commands count as activated
- **Action:** `muster plugins inspect` / `install` of that plugin.
- **Expected result:** commands are listed as `command=review-pr status=available`, not under "ignored".
- **Test:** same as 20-1A.
