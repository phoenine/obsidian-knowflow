import { App, Modal, Notice, PluginSettingTab, Setting, TextComponent, normalizePath, requestUrl } from "obsidian";
import type KnowFlowPlugin from "./main";
import { withTimeout } from "./services/ai/ai-transport";
import { EmbeddingTransport } from "./services/ai/embedding-transport";
import type { AiModelConfig, AiRuntime, KnowFlowSettings } from "./types";

type ModelConfigKey = "summaryModel" | "knowledgeMapModel" | "pipelineModel" | "chatModel" | "quizModel" | "embeddingModel";
type SettingsTabKey = "basic" | "ai-models" | "pipeline" | "learning" | "data";

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
  defaultArticleCategory: "知识积累",
  archiveFolder: "Archives",
  chatConversationFolder: "copilot-conversations",
  templatePath: "Template/article.md",
  summaryModel: { ...DEFAULT_MODEL_CONFIG },
  knowledgeMapModel: { ...DEFAULT_MODEL_CONFIG },
  pipelineModel: { ...DEFAULT_MODEL_CONFIG },
  chatModel: { ...DEFAULT_MODEL_CONFIG },
  quizModel: { ...DEFAULT_MODEL_CONFIG },
  embeddingModel: {
    runtime: "disabled",
    apiBaseUrl: "",
    apiKey: "",
    model: "text-embedding-3-small"
  },
  embeddingDimensions: 0,
  confirmBeforeWrite: false,
  translateEnglishClippings: false,
  autoOrganize: false,
  autoGenerateSummary: false,
  autoGenerateQuiz: false,
  dailyNewArticleLimit: 1,
  dailyReviewQuestionCap: 10,
  autoCreateCategoryFolders: false
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
    containerEl.createEl("h2", { text: "KnowFlow Settings" });
    this.renderTabs(containerEl);

    if (this.activeTab === "basic") {
      this.displayBasic(containerEl);
    } else if (this.activeTab === "ai-models") {
      this.displayAiModels(containerEl);
    } else if (this.activeTab === "pipeline") {
      this.displayPipeline(containerEl);
    } else if (this.activeTab === "learning") {
      this.displayLearning(containerEl);
    } else {
      this.displayData(containerEl);
    }
    this.renderSupportFooter(containerEl);
  }

  private displayBasic(containerEl: HTMLElement): void {
    const vault = this.createGroup(containerEl, "Vault 路径", `${this.plugin.settings.clippingFolder} -> ${this.plugin.settings.articlesFolder}`, true);

    new Setting(vault)
      .setName("Clipping folder")
      .setDesc("Folder where Obsidian Web Clipper saves new articles.")
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
      .setName("Articles folder")
      .setDesc("Long-term article library root.")
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
      .setName("Default article category")
      .setDesc("Fallback category when classification confidence is low.")
      .addText((text) =>
        text
          .setPlaceholder("知识积累")
          .setValue(this.plugin.settings.defaultArticleCategory)
          .onChange(async (value) => {
            this.plugin.settings.defaultArticleCategory = value.trim() || DEFAULT_SETTINGS.defaultArticleCategory;
            await this.plugin.saveSettings();
          })
      );

    new Setting(vault)
      .setName("Archive folder")
      .setDesc("Where generated quiz notes are stored (one markdown note per article, instead of growing data.json).")
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
      .setName("Chat conversation folder")
      .setDesc("Only conversations explicitly saved from Chat are stored here and shown in history.")
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
      .setName("Article template")
      .setDesc("Frontmatter field reference. Defaults to your current Template/article.md.")
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
      .setName("Auto-create category folders")
      .setDesc("Built-in categories are always auto-created. Off by default; enable to also auto-create folders for custom (non-built-in) categories.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.autoCreateCategoryFolders)
          .onChange(async (value) => {
            this.plugin.settings.autoCreateCategoryFolders = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(vault)
      .setName("Validate paths")
      .setDesc("Check whether the configured folders and article template exist in the current vault.")
      .addButton((button) =>
        button
          .setButtonText("Validate")
          .onClick(async () => {
            await this.validateBasicPaths();
          })
      );
  }

  private displayAiModels(containerEl: HTMLElement): void {
    const ai = this.createGroup(containerEl, "AI 模型", "", true);

    this.createModelEntry(ai, "Summary model", "AI Summary: generates article summary, reading value and classification.", "summaryModel");
    this.createModelEntry(ai, "Knowledge Map model", "Generates Mermaid maps and structured knowledge points for an article.", "knowledgeMapModel");
    this.createModelEntry(ai, "Pipeline model", "Clipping Pipeline: heading detection, code block recognition and language classification.", "pipelineModel");
    this.createModelEntry(ai, "Chat model", "Used by the sidebar chat composer.", "chatModel");
    this.createModelEntry(ai, "Quiz model", "Generates Markdown quiz questions, including targeted knowledge-point questions.", "quizModel");
    this.createModelEntry(ai, "Embedding model", "Builds the local Relevant Notes and Vault Search index.", "embeddingModel");
  }

  private displayPipeline(containerEl: HTMLElement): void {
    const pipeline = this.createGroup(containerEl, "Pipeline", this.plugin.settings.confirmBeforeWrite ? "confirm before write" : "direct apply", true);

    new Setting(pipeline)
      .setName("Confirm before write")
      .setDesc("When enabled, file modifications require manual confirmation.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.confirmBeforeWrite)
          .onChange(async (value) => {
            this.plugin.settings.confirmBeforeWrite = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(pipeline)
      .setName("Translate English clippings")
      .setDesc("When an article is predominantly English, insert a Chinese translation directly below each English prose paragraph. Code, Callouts and structured Markdown are skipped.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.translateEnglishClippings)
          .onChange(async (value) => {
            this.plugin.settings.translateEnglishClippings = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(pipeline)
      .setName("Auto organize")
      .setDesc("Available in 2.0. Automatically process new clippings.")
      .addToggle((toggle) =>
        toggle
          .setValue(false)
          .setDisabled(true)
      );

    new Setting(pipeline)
      .setName("Auto generate summary")
      .setDesc("Available in 2.0. Generate summaries after pipeline processing.")
      .addToggle((toggle) =>
        toggle
          .setValue(false)
          .setDisabled(true)
      );

    new Setting(pipeline)
      .setName("Auto generate quiz")
      .setDesc("Available in 2.0. Generate database-backed quiz after article processing.")
      .addToggle((toggle) =>
        toggle
          .setValue(false)
          .setDisabled(true)
      );
  }

  private displayLearning(containerEl: HTMLElement): void {
    const learning = this.createGroup(containerEl, "Learning", `${this.plugin.settings.dailyNewArticleLimit} new · up to ${this.plugin.settings.dailyReviewQuestionCap} review questions`, true);

    new Setting(learning)
      .setName("Daily new article limit")
      .setDesc("Maximum new articles in Daily Learning.")
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
      .setName("Daily review question cap")
      .setDesc("Maximum questions in the global daily review.")
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
    const semantic = this.createGroup(
      containerEl,
      "Semantic index",
      stats.chunks > 0 ? `${stats.files} files · ${stats.chunks} chunks` : "not built",
      true
    );
    semantic.createEl("p", {
      text: stats.chunks === 0
        ? "Configure an Embedding model, then build the index for Relevant Notes and Chat Vault Search."
        : stats.compatible
          ? `Model: ${stats.model || "unknown"} · Updated: ${stats.updatedAt || "--"}`
          : "The saved index was built with a different embedding configuration. Rebuild it before searching.",
      cls: "setting-item-description"
    });
    new Setting(semantic)
      .setName("Excluded folders")
      .setDesc("Comma-separated folder names or paths under the configured Articles folder. A simple name such as assets matches at any depth.")
      .addText((input) => input
        .setPlaceholder("assets, Attachments")
        .setValue(this.plugin.settings.semanticIndexExcludeFolders.join(", "))
        .onChange(async (value) => {
          this.plugin.settings.semanticIndexExcludeFolders = parseFolderList(value);
          await this.plugin.saveSettings();
        }));
    new Setting(semantic)
      .setName("Embedding dimensions")
      .setDesc("0 keeps the model's full vector. Use 1024 only with a model that supports Matryoshka truncation; KnowFlow re-normalizes truncated vectors.")
      .addText((input) => input
        .setPlaceholder("0")
        .setValue(String(this.plugin.settings.embeddingDimensions))
        .onChange(async (value) => {
          this.plugin.settings.embeddingDimensions = toNonNegativeInt(value, 0);
          await this.plugin.saveSettings();
        }));
    new Setting(semantic)
      .setName(stats.chunks > 0 ? "Rebuild index" : "Build index")
      .setDesc(`Indexes Markdown files under ${this.plugin.settings.articlesFolder}. Cloud runtimes send article chunks to the configured embedding provider.`)
      .addButton((button) => button
        .setButtonText(stats.chunks > 0 ? "Rebuild" : "Build")
        .setCta()
        .onClick(async () => {
          button.setDisabled(true).setButtonText("Building...");
          try {
            const next = await this.plugin.semanticIndex.rebuild();
            new Notice(`KnowFlow indexed ${next.files} files and ${next.chunks} chunks.`);
            this.plugin.refreshView();
            this.display();
          } catch (error) {
            new Notice(`KnowFlow index failed: ${error instanceof Error ? error.message : String(error)}`, 8000);
            button.setDisabled(false).setButtonText(stats.chunks > 0 ? "Rebuild" : "Build");
          }
        }));
    new Setting(semantic)
      .setName("Clear semantic index")
      .setDesc("Deletes the derived local index. Your Markdown notes are not changed.")
      .addButton((button) => button
        .setButtonText("Clear")
        .setWarning()
        .setDisabled(stats.chunks === 0)
        .onClick(async () => {
          await this.plugin.semanticIndex.clear();
          new Notice("KnowFlow semantic index cleared.");
          this.plugin.refreshView();
          this.display();
        }));

    const privacy = this.createGroup(containerEl, "Data & Privacy", "local settings", true);
    privacy.createEl("p", {
      text: "KnowFlow stores settings, learning state and the derived semantic index locally. Chat requests send the current note and selected context; building a cloud embedding index sends article chunks to that configured provider.",
      cls: "setting-item-description"
    });
    const apiKeyWarning = privacy.createEl("p", {
      text: "Warning: AI model API keys are stored in plain text inside this vault's plugin data file (.obsidian/plugins/knowflow/data.json). If this vault is synced via Git or a cloud service, exclude that file or your keys may be exposed.",
      cls: "setting-item-description"
    });
    Object.assign(apiKeyWarning.style, { color: "var(--text-warning)" });

    new Setting(privacy)
      .setName("Export data")
      .setDesc("Data export will include notes, summaries, quizzes, attempts and review tasks.")
      .addButton((button) =>
        button
          .setButtonText("Export")
          .onClick(() => this.exportData())
      );

    new Setting(privacy)
      .setName("Clear AI task history")
      .setDesc("Clear AI task logs after the AI adapter and task queue are implemented.")
      .addButton((button) => button.setButtonText("Clear").setDisabled(true));
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
      ["basic", "Basic"],
      ["ai-models", "AI Models"],
      ["pipeline", "Pipeline"],
      ["learning", "Learning"],
      ["data", "Data"]
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
      text: "If you like KnowFlow and would like to support its continued development, star the project on GitHub."
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
        title: "Star KnowFlow on GitHub"
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
    link.createSpan({ text: "Star on GitHub" });
  }

  private createModelEntry(containerEl: HTMLElement, name: string, desc: string, key: ModelConfigKey): void {
    const config = this.plugin.settings[key];
    const description = document.createDocumentFragment();
    const purpose = description.createSpan({ text: desc });
    const current = description.createSpan({
      text: `Current: ${runtimeLabel(config.runtime)} / ${config.model}`
    });
    Object.assign(purpose.style, { display: "block" });
    Object.assign(current.style, {
      display: "block",
      marginTop: "3px",
      overflowWrap: "anywhere"
    });
    new Setting(containerEl)
      .setName(name)
      .setDesc(description)
      .addButton((button) =>
        button
          .setButtonText("Configure")
          .onClick(() => new ModelConfigModal(this.app, this.plugin, key, name, () => this.display()).open())
      );
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
      new Notice("KnowFlow paths are valid.");
      return;
    }

    new Notice(`KnowFlow missing paths:\n${missing.join("\n")}`, 8000);
  }

  private exportData(): void {
    const payload = {
      exportedAt: new Date().toISOString(),
      settings: this.plugin.settings,
      store: this.plugin.store.exportData()
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `knowflow-export-${new Date().toISOString().slice(0, 10)}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
    new Notice("KnowFlow data exported.");
  }
}

function toPositiveInt(value: string, fallback: number): number {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function toNonNegativeInt(value: string, fallback: number): number {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function parseFolderList(value: string): string[] {
  return Array.from(new Set(value
    .split(/[,\n]/)
    .map((folder) => folder.trim().replace(/^\/+|\/+$/g, ""))
    .filter(Boolean)));
}

function runtimeLabel(runtime: AiRuntime): string {
  if (runtime === "openai-compatible") return "Cloud";
  if (runtime === "ollama") return "Ollama";
  if (runtime === "lm-studio") return "LM Studio";
  return "Disabled";
}

async function testModelConnection(config: AiModelConfig): Promise<void> {
  if (config.runtime === "disabled") {
    throw new Error("AI Runtime is disabled.");
  }

  const baseUrl = config.apiBaseUrl.trim().replace(/\/+$/g, "");
  if (!baseUrl) {
    throw new Error("API Base URL is required.");
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
    `Connection test timed out after 15s. Check that ${baseUrl} is reachable.`
  );

  if (response.status < 200 || response.status >= 300) {
    const message = response.text?.slice(0, 160) || `HTTP ${response.status}`;
    throw new Error(`Connection failed: ${message}`);
  }

  const models = Array.isArray(response.json?.data) ? response.json.data : [];
  if (config.model && models.length > 0) {
    const found = models.some((model: unknown) => {
      if (!model || typeof model !== "object") return false;
      return (model as { id?: unknown }).id === config.model;
    });
    if (!found) {
      new Notice(`Connection succeeded, but model "${config.model}" was not found in /models.`, 8000);
    }
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
      text: "Configure this model independently. Cloud uses an OpenAI-compatible endpoint. Local runtimes support Ollama and LM Studio.",
      cls: "setting-item-description"
    });

    let baseUrlInput: TextComponent | undefined;

    new Setting(contentEl)
      .setName("AI Runtime")
      .setDesc("Cloud uses OpenAI-compatible API. Local supports Ollama and LM Studio.")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("openai-compatible", "Cloud")
          .addOption("ollama", "Ollama")
          .addOption("lm-studio", "LM Studio")
          .addOption("disabled", "Disabled")
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
      .setName("API Base URL")
      .setDesc("Cloud: OpenAI-compatible endpoint. Ollama and LM Studio use local v1-compatible endpoints.")
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
      .setName("API Key")
      .setDesc("Required for Cloud. Usually empty for local Ollama and LM Studio.")
      .addText((text) => {
        text.inputEl.type = "password";
        text
          .setPlaceholder("sk-...")
          .setValue(config.apiKey)
          .onChange(async (value) => {
            config.apiKey = value.trim();
            await this.plugin.saveSettings();
          });
      });

    new Setting(contentEl)
      .setName("Model ID")
      .setDesc("The exact model name exposed by this runtime.")
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
      .setName("Test connection")
      .setDesc(this.key === "embeddingModel"
        ? "Embeds a short test string using the current /embeddings endpoint."
        : "Calls the runtime /models endpoint using the current base URL and API key.")
      .addButton((button) =>
        button
          .setButtonText("Test")
          .onClick(async () => {
            button.setButtonText("Testing...");
            button.setDisabled(true);
            try {
              if (this.key === "embeddingModel") {
                await new EmbeddingTransport().embed(config, ["KnowFlow connection test"]);
              } else {
                await testModelConnection(config);
              }
              new Notice(`${this.title}: connection succeeded.`);
            } catch (error) {
              new Notice(`${this.title}: ${error instanceof Error ? error.message : String(error)}`, 8000);
            } finally {
              button.setButtonText("Test");
              button.setDisabled(false);
            }
          })
      );

    new Setting(contentEl)
      .addButton((button) =>
        button
          .setButtonText("Save")
          .setCta()
          .onClick(() => this.close())
      );
  }

  onClose(): void {
    this.contentEl.empty();
    this.onSave();
  }
}
