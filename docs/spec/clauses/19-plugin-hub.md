# 19 — Plugin hub: marketplaces, search, install by name

Muster reads plugin marketplaces in the widely used `.claude-plugin/marketplace.json` format (a git repo listing plugins with pinned sources), searches them and installs plugins by name, cold-read and pinned. Each case names the one test that proves it. Evidence is a receipt from a real run, or UNVERIFIED.

## MUS-SPEC-19-1A — Add a marketplace and list it

- **Precondition:** a git repo whose `.claude-plugin/marketplace.json` names `fixture-market` and lists 4 plugins.
- **Action:** `muster plugins marketplace add <repo>`; `muster plugins marketplace list`.
- **Expected result:** add prints `marketplace=fixture-market plugins=4`; list shows it with its source.
- **Test:** `packages/cli/test/plugin-hub.test.ts` › "a marketplace is added, searched and its plugins install by name at their pinned commits"
- **Environment:** real CLI; local git repos as marketplace and plugin sources (`file://`).
- **Known gaps:** `owner/repo` is shorthand for `https://github.com/owner/repo.git`.
- **Evidence:** UNVERIFIED

## MUS-SPEC-19-1B — Search across marketplaces

- **Action:** `muster plugins search tide`, `muster plugins search lookups`.
- **Expected result:** rows `name@marketplace` with description; `tide` finds `tides`; `lookups` finds `weather` and `inline-orders`.
- **Test:** same as 19-1A.

## MUS-SPEC-19-1C — Install by name at the pinned commit, for every source kind

- **Action:** `muster plugins install tides` (`url` + sha), `install weather@fixture-market` (`git-subdir` + sha + path), `install notes` (path inside the marketplace).
- **Expected result:** each installs without running plugin code; the lock records the marketplace, the url/path and the exact sha; their skills are listed by `muster skills list`.
- **Test:** same as 19-1A.

## MUS-SPEC-19-1D — Inline (`strict: false`) entries install from the marketplace's own description

- **Precondition:** `inline-orders` has no manifest in its directory; its marketplace entry declares `mcpServers.orders`.
- **Action:** `muster plugins install inline-orders`.
- **Expected result:** the `inline-orders__orders` MCP server is added with the bundle path as its working directory.
- **Test:** same as 19-1A.

## MUS-SPEC-19-1E — Denied plugins never install

- **Precondition:** `plugins.deny` contains `weather`.
- **Action:** `muster plugins install weather`.
- **Expected result:** refused with "denied by plugins.deny"; nothing installed.
- **Test:** `packages/cli/test/plugin-hub.test.ts` › "a denied marketplace plugin is refused"
