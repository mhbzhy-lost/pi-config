import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { createJiti } from "../packages/pi-subagents-enhanced/node_modules/jiti/lib/jiti.mjs";

const jiti = createJiti(import.meta.url, { interopDefault: true });
const { compileCodingDispatchIR } = await jiti.import("../packages/pi-subagents-enhanced/src/contracts/dispatch-ir.ts");
const repoRoot = dirname(new URL(import.meta.url).pathname);
const overrideSkill = join(repoRoot, "..", "skill-overrides", "subagent-dispatch", "SKILL.md");
const installedSkill = "/Users/leshi.zhy/.agents/skills/subagent-dispatch/SKILL.md";

function withWritePaths(writePaths) {
  return compileCodingDispatchIR({
    version: "dispatch-ir.v1", taskId: "grammar-probe", title: "writePaths 文法探针", agent: "executor", risk: "low",
    objective: "验证 writePaths 文法与错误可行动性。", requirements: ["只读验证。"],
    context: { knownFacts: [], decisions: [], relevantFiles: [] },
    boundaries: { writePaths, excludedWork: [], forbiddenActions: [] },
    acceptance: { criteria: ["文法判定符合规格。"] }, execution: { timeoutMs: 1000 },
  }, { cwd: "/repo" });
}

test("合法文法全部通过且规范化正确", () => {
  assert.deepEqual(withWritePaths(["README.md"]).boundaries.writePaths, ["README.md"]);
  assert.deepEqual(withWritePaths(["src/index.ts"]).boundaries.writePaths, ["src/index.ts"]);
  assert.deepEqual(withWritePaths([".github/workflows/ci.yml"]).boundaries.writePaths, [".github/workflows/ci.yml"]);
  assert.deepEqual(withWritePaths(["src/**"]).boundaries.writePaths, ["src/**"]);
  assert.deepEqual(withWritePaths(["packages/a/src/**"]).boundaries.writePaths, ["packages/a/src/**"]);
  assert.deepEqual(withWritePaths(["  src/index.ts  "]).boundaries.writePaths, ["src/index.ts"]);
  assert.deepEqual(withWritePaths(["src"]).boundaries.writePaths, ["src"]);
  assert.deepEqual(withWritePaths([]).boundaries.writePaths, []);
});

const CASES = [
  { input: "/**", re: /must not be "\/\*\*"/ }, { input: "/Users/me/repo/src/a.ts", re: /must be repo-relative/ },
  { input: "C:/repo/a.ts", re: /must be repo-relative/ }, { input: "\\\\server\\share\\a.ts", re: /must be repo-relative/ },
  { input: "src\\a.ts", re: /POSIX '\/' separators/ }, { input: "src\u0000a.ts", re: /must not contain NUL/ },
  { input: "src/", re: /must not end with '\/'/ }, { input: "docs/plans/", re: /must not end with '\/'/ },
  { input: "src/*", re: /unsupported glob character "\*"/ }, { input: "src/**/*.ts", re: /unsupported glob character/ },
  { input: "src/**/a.ts", re: /unsupported glob character/ }, { input: "a/**/**", re: /unsupported glob character/ },
  { input: "src/**x", re: /unsupported glob character/ }, { input: "src/file?.ts", re: /unsupported glob character "\?"/ },
  { input: "src/[ab].ts", re: /unsupported glob character "\["/ }, { input: "./src/a.ts", re: /unsafe path segment "\."/ },
  { input: "src/../a.ts", re: /unsafe path segment "\.\."/ }, { input: "src//a.ts", re: /unsafe path segment ""/ },
  { input: "src//**", re: /must not end with '\/'|unsafe path segment/ },
];

test("非法输入命中专属分类文案，且回显实际值与合法示例", () => {
  for (const { input, re } of CASES) assert.throws(() => withWritePaths([input]), (error) => {
    assert.equal(error.code, "INVALID_PATH"); assert.match(error.message, re);
    assert.ok(error.message.includes(JSON.stringify(input).slice(1, -1)) || error.message.includes("NUL"));
    assert.match(error.message, /src\/\*\*|src\/a\.ts/); assert.match(error.message, /boundaries\.writePaths\[0\]/); return true;
  });
});

test("keypath 指向出错的具体下标", () => assert.throws(() => withWritePaths(["src/ok.ts", "/abs/bad.ts"]), (error) => error.message.includes("boundaries.writePaths[1]")));

test("context.relevantFiles 复用同一文法，keypath 正确且示例仍适用", () => assert.throws(() => compileCodingDispatchIR({
  version: "dispatch-ir.v1", taskId: "rf-probe", title: "relevantFiles 文法", agent: "executor", risk: "low", objective: "验证。", requirements: ["只读验证。"],
  context: { knownFacts: [], decisions: [], relevantFiles: ["/abs/path.ts"] }, boundaries: { writePaths: [], excludedWork: [], forbiddenActions: [] },
  acceptance: { criteria: ["文法一致。"] }, execution: { timeoutMs: 1000 },
}, { cwd: "/repo" }), (error) => error.code === "INVALID_PATH" && /context\.relevantFiles\[0\]/.test(error.message) && /must be repo-relative/.test(error.message)));

test("SKILL 副本不再声称目录范围可以尾随斜杠", () => {
  const override = readFileSync(overrideSkill, "utf8");
  assert.equal(override.includes("目录范围 `writePaths` 必须以 `/**` 或 `/` 结尾（如 `src/**` 或 `src/`）；裸路径按精确文件匹配。"), false);
  const expected = "`writePaths` 的文法只有一种：仓库相对 POSIX 路径，写作精确路径（`src/a.ts`）或末尾带 `/**` 的递归目录范围（`src/**`）。唯一支持的目录范围写法是末尾 `/**`；尾随 `/` 会被拒绝（`src/` 非法，必须写 `src/**`），末尾 `/**` 之外的任何 `* ? [ ]` 均非法，`.`/`..`/空段非法，绝对路径、Windows 盘符、UNC、反斜杠与 NUL 均非法。裸路径（如 `src`）按精确条目匹配，不展开为目录范围。`writePaths` 可以是空数组，表示显式只读派发。";
  assert.ok(override.includes(expected));
});

test("已安装 SKILL 副本存在时与仓库副本逐字一致，不存在时 skip", (t) => {
  if (!existsSync(installedSkill)) { t.skip("已安装副本不存在于本环境"); return; }
  assert.equal(readFileSync(installedSkill, "utf8"), readFileSync(overrideSkill, "utf8"));
});
