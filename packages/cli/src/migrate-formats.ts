/**
 * Small, read-only parsers for the config formats other agent setups keep on
 * disk (a YAML subset, a TOML subset, relaxed JSON, dotenv, SKILL.md front
 * matter) plus the secret heuristics `muster migrate` uses. Nothing here
 * touches the filesystem.
 */

/** Keys whose values are credentials. */
const SECRET_KEY = /(token|secret|password|passwd|api[-_]?key|apikey|access[-_]?key|private[-_]?key|credential|bearer|authorization|auth)$/i;

export function isSecretKey(key: string): boolean {
  return SECRET_KEY.test(key.replace(/[^A-Za-z0-9_-]/g, ""));
}

const TOKEN_PREFIX = /^(sk-|ghp_|gho_|ghs_|ghu_|github_pat_|xox[abprs]-|xapp-|glpat-|AKIA|AIza|lin_|pk_live_|sk_live_|rk_live_)/;
const TELEGRAM_TOKEN = /^\d{6,12}:[A-Za-z0-9_-]{30,}$/;

/** A value that looks like a credential even when its key does not say so. */
export function looksLikeSecret(value: string): boolean {
  const v = value.trim();
  if (v.length < 16) return false;
  if (TOKEN_PREFIX.test(v) || TELEGRAM_TOKEN.test(v)) return true;
  if (v.length < 32 || /[\s/\\]/.test(v)) return false;
  return /^[A-Za-z0-9+=_.-]+$/.test(v) && /\d/.test(v) && /[A-Za-z]/.test(v) && /[A-Z]/.test(v) && /[a-z]/.test(v);
}

/** `${NAME}`, `$NAME`, or a bare env name equal to the key: already a reference, not a secret. */
export function envReferenceName(key: string, value: string): string | undefined {
  const full = value.match(/^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/) ?? value.match(/^\$([A-Za-z_][A-Za-z0-9_]*)$/);
  if (full) return full[1];
  if (value === key && /^[A-Z_][A-Z0-9_]*$/.test(value)) return value;
  return undefined;
}

export function envNameFor(...parts: string[]): string {
  return parts.join("_").replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "").toUpperCase() || "SECRET";
}

const INLINE_TOKEN = /\b(sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|xapp-[A-Za-z0-9-]{10,}|glpat-[A-Za-z0-9_-]{16,}|AKIA[A-Z0-9]{16}|AIza[A-Za-z0-9_-]{30,}|\d{6,12}:[A-Za-z0-9_-]{30,})\b/g;

/** Replace every known secret value, and anything shaped like a token, with `[redacted]`. */
export function redact(text: string, known: Iterable<string>): string {
  let out = text;
  for (const value of known) {
    if (value && value.length >= 6) out = out.split(value).join("[redacted]");
  }
  return out.replace(INLINE_TOKEN, "[redacted]");
}

// ── relaxed JSON ────────────────────────────────────────────────────────────

/** JSON first; then JSON with comments, trailing commas and bare keys. */
export function parseRelaxedJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    // fall through
  }
  let out = "";
  let inString: string | undefined;
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i]!;
    if (inString) {
      out += ch;
      if (ch === "\\") { out += raw[i + 1] ?? ""; i += 1; continue; }
      if (ch === inString) inString = undefined;
      continue;
    }
    if (ch === '"' || ch === "'") { inString = ch; out += '"'; continue; }
    if (ch === "/" && raw[i + 1] === "/") { while (i < raw.length && raw[i] !== "\n") i += 1; out += "\n"; continue; }
    if (ch === "/" && raw[i + 1] === "*") { i += 2; while (i < raw.length && !(raw[i] === "*" && raw[i + 1] === "/")) i += 1; i += 1; continue; }
    out += ch;
  }
  // Single-quoted strings were opened with '"'; close them the same way.
  out = out.replace(/"([^"\\]*(?:\\.[^"\\]*)*)'/g, '"$1"');
  out = out.replace(/,(\s*[}\]])/g, "$1").replace(/([{,]\s*)([A-Za-z_$][\w$-]*)\s*:/g, '$1"$2":');
  return JSON.parse(out);
}

// ── dotenv ──────────────────────────────────────────────────────────────────

export function parseDotenv(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    let value = match[2]!.trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/, "");
    out[match[1]!] = value;
  }
  return out;
}

export function dotenvLine(name: string, value: string): string {
  return `${name}="${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
}

// ── YAML subset ─────────────────────────────────────────────────────────────

function stripYamlComment(line: string): string {
  let quote: string | undefined;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]!;
    if (quote) { if (ch === quote) quote = undefined; continue; }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "#" && (i === 0 || /\s/.test(line[i - 1]!))) return line.slice(0, i);
  }
  return line;
}

function yamlScalar(raw: string): unknown {
  const value = raw.trim();
  if (value === "") return null;
  if ((value.startsWith('"') && value.endsWith('"'))) {
    try { return JSON.parse(value); } catch { return value.slice(1, -1); }
  }
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1).replace(/''/g, "'");
  if (value.startsWith("[") && value.endsWith("]")) {
    const inner = value.slice(1, -1).trim();
    return inner ? splitFlow(inner).map(yamlScalar) : [];
  }
  if (value.startsWith("{") && value.endsWith("}")) {
    const out: Record<string, unknown> = {};
    for (const part of splitFlow(value.slice(1, -1))) {
      const index = part.indexOf(":");
      if (index > 0) out[String(yamlScalar(part.slice(0, index)))] = yamlScalar(part.slice(index + 1));
    }
    return out;
  }
  if (value === "true" || value === "false") return value === "true";
  if (value === "null" || value === "~") return null;
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  return value;
}

function splitFlow(inner: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | undefined;
  let current = "";
  for (const ch of inner) {
    if (quote) { current += ch; if (ch === quote) quote = undefined; continue; }
    if (ch === '"' || ch === "'") { quote = ch; current += ch; continue; }
    if (ch === "[" || ch === "{") depth += 1;
    if (ch === "]" || ch === "}") depth -= 1;
    if (ch === "," && depth === 0) { parts.push(current.trim()); current = ""; continue; }
    current += ch;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

interface YamlLine { readonly indent: number; readonly text: string }

/** Maps, block lists, flow lists/maps and scalars — enough for agent config files. */
export function parseYaml(raw: string): unknown {
  const lines: YamlLine[] = [];
  for (const rawLine of raw.split(/\r?\n/)) {
    if (/^\s*(---|\.\.\.)\s*$/.test(rawLine)) continue;
    const text = stripYamlComment(rawLine).replace(/\s+$/, "");
    if (!text.trim()) continue;
    lines.push({ indent: text.length - text.trimStart().length, text: text.trim() });
  }
  let index = 0;
  const parseBlock = (indent: number): unknown => {
    const first = lines[index];
    if (!first || first.indent < indent) return null;
    if (first.text.startsWith("- ") || first.text === "-") {
      const list: unknown[] = [];
      while (index < lines.length && lines[index]!.indent === first.indent && (lines[index]!.text.startsWith("- ") || lines[index]!.text === "-")) {
        const line = lines[index]!;
        const rest = line.text.slice(1).trim();
        index += 1;
        if (!rest) { list.push(parseBlock(first.indent + 1)); continue; }
        const keyMatch = rest.match(/^([^:"'{[]+):(\s+.*|)$/);
        if (keyMatch) {
          // "- key: value" opens a map whose other keys sit deeper.
          lines.splice(index, 0, { indent: line.indent + 2, text: rest });
          list.push(parseBlock(line.indent + 2));
        } else {
          list.push(yamlScalar(rest));
        }
      }
      return list;
    }
    const map: Record<string, unknown> = {};
    while (index < lines.length && lines[index]!.indent === first.indent) {
      const line = lines[index]!;
      const match = line.text.match(/^("[^"]*"|'[^']*'|[^:]+?):(?:\s+(.*))?$/);
      index += 1;
      if (!match) continue;
      const key = String(yamlScalar(match[1]!));
      const rest = (match[2] ?? "").trim();
      if (rest === "|" || rest === ">" || rest === "|-" || rest === ">-") {
        const parts: string[] = [];
        while (index < lines.length && lines[index]!.indent > line.indent) { parts.push(lines[index]!.text); index += 1; }
        map[key] = parts.join(rest.startsWith("|") ? "\n" : " ");
      } else if (rest) {
        map[key] = yamlScalar(rest);
      } else if (index < lines.length && (lines[index]!.indent > line.indent || (lines[index]!.indent === line.indent && lines[index]!.text.startsWith("- ")))) {
        map[key] = parseBlock(lines[index]!.indent);
      } else {
        map[key] = null;
      }
    }
    return map;
  };
  return lines.length ? parseBlock(lines[0]!.indent) : {};
}

// ── TOML subset ─────────────────────────────────────────────────────────────

function tomlKeyPath(raw: string): string[] {
  const keys: string[] = [];
  const re = /\s*(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|([A-Za-z0-9_-]+))\s*(?:\.|$)/y;
  let match: RegExpExecArray | null;
  while (re.lastIndex < raw.length && (match = re.exec(raw))) keys.push(match[1] ?? match[2] ?? match[3]!);
  return keys;
}

function tomlValue(raw: string): unknown {
  const value = raw.trim();
  if (value.startsWith('"""')) return value.slice(3, -3);
  if (value.startsWith('"')) { try { return JSON.parse(value); } catch { return value.slice(1, -1); } }
  if (value.startsWith("'")) return value.slice(1, -1);
  if (value.startsWith("[")) {
    const inner = value.slice(1, -1).trim().replace(/,\s*$/, "");
    return inner ? splitFlow(inner).map(tomlValue) : [];
  }
  if (value.startsWith("{")) {
    const out: Record<string, unknown> = {};
    for (const part of splitFlow(value.slice(1, -1))) {
      const index = part.indexOf("=");
      if (index > 0) setPath(out, tomlKeyPath(part.slice(0, index)), tomlValue(part.slice(index + 1)));
    }
    return out;
  }
  if (value === "true" || value === "false") return value === "true";
  if (/^[+-]?\d[\d_]*(\.\d+)?$/.test(value)) return Number(value.replace(/_/g, ""));
  return value;
}

function setPath(root: Record<string, unknown>, path: readonly string[], value: unknown): void {
  let node = root;
  for (const key of path.slice(0, -1)) {
    if (typeof node[key] !== "object" || node[key] === null || Array.isArray(node[key])) node[key] = {};
    node = node[key] as Record<string, unknown>;
  }
  if (path.length) node[path[path.length - 1]!] = value;
}

function stripTomlComment(line: string): string {
  let quote: string | undefined;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]!;
    if (quote) { if (ch === "\\" && quote === '"') { i += 1; continue; } if (ch === quote) quote = undefined; continue; }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "#") return line.slice(0, i);
  }
  return line;
}

function bracketDepth(text: string): number {
  let depth = 0;
  let quote: string | undefined;
  for (const ch of text) {
    if (quote) { if (ch === quote) quote = undefined; continue; }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "[" || ch === "{") depth += 1;
    else if (ch === "]" || ch === "}") depth -= 1;
  }
  return depth;
}

/** Tables, dotted keys, strings, numbers, booleans, arrays and inline tables. */
export function parseToml(raw: string): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  let table: string[] = [];
  const lines = raw.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    let line = stripTomlComment(lines[i]!).trim();
    if (!line) continue;
    const header = line.match(/^\[\[?\s*(.+?)\s*\]\]?$/);
    if (header && !line.includes("=")) {
      table = tomlKeyPath(header[1]!);
      continue;
    }
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    let valueText = line.slice(eq + 1);
    while (bracketDepth(valueText) > 0 && i + 1 < lines.length) {
      i += 1;
      valueText += ` ${stripTomlComment(lines[i]!).trim()}`;
    }
    line = line.slice(0, eq);
    setPath(root, [...table, ...tomlKeyPath(line)], tomlValue(valueText));
  }
  return root;
}

// ── SKILL.md front matter ───────────────────────────────────────────────────

export interface SkillHead {
  readonly name?: string;
  readonly description?: string;
  readonly body: string;
}

export function parseSkillMarkdown(raw: string): SkillHead {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { body: raw };
  let head: Record<string, unknown> = {};
  try {
    const parsed = parseYaml(match[1]!);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) head = parsed as Record<string, unknown>;
  } catch {
    head = {};
  }
  const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.replace(/\s+/g, " ").trim() : undefined);
  return { name: text(head.name), description: text(head.description), body: match[2]!.replace(/^\r?\n/, "") };
}

/** Markdown notes → one entry per `§` block, bullet, or paragraph; headings dropped. */
export function splitMemoryEntries(raw: string): string[] {
  const text = raw.replace(/\r\n/g, "\n");
  if (/^\s*§\s*$/m.test(text)) {
    return text.split(/^\s*§\s*$/m).map((part) => part.trim().replace(/\s+/g, " ")).filter((part) => part.length >= 3);
  }
  const entries: string[] = [];
  let paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length) entries.push(paragraph.join(" ").trim());
    paragraph = [];
  };
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || /^#{1,6}\s/.test(trimmed) || /^(-{3,}|\*{3,})$/.test(trimmed)) { flush(); continue; }
    const bullet = trimmed.match(/^(?:[-*+]|\d+[.)])\s+(.*)$/);
    if (bullet) { flush(); entries.push(bullet[1]!.replace(/^\[[ xX]\]\s*/, "").trim()); continue; }
    paragraph.push(trimmed);
  }
  flush();
  return entries.filter((entry) => entry.length >= 3);
}
