import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { parseSections, shouldExempt, buildDenyReason, runReview, workspaceReviewBypass } from "../src/security-gates/review-invoker.ts";

const execFileAsync = promisify(execFile);

async function initGitRepository(dir) {
  await execFileAsync("git", ["init", "--quiet"], { cwd: dir });
}

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

test("workspaceReviewBypass 仅接受 Git 仓库根 .push-gate.json 中严格布尔 true", async () => {
  const dir = await mkdtemp(join(tmpdir(), "review-invoker-"));
  try {
    assert.equal(await workspaceReviewBypass({ cwd: dir }), false, "文件缺失不绕过");

    await initGitRepository(dir);

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

test("workspaceReviewBypass 只读取有效 cwd 所属 Git 根配置", async () => {
  const root = await mkdtemp(join(tmpdir(), "review-invoker-root-"));
  const rootChild = join(root, "packages", "app");
  const nested = join(root, "vendor", "nested");
  const nestedChild = join(nested, "src");
  try {
    await mkdir(rootChild, { recursive: true });
    await mkdir(nestedChild, { recursive: true });
    await initGitRepository(root);
    await initGitRepository(nested);

    await writeFile(join(root, ".push-gate.json"), JSON.stringify({ bypassReview: true }));
    assert.equal(await workspaceReviewBypass({ cwd: rootChild }), true, "根仓普通子目录使用根配置");
    assert.equal(await workspaceReviewBypass({ cwd: nested }), false, "嵌套仓不受外层根配置控制");

    await writeFile(join(nested, ".push-gate.json"), JSON.stringify({ bypassReview: true }));
    assert.equal(await workspaceReviewBypass({ cwd: nestedChild }), true, "嵌套仓普通子目录使用嵌套根配置");

    await writeFile(join(root, ".push-gate.json"), JSON.stringify({ bypassReview: false }));
    await writeFile(join(rootChild, ".push-gate.json"), JSON.stringify({ bypassReview: true }));
    assert.equal(await workspaceReviewBypass({ cwd: rootChild }), false, "非仓库子目录配置不能绕过");
  } finally {
    await rm(root, { recursive: true, force: true });
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
      diagnosticSink: () => { throw new Error("diagnostic sink unavailable"); },
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

test("runReview 在 provider 失败时报告原始有界诊断，同时保持 fallback 和 fail-open", async () => {
  const dir = await mkdtemp(join(tmpdir(), "review-invoker-"));
  const uvPath = join(dir, "uv");
  const diagnostics = [];
  const stderr = "API_KEY=super-secret\nAuthorization: Bearer access-token\nhttps://reviewer:password@example.test/path\nprovider failure\n" + "x".repeat(5_000);
  await writeFile(uvPath, `#!/bin/sh
printf '%s' '${stderr}' >&2
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
      diagnosticSink: (message) => diagnostics.push(message),
    });
    assert.deepEqual(result, { output: null, provider: null });
    assert.equal(diagnostics.length, 2);
    assert.match(diagnostics[0], /idealab-anthropic/);
    assert.match(diagnostics[1], /idealab-openai/);
    assert.match(diagnostics[0], /provider failure/);
    assert.match(diagnostics[0], /exit 1/);
    assert.match(diagnostics.join("\n"), /API_KEY=super-secret/);
    assert.match(diagnostics.join("\n"), /Authorization: Bearer access-token/);
    assert.match(diagnostics.join("\n"), /https:\/\/reviewer:password@example\.test\/path/);
    const expectedStderr = stderr.slice(0, 4_096).trim();
    assert.deepEqual(diagnostics, [
      `Push review provider idealab-anthropic exit 1: ${expectedStderr}`,
      `Push review provider idealab-openai exit 1: ${expectedStderr}`,
    ]);
  } finally {
    process.env.PATH = previousPath;
    await rm(dir, { recursive: true, force: true });
  }
});

test("runReview 将多字节 stderr 诊断限制为 4096 UTF-8 bytes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "review-invoker-"));
  const uvPath = join(dir, "uv");
  const diagnostics = [];
  const stderr = "诊断".repeat(2_000);
  await writeFile(uvPath, `#!/bin/sh
printf '%s' '${stderr}' >&2
exit 1
`);
  await chmod(uvPath, 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = `${dir}:${previousPath}`;
  try {
    await runReview({
      cwd: dir,
      baseRef: "origin/main",
      round: 1,
      reviewerPy: "/reviewer.py",
      envFile: "/ignored.env",
      timeoutMs: 10_000,
      diagnosticSink: (message) => diagnostics.push(message),
    });
    const diagnosticBody = diagnostics[0].replace(/^Push review provider idealab-anthropic exit 1: /, "");
    assert.ok(Buffer.byteLength(diagnosticBody, "utf8") <= 4_096);
    assert.equal(diagnosticBody.includes("\uFFFD"), false);
  } finally {
    process.env.PATH = previousPath;
    await rm(dir, { recursive: true, force: true });
  }
});
