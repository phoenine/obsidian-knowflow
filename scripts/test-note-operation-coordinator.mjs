import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import * as esbuild from "esbuild";

const tempDir = await mkdtemp(join(tmpdir(), "knowflow-note-operations-"));
await esbuild.build({
  bundle: true,
  entryPoints: ["src/services/core/note-operation-coordinator.ts"],
  format: "esm",
  outdir: tempDir,
  platform: "node"
});
const { NoteOperationCoordinator } = await import(
  pathToFileURL(join(tempDir, "note-operation-coordinator.js")).href
);

const coordinator = new NoteOperationCoordinator();
const events = [];
let releasePipeline;
const pipelineGate = new Promise((resolve) => {
  releasePipeline = resolve;
});

const pipeline = coordinator.runExclusive("Clippings/article.md", async () => {
  events.push("pipeline:start");
  await pipelineGate;
  events.push("pipeline:write");
});
await Promise.resolve();

const summary = coordinator.runExclusive("Clippings/article.md", async () => {
  events.push("summary:write");
});
const otherNote = coordinator.runExclusive("Clippings/other.md", async () => {
  events.push("other:write");
});
await otherNote;

assert.deepEqual(events, ["pipeline:start", "other:write"]);
releasePipeline();
await Promise.all([pipeline, summary]);
assert.deepEqual(events, [
  "pipeline:start",
  "other:write",
  "pipeline:write",
  "summary:write"
]);

await assert.rejects(
  coordinator.runExclusive("Clippings/failure.md", async () => {
    throw new Error("expected");
  }),
  /expected/
);
await coordinator.runExclusive("Clippings/failure.md", async () => {
  events.push("after-failure");
});
assert.equal(events.at(-1), "after-failure", "a failed operation must not poison the queue");

await rm(tempDir, { recursive: true, force: true });
console.log("note operation coordinator tests passed");
