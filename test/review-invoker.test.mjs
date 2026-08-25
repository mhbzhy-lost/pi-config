import assert from "node:assert/strict";
import test from "node:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSections, shouldExempt, buildDenyReason, runReview, workspaceReviewBypass } from "../scripts/lib/review-invoker.mjs";

test("parseSections 检测 Critical 段落有内容", () => {
  const text = "### Critical\n\n1. SQL injection in user input\n\n### Minor\n\nNone.";
  const result = parseSections(text);
  assert.equal(result.hasCritical, true);
  assert.equal(result.hasImportant, false);
  assert.equal(result.hasMinor, false);
});

test("parseSections 检测 Important 段落有内容", () => {
  const text = "### Critical\n\nNone.\n\n### Important\n\n1. Missing validation\n\n### Minor\n\nNone.";
  const result = parseSections(text);
  assert.equal(result.hasCritical, false);
  assert.equal(result.hasImportant, true);
  assert.equal(result.hasMinor, false);
});

test("parseSections 识别 None/N/A 为无问题", () => {
  const text = "### Critical\n\nNone.\n\n### Important\n\nN/A\n\n### Minor\n\n- typo in readme";
  const result = parseSections(text);
  assert.equal(result.hasCritical, false);
  assert.equal(result.hasImportant, false);
  assert.equal(result.hasMinor, true);
});

test("parseSections 识别 _(none)_ 为无问题", () => {
  const text = "#### Critical (Must Fix)\n\n_(none)_\n\n#### Important\n\nSome issue here";
  const result = parseSections(text);
  assert.equal(result.hasCritical, false);
  assert.equal(result.hasImportant, true);
});

test("parseSections 空 review 返回全 false", () => {
  const result = parseSections("");
  assert.equal(result.hasCritical, false);
  assert.equal(result.hasImportant, false);
  assert.equal(result.hasMinor, false);
});

test("shouldExempt 小于阈值行数放行", () => {
  assert.equal(shouldExempt({ totalLines: 8, allNonCode: false, hasBinary: false }), true);
});

test("shouldExempt 全非代码文件放行", () => {
  assert.equal(shouldExempt({ totalLines: 500, allNonCode: true, hasBinary: false }), true);
});

test("shouldExempt 二进制文件不豁免", () => {
  assert.equal(shouldExempt({ totalLines: 5, allNonCode: false, hasBinary: true }), false);
});

test("shouldExempt 大代码变更不豁免", () => {
  assert.equal(shouldExempt({ totalLines: 100, allNonCode: false, hasBinary: false }), false);
});

test("buildDenyReason 包含 review 输出和综合判断框架", () => {
  const reason = buildDenyReason({ reviewOutput: "### Critical\n\n1. Bug", range: "origin/main..HEAD", cwd: "/repo", fileCount: 3 });
  assert.match(reason, /禁止 push/);
  assert.match(reason, /Review range: origin\/main\.\.HEAD/);
  assert.match(reason, /Review file count: 3/);
  assert.match(reason, /综合判断/);
  assert.match(reason, /### Critical\n\n1\. Bug/);
});

test("workspaceReviewBypass 仅接受 .push-gate.json 中严格布尔 true", async () => {
  const dir = await mkdtemp(join(tmpdir(), "review-invoker-"));
  try {
    assert.equal(await workspaceReviewBypass({ cwd: dir }), false, "文件缺失不绕过");

    await writeFile(join(dir, ".push-gate.json"), "{");
    assert.equal(await workspaceReviewBypass({ cwd: dir }), false, "非法 JSON 不绕过");

    await writeFile(join(dir, ".push-gate.json"), JSON.stringify({ bypassReview: false }));
    assert.equal(await workspaceReviewBypass({ cwd: dir }), false, "false 不绕过");

    await writeFile(join(dir, ".push-gate.json"), JSON.stringify({ bypassReview: "true" }));
    assert.equal(await workspaceReviewBypass({ cwd: dir }), false, "字符串 true 不绕过");

    await writeFile(join(dir, ".push-gate.json"), JSON.stringify({ bypassReview: 1 }));
    assert.equal(await workspaceReviewBypass({ cwd: dir }), false, "数字 1 不绕过");

    await writeFile(join(dir, ".push-gate.json"), JSON.stringify([true]));
    assert.equal(await workspaceReviewBypass({ cwd: dir }), false, "非对象结构不绕过");

    await writeFile(join(dir, ".push-gate.json"), JSON.stringify({ bypassReview: true }));
    assert.equal(await workspaceReviewBypass({ cwd: dir }), true, "严格布尔 true 绕过");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runReview 按 Anthropic 后 Idealab OpenAI 的顺序 fallback", async () => {
  const dir = await mkdtemp(join(tmpdir(), "review-invoker-"));
  const logPath = join(dir, "providers.log");
  const uvPath = join(dir, "uv");
  await writeFile(uvPath, `#!/bin/sh
printf '%s\\n' "$@" >> "${logPath}"
provider=
for arg in "$@"; do
  if [ "$previous" = "--provider" ]; then provider="$arg"; fi
  previous="$arg"
done
if [ "$provider" = "idealab-openai" ]; then
  printf 'review output\\n'
  exit 0
fi
exit 1
`);
  await chmod(uvPath, 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = `${dir}:${previousPath}`;
  try {
    const result = await runReview({
      cwd: dir,
      baseRef: "origin/main",
      round: 1,
      reviewerPy: "/reviewer.py",
      envFile: "/ignored.env",
      timeoutMs: 10_000,
    });
    const providers = (await readFile(logPath, "utf8"))
      .trim()
      .split("\n")
      .filter((arg, index, args) => args[index - 1] === "--provider");
    assert.deepEqual(providers, [
      "idealab-anthropic",
      "idealab-openai",
    ]);
    const argv = (await readFile(logPath, "utf8")).trim().split("\n");
    assert.equal(argv.filter((arg) => arg === "--api-timeout-seconds").length, 2);
    assert.equal(argv.filter((arg) => arg === "600").length, 2);
    assert.equal(result.provider, "idealab-openai");
  } finally {
    process.env.PATH = previousPath;
    await rm(dir, { recursive: true, force: true });
  }
});
