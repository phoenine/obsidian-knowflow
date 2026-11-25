import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";

const module = { exports: {} };
const obsidian = {
  Plugin: class {},
  PluginSettingTab: class {},
  Modal: class {},
  ItemView: class {},
  normalizePath: (path) => path
};
runInNewContext(await readFile("main.js", "utf8"), {
  module,
  structuredClone,
  require(id) {
    assert.equal(id, "obsidian");
    return obsidian;
  }
});
const KnowFlowPlugin = module.exports.default;

function createVault(initialData, secrets = new Map()) {
  let data = structuredClone(initialData);
  let saves = 0;
  let failSecretId;
  const app = {
    secretStorage: {
      getSecret: (id) => secrets.get(id) ?? null,
      setSecret(id, secret) {
        if (id === failSecretId) throw new Error("Keychain unavailable");
        secrets.set(id, secret);
      }
    },
    vault: { adapter: { exists: async () => false }, on() {} },
    workspace: { on() {}, getLeavesOfType: () => [] }
  };
  return {
    get data() { return data; },
    get saves() { return saves; },
    failOnSecret(id) { failSecretId = id; },
    createPlugin() {
      return Object.assign(new KnowFlowPlugin(), {
        app,
        manifest: { id: "knowflow" },
        loadData: async () => structuredClone(data),
        saveData: async (value) => { data = structuredClone(value); saves += 1; },
        registerView() {}, addRibbonIcon() {}, addCommand() {}, registerEvent() {}, addSettingTab() {}
      });
    }
  };
}

{
  const secrets = new Map([["knowflow-chat-model", "fixture-current-chat"]]);
  const vault = createVault({
    apiKey: "fixture-stale-global",
    pipelineModel: { apiKey: "fixture-stale-pipeline", model: "old" },
    settings: {
      summaryModel: { apiKey: " fixture-summary ", model: "summary" },
      taskModel: { apiKey: "fixture-task" },
      chatModel: { apiKey: "fixture-stale-chat" },
      embeddingModel: { apiKey: "fixture-embedding" },
      archiveFolder: "My Quizzes"
    },
    store: { articles: {} }
  }, secrets);
  const plugin = vault.createPlugin();
  await plugin.onload();
  assert.deepEqual(Object.fromEntries(secrets), {
    "knowflow-summary-model": "fixture-summary",
    "knowflow-task-model": "fixture-task",
    "knowflow-chat-model": "fixture-current-chat",
    "knowflow-embedding-model": "fixture-embedding"
  });
  assert.equal(vault.saves, 1);
  assert.equal(vault.data.settings.summaryModel.model, "summary");
  assert.equal(vault.data.settings.archiveFolder, "My Quizzes");
  assert.deepEqual(vault.data.store, { articles: {} });

  const reopened = vault.createPlugin();
  await reopened.onload();
  assert.equal(vault.saves, 1, "a clean settings file needs no migration on reload");
  assert.equal(reopened.settings.chatModel.apiKey, "fixture-current-chat");
  assert.equal(reopened.settings.embeddingModel.apiKey, "fixture-embedding");
  await reopened.saveSettings();
  assert.doesNotMatch(JSON.stringify(vault.data), /apiKey|fixture-/);
}

{
  const vault = createVault({ apiKey: "fixture-global", pipelineModel: { apiKey: "fixture-pipeline", model: "task" } });
  vault.failOnSecret("knowflow-task-model");
  await assert.rejects(vault.createPlugin().onload(), /Keychain unavailable/);
  assert.equal(vault.data.apiKey, "fixture-global", "keep plaintext until the keychain writes succeed");
  assert.equal(vault.saves, 0);

  vault.failOnSecret(undefined);
  const plugin = vault.createPlugin();
  await plugin.onload();
  assert.equal(plugin.settings.summaryModel.apiKey, "fixture-global");
  assert.equal(plugin.settings.taskModel.apiKey, "fixture-pipeline");
  assert.equal(plugin.settings.chatModel.apiKey, "fixture-global");
  assert.equal(plugin.settings.embeddingModel.apiKey, "");
  assert.doesNotMatch(JSON.stringify(vault.data), /apiKey|fixture-/);
}

console.log("KnowFlow model credential migration tests passed.");
