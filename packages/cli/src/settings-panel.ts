import { Input, matchesKey, SelectList, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component, type SelectListTheme } from "@earendil-works/pi-tui";
import {
  SETTING_TABS,
  formatSettingValue,
  resetSetting,
  resolveSettings,
  setSetting,
  settingsPaths,
  type ResolvedSetting,
  type SettingDef,
  type SettingScope,
  type SettingValue,
} from "@musterhq/core";

/**
 * `/settings` and `muster settings`: one full-screen panel generated from the
 * settings registry (packages/core/src/settings.ts). Tabs, `Label  value` rows,
 * the focused row's description at the bottom, enum sub-lists with a line per
 * option (pi-tui SelectList), inline editing for text and numbers (pi-tui
 * Input), type-to-search across every tab, and a project/global scope switch.
 * Every change is saved the moment it is made and confirmed with a toast.
 */

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const UNDERLINE = "\x1b[4m";
const ACCENT = "217;119;87";
const MUTED = "148;144;140";
const SUCCESS = "132;176;121";
const FAILURE = "255;107;122";
const SELECT = "176;184;248";
const RULE = "72;72;76";
const TAB_BAND = "52;52;58";

function colorOn(): boolean {
  if (process.env.FORCE_COLOR) return true;
  return !process.env.NO_COLOR && Boolean(process.stdout.isTTY);
}
function fg(text: string, rgb: string): string {
  return colorOn() ? `\x1b[38;2;${rgb}m${text}${RESET}` : text;
}
function bold(text: string): string {
  return colorOn() ? `${BOLD}${text}${RESET}` : text;
}
const accent = (text: string) => fg(text, ACCENT);
const muted = (text: string) => fg(text, MUTED);
const rule = (text: string) => fg(text, RULE);
const selected = (text: string) => fg(text, SELECT);
function pad(text: string, width: number): string {
  return text + " ".repeat(Math.max(0, width - visibleWidth(text)));
}

export interface SettingsChange {
  readonly key: string;
  readonly value: SettingValue;
  readonly scope: SettingScope;
}

export interface SettingsPanelOptions {
  readonly cwd: string;
  /** Terminal height; the panel fills it. */
  readonly rows: () => number;
  readonly onClose: () => void;
  readonly onChange?: (change: SettingsChange) => void;
  readonly requestRender?: () => void;
}

interface Toast {
  readonly text: string;
  readonly tone: "ok" | "error";
}

type ListEntry = { readonly kind: "heading"; readonly label: string } | { readonly kind: "row"; readonly row: ResolvedSetting };

export class SettingsPanel implements Component {
  private tab = 0;
  private cursor = 0;
  private query = "";
  private scope: SettingScope = "project";
  private rows: ResolvedSetting[] = [];
  private toast: Toast | undefined;
  private submenu: { readonly key: string; readonly list: SelectList } | undefined;
  private editor: { readonly key: string; readonly input: Input } | undefined;

  constructor(private readonly options: SettingsPanelOptions) {
    this.reload();
  }

  invalidate(): void {}

  private reload(): void {
    this.rows = resolveSettings(this.options.cwd);
  }

  private tabRows(tabIndex: number): ResolvedSetting[] {
    const id = SETTING_TABS[tabIndex]?.id;
    return this.rows.filter((row) => row.setting.tab === id);
  }

  private matches(row: ResolvedSetting): boolean {
    const query = this.query.toLowerCase();
    if (!query) return true;
    const setting = row.setting;
    const haystack = [setting.label, setting.key, ...(setting.options ?? []).map((option) => option.value)].join(" ").toLowerCase();
    return haystack.includes(query);
  }

  /** Search results grouped by tab, best-matching tab first (omp's re-ranking). */
  private searchGroups(): Array<{ readonly tab: number; readonly rows: ResolvedSetting[] }> {
    return SETTING_TABS.map((_tab, index) => ({ tab: index, rows: this.tabRows(index).filter((row) => this.matches(row)) }))
      .filter((group) => group.rows.length > 0)
      .sort((a, b) => b.rows.length - a.rows.length || a.tab - b.tab);
  }

  private visibleRows(): ResolvedSetting[] {
    return this.query ? this.searchGroups().flatMap((group) => group.rows) : this.tabRows(this.tab);
  }

  private focusedRow(): ResolvedSetting | undefined {
    return this.visibleRows()[this.cursor];
  }

  handleInput(data: string): void {
    if (this.submenu) {
      this.submenu.list.handleInput(data);
      this.repaint();
      return;
    }
    if (this.editor) {
      this.editor.input.handleInput(data);
      this.repaint();
      return;
    }
    const count = this.visibleRows().length;
    if (matchesKey(data, "escape")) {
      if (this.query) {
        this.query = "";
        this.cursor = 0;
      } else {
        this.options.onClose();
        return;
      }
    } else if (matchesKey(data, "tab")) {
      this.scope = this.scope === "project" ? "global" : "project";
      this.toast = undefined;
    } else if (matchesKey(data, "left") || matchesKey(data, "right")) {
      if (!this.query) {
        const delta = matchesKey(data, "left") ? -1 : 1;
        this.tab = (this.tab + delta + SETTING_TABS.length) % SETTING_TABS.length;
        this.cursor = 0;
        this.toast = undefined;
      }
    } else if (matchesKey(data, "up")) {
      if (count) this.cursor = (this.cursor - 1 + count) % count;
    } else if (matchesKey(data, "down")) {
      if (count) this.cursor = (this.cursor + 1) % count;
    } else if (matchesKey(data, "enter") || matchesKey(data, "return") || data === " ") {
      this.activate();
    } else if (matchesKey(data, "delete")) {
      this.reset();
    } else if (matchesKey(data, "backspace")) {
      if (this.query) {
        this.query = this.query.slice(0, -1);
        this.cursor = 0;
      }
    } else if (data.length === 1 && data >= "!" && data <= "~") {
      this.query += data;
      this.cursor = 0;
      this.toast = undefined;
    }
    this.repaint();
  }

  private repaint(): void {
    this.options.requestRender?.();
  }

  private activate(): void {
    const row = this.focusedRow();
    if (!row) return;
    const setting = row.setting;
    if (setting.type === "boolean") {
      this.save(setting, !row.value);
      return;
    }
    if (setting.type === "enum") {
      const options = setting.options ?? [];
      const list = new SelectList(
        options.map((option) => ({
          value: option.value,
          label: option.value === row.value ? `${option.value}  ${fg("✓", SUCCESS)}` : option.value,
          description: option.description,
        })),
        Math.max(4, options.length),
        selectTheme(),
        { minPrimaryColumnWidth: 16, maxPrimaryColumnWidth: 28 },
      );
      list.setSelectedIndex(Math.max(0, options.findIndex((option) => option.value === row.value)));
      list.onSelect = (item) => {
        this.submenu = undefined;
        this.save(setting, item.value);
        this.repaint();
      };
      list.onCancel = () => {
        this.submenu = undefined;
        this.repaint();
      };
      this.submenu = { key: setting.key, list };
      return;
    }
    const input = new Input();
    input.setValue(String(row.value));
    input.focused = true;
    input.onSubmit = (value) => {
      this.editor = undefined;
      this.save(setting, value);
      this.repaint();
    };
    input.onEscape = () => {
      this.editor = undefined;
      this.repaint();
    };
    this.editor = { key: setting.key, input };
  }

  private targetScope(setting: SettingDef): { scope: SettingScope; note: string } {
    if (setting.scopes.includes(this.scope)) return { scope: this.scope, note: "" };
    const scope = setting.scopes[0]!;
    return { scope, note: ` (${setting.key} is ${scope}-only)` };
  }

  private save(setting: SettingDef, raw: unknown): void {
    const { scope, note } = this.targetScope(setting);
    try {
      const write = setSetting(setting.key, raw, { cwd: this.options.cwd, scope });
      this.reload();
      this.toast = { tone: "ok", text: `Saved ${setting.key} → ${formatSettingValue(setting, write.value)} · ${scope}${note}` };
      this.options.onChange?.({ key: setting.key, value: write.value, scope });
    } catch (error) {
      this.toast = { tone: "error", text: error instanceof Error ? error.message : String(error) };
    }
  }

  private reset(): void {
    const row = this.focusedRow();
    if (!row) return;
    const { scope } = this.targetScope(row.setting);
    try {
      resetSetting(row.key, { cwd: this.options.cwd, scope });
      this.reload();
      const now = this.rows.find((candidate) => candidate.key === row.key)!;
      this.toast = { tone: "ok", text: `Reset ${row.key} in ${scope} → ${formatSettingValue(row.setting, now.value)} (${now.source})` };
      this.options.onChange?.({ key: row.key, value: now.value, scope });
    } catch (error) {
      this.toast = { tone: "error", text: error instanceof Error ? error.message : String(error) };
    }
  }

  render(width: number): string[] {
    const total = Math.max(14, this.options.rows());
    const inner = Math.max(40, width - 4);
    const out: string[] = [];
    const frame = (content: string) => `${rule("│")} ${pad(truncateToWidth(content, inner, "…"), inner)} ${rule("│")}`;
    const divider = () => rule(`├${"─".repeat(inner + 2)}┤`);

    // Title bar: name on the left, where saves go on the right.
    const title = ` ${bold(accent("Settings"))} `;
    const scopeLabel = (scope: SettingScope) => (scope === this.scope ? `${accent("●")} ${bold(scope)}` : `${muted("○")} ${muted(scope)}`);
    const scopeText = ` ${muted("save to")} ${scopeLabel("project")}  ${scopeLabel("global")} `;
    const fill = Math.max(1, inner + 2 - 1 - visibleWidth(title) - visibleWidth(scopeText) - 1);
    out.push(`${rule("╭─")}${title}${rule("─".repeat(fill))}${scopeText}${rule("─╮")}`);
    out.push(frame(this.renderTabs()));
    out.push(divider());

    const footerHint = this.submenu
      ? "↑↓ choose · ⏎ select · esc back"
      : this.editor
        ? "⏎ save · esc cancel"
        : this.query
          ? "↑↓ move · ⏎/␣ change · ⌫ edit search · esc clear search"
          : "↑↓ move · ⏎/␣ change · ←/→ tabs · ⇥ scope · del reset · type to search · esc close";
    const descLines = this.descriptionLines(inner);
    const bottom: string[] = [divider(), ...descLines.map(frame), frame(this.toastLine()), divider(), frame(muted(footerHint)), rule(`╰${"─".repeat(inner + 2)}╯`)];

    const bodyHeight = Math.max(3, total - out.length - bottom.length);
    const body = this.submenu || this.editor ? this.renderDetail(inner) : this.renderList(inner, bodyHeight);
    for (let index = 0; index < bodyHeight; index += 1) out.push(frame(body[index] ?? ""));
    out.push(...bottom);
    return out.map((line) => truncateToWidth(line, width, ""));
  }

  private renderTabs(): string {
    const parts: string[] = [];
    if (this.query) {
      const groups = this.searchGroups();
      const counts = new Map(groups.map((group) => [group.tab, group.rows.length]));
      const order = [...groups.map((group) => group.tab), ...SETTING_TABS.map((_tab, index) => index).filter((index) => !counts.has(index))];
      const focusedTab = this.focusedRow() ? SETTING_TABS.findIndex((tab) => tab.id === this.focusedRow()!.setting.tab) : -1;
      for (const index of order) {
        const count = counts.get(index);
        const label = count ? `${SETTING_TABS[index]!.label} (${count})` : SETTING_TABS[index]!.label;
        parts.push(index === focusedTab ? tabChip(label) : count ? ` ${label} ` : ` ${muted(label)} `);
      }
      return parts.join("  ");
    }
    SETTING_TABS.forEach((tab, index) => {
      const changed = this.tabRows(index).some((row) => row.changed);
      const label = `${tab.label}${changed ? " •" : ""}`;
      parts.push(index === this.tab ? tabChip(label) : ` ${muted(label)} `);
    });
    return parts.join("  ");
  }

  private renderList(inner: number, height: number): string[] {
    const entries: ListEntry[] = [];
    const lines: string[] = [];
    if (this.query) {
      const groups = this.searchGroups();
      const total = groups.reduce((sum, group) => sum + group.rows.length, 0);
      const search = `${muted("search")} ${bold(this.query)}${selected("▏")}`;
      const count = muted(`${total} ${total === 1 ? "match" : "matches"}`);
      lines.push(`${search}${" ".repeat(Math.max(1, inner - visibleWidth(search) - visibleWidth(count)))}${count}`);
      lines.push("");
      for (const group of groups) {
        entries.push({ kind: "heading", label: SETTING_TABS[group.tab]!.label });
        for (const row of group.rows) entries.push({ kind: "row", row });
      }
      if (!groups.length) lines.push(muted("  No setting matches. ⌫ to edit, esc to clear."));
    } else {
      lines.push("");
      for (const row of this.tabRows(this.tab)) entries.push({ kind: "row", row });
    }
    // Columns are sized over every setting so they do not jump between tabs.
    const all = this.rows;
    const labelWidth = Math.min(28, Math.max(12, ...all.map((row) => visibleWidth(row.setting.label)))) + 2;
    const valueWidth = Math.min(30, Math.max(10, ...all.map((row) => visibleWidth(formatSettingValue(row.setting, row.value))))) + 2;
    let rowIndex = 0;
    for (const entry of entries) {
      if (entry.kind === "heading") {
        lines.push(`  ${colorOn() ? `${UNDERLINE}\x1b[38;2;${MUTED}m${entry.label}${RESET}` : entry.label}`);
        continue;
      }
      const row = entry.row;
      const isFocused = rowIndex === this.cursor;
      rowIndex += 1;
      const cursor = isFocused ? selected("❯") : " ";
      const mark = row.changed ? accent("•") : " ";
      const label = pad(row.setting.label, labelWidth);
      const value = pad(formatSettingValue(row.setting, row.value), valueWidth);
      // Where the value comes from matters only when it is not the default.
      const source = row.changed ? muted(row.source) : "";
      lines.push(` ${cursor} ${mark} ${isFocused ? bold(selected(label)) : label}${isFocused ? selected(value) : muted(value)}${source}`);
    }
    // Keep the focused row on screen when a tab outgrows the body.
    if (lines.length > height) {
      const focusLine = lines.findIndex((line) => line.includes("❯"));
      const start = Math.max(0, Math.min(focusLine - Math.floor(height / 2), lines.length - height));
      return lines.slice(start, start + height);
    }
    return lines;
  }

  private renderDetail(inner: number): string[] {
    const key = this.submenu?.key ?? this.editor?.key;
    const row = this.rows.find((candidate) => candidate.key === key);
    if (!row) return [];
    const lines = ["", `${bold(accent(row.setting.label))}  ${muted(row.setting.key)}`];
    for (const line of wrapTextWithAnsi(row.setting.description, inner - 2)) lines.push(muted(line));
    lines.push("");
    if (this.submenu) {
      lines.push(...this.submenu.list.render(inner));
    } else if (this.editor) {
      const field = this.editor.input.render(Math.max(10, inner - 4))[0] ?? "";
      lines.push(field);
      lines.push("");
      lines.push(muted(row.setting.type === "number" ? "A number." : `Text. Empty means: ${row.setting.emptyLabel ?? "unset"}. Never paste a key here; use an env-var name.`));
    }
    return lines;
  }

  private descriptionLines(inner: number): string[] {
    const row = this.submenu || this.editor ? undefined : this.focusedRow();
    if (!row) return ["", "", ""];
    const setting = row.setting;
    const where = setting.scopes.length === 1 ? `${setting.scopes[0]}-only` : `saves to ${this.scope}`;
    const meta = muted(`${setting.key} · default ${formatSettingValue(setting, setting.default)} · ${where}`);
    const wrapped = wrapTextWithAnsi(setting.description, inner);
    const text = wrapped.length > 2 ? [wrapped[0]!, truncateToWidth(wrapped.slice(1).join(" "), inner, "…")] : wrapped;
    return [...text, meta, "", ""].slice(0, 3);
  }

  private toastLine(): string {
    if (!this.toast) return "";
    return this.toast.tone === "ok" ? fg(`✓ ${this.toast.text}`, SUCCESS) : fg(`✗ ${this.toast.text}`, FAILURE);
  }
}

function tabChip(label: string): string {
  return colorOn() ? `\x1b[48;2;${TAB_BAND}m${BOLD}\x1b[38;2;${ACCENT}m ${label} ${RESET}` : `[${label}]`;
}

function selectTheme(): SelectListTheme {
  return {
    selectedPrefix: selected,
    selectedText: (text) => bold(selected(text)),
    description: muted,
    scrollInfo: muted,
    noMatch: muted,
  };
}

/** `muster config list` text: one row per setting, grouped by tab, `•` on rows that differ from the default. */
export function renderSettingsList(cwd: string): string[] {
  const rows = resolveSettings(cwd);
  const keyWidth = Math.max(...rows.map((row) => row.key.length)) + 2;
  const valueWidth = Math.min(28, Math.max(...rows.map((row) => formatPlain(row).length))) + 2;
  const lines: string[] = [];
  for (const tab of SETTING_TABS) {
    const tabRows = rows.filter((row) => row.setting.tab === tab.id);
    if (!tabRows.length) continue;
    if (lines.length) lines.push("");
    lines.push(bold(accent(tab.label)));
    for (const row of tabRows) {
      const mark = row.changed ? accent("•") : " ";
      lines.push(`${mark} ${pad(row.key, keyWidth)}${pad(formatPlain(row), valueWidth)}${pad(row.source, 9)}${muted(row.setting.description.split(". ")[0]!.replace(/\.$/, ""))}`);
    }
  }
  const paths = settingsPaths(cwd);
  lines.push("", muted(`project ${paths.project}`), muted(`global  ${paths.global}`));
  return lines;
}

function formatPlain(row: ResolvedSetting): string {
  if (row.setting.type === "string" && row.value === "") return '""';
  return String(row.value);
}
