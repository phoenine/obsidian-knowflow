import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import * as esbuild from "esbuild";

const tempDir = await mkdtemp(join(tmpdir(), "knowflow-coordinated-services-"));
await esbuild.build({
  bundle: true,
  entryPoints: [
    "src/services/clipping/clipping-pipeline.ts",
    "src/services/clipping/repair-validator.ts",
    "src/services/core/note-operation-coordinator.ts",
    "src/services/learning/article-learning-service.ts",
    "src/services/learning/quiz-note-service.ts"
  ],
  format: "esm",
  outdir: tempDir,
  platform: "node",
  plugins: [{
    name: "stub-obsidian",
    setup(build) {
      build.onResolve({ filter: /^obsidian$/ }, () => ({ path: "obsidian", namespace: "stub-obsidian" }));
      build.onLoad({ filter: /.*/, namespace: "stub-obsidian" }, () => ({
        contents: [
          "export class Notice { constructor(message) { globalThis.knowflowNotices?.push(message); } }",
          "export class TFile { static [Symbol.hasInstance](value) { return Boolean(value && typeof value.path === 'string' && typeof value.basename === 'string'); } }",
          "export class TFolder {}",
          "export const parseYaml = (text) => { if (text === 'invalid: [') throw new Error('invalid YAML'); return globalThis.knowflowParseYaml?.(text) ?? {}; };",
          "export const normalizePath = (value) => value.replace(/\\\\/g, '/');",
          "export const requestUrl = async (request) => globalThis.knowflowRequest?.(request) ?? ({ status: 500, text: '' });"
        ].join("\n"),
        loader: "js"
      }));
    }
  }]
});

const { ClippingPipeline } = await import(pathToFileURL(join(tempDir, "clipping", "clipping-pipeline.js")).href);
const { inspectClippingOutput } = await import(pathToFileURL(join(tempDir, "clipping", "repair-validator.js")).href);
const { QuizNoteService } = await import(pathToFileURL(join(tempDir, "learning", "quiz-note-service.js")).href);
const { ArticleLearningService } = await import(pathToFileURL(join(tempDir, "learning", "article-learning-service.js")).href);
const { NoteOperationCoordinator } = await import(pathToFileURL(join(tempDir, "core", "note-operation-coordinator.js")).href);

{
  const previousImage = globalThis.Image;
  const previousWindow = globalThis.window;
  const downloads = [];
  const healthy = "https://example.com/healthy.png";
  const broken = "https://mmbiz.qpic.cn/mmbiz_png/abcdef/640?wx_fmt=png";
  const body = `![健康图片](${healthy})\n\n[![失效图片](${broken})](https://mp.weixin.qq.com/s/source)`;
  let written;
  globalThis.Image = class {
    naturalWidth = 800;
    naturalHeight = 600;
    set src(url) { queueMicrotask(() => url === healthy || url.startsWith("blob:") ? this.onload() : this.onerror()); }
  };
  globalThis.window = { setTimeout, clearTimeout, moment: () => ({ format: () => "2026-10-22" }) };
  globalThis.knowflowRequest = async ({ url, headers }) => {
    downloads.push([url, headers?.Referer]);
    return { status: 200, headers: { "content-type": "image/png" }, arrayBuffer: new Uint8Array([137, 80, 78, 71]).buffer };
  };
  try {
    const app = {
      metadataCache: { getFirstLinkpathDest: () => ({ path: "Attachments/640.png" }) },
      vault: {
        read: async () => body,
        getAbstractFileByPath: () => null,
        adapter: { exists: async () => false },
        createBinary: async (path) => ({ path }),
        delete: async () => {},
        process: async (_file, transform) => { written = transform(body); }
      },
      fileManager: {
        getAvailablePathForAttachment: async (name) => `Attachments/${name}`,
        generateMarkdownLink: (file) => `[[${file.path}]]`
      }
    };
    const pipeline = new ClippingPipeline(app, { templatePath: "" }, {
      recordPipelineSuccess: async () => {},
      setPipelineStatus: async (status) => assert.fail(status.error)
    }, {}, { runExclusive: async (_path, operation) => operation() });
    await pipeline.process({ path: "Clippings/Images.md", basename: "Images" });
    assert.deepEqual(downloads, [[broken, "https://mp.weixin.qq.com/"]]);
    assert.ok(written.includes(`![健康图片](${healthy})`));
    assert.ok(written.includes("[![失效图片](Attachments/640.png)](https://mp.weixin.qq.com/s/source)"));
  } finally {
    globalThis.Image = previousImage;
    globalThis.window = previousWindow;
    delete globalThis.knowflowRequest;
  }
}

{
  const app = {
    metadataCache: {
      getFirstLinkpathDest: (link, source) =>
        source === "Clippings/案例.md" && ["assets/图 1.png", "100% 图.png"].includes(link) ? { path: link } : null
    }
  };
  const body = [
    "![图一](assets/图%201.png)", "![[100% 图.png|300]]", "![未解析的图](missing.png)",
    "", "| A | B |", "| --- |", "", "```text", "![[围栏中的示例.png]]", "```"
  ].join("\n");
  const result = `---\n状态: true\n---\n\n${body}`;
  assert.deepEqual(inspectClippingOutput(app, "Clippings/案例.md", body, result), [
    "1 处表格表头和分隔行列数不一致", "1 个本地图片或嵌入目标未解析"
  ]);
  assert.throws(() => inspectClippingOutput(app, "Clippings/案例.md", body, result.replace("![[100% 图.png|300]]", "")),
    /丢失或修改/);
  assert.throws(() => inspectClippingOutput(app, "Clippings/案例.md", body, result.replace("状态: true", "invalid: [")),
    /无法解析为 YAML/);
}

// The skill decides which paragraphs to translate. Code only withholds
// links, code, and managed sections. A failed formatting batch keeps the
// original fragment and still writes the rest of the note.
{
  const english = "Distributed systems are difficult because independent components can fail in many different ways.";
  const french = "Voici un paragraphe français qui explique comment utiliser cette bibliothèque dans une application.";
  const link = "[esp32-iphone-agent](https://github.com/onehumanbeing/esp32-iphone-agent)";
  const previousWindow = globalThis.window;
  globalThis.window = { moment: () => ({ format: () => "2026-10-22" }) };
  try {
    for (const { body, calls, status, info } of [
      { body: `这篇中文文章介绍 ESP32 开发板，以及如何选择入门项目。\n\n- ${link}`, calls: 1, status: "skipped", info: "无可翻译正文" },
      { body: `${english}\n\n这一段是原文自带的中文说明。`, calls: 1, status: "completed" },
      { body: link, calls: 0, status: "skipped", info: "无可翻译正文" },
      { body: french, calls: 1, status: "completed" },
      { body: `> [!summary]- AI 摘要\n> 中文摘要不改变原文语言。\n\n${english}\n\n- ${link}`, calls: 1, status: "completed" }
    ]) {
      let translationCalls = 0;
      let written;
      let success = false;
      const progress = [];
      const app = { vault: {
        read: async () => body,
        getAbstractFileByPath: () => null,
        process: async (_file, transform) => { written = transform(body); },
        adapter: { exists: async () => false }
      } };
      const ai = {
        translateEnglishParagraphs: async (_title, candidates) => {
          translationCalls += 1;
          assert.ok(candidates.every((candidate) => !candidate.content.includes("esp32-iphone-agent")));
          assert.ok(candidates.every((candidate) => !candidate.content.includes("中文摘要")));
          return candidates
            .filter((candidate) => !/\p{Script=Han}/u.test(candidate.content))
            .map((candidate) => ({ id: candidate.id, translation: "中文译文。" }));
        }
      };
      const pipeline = new ClippingPipeline(app, { templatePath: "" }, {
        recordPipelineSuccess: async () => { success = true; },
        setPipelineStatus: async (status) => { assert.fail(status.error); }
      }, ai, { runExclusive: async (_path, operation) => operation() });
      await pipeline.process({ path: "Clippings/Test.md", basename: "Test" }, (...event) => progress.push(event));
      assert.equal(success, true);
      assert.ok(written);
      assert.equal(translationCalls, calls);
      assert.ok(progress.some(([step, stepStatus, stepInfo]) => step === "英文翻译"
        && stepStatus === status && stepInfo === info));
      if (body.includes(link)) assert.ok(written.includes(link));
      if (body.includes(french)) assert.ok(written.includes("（中文译文。）"));
    }
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
}

{
  const english = "A good harness makes lots of small decisions along the way before handing the answer back.";
  const body = [
    "An AI agent is a language model that works in a loop until the job is done.人工智能代理循环运行直到完成工作。",
    "",
    english,
    "",
    "```bash",
    "echo 这段中文在代码块里",
    "```"
  ].join("\n");
  const previousWindow = globalThis.window;
  globalThis.window = { moment: () => ({ format: () => "2026-10-22" }) };
  try {
    let written = "";
    const app = { vault: {
      read: async () => body,
      getAbstractFileByPath: () => null,
      process: async (_file, transform) => { written = transform(body); },
      adapter: { exists: async () => false }
    } };
    const ai = {
      translateEnglishParagraphs: async (_title, candidates) => {
        assert.ok(!candidates.some((candidate) => candidate.content.includes("代码块")));
        assert.ok(candidates.some((candidate) => candidate.content === english));
        assert.ok(candidates.some((candidate) => candidate.content.includes("人工智能")));
        return candidates
          .filter((candidate) => candidate.content === english)
          .map((candidate) => ({ id: candidate.id, translation: "一个好的线束会沿途做出许多小决定。" }));
      }
    };
    const pipeline = new ClippingPipeline(app, { templatePath: "" }, {
      recordPipelineSuccess: async () => {},
      setPipelineStatus: async (status) => { assert.fail(status.error); }
    }, ai, { runExclusive: async (_path, operation) => operation() });
    await pipeline.process({ path: "Clippings/Harness.md", basename: "Harness" });
    assert.ok(written.includes(`${english}（一个好的线束会沿途做出许多小决定。）`));
    assert.ok(written.includes("echo 这段中文在代码块里"));
    assert.ok(!written.includes("人工智能代理循环运行直到完成工作。（"));
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
}

{
  const body = "这篇笔记已经有足够长的正文，用来通过最短长度检查。\n\n记忆架构\n\n后面还有一段说明文字，避免整篇因为一次空回复而退回。";
  let written;
  let success = false;
  const progress = [];
  const previousWindow = globalThis.window;
  globalThis.window = { moment: () => ({ format: () => "2026-10-22" }) };
  const notices = [];
  globalThis.knowflowNotices = notices;
  try {
    const app = { vault: {
      read: async () => body,
      getAbstractFileByPath: () => null,
      process: async (_file, transform) => { written = transform(body); },
      adapter: { exists: async () => false }
    } };
    const ai = {
      confirmFormatting: async () => { throw new Error("AI response did not contain message content."); },
      translateEnglishParagraphs: async () => []
    };
    const pipeline = new ClippingPipeline(app, { templatePath: "" }, {
      recordPipelineSuccess: async () => { success = true; },
      setPipelineStatus: async (status) => { assert.fail(status.error); }
    }, ai, { runExclusive: async (_path, operation) => operation() });
    await pipeline.process({ path: "Clippings/Memory.md", basename: "Memory" }, (...event) => progress.push(event));
    assert.equal(success, true);
    assert.ok(written.includes("记忆架构"));
    const format = progress.find(([step, status]) => step === "文章样式梳理" && status === "completed");
    assert.ok(format);
    assert.ok(!String(format[2] ?? "").includes("未确认"));
    assert.ok(progress.every(([, , info]) => !String(info ?? "").includes("未确认")));
    assert.ok(progress.some(([step, status]) => step === "补全 Frontmatter" && status === "completed"));
    assert.ok(progress.some(([step, status, info]) => step === "格式化代码块" && status === "skipped" && info === "没有代码块"));
    assert.ok(progress.some(([step, status, info]) => step === "整理图片" && status === "skipped" && info === "图片无需整理"));
    // The failed batch is reported on the completion notice too, not only on the progress callback.
    assert.match(format[2], /1 批模型确认失败/);
    assert.equal(notices.length, 1);
    assert.match(notices[0], /待检查：.*1 批模型确认失败/);
  } finally {
    delete globalThis.knowflowNotices;
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
}

{
  const titles = ["甲标题", "乙标题", "丙标题", "丁标题", "戊标题"];
  const body = [
    "这篇笔记已经有足够长的正文，用来通过最短长度检查。",
    ...titles.flatMap((title) => ["", title, "", `${title}后面是一段说明，避免这行被收成标题。`])
  ].join("\n");
  const previousWindow = globalThis.window;
  globalThis.window = { moment: () => ({ format: () => "2026-10-22" }) };
  let inFlight = 0;
  let maxInFlight = 0;
  try {
    let written = "";
    const app = { vault: {
      read: async () => body,
      getAbstractFileByPath: () => null,
      process: async (_file, transform) => { written = transform(body); },
      adapter: { exists: async () => false }
    } };
    const ai = {
      confirmFormatting: async (batch) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 20));
        inFlight -= 1;
        return batch.map((candidate) => ({ id: candidate.id, action: "heading", level: 2 }));
      },
      translateEnglishParagraphs: async () => []
    };
    const pipeline = new ClippingPipeline(app, { templatePath: "" }, {
      recordPipelineSuccess: async () => {},
      setPipelineStatus: async (status) => { assert.fail(status.error); }
    }, ai, { runExclusive: async (_path, operation) => operation() });
    await pipeline.process({ path: "Clippings/Batches.md", basename: "Batches" });
    assert.ok(maxInFlight > 1, "formatting batches should run together");
    for (const title of titles) assert.ok(written.includes(`## ${title}`), title);
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
}

{
  const body = "这篇笔记已经有足够长的正文，用来通过最短长度检查。\n\n记忆架构说明了事件日志和派生索引如何分工。";
  const previousWindow = globalThis.window;
  globalThis.window = { moment: () => ({ format: () => "2026-10-22" }) };
  try {
    let written = "";
    const progress = [];
    const app = { vault: {
      read: async () => body,
      getAbstractFileByPath: () => null,
      process: async (_file, transform) => { written = transform(body); },
      adapter: { exists: async () => false }
    } };
    let propertyCalls = 0;
    const pipeline = new ClippingPipeline(app, { templatePath: "" }, {
      recordPipelineSuccess: async () => {},
      setPipelineStatus: async (status) => { assert.fail(status.error); }
    }, {
      proposeNoteProperties: async () => {
        propertyCalls += 1;
        return {
          description: "说明事件日志和派生索引的分工。",
          readingValue: 4,
          category: "人工智能",
          tags: ["agent-memory"]
        };
      },
      translateEnglishParagraphs: async () => []
    }, { runExclusive: async (_path, operation) => operation() });
    await pipeline.process({ path: "Clippings/Memory.md", basename: "Memory" }, (...event) => progress.push(event));
    assert.match(written, /简要描述: "说明事件日志和派生索引的分工。"/);
    assert.match(written, /阅读价值: 4/);
    assert.match(written, /分类:\n  - 人工智能/);
    assert.match(written, /  - agent-memory/);
    assert.equal(propertyCalls, 1);
    assert.ok(progress.some(([step, status, info]) => step === "补全 Frontmatter" && status === "completed" && String(info).includes("已更新简要描述、阅读价值、分类、标签")));

    const existing = [
      "---",
      "简要描述: \"已有描述\"",
      "阅读价值: 2",
      "分类: 知识积累",
      "tags:",
      "  - kept",
      "---",
      body
    ].join("\n");
    const keeping = { vault: {
      read: async () => existing,
      getAbstractFileByPath: () => null,
      process: async (_file, transform) => { written = transform(existing); },
      adapter: { exists: async () => false }
    } };
    propertyCalls = 0;
    await new ClippingPipeline(keeping, { templatePath: "" }, {
      recordPipelineSuccess: async () => {},
      setPipelineStatus: async (status) => { assert.fail(status.error); }
    }, {
      proposeNoteProperties: async () => {
        propertyCalls += 1;
        return { description: "说明事件日志和派生索引的分工。", readingValue: 5, category: "人工智能", tags: ["agent-memory"] };
      },
      translateEnglishParagraphs: async () => []
    }, { runExclusive: async (_path, operation) => operation() }).process(
      { path: "Clippings/Memory.md", basename: "Memory" }
    );
    assert.equal(propertyCalls, 1);
    assert.match(written, /简要描述: "说明事件日志和派生索引的分工。"/);
    assert.doesNotMatch(written, /已有描述/);
    assert.match(written, /阅读价值: 5/);
    assert.match(written, /分类:\n  - 人工智能/);
    assert.match(written, /  - agent-memory/);
    assert.doesNotMatch(written, /知识积累/);
    assert.doesNotMatch(written, /  - kept/);

    await new ClippingPipeline(keeping, { templatePath: "" }, {
      recordPipelineSuccess: async () => {},
      setPipelineStatus: async (status) => { assert.fail(status.error); }
    }, {
      proposeNoteProperties: async () => ({}),
      translateEnglishParagraphs: async () => []
    }, { runExclusive: async (_path, operation) => operation() }).process(
      { path: "Clippings/Memory.md", basename: "Memory" }
    );
    assert.match(written, /简要描述:\n/);
    assert.doesNotMatch(written, /已有描述/);
    assert.match(written, /阅读价值: 2/);

    await new ClippingPipeline(keeping, { templatePath: "" }, {
      recordPipelineSuccess: async () => {},
      setPipelineStatus: async (status) => { assert.fail(status.error); }
    }, {
      proposeNoteProperties: async () => { throw new Error("model down"); },
      translateEnglishParagraphs: async () => []
    }, { runExclusive: async (_path, operation) => operation() }).process(
      { path: "Clippings/Memory.md", basename: "Memory" }
    );
    assert.match(written, /简要描述: "已有描述"/);
    assert.match(written, /阅读价值: 2/);
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
}

// Moving categories must validate the destination first, then rename before
// changing frontmatter so a failed rename cannot alter a note left behind.
{
  const events = [];
  const file = { path: "Clippings/Test.md", name: "Test.md" };
  const app = {
    vault: {
      adapter: { exists: async (path) => path === "Articles/AI" },
      read: async () => "---\n分类: 旧分类\n---\n\n正文。\n",
      modify: async () => events.push("modify"),
      getAbstractFileByPath: () => null
    },
    fileManager: {
      renameFile: async (target, path) => {
        events.push("rename");
        target.path = path;
      }
    }
  };
  const store = { recordCategoryMove: async () => events.push("store") };
  const coordinator = { runExclusive: async (_path, operation) => operation() };
  const pipeline = new ClippingPipeline(
    app,
    { articlesFolder: "Articles" },
    store,
    {},
    coordinator
  );
  await pipeline.moveToCategory(file, "AI");
  assert.deepEqual(events, ["rename", "modify", "store"]);
}

{
  let modified = false;
  const file = { path: "Clippings/Conflict.md", name: "Conflict.md" };
  const app = {
    vault: {
      adapter: { exists: async (path) => path === "Articles/AI" || path === "Articles/AI/Conflict.md" },
      modify: async () => { modified = true; }
    }
  };
  const coordinator = { runExclusive: async (_path, operation) => operation() };
  const pipeline = new ClippingPipeline(
    app,
    { articlesFolder: "Articles" },
    {},
    {},
    coordinator
  );
  await assert.rejects(pipeline.moveToCategory(file, "AI"), /目标文件已存在/);
  assert.equal(modified, false, "destination conflicts must not modify source frontmatter");
}

// Quiz source callouts must be based on content read inside the shared note
// operation, so edits queued before that operation are preserved.
{
  const source = { path: "Articles/Test.md", name: "Test.md", basename: "Test" };
  let current = "## 正文\n\n原始内容。\n";
  const app = {
    vault: {
      adapter: { exists: async () => false },
      createFolder: async () => {},
      read: async (file) => file === source ? current : "",
      create: async () => {
        current += "\n创建题库期间的用户编辑。\n";
      },
      process: async (file, edit) => {
        if (file === source) current = edit(current);
      },
      getAbstractFileByPath: () => null
    }
  };
  const coordinator = {
    runExclusive: async (_path, operation) => {
      current = `${current.trimEnd()}\n\n排队期间的用户编辑。\n`;
      return operation();
    }
  };
  const service = new QuizNoteService(app, { archiveFolder: "Archives" }, coordinator);
  await service.saveQuiz(source, "AI", []);
  assert.ok(current.includes("排队期间的用户编辑。"));
  assert.ok(current.includes("创建题库期间的用户编辑。"));
  assert.ok(current.includes("> [!question]- Quiz"));
}

{
  const source = { path: "Articles/Learning.md", basename: "Learning" };
  let current = "正文。";
  const service = new ArticleLearningService({ vault: {
    process: async (_file, edit) => {
      current += "\n标记学习期间的用户编辑。";
      current = edit(current);
    }
  } }, new NoteOperationCoordinator());
  await service.markComplete(source, "2026-11-26");
  assert.match(current, /学习日期: 2026-11-26/);
  assert.match(current, /标记学习期间的用户编辑。/);
}

// The global review bank must discover legacy Quiz notes whose source is stored
// as a parent-relative frontmatter wikilink.
{
  const quiz = { path: "Archives/AI/Source_Quiz.md", name: "Source_Quiz.md", basename: "Source_Quiz" };
  const source = { path: "Articles/AI/Source.md", name: "Source.md", basename: "Source" };
  const content = [
    "---",
    '原文链接: "[[../Articles/AI/Source|Source]]"',
    "---",
    "",
    "<!-- study-quiz:start -->",
    "",
    "## 1. 选择题",
    "",
    "### 1.1. 哪个选项正确？",
    "",
    "- [ ] A. 错误项",
    "- [ ] B. 正确项",
    "- [ ] C. 干扰项",
    "- [ ] D. 干扰项",
    "",
    "```Answer fold",
    "- 答案：B",
    "- 解析：来自旧版题库。",
    "```",
    "",
    "<!-- study-quiz:end -->",
    ""
  ].join("\n");
  const app = {
    vault: {
      getMarkdownFiles: () => [quiz, source],
      getAbstractFileByPath: (path) => path === source.path ? source : null,
      read: async (file) => file === quiz ? content : ""
    }
  };
  const coordinator = { runExclusive: async (_path, operation) => operation() };
  const service = new QuizNoteService(app, { archiveFolder: "Archives" }, coordinator);
  const questions = await service.listReviewQuestions();
  assert.equal(questions.length, 1);
  assert.equal(questions[0].articlePath, source.path);
  assert.equal(questions[0].entries[0].question.question, "哪个选项正确？");
}

{
  const quiz = { path: "Archives/Concurrent_Quiz.md", basename: "Concurrent_Quiz" };
  let content = [
    "---",
    "考试结果: false",
    "---",
    "",
    "<!-- study-quiz:start -->",
    "",
    "## 1. 第一题",
    "",
    "- [ ] A. 甲",
    "- [ ] B. 乙",
    "",
    "```Answer fold",
    "- 答案：A",
    "- 解析：第一题。",
    "```",
    "",
    "## 2. 第二题",
    "",
    "- [ ] A. 丙",
    "- [ ] B. 丁",
    "",
    "```Answer fold",
    "- 答案：B",
    "- 解析：第二题。",
    "```",
    "",
    "<!-- study-quiz:end -->",
    ""
  ].join("\n");
  const source = { path: "Articles/Concurrent.md", basename: "Concurrent" };
  const coordinator = new NoteOperationCoordinator();
  const app = {
    vault: {
      getAbstractFileByPath: (path) => path === quiz.path ? quiz : source,
      read: async (file) => file === source ? `> [!question]- Quiz\n> [[${quiz.path}]]\n` : content,
      modify: async (_file, next) => { content = next; },
      process: async (_file, transform) => {
        const snapshot = content;
        await new Promise((resolve) => setTimeout(resolve, 20));
        content = transform(snapshot);
        return content;
      }
    }
  };
  const service = new QuizNoteService(app, { archiveFolder: "Archives" }, coordinator);
  const RealDate = Date;
  const previousZone = process.env.TZ;
  process.env.TZ = "Asia/Shanghai";
  globalThis.Date = class extends RealDate {
    constructor(...args) { super(...(args.length ? args : ["2026-11-26T00:15:00+08:00"])); }
  };
  try {
    const [first, quizPath, second] = await Promise.all([
      service.recordAnswer(quiz.path, 1, "A", "A", "第一题"),
      service.appendKnowledgePointQuiz(source, "AI", { id: "point" }, {
        question: "追加的题目", options: [{ key: "A", content: "是" }, { key: "B", content: "否" }],
        answerKey: "A", explanation: "说明", difficulty: 3
      }),
      service.recordAnswer(quiz.path, 2, "B", "B", "第二题")
    ]);
    assert.equal(first, true);
    assert.equal(second, true);
    assert.equal(quizPath, quiz.path);
  } finally {
    globalThis.Date = RealDate;
    if (previousZone === undefined) delete process.env.TZ;
    else process.env.TZ = previousZone;
  }
  assert.match(content, /追加的题目/);
  assert.match(content, /- \[x\] A\. 甲 ✅ 2026-11-26/);
  assert.match(content, /- \[x\] B\. 丁 ✅/);
}

{
  const listFence = ["    ```", "keep\tlist\ttab", "    ```"].join("\n");
  const calloutFence = ["> ```", "> keep\tcallout\ttab", "> 微信扫一扫", "> ```"].join("\n");
  const body = [
    "这篇笔记已经有足够长的正文，用来通过最短长度检查。",
    "",
    "1. 先看嵌套代码。",
    "",
    listFence,
    "",
    "微信扫一扫",
    "",
    "```yaml",
    "root:./data",
    "```",
    "",
    "> [!note] 说明",
    calloutFence,
    "",
    "后面还有一段说明文字，避免整篇因为一次空回复而退回。"
  ].join("\n");
  const previousWindow = globalThis.window;
  globalThis.window = { moment: () => ({ format: () => "2026-10-22" }) };
  globalThis.knowflowParseYaml = (source) => {
    if (source === "root:./data") throw new Error("invalid YAML");
    return source === "root: ./data" ? { root: "./data" } : {};
  };
  try {
    let written = "";
    const app = { vault: {
      read: async () => body,
      getAbstractFileByPath: () => null,
      process: async (_file, transform) => { written = transform(body); },
      adapter: { exists: async () => false }
    } };
    const pipeline = new ClippingPipeline(app, { templatePath: "" }, {
      recordPipelineSuccess: async () => {},
      setPipelineStatus: async (status) => { assert.fail(status.error); }
    }, { translateEnglishParagraphs: async () => [] }, { runExclusive: async (_path, operation) => operation() });
    await pipeline.process({ path: "Clippings/Fences.md", basename: "Fences" });
    assert.ok(written.includes(listFence), "an indented list fence must keep its tabs");
    assert.ok(written.includes(calloutFence), "a callout fence must keep its tabs");
    assert.doesNotMatch(written, /^微信扫一扫$/m);
    assert.match(written, /```yaml\nroot: \.\/data\n```/);
  } finally {
    delete globalThis.knowflowParseYaml;
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
}

await rm(tempDir, { recursive: true, force: true });
console.log("coordinated service tests passed");
