import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "../packages/pi-subagents-enhanced/node_modules/jiti/lib/jiti.mjs";

const jiti = createJiti(import.meta.url, { interopDefault: true });
const mod = await jiti.import("../packages/pi-subagents-enhanced/src/workspace/git-worktree.ts");
const { classifyGitFailure, redactGitText } = mod;
assert.equal(typeof classifyGitFailure, "function", "classifyGitFailure 必须已导出");
assert.equal(typeof redactGitText, "function", "redactGitText 必须已导出");

const args = ["worktree", "remove", "/Users/someone/var/workspaces/wt"];
const cause = (stderr) => Object.assign(new Error("git failed"), { stderr, status: 128 });

test("stderr 合并文案只归类 dirty-worktree", () => {
  const d = classifyGitFailure({ args, cause: cause("contains modified or untracked files") });
  assert.deepEqual([...d.categories], ["dirty-worktree"]);
  assert.equal(d.category, "dirty-worktree");
});

test("结构性 stderr 分类", () => {
  for (const [stderr, category] of [
    ["index.lock: File exists", "locked"],
    ["worktree is already locked", "locked"],
    ["does not exist", "path-missing"],
    ["No such file or directory", "path-missing"],
    ["interactive rebase is ongoing", "sequencer-in-progress"],
  ]) assert.equal(classifyGitFailure({ args, cause: cause(stderr) }).category, category);
});

test("porcelain -z 等价解析覆盖 quoted/space/rename/unmerged/submodule", () => {
  const porcelain = " M sub2api\0?? docs/new file.md\0R  old name.md\0new name.md\0UU src/conflict.ts\0";
  const d = classifyGitFailure({ args, cause: cause("contains modified or untracked"), porcelain, submodulePaths: ["sub2api"] });
  assert.deepEqual([...d.categories], ["unmerged-entries", "submodule-dirty", "dirty-worktree", "untracked-files"]);
});

test("ignored 与 modified 多重命中按优先级", () => {
  const d = classifyGitFailure({ args, cause: cause("contains modified"), porcelain: "!! .pi/subagents/artifacts/x\0 M src/a.ts\0" });
  assert.deepEqual([...d.categories], ["dirty-worktree", "ignored-runtime-artifacts"]);
});

test("unknown 透传 bounded stderr，args 与路径脱敏", () => {
  const d = classifyGitFailure({ args, cause: cause("fatal /Users/name/repo managed-workspace-owner.v1:" + "a".repeat(64)) });
  assert.equal(d.category, "unknown");
  assert.ok(d.gitStderr.includes("fatal"));
  assert.equal(JSON.stringify(d).includes("/Users/name"), false);
  assert.equal(JSON.stringify(d).includes("managed-workspace-owner.v1:" + "a"), false);
});

test("stderr/porcelain UTF-8 截断不超过 512 且无替换字符", () => {
  const d = classifyGitFailure({ args, cause: cause("错误".repeat(1000)), porcelain: "状态".repeat(1000) });
  for (const value of [d.gitStderr, d.porcelain]) {
    assert.ok(Buffer.byteLength(value ?? "", "utf8") <= 512);
    assert.match(value ?? "", /truncated/);
    assert.equal(value?.includes("\uFFFD"), false);
  }
});

test("自定义脱敏根路径", () => assert.match(redactGitText("/opt/state/repo", ["/opt/state"]), /<redacted-root>/));
