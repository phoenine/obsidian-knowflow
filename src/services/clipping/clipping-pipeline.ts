import { Notice, TFile, normalizePath, parseYaml } from "obsidian";
import type { App } from "obsidian";
import type { KnowFlowSettings } from "../../types";
import type { AiService } from "../ai/ai-service";
import { protectedRanges } from "./protected-markdown";
import { removeCodeWatermarkLines } from "./cleanup-rules";
import {
  applyFormattingEdits,
  batchFormattingCandidates,
  collectClippedCodeCandidates,
  collectCodeCandidates,
  collectHeadingCandidates,
  normalizeBodyHeadingLevels,
  normalizeOrphanBoldTriplet,
  trimCodeFenceBody,
  type FormattingCandidate,
  type FormattingDecision
} from "./formatting-candidates";
import { applyArticleFrontmatter, fillEmptyNoteProperties, splitFrontmatter, updateFrontmatterCategory } from "./frontmatter-rules";
import { NoteOperationCoordinator } from "../core/note-operation-coordinator";
import { SkillStore } from "../core/skill-store";
import { SkillRunner } from "../core/skill-runner";
import { formatPromptBlocks, promptFenceStarts } from "../../../skills/clipping-update/scripts/prompt-blocks";
import { restoreDetachedLists } from "../../../skills/clipping-update/scripts/detached-lists";
import { repairTableDividers } from "../../../skills/clipping-update/scripts/reading-structure";
import { prettyJsonBlock, removeClipperFenceSpacing } from "../../../skills/clipping-update/scripts/clipped-code";
import { planImageRepairs, saveImageRepairs } from "../../../skills/clipping-update/scripts/repair-images";
import { inspectClippingOutput } from "./repair-validator";
import { KnowledgeStore } from "../core/store";
import {
  applyTranslationDecisions,
  planEnglishTranslation
} from "./translation-candidates";

export const CLIPPING_PIPELINE_STEPS = ["文章样式梳理", "格式化代码块", "整理图片", "英文翻译", "补全 Frontmatter"] as const;
const [formatStep, codeStep, imageStep, translationStep, propertyStep] = CLIPPING_PIPELINE_STEPS;
const FORMAT_CONFIRM_CONCURRENCY = 3;

export const ARTICLE_CATEGORIES = [
  "人工智能",
  "知识积累",
  "操作系统",
  "常用工具",
  "算法分析",
  "系统架构",
  "编程语法",
  "项目管理",
  "工作相关",
  "奇思妙想",
  "论文相关",
  "休闲时光"
];

export class ClippingPipeline {
  constructor(
    private app: App,
    private settings: KnowFlowSettings,
    private store: KnowledgeStore,
    private ai: AiService,
    private noteOperations: NoteOperationCoordinator,
    private skills = new SkillRunner(new SkillStore(app.vault), app.vault)
  ) {}

  updateSettings(settings: KnowFlowSettings): void {
    this.settings = settings;
  }

  async process(
    file: TFile,
    onProgress?: (step: string, status: "active" | "completed" | "skipped", info?: string) => void
  ): Promise<void> {
    const path = file.path;
    return this.noteOperations.runExclusive(path, () => this.skills.run("clipping-update", (skill) => {
      if (file.path !== path) throw new Error("文章已移动，请重新执行整理。");
      return this.processExclusive(file, skill, onProgress);
    }));
  }

  private async processExclusive(
    file: TFile,
    instructions: string,
    onProgress?: (step: string, status: "active" | "completed" | "skipped", info?: string) => void
  ): Promise<void> {
    const report = async (
      step: string,
      status: "active" | "completed" | "skipped" = "active",
      info?: string
    ): Promise<void> => {
      onProgress?.(step, status, info);
      await Promise.resolve();
    };

    const createdAttachments: TFile[] = [];
    let noteWritten = false;
    try {
      const sourcePath = file.path;
      await report(formatStep);
      const original = await this.app.vault.read(file);
      const title = file.basename;
      const { frontmatter, body } = splitFrontmatter(original);
      if (frontmatter === null && /^(?:\uFEFF)?---[ \t]*\r?\n[^#:\s][^:\r\n]*:(?:[ \t]|\r?\n|$)/.test(original)) {
        throw new Error("Frontmatter 缺少独立的结束行，原文已保留。");
      }
      this.assertReadableBody(body);
      const translate = this.settings.translateEnglishClippings;
      const prompts = formatPromptBlocks(body);
      let formatted = normalizeBodyHeadingLevels(repairTableDividers(this.organizeMarkdownStyle(restoreDetachedLists(prompts.content))));
      const autoWrapped = applyAutoCodeWraps(formatted);
      formatted = autoWrapped.content;
      const confirmation = await this.confirmCandidates(formatted, instructions);
      formatted = confirmation.content;
      const formatChanges = prompts.wrapped + autoWrapped.applied + confirmation.changed;
      await report(formatStep, "completed", formatChanges > 0 ? `修改了 ${formatChanges} 处` : undefined);

      await report(codeStep);
      const codeBlocks = this.formatCodeBlocks(formatted);
      formatted = normalizeBodyHeadingLevels(codeBlocks.content);
      let text = this.normalizeFinalBody(formatted);
      await report(codeStep, codeBlocks.changed > 0 ? "completed" : "skipped", codeBlocks.changed > 0
        ? `修改了 ${codeBlocks.changed} 处`
        : codeBlocks.seen > 0 ? "代码块无需修改" : "没有代码块");

      await report(imageStep);
      const imageTask = planImageRepairs(this.app, sourcePath, text, clippingSourceUrl(frontmatter));
      let imagePlan: Awaited<ReturnType<typeof planImageRepairs>> | undefined;
      let imageWarnings: string | undefined;
      const finishImagePlan = async (): Promise<Awaited<ReturnType<typeof planImageRepairs>>> => {
        if (imagePlan) return imagePlan;
        imagePlan = await imageTask;
        imageWarnings = imagePlan.unavailable ? `${imagePlan.unavailable} 张图片无法恢复，保留原链接` : undefined;
        if (imagePlan.repairs.length === 0 && !imagePlan.unavailable) {
          await report(imageStep, "skipped", "图片无需整理");
        } else {
          await report(imageStep, "completed", imagePlan.repairs.length
            ? [`找到 ${imagePlan.repairs.length} 张失效图片的替代路径或原图`, imageWarnings].filter(Boolean).join("；")
            : imageWarnings);
        }
        return imagePlan;
      };

      const translationPlan = translate ? planEnglishTranslation(text) : { candidates: [], skipReason: "未开启英文翻译" };
      let propertyTask: Promise<Awaited<ReturnType<ClippingPipeline["proposeNoteProperties"]>>> | undefined;
      if (!translate || translationPlan.skipReason) {
        await report(translationStep, "skipped", translationPlan.skipReason);
        propertyTask = this.startNoteProperties(title, text);
      } else {
        await finishImagePlan();
        await report(translationStep);
        const translations = await this.ai.translateEnglishParagraphs(title, translationPlan.candidates, instructions);
        text = this.normalizeFinalBody(normalizeBodyHeadingLevels(
          applyTranslationDecisions(text, translationPlan.candidates, translations)
        ));
        await report(translationStep, translations.length ? "completed" : "skipped", translations.length ? undefined : "无可翻译正文");
        propertyTask = this.startNoteProperties(title, text);
      }

      const resolvedImagePlan = await finishImagePlan();
      await report(propertyStep);
      const repaired = await saveImageRepairs(this.app, sourcePath, text, resolvedImagePlan.repairs, createdAttachments);
      const promptCoverage = formatPromptBlocks(repaired.content);
      if (promptCoverage.wrapped || promptCoverage.bodies.length !== prompts.bodies.length
        || promptCoverage.bodies.some((promptBody, index) => promptBody !== prompts.bodies[index])) {
        throw new Error("整理后的提示词围栏覆盖不完整，原文已保留。");
      }
      const template = await this.readTemplateFrontmatter();
      const data = { title, today: window.moment().format("YYYY-MM-DD") };
      const proposal = await propertyTask;

      let filled: string[] = [];
      let warnings: string[] = [];
      await this.app.vault.process(file, (current) => {
        const snapshot = splitFrontmatter(current);
        if (snapshot.body !== body || file.path !== sourcePath) {
          throw new Error("文章在修复期间被修改或移动，请重新执行。");
        }
        const withFrontmatter = applyArticleFrontmatter(repaired.content, current, template, data);
        warnings = inspectClippingOutput(this.app, sourcePath, original, withFrontmatter, repaired.targets);
        if (imageWarnings) warnings.push(imageWarnings);
        const properties = fillEmptyNoteProperties(withFrontmatter, proposal, { replaceExisting: true });
        filled = properties.filled;
        if (properties.clearedDescription) warnings.push("简要描述未生成，已清空");
        return properties.content;
      });
      noteWritten = true;

      await this.store.recordPipelineSuccess({
        path: file.path,
        status: "processed",
        updatedAt: new Date().toISOString()
      });
      const propertyInfo = [filled.length ? `已更新${filled.join("、")}` : undefined, warnings.length ? warnings.join("；") : undefined]
        .filter(Boolean).join("；") || undefined;
      await report(propertyStep, "completed", propertyInfo);
      const imageResult = repaired.restored ? `已恢复 ${repaired.restored} 张图片。` : "";
      new Notice(`KnowFlow 已整理。${imageResult}${warnings.length ? `待检查：${warnings.join("；")}` : ""}`);
    } catch (error) {
      if (!noteWritten) await Promise.allSettled(createdAttachments.map((attachment) => this.app.vault.delete(attachment)));
      await this.store.setPipelineStatus({
        path: file.path,
        status: "failed",
        updatedAt: new Date().toISOString(),
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }

  async moveToCategory(file: TFile, category: string): Promise<TFile> {
    return this.noteOperations.runExclusive(file.path, () => this.moveToCategoryExclusive(file, category));
  }

  private async moveToCategoryExclusive(file: TFile, category: string): Promise<TFile> {
    const targetFolder = normalizePath(`${this.settings.articlesFolder}/${category}`);
    await this.ensureCategoryFolder(targetFolder, category);

    const oldPath = file.path;
    const targetPath = normalizePath(`${targetFolder}/${file.name}`);
    if (oldPath !== targetPath) {
      if (await this.app.vault.adapter.exists(targetPath)) {
        throw new Error(`目标文件已存在：${targetPath}`);
      }
      await this.app.fileManager.renameFile(file, targetPath);
    }

    const moved = this.app.vault.getAbstractFileByPath(targetPath);
    const movedFile = moved instanceof TFile ? moved : file;
    const content = await this.app.vault.read(movedFile);
    const categorized = this.updateFrontmatterCategory(content, category);
    if (categorized !== content) await this.app.vault.modify(movedFile, categorized);

    await this.store.recordCategoryMove({ oldPath, newPath: movedFile.path });
    new Notice(`KnowFlow: moved to ${category}`);
    return movedFile;
  }

  private async ensureCategoryFolder(targetFolder: string, category: string): Promise<void> {
    if (await this.app.vault.adapter.exists(targetFolder)) return;
    if (!this.settings.autoCreateCategoryFolders && !ARTICLE_CATEGORIES.includes(category)) {
      throw new Error(`目标分类目录不存在：${targetFolder}`);
    }
    await this.app.vault.createFolder(targetFolder);
  }

  private startNoteProperties(
    title: string,
    content: string
  ): Promise<Awaited<ReturnType<ClippingPipeline["proposeNoteProperties"]>>> {
    return this.proposeNoteProperties(title, content);
  }

  private async proposeNoteProperties(title: string, content: string) {
    if (typeof this.ai.proposeNoteProperties !== "function") return undefined;
    try {
      return await this.ai.proposeNoteProperties(title, content, ARTICLE_CATEGORIES);
    } catch {
      return undefined;
    }
  }

  private assertReadableBody(body: string): void {
    const visibleText = body
      .replace(/!\[\[.*?\]\]/g, "")
      .replace(/!\[.*?\]\(.*?\)/g, "")
      .replace(/[#>*_\-\s`=[\]()]/g, "")
      .trim();
    if (visibleText.length < 20 && !/!\[\[.+?\]\]|!\[[^\]\n]*\]\(.+?\)/.test(body)) {
      throw new Error("当前剪藏正文过短，可能是 Web Clipper 只保存了 Frontmatter。");
    }
  }

  private async confirmCandidates(
    content: string,
    instructions: string
  ): Promise<{ content: string; changed: number }> {
    const candidates = collectUncertainCandidates(content);
    if (candidates.length === 0) return { content, changed: 0 };
    const batches = batchFormattingCandidates(candidates, { maxChars: 3500, maxItems: 4 });
    const decisions: FormattingDecision[] = [];
    let nextBatch = 0;
    const workers = Array.from({ length: Math.min(FORMAT_CONFIRM_CONCURRENCY, batches.length) }, async () => {
      while (nextBatch < batches.length) {
        const batch = batches[nextBatch];
        nextBatch += 1;
        try {
          decisions.push(...await this.ai.confirmFormatting(batch, instructions));
        } catch {
          // A failed batch keeps its original text and does not surface an unconfirmed count.
        }
      }
    });
    await Promise.all(workers);
    const edited = applyFormattingEdits(content, candidates, decisions);
    return { content: edited.content, changed: edited.applied };
  }

  private organizeMarkdownStyle(content: string): string {
    return mapUnprotectedMarkdown(content, (plain) => {
      const cleaned = stripOrphanBoldDelimiters(normalizeOrphanBoldTriplet(plain))
        .replace(/\u00a0/g, " ")
        .replace(/(^|\n)\s*\*\*\s*(\n|$)/g, "$1$2");
      return cleaned.split("\n").map((line) => {
        let next = normalizeListIndent(line)
          .replace(/\t/g, "  ")
          .replace(/^(\s*)•\s+/g, "$1- ")
          .replace(/\*\*\*\*([^*\n]+)\*\*\*\*/g, "**$1**")
          .replace(/\*\*(.+?)\*\*\*\*/g, "**$1**")
          .replace(/\*\*\*\*(.+?)\*\*/g, "**$1**")
          .replace(/[ \t]+$/g, "");
        // Clean trailing ** from heading lines (orphan bold artifact)
        next = next.replace(/^(#{1,6}\s+.*?)\s*\*\*\s*$/g, "$1");
        next = next.replace(/^(\s*)(\d+)[、)]\s+/g, "$1$2. ");
        next = next.replace(/^(\s*)([一二三四五六七八九十]+)([、.])\s+/g, (_m, sp, num, sep) =>
          `${sp}${chineseToArabic(num)}. `);
        next = next.replace(/^\s+\|(\s*:?-{3,}:?\s*\|.*)$/g, "|$1");
        return next;
      }).join("\n");
    });
  }

  private formatCodeBlocks(content: string): { content: string; changed: number; seen: number } {
    const lines = content.split("\n");
    const ranges = protectedRanges(lines);
    const prompts = promptFenceStarts(lines, ranges);
    let changed = 0;
    let seen = 0;
    for (const range of ranges.reverse()) {
      const { start, end, marker, closed } = range;
      if (prompts.has(start) || !closed || marker !== "```" || !lines[start].startsWith(marker) || lines[end] !== marker) continue;
      const raw = lines.slice(start + 1, end).join("\n");
      const rawLanguage = lines[start].slice(marker.length);
      if (rawLanguage.trim().split(/\s+/).length > 1) continue;
      seen += 1;
      const language = rawLanguage.trim().split(/\s+/)[0] ?? "";
      const cleaned = prettyJsonBlock(removeClipperFenceSpacing(removeCodeWatermarkLines(raw)
        .replace(/^\s*(体验AI代码助手|代码解读复制代码)\s*$/gm, "")
        .replace(/^\s*(In \[\d+\]:|Out\[\d+\]:)\s*$/gm, ""), language), language);
      if (cleaned === raw) continue;
      lines.splice(start + 1, end - start - 1, ...trimCodeFenceBody(cleaned).split("\n"));
      changed += 1;
    }
    return { content: lines.join("\n"), changed, seen };
  }

  private normalizeFinalBody(content: string): string {
    return mapUnprotectedMarkdown(content, (plain) => plain
      .replace(/[ \t]+$/gm, "")
      .replace(/\n{3,}/g, "\n\n"))
      .trim() + "\n";
  }

  private async readTemplateFrontmatter(): Promise<string> {
    const path = normalizePath(this.settings.templatePath);
    if (!path || !(await this.app.vault.adapter.exists(path))) return "";
    return this.app.vault.adapter.read(path);
  }

  private updateFrontmatterCategory(content: string, category: string): string {
    return updateFrontmatterCategory(content, category);
  }
}

function applyAutoCodeWraps(content: string): { content: string; applied: number } {
  const auto = collectCodeCandidates(content).possibleCode.filter((candidate) => candidate.autoLanguage);
  if (auto.length === 0) return { content, applied: 0 };
  const decisions: FormattingDecision[] = auto.map((candidate) => ({
    id: candidate.id,
    action: "wrap-code",
    language: candidate.autoLanguage
  }));
  return applyFormattingEdits(content, auto, decisions);
}

function collectUncertainCandidates(content: string): FormattingCandidate[] {
  const headings = collectHeadingCandidates(content).map((candidate, index) => ({ ...candidate, id: `heading-${index + 1}` }));
  const code = collectCodeCandidates(content);
  const possible = code.possibleCode
    .filter((candidate) => !candidate.autoLanguage)
    .map((candidate, index) => ({ ...candidate, id: `code-${index + 1}` }));
  const fenced = code.fencedCode.map((candidate, index) => ({ ...candidate, id: `fence-${index + 1}` }));
  const clipped = collectClippedCodeCandidates(content).map((candidate, index) => ({ ...candidate, id: `clip-${index + 1}` }));
  return [...headings, ...possible, ...fenced, ...clipped];
}

function clippingSourceUrl(frontmatter: string | null): string | undefined {
  if (!frontmatter) return undefined;
  try {
    const properties: unknown = parseYaml(frontmatter);
    if (!properties || typeof properties !== "object") return undefined;
    const values = properties as Record<string, unknown>;
    return [values["网址"], values.url, values.source].find((value): value is string => typeof value === "string" && /^https?:\/\//i.test(value.trim()))?.trim();
  } catch {
    return undefined;
  }
}

function mapUnprotectedMarkdown(content: string, mapper: (block: string) => string): string {
  const lines = content.split("\n");
  const segments: string[] = [];
  let first = 0;
  for (const { start, end } of protectedRanges(lines)) {
    if (start > first) segments.push(mapper(lines.slice(first, start).join("\n")));
    segments.push(lines.slice(start, end + 1).join("\n"));
    first = end + 1;
  }
  if (first < lines.length) segments.push(mapper(lines.slice(first).join("\n")));
  return segments.join("\n");
}

function normalizeListIndent(line: string): string {
  const match = /^(\s+)([-*+]|\d+\.)\s+/.exec(line);
  if (!match) return line;
  const spaces = match[1].length;
  if (spaces % 2 === 0) return line;
  return `${" ".repeat(spaces - 1)}${line.slice(spaces)}`;
}

function stripOrphanBoldDelimiters(content: string): string {
  return content.replace(
    /(^|\n)[ \t]*\*\*[ \t]*\n+([^\n*][^\n]*?)\n+[ \t]*\*\*[ \t]*(?=\n|$)/g,
    (_match, prefix: string, title: string) => `${prefix}**${title.trim()}**`
  );
}

const CHINESE_DIGITS: Record<string, number> = {
  "一": 1, "二": 2, "三": 3, "四": 4, "五": 5,
  "六": 6, "七": 7, "八": 8, "九": 9, "十": 10
};

function chineseToArabic(chinese: string): string {
  if (chinese === "十") return "10";
  if (chinese.startsWith("十")) return String(10 + (CHINESE_DIGITS[chinese[1]] ?? 0));
  if (chinese.endsWith("十")) return String((CHINESE_DIGITS[chinese[0]] ?? 0) * 10);
  if (chinese.includes("十")) {
    const [tens, ones] = chinese.split("十");
    return String((CHINESE_DIGITS[tens] ?? 0) * 10 + (CHINESE_DIGITS[ones] ?? 0));
  }
  return String(CHINESE_DIGITS[chinese] ?? chinese);
}
