import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  SETTINGS,
  ensureDefaultConfig,
  loadConfig,
  parseSettingValue,
  resetSetting,
  resolveSettings,
  setSetting,
  settingsPaths,
} from "../src/index.js";

const REQUIRED = ["chat.access", "chat.liveDiff", "chat.reasoningMode", "chat.speed", "models.default", "memory.policy", "appearance.statusBar", "appearance.header"];

// Spec: MUS-SPEC-14-1A (docs/spec/clauses/14-settings.md#mus-spec-14-1a--the-registry-describes-every-setting-completely)
test("every registered setting is typed, documented and has a valid default", () => {
  const keys = SETTINGS.map((setting) => setting.key);
  for (const key of REQUIRED) assert.ok(keys.includes(key), `${key} is registered`);
  assert.equal(new Set(keys).size, keys.length, "keys are unique");
  for (const setting of SETTINGS) {
    assert.match(setting.key, /^[a-z]+(\.[a-zA-Z]+)+$/, `${setting.key} is dotted`);
    assert.ok(setting.label.trim(), `${setting.key} has a label`);
    assert.ok(["models", "permissions", "appearance", "memory"].includes(setting.tab), `${setting.key} tab`);
    assert.ok(setting.description.trim().length > 10, `${setting.key} has a description`);
    assert.ok(["enum", "boolean", "string", "number"].includes(setting.type), `${setting.key} type`);
    assert.ok(setting.scopes.length > 0 && setting.scopes.includes(setting.scope), `${setting.key} default scope is allowed`);
    if (setting.type === "enum") {
      assert.ok((setting.options?.length ?? 0) >= 2, `${setting.key} has options`);
      for (const option of setting.options ?? []) assert.ok(option.description.trim(), `${setting.key}=${option.value} has a description`);
      assert.ok(setting.options?.some((option) => option.value === setting.default), `${setting.key} default is an option`);
    }
    assert.deepEqual(parseSettingValue(setting, String(setting.default)), setting.default, `${setting.key} default round-trips`);
  }
});

// Spec: MUS-SPEC-14-1B (docs/spec/clauses/14-settings.md#mus-spec-14-1b--values-layer-project-over-global-over-default-and-persist-in-the-config-files)
test("values layer project over global over default, persist in the config files and refuse bad values", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-settings-core-"));
  const home = await mkdtemp(join(tmpdir(), "muster-settings-home-"));
  const previous = process.env.MUSTER_CONFIG_HOME;
  process.env.MUSTER_CONFIG_HOME = home;
  try {
    await ensureDefaultConfig(cwd);
    const paths = settingsPaths(cwd);
    assert.equal(paths.global, join(home, "config.json"));
    const access = () => resolveSettings(cwd).find((row) => row.key === "chat.access")!;
    assert.deepEqual([access().value, access().source], ["auto-edit", "default"]);

    setSetting("chat.access", "ask", { cwd, scope: "global" });
    assert.equal(JSON.parse(readFileSync(paths.global, "utf8")).chat.access, "ask");
    assert.deepEqual([access().value, access().source], ["ask", "global"]);

    setSetting("chat.access", "read-only", { cwd, scope: "project" });
    assert.equal(JSON.parse(readFileSync(paths.project, "utf8")).chat.access, "read-only");
    assert.deepEqual([access().value, access().source], ["read-only", "project"]);

    resetSetting("chat.access", { cwd, scope: "project" });
    assert.equal(JSON.parse(readFileSync(paths.project, "utf8")).chat?.access, undefined);
    assert.deepEqual([access().value, access().source], ["ask", "global"]);

    assert.throws(() => setSetting("chat.access", "yolo", { cwd }), /read-only, ask, auto-edit, full/);
    const secret = ["sk", "proj", "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6"].join("-");
    assert.throws(() => setSetting("models.default", secret, { cwd }), /env-var name/);
    assert.ok(!readFileSync(paths.project, "utf8").includes(secret));
    assert.ok(!existsSync(paths.global) || !readFileSync(paths.global, "utf8").includes(secret));
    assert.throws(() => setSetting("memory.policy", "ask", { cwd, scope: "global" }), /project-only/);

    setSetting("memory.policy", "ask", { cwd });
    assert.equal((await loadConfig(cwd)).memory?.policy, "ask");
  } finally {
    if (previous === undefined) delete process.env.MUSTER_CONFIG_HOME;
    else process.env.MUSTER_CONFIG_HOME = previous;
    await rm(cwd, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});
