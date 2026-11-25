import { App, Modal, Notice, PluginSettingTab, Setting, TextComponent, normalizePath, requestUrl } from "obsidian";
import type KnowFlowPlugin from "./main";
import { withTimeout } from "./services/ai/ai-transport";
import { EmbeddingTransport } from "./services/ai/embedding-transport";
import { MODEL_SECRET_IDS, type ModelConfigKey } from "./services/core/model-credentials";
import type { AiModelConfig, AiRuntime, KnowFlowSettings } from "./types";
import { DEEPSEEK_SEARCH_SECRET_ID, resolveDeepSeekSearchKey } from "./services/search/public-evidence";
import { setAppLanguage, t } from "./i18n";

type SettingsTabKey = "basic" | "ai-models" | "data";

const DEFAULT_MODEL_CONFIG: AiModelConfig = {
  runtime: "openai-compatible",
  apiBaseUrl: "https://api.openai.com/v1",
  apiKey: "",
  model: "gpt-4.1-mini"
};

const RUNTIME_DEFAULT_BASE_URL: Record<AiRuntime, string> = {
  "openai-compatible": "https://api.openai.com/v1",
  "ollama": "http://localhost:11434/v1",
  "lm-studio": "http://localhost:1234/v1",
  "disabled": ""
};

export const DEFAULT_SETTINGS: KnowFlowSettings = {
  clippingFolder: "Clippings",
  articlesFolder: "Articles",
  semanticIndexExcludeFolders: ["assets"],
  archiveFolder: "Archives",
  chatConversationFolder: "copilot-conversations",
  templatePath: "Template/article.md",
  summaryModel: { ...DEFAULT_MODEL_CONFIG },
  taskModel: { ...DEFAULT_MODEL_CONFIG },
  chatModel: { ...DEFAULT_MODEL_CONFIG },
    embeddingModel: {
    runtime: "disabled",
    apiBaseUrl: "",
    apiKey: "",
    model: "text-embedding-3-small"
  },
  dailyNewArticleLimit: 1,
  dailyReviewQuestionCap: 10,
  language: "zh"
};

export class KnowFlowSettingTab extends PluginSettingTab {
  plugin: KnowFlowPlugin;
  private activeTab: SettingsTabKey = "basic";

  constructor(app: App, plugin: KnowFlowPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: t("settingsTitle") });
    this.renderTabs(containerEl);

    if (this.activeTab === "basic") {
      this.displayLanguage(containerEl);
      this.displayBasic(containerEl);
      this.displayLearning(containerEl);
    } else if (this.activeTab === "ai-models") {
      this.displayAiModels(containerEl);
    } else {
      this.displayData(containerEl);
    }
    this.renderSupportFooter(containerEl);
  }

  private displayLanguage(containerEl: HTMLElement): void {
    const language = this.createGroup(containerEl, t("language"), "", true);
    new Setting(language)
      .setName(t("interfaceLanguage"))
      .setDesc(t("interfaceLanguageDesc"))
      .addDropdown((dropdown) =>
        dropdown
          .addOption("zh", "中文")
          .addOption("en", "English")
          .setValue(this.plugin.settings.language)
          .onChange(async (value) => {
            this.plugin.settings.language = value === "en" ? "en" : "zh";
            setAppLanguage(this.plugin.settings.language);
            await this.plugin.saveSettings();
            this.display();
          })
      );
  }

  private displayBasic(containerEl: HTMLElement): void {
    const vault = this.createGroup(containerEl, t("vaultPaths"), "");

    new Setting(vault)
      .setName(t("clippingFolder"))
      .setDesc(t("clippingFolderDesc"))
      .addText((text) =>
        text
          .setPlaceholder("Clippings")
          .setValue(this.plugin.settings.clippingFolder)
          .onChange(async (value) => {
            this.plugin.settings.clippingFolder = value.trim() || DEFAULT_SETTINGS.clippingFolder;
            await this.plugin.saveSettings();
          })
      );

    new Setting(vault)
      .setName(t("articlesFolder"))
      .setDesc(t("articlesFolderDesc"))
      .addText((text) =>
        text
          .setPlaceholder("Articles")
          .setValue(this.plugin.settings.articlesFolder)
          .onChange(async (value) => {
            this.plugin.settings.articlesFolder = value.trim() || DEFAULT_SETTINGS.articlesFolder;
            await this.plugin.saveSettings();
          })
      );

    new Setting(vault)
      .setName(t("archiveFolder"))
      .setDesc(t("archiveFolderDesc"))
      .addText((text) =>
        text
          .setPlaceholder("Archives")
          .setValue(this.plugin.settings.archiveFolder)
          .onChange(async (value) => {
            this.plugin.settings.archiveFolder = value.trim() || DEFAULT_SETTINGS.archiveFolder;
            await this.plugin.saveSettings();
          })
      );

    new Setting(vault)
      .setName(t("chatFolder"))
      .setDesc(t("chatFolderDesc"))
      .addText((text) =>
        text
          .setPlaceholder("copilot-conversations")
          .setValue(this.plugin.settings.chatConversationFolder)
          .onChange(async (value) => {
            this.plugin.settings.chatConversationFolder = value.trim() || DEFAULT_SETTINGS.chatConversationFolder;
            await this.plugin.saveSettings();
          })
      );

    new Setting(vault)
      .setName(t("articleTemplate"))
      .setDesc(t("articleTemplateDesc"))
      .addText((text) =>
        text
          .setPlaceholder("Template/article.md")
          .setValue(this.plugin.settings.templatePath)
          .onChange(async (value) => {
            this.plugin.settings.templatePath = value.trim() || DEFAULT_SETTINGS.templatePath;
            await this.plugin.saveSettings();
          })
      );

    new Setting(vault)
      .setName(t("validatePaths"))
      .setDesc(t("validatePathsDesc"))
      .addButton((button) =>
        button
          .setButtonText(t("validate"))
          .onClick(async () => {
            await this.validateBasicPaths();
          })
      );
  }

  private displayAiModels(containerEl: HTMLElement): void {
    const ai = this.createGroup(containerEl, t("aiModels"), "", true);
    this.createModelEntry(ai, t("summaryModel"), t("summaryModelDesc"), "summaryModel");
    this.createModelEntry(ai, t("taskModel"), t("taskModelDesc"), "taskModel");
    this.createModelEntry(ai, t("chatModel"), t("chatModelDesc"), "chatModel");
    this.createModelEntry(ai, t("embeddingModel"), t("embeddingModelDesc"), "embeddingModel");

    const secrets = this.app.secretStorage;
    const separateKey = secrets?.getSecret(DEEPSEEK_SEARCH_SECRET_ID)?.trim();
    const status = separateKey ? t("deepseekDedicated")
      : resolveDeepSeekSearchKey(this.plugin.settings, secrets) ? t("deepseekFallback") : t("deepseekMissing");
    this.createConfiguredEntry(ai, t("deepseekSearch"), t("deepseekSearchDesc"), status,
      () => new DeepSeekSearchConfigModal(this.app, () => this.display()).open()
      );
  }

  private displayLearning(containerEl: HTMLElement): void {
    const learning = this.createGroup(containerEl, t("learning"), "");

    new Setting(learning)
      .setName(t("dailyNewLimit"))
      .setDesc(t("dailyNewLimitDesc"))
      .addText((text) =>
        text
          .setPlaceholder("1")
          .setValue(String(this.plugin.settings.dailyNewArticleLimit))
          .onChange(async (value) => {
            this.plugin.settings.dailyNewArticleLimit = toPositiveInt(value, DEFAULT_SETTINGS.dailyNewArticleLimit);
            await this.plugin.saveSettings();
          })
      );

    new Setting(learning)
      .setName(t("dailyReviewCap"))
      .setDesc(t("dailyReviewCapDesc"))
      .addText((text) =>
        text
          .setPlaceholder("10")
          .setValue(String(this.plugin.settings.dailyReviewQuestionCap))
          .onChange(async (value) => {
            this.plugin.settings.dailyReviewQuestionCap = toPositiveInt(value, DEFAULT_SETTINGS.dailyReviewQuestionCap);
            await this.plugin.saveSettings();
          })
      );
  }

  private displayData(containerEl: HTMLElement): void {
    const stats = this.plugin.semanticIndex.getStats();
    const semantic = this.createGroup(containerEl, t("semanticIndex"), "", true);
    if (stats.chunks === 0 || !stats.compatible) {
      semantic.createEl("p", {
        text: stats.chunks === 0 ? t("indexEmptyHint") : t("indexRebuildHint"),
        cls: "setting-item-description"
      });
    }
    if (stats.degraded) {
      semantic.createEl("p", {
        text: t("indexDegraded", { shards: stats.unhealthyShards, files: stats.unavailableFiles }),
        cls: "setting-item-description"
      });
    }
    new Setting(semantic)
      .setName(t("excludedFolders"))
      .setDesc(t("excludedFoldersDesc"))
      .addText((input) => input
        .setPlaceholder("assets, Attachments")
        .setValue(this.plugin.settings.semanticIndexExcludeFolders.join(", "))
        .onChange(async (value) => {
          this.plugin.settings.semanticIndexExcludeFolders = parseFolderList(value);
          await this.plugin.saveSettings();
        }));
    new Setting(semantic)
      .setName(stats.chunks > 0 ? t("rebuildIndex") : t("buildIndex"))
      .setDesc(t("indexDesc", { folder: this.plugin.settings.articlesFolder }))
      .addButton((button) => button
        .setButtonText(stats.chunks > 0 ? t("rebuild") : t("build"))
        .setCta()
        .onClick(async () => {
          button.setDisabled(true).setButtonText(t("building"));
          try {
            const next = await this.plugin.semanticIndex.rebuild();
            new Notice(t("indexedNotice", { count: next.files }));
            this.plugin.refreshView();
            this.display();
          } catch (error) {
            new Notice(t("indexFailed", { message: error instanceof Error ? error.message : String(error) }), 8000);
            button.setDisabled(false).setButtonText(stats.chunks > 0 ? t("rebuild") : t("build"));
          }
        }));
    new Setting(semantic)
      .setName(t("clearIndex"))
      .setDesc(t("clearIndexDesc"))
      .addButton((button) => button
        .setButtonText(t("clear"))
        .setWarning()
        .setDisabled(stats.chunks === 0)
        .onClick(async () => {
          await this.plugin.semanticIndex.clear();
          new Notice(t("indexCleared"));
          this.plugin.refreshView();
          this.display();
        }));
  }

  private renderTabs(containerEl: HTMLElement): void {
    const tabs = containerEl.createDiv();
    Object.assign(tabs.style, {
      borderBottom: "1px solid var(--background-modifier-border)",
      display: "flex",
      flexWrap: "wrap",
      gap: "4px",
      marginBottom: "12px"
    });

    const items: Array<[SettingsTabKey, string]> = [
      ["basic", t("tabBasic")],
      ["ai-models", t("tabAi")],
      ["data", t("tabData")]
    ];

    for (const [key, label] of items) {
      const button = tabs.createEl("button", { text: label });
      const active = this.activeTab === key;
      Object.assign(button.style, {
        background: active ? "var(--interactive-accent)" : "var(--background-primary)",
        border: "1px solid var(--background-modifier-border)",
        borderBottom: active ? "1px solid var(--interactive-accent)" : "1px solid var(--background-modifier-border)",
        borderRadius: "6px 6px 0 0",
        color: active ? "var(--text-on-accent)" : "var(--text-normal)",
        cursor: "pointer",
        fontWeight: active ? "700" : "500",
        padding: "6px 12px"
      });
      button.addEventListener("click", () => {
        this.activeTab = key;
        this.display();
      });
    }
  }

  private createGroup(containerEl: HTMLElement, title: string, subtitle: string, open = false): HTMLElement {
    const details = containerEl.createEl("details");
    details.open = open;
    details.addEventListener("toggle", () => {
      if (!details.open) return;
      for (const sibling of Array.from(containerEl.children)) {
        if (sibling instanceof HTMLDetailsElement && sibling !== details) sibling.open = false;
      }
    });
    Object.assign(details.style, {
      border: "1px solid var(--background-modifier-border)",
      borderRadius: "8px",
      margin: "12px 0",
      padding: "0"
    });

    const summary = details.createEl("summary");
    Object.assign(summary.style, {
      alignItems: "center",
      cursor: "pointer",
      display: "flex",
      gap: "8px",
      justifyContent: "space-between",
      padding: "12px 14px"
    });
    summary.createEl("strong", { text: title });
    if (subtitle) {
      const desc = summary.createSpan({ text: subtitle });
      Object.assign(desc.style, {
        color: "var(--text-muted)",
        fontSize: "12px"
      });
    }

    const body = details.createDiv();
    Object.assign(body.style, {
      borderTop: "1px solid var(--background-modifier-border)",
      padding: "0 14px 8px"
    });
    return body;
  }

  private renderSupportFooter(containerEl: HTMLElement): void {
    const footer = containerEl.createDiv();
    Object.assign(footer.style, {
      alignItems: "center",
      borderTop: "1px solid var(--interactive-accent)",
      display: "flex",
      flexDirection: "column",
      marginTop: "28px",
      padding: "22px 12px 8px",
      textAlign: "center"
    });
    const message = footer.createEl("p", {
      text: t("supportMessage")
    });
    Object.assign(message.style, {
      lineHeight: "1.45",
      margin: "0 0 14px",
      maxWidth: "430px"
    });
    const link = footer.createEl("a", {
      attr: {
        href: "https://github.com/phoenine/KnowFlow",
        rel: "noopener noreferrer",
        target: "_blank",
        title: t("starTitle")
      }
    });
    Object.assign(link.style, {
      alignItems: "center",
      backgroundColor: "var(--background-secondary)",
      borderRadius: "9px",
      color: "var(--text-normal)",
      display: "inline-flex",
      fontSize: "13px",
      fontWeight: "500",
      gap: "8px",
      justifyContent: "center",
      minWidth: "156px",
      padding: "9px 14px",
      textDecoration: "none"
    });
    const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    icon.setAttribute("aria-hidden", "true");
    icon.setAttribute("focusable", "false");
    icon.setAttribute("viewBox", "0 0 24 24");
    icon.setAttribute("width", "16");
    icon.setAttribute("height", "16");
    icon.setAttribute("fill", "currentColor");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", "M10.226 17.284c-2.965-.36-5.054-2.493-5.054-5.256 0-1.123.404-2.336 1.078-3.144-.292-.741-.247-2.314.09-2.965.898-.112 2.111.36 2.83 1.01.853-.269 1.752-.404 2.853-.404 1.1 0 1.999.135 2.807.382.696-.629 1.932-1.1 2.83-.988.315.606.36 2.179.067 2.942.72.854 1.101 2 1.101 3.167 0 2.763-2.089 4.852-5.098 5.234.763.494 1.28 1.572 1.28 2.807v2.336c0 .674.561 1.056 1.235.786 4.066-1.55 7.255-5.615 7.255-10.646C23.5 6.188 18.334 1 11.978 1 5.62 1 .5 6.188.5 12.545c0 4.986 3.167 9.12 7.435 10.669.606.225 1.19-.18 1.19-.786V20.63a2.9 2.9 0 0 1-1.078.224c-1.483 0-2.359-.808-2.987-2.313-.247-.607-.517-.966-1.034-1.033-.27-.023-.359-.135-.359-.27 0-.27.45-.471.898-.471.652 0 1.213.404 1.797 1.235.45.651.921.943 1.483.943.561 0 .92-.202 1.437-.719.382-.381.674-.718.944-.943");
    icon.appendChild(path);
    link.appendChild(icon);
    link.createSpan({ text: t("starGithub") });
  }

  private createModelEntry(containerEl: HTMLElement, name: string, desc: string, key: ModelConfigKey): void {
    const config = this.plugin.settings[key];
    this.createConfiguredEntry(containerEl, name, desc, `${runtimeLabel(config.runtime)} / ${config.model}`,
      () => new ModelConfigModal(this.app, this.plugin, key, name, () => this.display()).open()
    );
  }

  private createConfiguredEntry(
    containerEl: HTMLElement,
    name: string,
    desc: string,
    status: string,
    configure: () => void
  ): void {
    const description = document.createDocumentFragment();
    const purpose = description.createSpan({ text: desc });
    const current = description.createSpan({ text: `Current: ${status}` });
    Object.assign(purpose.style, { display: "block" });
    Object.assign(current.style, {
      display: "block",
      marginTop: "3px",
      overflowWrap: "anywhere"
    });
    new Setting(containerEl)
      .setName(name)
      .setDesc(description)
      .addButton((button) => button.setButtonText(t("configure")).onClick(configure));
  }

  private async validateBasicPaths(): Promise<void> {
    const checks: Array<[string, string]> = [
      ["Clipping folder", this.plugin.settings.clippingFolder],
      ["Articles folder", this.plugin.settings.articlesFolder],
      ["Archive folder", this.plugin.settings.archiveFolder],
      ["Article template", this.plugin.settings.templatePath]
    ];
    const missing: string[] = [];

    for (const [label, path] of checks) {
      const exists = await this.app.vault.adapter.exists(normalizePath(path));
      if (!exists) missing.push(`${label}: ${path}`);
    }

    if (missing.length === 0) {
      new Notice(t("pathsValid"));
      return;
    }

    new Notice(t("pathsMissing", { paths: missing.join("\n") }), 8000);
  }
}

function toPositiveInt(value: string, fallback: number): number {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseFolderList(value: string): string[] {
  return Array.from(new Set(value
    .split(/[,\n]/)
    .map((folder) => folder.trim().replace(/^\/+|\/+$/g, ""))
    .filter(Boolean)));
}

function runtimeLabel(runtime: AiRuntime): string {
  if (runtime === "openai-compatible") return t("runtimeCloud");
  if (runtime === "ollama") return "Ollama";
  if (runtime === "lm-studio") return "LM Studio";
  return t("runtimeDisabled");
}

async function testModelConnection(config: AiModelConfig): Promise<void> {
  if (config.runtime === "disabled") {
    throw new Error(t("runtimeDisabledError"));
  }

  const baseUrl = config.apiBaseUrl.trim().replace(/\/+$/g, "");
  if (!baseUrl) {
    throw new Error(t("apiBaseRequired"));
  }

  const headers: Record<string, string> = {
    Accept: "application/json"
  };
  if (config.apiKey.trim()) {
    headers.Authorization = `Bearer ${config.apiKey.trim()}`;
  }

  const response = await withTimeout(
    requestUrl({
      url: `${baseUrl}/models`,
      method: "GET",
      headers,
      throw: false
    }),
    15000,
    t("connectionTimeout", { url: baseUrl })
  );

  if (response.status < 200 || response.status >= 300) {
    const message = response.text?.slice(0, 160) || `HTTP ${response.status}`;
    throw new Error(t("connectionFailed", { message }));
  }

  const models = Array.isArray(response.json?.data) ? response.json.data : [];
  if (config.model && models.length > 0) {
    const found = models.some((model: unknown) => {
      if (!model || typeof model !== "object") return false;
      return (model as { id?: unknown }).id === config.model;
    });
    if (!found) {
      new Notice(t("modelMissing", { model: config.model }), 8000);
    }
  }
}

class DeepSeekSearchConfigModal extends Modal {
  constructor(app: App, private onSave: () => void) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    const secrets = this.app.secretStorage;
    const originalKey = secrets?.getSecret(DEEPSEEK_SEARCH_SECRET_ID) ?? "";
    let apiKey = originalKey;
    contentEl.empty();
    contentEl.createEl("h2", { text: t("deepseekSearch") });
    contentEl.createEl("p", {
      text: t("deepseekIntro"),
      cls: "setting-item-description"
    });
    new Setting(contentEl)
      .setName(t("apiKey"))
      .setDesc(secrets
        ? t("deepseekKeyDesc")
        : t("deepseekKeyUnavailable"))
      .addText((input) => {
        input.inputEl.type = "password";
        input.setPlaceholder("sk-...")
          .setValue(apiKey)
          .setDisabled(!secrets)
          .onChange((value) => { apiKey = value.trim(); });
      });
    new Setting(contentEl)
      .addButton((button) => button.setButtonText(t("save")).setCta().onClick(() => {
        if (apiKey !== originalKey) secrets?.setSecret(DEEPSEEK_SEARCH_SECRET_ID, apiKey);
        this.close();
        this.onSave();
      }));
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

class ModelConfigModal extends Modal {
  constructor(
    app: App,
    private plugin: KnowFlowPlugin,
    private key: ModelConfigKey,
    private title: string,
    private onSave: () => void
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    const config = this.plugin.settings[this.key];
    contentEl.empty();
    contentEl.createEl("h2", { text: this.title });
    contentEl.createEl("p", {
      text: t("modelIntro"),
      cls: "setting-item-description"
    });

    let baseUrlInput: TextComponent | undefined;

    new Setting(contentEl)
      .setName(t("aiRuntime"))
      .setDesc(t("aiRuntimeDesc"))
      .addDropdown((dropdown) =>
        dropdown
          .addOption("openai-compatible", t("runtimeCloud"))
          .addOption("ollama", "Ollama")
          .addOption("lm-studio", "LM Studio")
          .addOption("disabled", t("runtimeDisabled"))
          .setValue(config.runtime)
          .onChange(async (value) => {
            const previousBaseUrl = config.apiBaseUrl;
            config.runtime = value as AiRuntime;
            if (!previousBaseUrl || Object.values(RUNTIME_DEFAULT_BASE_URL).includes(previousBaseUrl)) {
              config.apiBaseUrl = RUNTIME_DEFAULT_BASE_URL[config.runtime];
              // The base URL field below was already rendered with the old
              // value; without this it would keep showing a stale URL even
              // though the new default was already saved.
              baseUrlInput?.setValue(config.apiBaseUrl);
            }
            await this.plugin.saveSettings();
          })
      );

    new Setting(contentEl)
      .setName(t("apiBaseUrl"))
      .setDesc(t("apiBaseUrlDesc"))
      .addText((text) => {
        baseUrlInput = text;
        text
          .setPlaceholder(RUNTIME_DEFAULT_BASE_URL[config.runtime])
          .setValue(config.apiBaseUrl)
          .onChange(async (value) => {
            config.apiBaseUrl = value.trim();
            await this.plugin.saveSettings();
          });
      });

    new Setting(contentEl)
      .setName(t("apiKey"))
      .setDesc(t("apiKeyDesc"))
      .addText((text) => {
        text.inputEl.type = "password";
        text
          .setPlaceholder("sk-...")
          .setValue(config.apiKey)
          .onChange(async (value) => {
            const apiKey = value.trim();
            this.app.secretStorage.setSecret(MODEL_SECRET_IDS[this.key], apiKey);
            config.apiKey = apiKey;
            await this.plugin.saveSettings();
          });
      });

    new Setting(contentEl)
      .setName(t("modelId"))
      .setDesc(t("modelIdDesc"))
      .addText((text) =>
        text
          .setPlaceholder(DEFAULT_SETTINGS[this.key].model)
          .setValue(config.model)
          .onChange(async (value) => {
            config.model = value.trim() || DEFAULT_SETTINGS[this.key].model;
            await this.plugin.saveSettings();
          })
      );

    new Setting(contentEl)
      .setName(t("testConnection"))
      .setDesc(this.key === "embeddingModel"
        ? t("testEmbeddingDesc")
        : t("testModelsDesc"))
      .addButton((button) =>
        button
          .setButtonText(t("test"))
          .onClick(async () => {
            button.setButtonText(t("testing"));
            button.setDisabled(true);
            try {
              if (this.key === "embeddingModel") {
                await new EmbeddingTransport().embed(config, ["KnowFlow connection test"]);
              } else {
                await testModelConnection(config);
              }
              new Notice(t("connectionSucceeded", { title: this.title }));
            } catch (error) {
              new Notice(t("connectionFailedNotice", { title: this.title, message: error instanceof Error ? error.message : String(error) }), 8000);
            } finally {
              button.setButtonText(t("test"));
              button.setDisabled(false);
            }
          })
      );

    new Setting(contentEl)
      .addButton((button) =>
        button
          .setButtonText(t("save"))
          .setCta()
          .onClick(() => this.close())
      );
  }

  onClose(): void {
    this.contentEl.empty();
    this.onSave();
  }
}
