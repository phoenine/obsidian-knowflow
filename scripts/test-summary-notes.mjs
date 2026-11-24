import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import * as esbuild from "esbuild";

const tempDir = await mkdtemp(join(tmpdir(), "knowflow-summary-notes-"));
await esbuild.build({
  bundle: true,
  entryPoints: ["src/services/learning/summary-notes.ts"],
  format: "esm",
  outdir: tempDir,
  platform: "node"
});
const { alignSummaryOutline, buildSummaryCallout, upsertSummaryCallout, parseSummaryCallout, findSummaryCalloutEndIndex } = await import(
  pathToFileURL(join(tempDir, "summary-notes.js")).href
);

const text = {
  summary: "核心观点\n- 第一条观点\n- 第二条观点\n\n章节梳理\n1. 第一章讲了什么\n2. 第二章讲了什么",
  reason: "文章有深度分析，值得深入学习。"
};

// buildSummaryCallout -> parseSummaryCallout should round-trip exactly,
// and the callout must not contain any marker comments — just the
// collapsible callout title itself.
{
  const callout = buildSummaryCallout(text);
  assert.ok(!callout.includes("<!--"), "no marker comments — the callout's own title line is enough to find it again");
  assert.ok(callout.includes("> [!summary]- AI 摘要"), "callout must be collapsible (the `-` suffix)");
  const parsed = parseSummaryCallout(callout);
  assert.ok(parsed);
  assert.equal(parsed.summary, text.summary);
  assert.equal(parsed.reason, text.reason);
}

// A summary with no reason should round-trip with an empty reason string,
// and must not emit a dangling "推荐理由" line.
{
  const callout = buildSummaryCallout({ summary: text.summary, reason: "" });
  assert.ok(!callout.includes("推荐理由"));
  const parsed = parseSummaryCallout(callout);
  assert.equal(parsed.summary, text.summary);
  assert.equal(parsed.reason, "");
}

// upsertSummaryCallout should insert right after frontmatter on a note
// that has never been summarized before.
{
  const note = "---\n分类: AI\n---\n\n## 正文标题\n\n这里是文章正文。\n";
  const withSummary = upsertSummaryCallout(note, text);
  assert.ok(withSummary.startsWith("---\n分类: AI\n---\n\n> [!summary]- AI 摘要"));
  assert.ok(withSummary.includes("## 正文标题"), "original body must be preserved");
  assert.ok(withSummary.trim().endsWith("这里是文章正文。"), "original body must be preserved");
}

// Re-summarizing must replace the existing callout in place, not stack a
// second one, and must not disturb the rest of the body.
{
  const note = "---\n分类: AI\n---\n\n## 正文标题\n\n这里是文章正文。\n";
  const first = upsertSummaryCallout(note, text);
  const second = upsertSummaryCallout(first, { summary: "更新后的摘要", reason: "更新后的理由" });
  assert.equal((second.match(/\[!summary\]/g) ?? []).length, 1, "must not duplicate the callout block");
  const parsed = parseSummaryCallout(second);
  assert.equal(parsed.summary, "更新后的摘要");
  assert.equal(parsed.reason, "更新后的理由");
  assert.ok(second.includes("## 正文标题"), "unrelated body content must survive re-summarization");
}

// A note with no frontmatter at all should still get the callout inserted
// at the very top, above the existing body.
{
  const note = "## 正文标题\n\n这里是文章正文。\n";
  const withSummary = upsertSummaryCallout(note, text);
  assert.ok(withSummary.startsWith("> [!summary]- AI 摘要"));
  assert.ok(withSummary.includes("## 正文标题"));
}

// A note that was never summarized should parse to null, not throw, and
// findSummaryCalloutEndIndex should likewise return null.
{
  assert.equal(parseSummaryCallout("## 正文标题\n\n这里是文章正文。\n"), null);
  assert.equal(findSummaryCalloutEndIndex("## 正文标题\n\n这里是文章正文。\n"), null);
}

// Position does not matter: summary type + exact "AI 摘要" title identifies
// the managed block. A different title remains ordinary user content.
{
  const laterCallout = `正文开头。\n\n${buildSummaryCallout(text)}\n`;
  assert.deepEqual(parseSummaryCallout(laterCallout), text);

  const differentTitle = "> [!summary]- AI 摘要补充\n> 用户自己的摘要。\n\n正文。\n";
  assert.equal(parseSummaryCallout(differentTitle), null);
  assert.equal(findSummaryCalloutEndIndex(differentTitle), null);
}

// Refreshing a managed summary must replace the matching callout while leaving
// unrelated summary callouts elsewhere in the article untouched.
{
  const unrelated = "> [!summary]- 读者摘要\n> 用户自己的内容。";
  const first = upsertSummaryCallout(`正文。\n\n${unrelated}\n`, text);
  const refreshed = upsertSummaryCallout(first, { summary: "刷新后的摘要", reason: "刷新后的理由" });
  const parsed = parseSummaryCallout(refreshed);
  assert.equal(parsed.summary, "刷新后的摘要");
  assert.equal(parsed.reason, "刷新后的理由");
  assert.ok(refreshed.includes(unrelated), "refresh must preserve unrelated callouts");
  assert.equal((refreshed.match(/> \[!summary\][+-]? AI 摘要$/gm) ?? []).length, 1, "managed AI summary must not duplicate");
}

{
  const example = "````markdown\n> [!summary]- AI 摘要\n> 这是代码示例。\n````";
  assert.equal(parseSummaryCallout(example), null);
  const updated = upsertSummaryCallout(example, text);
  assert.ok(updated.endsWith(example));
  assert.deepEqual(parseSummaryCallout(updated), text);
}

// findSummaryCalloutEndIndex must point right after the callout's last
// quoted line, so other note-writing code can splice content in immediately
// after the summary regardless of what follows it.
{
  const note = "---\n分类: AI\n---\n\n## 正文标题\n\n这里是文章正文。\n";
  const withSummary = upsertSummaryCallout(note, text);
  const endIndex = findSummaryCalloutEndIndex(withSummary);
  assert.ok(endIndex !== null);
  assert.equal(withSummary.slice(0, endIndex).trimEnd().endsWith(text.reason), true, "end index must land right after the callout's content");
  assert.ok(withSummary.slice(endIndex).includes("## 正文标题"), "everything after the callout must still be there");
}

{
  const outline = [
    "## 章节梳理",
    "9. 对比：向量库/Mem0/Letta/Anthropic 方案适用性。",
    "10. 选型：过期性/推理需求/团队能力混合架构建议。",
    "11-12. 场景与问答：客服/研发等五类场景及面试核心问题。",
    "    13-15. 资产与检查：格式契约、代码实现及十条上线清单。"
  ].join("\n");
  const aligned = alignSummaryOutline(outline);
  assert.equal(aligned, [
    "## 章节梳理",
    "9. 对比：向量库/Mem0/Letta/Anthropic 方案适用性。",
    "10. 选型：过期性/推理需求/团队能力混合架构建议。",
    "11. 场景与问答（11–12）：客服/研发等五类场景及面试核心问题。",
    "12. 资产与检查（13–15）：格式契约、代码实现及十条上线清单。"
  ].join("\n"));
  assert.equal(alignSummaryOutline(aligned), aligned);
  const parsed = parseSummaryCallout(buildSummaryCallout({ summary: outline, reason: "适合工程师。" }));
  assert.equal(parsed.summary, aligned);
  assert.equal(alignSummaryOutline("```\n11-12. 保留代码里的序号。\n```"), "```\n11-12. 保留代码里的序号。\n```");
  const withMetadata = [
    "title: AI 记忆的双刃剑",
    "value: 警惕 AI 记忆带来的身份窄化与认知固化",
    "tags: [AI, 心理效应，自我认知]",
    "",
    outline
  ].join("\n");
  assert.equal(alignSummaryOutline(withMetadata), aligned);
  assert.equal(parseSummaryCallout(buildSummaryCallout({ summary: withMetadata, reason: "适合工程师。" })).summary, aligned);
  const prose = "Value: low latency matters for this design.\n\n后面还有正文。";
  assert.equal(alignSummaryOutline(prose), prose);
  const singleLine = "Value: low latency matters.\n\n## 核心观点\n- 保持低延迟";
  assert.equal(alignSummaryOutline(singleLine), singleLine);
}

await rm(tempDir, { recursive: true, force: true });
console.log("summary-notes tests passed");
