import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadPiTestRuntime } from "./helpers/pi-runtime.mjs";

const { jiti } = await loadPiTestRuntime(import.meta.url);
const adapter = await jiti.import("../pi/extensions/lib/pi-subagents-browser-adapter.ts");

const theme = {
  bold: (text) => text,
  fg: (_color, text) => text,
};
const markdownTheme = {};

async function makeFixture() {
  const root = await mkdtemp(join(tmpdir(), "pi-subagents-browser-"));
  const asyncDir = join(root, "async");
  const runCwd = join(root, "run");
  const parentCwd = join(root, "parent");
  const artifactsDir = join(runCwd, ".pi-subagents", "artifacts");
  await Promise.all([mkdir(asyncDir), mkdir(artifactsDir, { recursive: true }), mkdir(parentCwd)]);
  return { root, asyncDir, runCwd, parentCwd, artifactsDir };
}

test("allocates only the checked status size plus one byte", async (t) => {
  const { root, asyncDir } = await makeFixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const statusText = JSON.stringify({ state: "running" });
  await writeFile(join(asyncDir, "status.json"), statusText);

  const originalAllocUnsafe = Buffer.allocUnsafe;
  const allocations = [];
  Buffer.allocUnsafe = (size) => {
    allocations.push(size);
    return originalAllocUnsafe(size);
  };
  t.after(() => {
    Buffer.allocUnsafe = originalAllocUnsafe;
  });

  assert.deepEqual(adapter.readBrowserRunStatus(asyncDir), { state: "running" });
  assert.deepEqual(allocations, [Buffer.byteLength(statusText) + 1]);
});

test("reads bounded object status and renders the upstream transcript", async (t) => {
  const { root, asyncDir, runCwd, parentCwd, artifactsDir } = await makeFixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const transcriptPath = join(artifactsDir, "executor.jsonl");
  await writeFile(join(asyncDir, "status.json"), JSON.stringify({
    runId: "run-1",
    state: "running",
    steps: [{ agent: "executor", status: "running", transcriptPath, tokens: { total: 1234 } }],
  }));
  await writeFile(transcriptPath, `${JSON.stringify({ recordType: "message", role: "assistant", text: "child output" })}\n`);

  assert.equal(adapter.readBrowserRunStatus(asyncDir).steps[0].agent, "executor");
  await writeFile(join(asyncDir, "status.json"), JSON.stringify({ payload: " ".repeat(2 * 1024 * 1024) }));
  assert.equal(adapter.readBrowserRunStatus(asyncDir), undefined);
  await writeFile(join(asyncDir, "status.json"), "[]");
  assert.equal(adapter.readBrowserRunStatus(asyncDir), undefined);

  const parentSessionFile = join(root, "sessions", "parent.jsonl");
  const cases = [
    ["project", [asyncDir, artifactsDir, join(parentCwd, ".pi-subagents", "artifacts")]],
    ["session", [asyncDir, join(root, "sessions", "subagent-artifacts")]],
    ["temp", [asyncDir]],
  ];
  for (const [artifactDirPreference, expectedRoots] of cases) {
    const roots = adapter.browserTrustedRoots({
      asyncDir,
      runCwd,
      parentCwd,
      parentSessionFile,
      artifactDirPreference,
    });
    if (artifactDirPreference === "temp") {
      assert.deepEqual(roots.slice(0, 1), expectedRoots, artifactDirPreference);
      assert.equal(roots.length, 2, artifactDirPreference);
    } else {
      assert.deepEqual(roots, expectedRoots, artifactDirPreference);
    }
  }

  const rendered = adapter.renderBrowserTranscript({ transcriptPath, trustedRoots: [artifactsDir], width: 80, theme, markdownTheme });
  assert.match(rendered.lines.join("\n"), /child output/);
  assert.equal(rendered.warning, undefined);
});

test("refuses outside-root and symlink transcript paths", async (t) => {
  const { root, artifactsDir } = await makeFixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const outsidePath = join(root, "outside.jsonl");
  const symlinkPath = join(artifactsDir, "linked.jsonl");
  await writeFile(outsidePath, `${JSON.stringify({ recordType: "message", role: "assistant", text: "secret" })}\n`);
  await symlink(outsidePath, symlinkPath);

  for (const transcriptPath of [outsidePath, symlinkPath]) {
    const rendered = adapter.renderBrowserTranscript({ transcriptPath, trustedRoots: [artifactsDir], width: 80, theme, markdownTheme });
    assert.ok(rendered.warning, transcriptPath);
    assert.doesNotMatch(rendered.lines.join("\n"), /secret/);
  }
});

test("refuses a symlinked final status file", async (t) => {
  const { root, asyncDir } = await makeFixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const outsidePath = join(root, "outside-status.json");
  await writeFile(outsidePath, JSON.stringify({ state: "running" }));
  await symlink(outsidePath, join(asyncDir, "status.json"));

  assert.equal(adapter.readBrowserRunStatus(asyncDir), undefined);
});