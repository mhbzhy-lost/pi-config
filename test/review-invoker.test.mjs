import assert from "node:assert/strict";
import test from "node:test";
import { parseSections, shouldExempt, buildDenyReason } from "../scripts/lib/review-invoker.mjs";

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
