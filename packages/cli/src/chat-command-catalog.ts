import type { InheritedPlugin } from "@musterhq/core";

export interface ChatCommandDef {
  readonly name: string;
  readonly usage: string;
  readonly description: string;
  readonly aliases?: readonly string[];
  readonly plugin?: InheritedPlugin;
  /** Bare submission opens choices instead of printing syntax. */
  readonly bareBehavior?: "picker";
  /** Argument prefixes that are bare at the name/id boundary. Empty means the command itself. */
  readonly pickerInvocations?: readonly string[];
}

/** User outcomes only: this text is shown in every slash-command surface. */
export const CHAT_COMMANDS: readonly ChatCommandDef[] = [
  { name: "help", usage: "/help", description: "see chat commands and shortcuts", aliases: ["?"] },
  { name: "commands", usage: "/commands", description: "see every chat command", aliases: ["cmds"] },
  { name: "shortcuts", usage: "/shortcuts", description: "see keyboard shortcuts", aliases: ["keys"] },
  { name: "status", usage: "/status", description: "see this conversation and its usage" },
  { name: "providers", usage: "/providers", description: "see available AI providers and models", aliases: ["provider-list"] },
  { name: "provider", usage: "/provider <id> [model]", description: "switch AI provider for this conversation", aliases: ["use-provider"], bareBehavior: "picker", pickerInvocations: [""] },
  { name: "cloud", usage: "/cloud [preset]", description: "choose or add a cloud AI provider" },
  { name: "model", usage: "/model [name]", description: "choose the model, effort, and speed" },
  { name: "runtime", usage: "/runtime [id]", description: "choose which local AI app runs turns" },
  { name: "speed", usage: "/speed [session|fast]", description: "choose full context or faster replies" },
  { name: "access", usage: "/access [read-only|ask|auto-edit|full]", description: "how much the agent may do without asking", aliases: ["permissions", "approvals"] },
  { name: "live-diff", usage: "/live-diff [on|off]", description: "show file changes while they happen", aliases: ["livediff", "diffs"] },
  { name: "diff", usage: "/diff", description: "open or close this turn's file changes" },
  { name: "tasks", usage: "/tasks [board | \"<goal>\" | why <taskId> | assign <taskId> <cardId>]", description: "open your task board or plan work across agents", bareBehavior: "picker", pickerInvocations: ["why", "assign"] },
  { name: "reasoning", usage: "/reasoning [auto|low|medium|high|compact|full]", description: "choose thinking effort or summary detail", aliases: ["think"] },
  { name: "senses", usage: "/senses", description: "see available screen and browser access" },
  { name: "sessions", usage: "/sessions [limit]", description: "see recent conversations", aliases: ["ls"] },
  { name: "resume", usage: "/resume <name|id>", description: "continue an earlier conversation", aliases: ["use"], bareBehavior: "picker", pickerInvocations: [""] },
  { name: "codex", usage: "/codex sessions [limit] | /codex resume <id-prefix>", description: "continue a conversation from Codex", bareBehavior: "picker", pickerInvocations: [""] },
  { name: "name", usage: "/name <name>", description: "rename this conversation", bareBehavior: "picker", pickerInvocations: [""] },
  { name: "history", usage: "/history [limit]", description: "see earlier messages here" },
  { name: "memory", usage: "/memory <query>", description: "find something saved from earlier work" },
  { name: "scope", usage: "/scope <kind:id...|add kind:id|clear>", description: "choose which saved context can be recalled" },
  { name: "scopes", usage: "/scopes", description: "see where saved context comes from" },
  { name: "tools", usage: "/tools [all|toolset]", description: "use an available tool, plugin, MCP, or skill" },
  { name: "whoami", usage: "/whoami", description: "see the identity used for this conversation" },
  { name: "reports", usage: "/reports", description: "see ways to filter, export, and share reports" },
  { name: "capabilities", usage: "/capabilities [query]", description: "find a tool, plugin, MCP, or skill", aliases: ["capability", "caps"] },
  { name: "skills", usage: "/skills [id]", description: "see or activate a skill", aliases: ["skill"] },
  { name: "plugins", usage: "/plugins [id|reuse provider]", description: "see, activate, or reuse a plugin", aliases: ["plugin"] },
  { name: "mcp", usage: "/mcp [id]", description: "connect or check an MCP server" },
  { name: "integrations", usage: "/integrations [id]", description: "connect a channel, plugin, or MCP", aliases: ["integration"] },
  { name: "agents", usage: "/agents", description: "see agents you can send work to" },
  { name: "tokens", usage: "/tokens [limit]", description: "see token use and cost", aliases: ["usage", "ledger"] },
  { name: "limits", usage: "/limits", description: "see request, token, and tool limits" },
  { name: "security", usage: "/security", description: "see permissions, approvals, and audit history" },
  { name: "evals", usage: "/evals", description: "see quality and safety checks" },
  { name: "index", usage: "/index", description: "see what Frappe data is ready to search" },
  { name: "settings", usage: "/settings", description: "choose answer style and assistant behavior" },
  { name: "goal", usage: "/goal [status]", description: "see progress on the active goal" },
  { name: "receipt", usage: "/receipt [limit]", description: "see what was recalled or saved and why" },
  { name: "new", usage: "/new [name]", description: "start a fresh conversation" },
  { name: "reset", usage: "/reset", description: "clear this conversation's provider thread" },
  { name: "header", usage: "/header [compact|full]", description: "choose a compact or detailed header" },
  { name: "clear", usage: "/clear", description: "clear the terminal", aliases: ["cls"] },
  { name: "exit", usage: "/exit", description: "leave chat", aliases: ["quit", "q"] },
] as const;

export function pickerClassInvocations(commands: readonly ChatCommandDef[] = CHAT_COMMANDS): readonly string[] {
  return commands.flatMap((command) => (command.pickerInvocations ?? []).map((args) => `/${command.name}${args ? ` ${args}` : ""}`));
}

export function pluginCommandName(plugin: InheritedPlugin): string | undefined {
  const name = plugin.id.split("@")[0]?.trim().toLowerCase();
  return name && /^[a-z0-9][a-z0-9-]*$/.test(name) ? name : undefined;
}

export function dynamicPluginCommands(plugins: readonly InheritedPlugin[]): ChatCommandDef[] {
  const staticNames = new Set(CHAT_COMMANDS.flatMap((command) => [command.name, ...(command.aliases ?? [])]));
  const seen = new Set<string>();
  return plugins.flatMap((plugin) => {
    const name = plugin.status === "active" ? pluginCommandName(plugin) : undefined;
    if (!name || staticNames.has(name) || seen.has(name)) return [];
    seen.add(name);
    return [{
      name,
      usage: `/${name} [request]`,
      description: plugin.shortDescription ?? `use the ${plugin.displayName ?? name} plugin`,
      plugin,
    }];
  });
}

export function directPluginCommand(
  name: string,
  args: string,
  commands: readonly ChatCommandDef[],
): { readonly kind: "prompt" | "insert"; readonly text: string } | undefined {
  const command = commands.find((entry) => entry.plugin && entry.name === name);
  if (!command?.plugin) return undefined;
  const displayName = command.plugin.displayName ?? command.name;
  const ask = args.trim();
  return ask
    ? { kind: "prompt", text: `Use the ${displayName} plugin. ${ask}` }
    : { kind: "insert", text: `use the ${displayName} plugin to ` };
}
