/**
 * Code plugins in a running Muster process: start a host per enabled plugin,
 * apply what it registered (tools into the tool registry, hooks onto the hook
 * bus, chat commands), and undo each of those through a ledger.
 */
import { PLUGIN_HOOK_PREFIX, type HookBus } from "./hooks.js";
import { PLUGIN_HOOK_TIMEOUT_MS, type PluginHost } from "./plugin-host.js";

/**
 * Route a host's accepted hooks onto a bus, under the id `plugin:<id>` (so a
 * block names the plugin). Returns the inverse: remove them again.
 */
export function attachPluginHooks(bus: HookBus, host: PluginHost): () => void {
  const undo = host.registrations
    .filter((entry) => entry.kind === "hook" && entry.event)
    .map((entry) => bus.on(entry.event!, (payload) => host.runHook(entry.event!, payload), {
      id: `${PLUGIN_HOOK_PREFIX}${host.id}`,
      // The host answers within its own 2 s budget (and applies failClosed); this is only a backstop.
      timeoutMs: PLUGIN_HOOK_TIMEOUT_MS + 3_000,
    }));
  return () => { for (const remove of undo) remove(); };
}
