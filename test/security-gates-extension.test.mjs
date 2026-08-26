import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import test from "node:test";
import { createSecurityGatesExtension } from "../scripts/lib/security-gates-extension.mjs";

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function setup(opts) {
  const handlers = new Map();
  createSecurityGatesExtension({
    on(name, handler) {
      handlers.set(name, handler);
    },
  }, opts);
  return handlers;
}

test("tool_call blocks bash commands using event input and context cwd", async () => {
  const handlers = setup();
  const result = await handlers.get("tool_call")(
    { toolName: "bash", input: { command: "rm -rf /Users/shared" } },
    { cwd: workspace },
  );

  assert.equal(result.block, true);
  assert.match(result.reason, /workspace 外 rm/);
});

test("tool_call keeps ctx.cwd as shell-policy workspaceRoot while using a valid declared cwd", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "bash-gate-workspace-"));
  const declaredCwd = resolve(root, "packages", "app");
  await mkdir(declaredCwd, { recursive: true });
  const policyCalls = [];
  const handlers = setup({
    shellPolicy: (input) => { policyCalls.push(input); return undefined; },
    workspaceBypass: async () => true,
  });

  try {
    const declaredResult = await handlers.get("tool_call")(
      { toolName: "bash", input: { command: "git push", cwd: "packages/app" } },
      { cwd: root },
    );

    assert.equal(declaredResult, undefined);
    assert.equal(policyCalls.length, 1);
    assert.equal(policyCalls[0].workspaceRoot, root);
    assert.equal(policyCalls[0].cwd, await realpath(declaredCwd));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("tool_call blocks an invalid declared bash cwd", async () => {
  const handlers = setup();
  const result = await handlers.get("tool_call")(
    { toolName: "bash", input: { command: "pwd", cwd: "/Users/shared" } },
    { cwd: workspace },
  );

  assert.equal(result.block, true);
  assert.match(result.reason, /cwd|工作区|安全门禁/i);
});

test("tool_call fails closed when bash context cwd is unavailable", async () => {
  const handlers = setup();
  const result = await handlers.get("tool_call")(
    { toolName: "bash", input: { command: "rm -rf /Users/shared" } },
    {},
  );

  assert.equal(result.block, true);
  assert.match(result.reason, /工作目录|安全门禁/);
});

test("git push --dry-run and EXTERNAL_REVIEW_SKIP bypass review", async () => {
  let reviewCalled = false;
  const handlers = setup({
    gatherDiffInfo: async () => { reviewCalled = true; return { exempt: false, baseRef: "origin/main", range: "origin/main..HEAD", diffHash: "x", fileCount: 1 }; },
    runReview: async () => ({ output: "### Critical\n\n1. Bug", provider: "test" }),
  });

  const dryRun = await handlers.get("tool_call")(
    { toolName: "bash", input: { command: "git push --dry-run origin main" } },
    { cwd: workspace },
  );
  const skipped = await handlers.get("tool_call")(
    { toolName: "bash", input: { command: "EXTERNAL_REVIEW_SKIP=1 git push origin main" } },
    { cwd: workspace },
  );

  assert.equal(dryRun, undefined);
  assert.equal(skipped, undefined);
  assert.equal(reviewCalled, false);
});

test("workspace 声明 bypassReview 时 git push 不收集 diff 或运行 review", async () => {
  const dir = await mkdtemp(resolve(tmpdir(), "push-gate-workspace-"));
  let gatherCalled = false;
  let reviewCalled = false;
  const handlers = setup({
    gatherDiffInfo: async () => { gatherCalled = true; throw new Error("不应收集 diff"); },
    runReview: async () => { reviewCalled = true; throw new Error("不应运行 review"); },
  });
  await writeFile(resolve(dir, ".push-gate.json"), JSON.stringify({ bypassReview: true }));
  await new Promise((resolvePromise, reject) => {
    const child = spawn("git", ["init", "--quiet"], { cwd: dir });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolvePromise() : reject(new Error(`git init failed: ${code}`)));
  });

  try {
    const result = await handlers.get("tool_call")(
      { toolName: "bash", input: { command: "git push origin main" } },
      { cwd: dir },
    );

    assert.equal(result, undefined);
    assert.equal(gatherCalled, false);
    assert.equal(reviewCalled, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("git push 触发 review，有 Critical 时 deny", async () => {
  let reviewCount = 0;
  const handlers = setup({
    gatherDiffInfo: async () => ({ exempt: false, baseRef: "origin/main", range: "origin/main..HEAD", diffHash: "aaa", fileCount: 2 }),
    runReview: async () => { reviewCount++; return { output: "### Critical\n\n1. Bug found\n\n### Minor\n\nNone.", provider: "test" }; },
  });

  const result = await handlers.get("tool_call")(
    { toolName: "bash", input: { command: "git push" } },
    { cwd: "/repo" },
  );

  assert.equal(result.block, true);
  assert.match(result.reason, /禁止 push/);
  assert.match(result.reason, /Bug found/);
  assert.equal(reviewCount, 1);
});

test("git push 相同 diffHash 不重复 review，直接从内存 deny", async () => {
  let reviewCount = 0;
  const handlers = setup({
    gatherDiffInfo: async () => ({ exempt: false, baseRef: "origin/main", range: "origin/main..HEAD", diffHash: "aaa", fileCount: 2 }),
    runReview: async () => { reviewCount++; return { output: "### Critical\n\n1. Bug\n\n### Minor\n\nNone.", provider: "test" }; },
  });

  const handler = handlers.get("tool_call");
  const event = { toolName: "bash", input: { command: "git push" } };
  const ctx = { cwd: "/repo" };

  await handler(event, ctx);
  const r2 = await handler(event, ctx);

  assert.equal(r2.block, true);
  assert.equal(reviewCount, 1);
});

test("git push review 通过时 allow", async () => {
  const handlers = setup({
    gatherDiffInfo: async () => ({ exempt: false, baseRef: "origin/main", range: "origin/main..HEAD", diffHash: "bbb", fileCount: 5 }),
    runReview: async () => ({ output: "### Critical\n\nNone.\n\n### Important\n\nN/A\n\n### Minor\n\n- typo", provider: "test" }),
  });

  const result = await handlers.get("tool_call")(
    { toolName: "bash", input: { command: "git push" } },
    { cwd: "/repo" },
  );

  assert.equal(result, undefined);
});

test("git push 小 diff 豁免不跑 review", async () => {
  let reviewCalled = false;
  const handlers = setup({
    gatherDiffInfo: async () => ({ exempt: true, reason: "small-or-non-code" }),
    runReview: async () => { reviewCalled = true; return { output: null }; },
  });

  const result = await handlers.get("tool_call")(
    { toolName: "bash", input: { command: "git push" } },
    { cwd: "/repo" },
  );

  assert.equal(result, undefined);
  assert.equal(reviewCalled, false);
});

test("git push reviewer 不可用时 fail-open", async () => {
  const handlers = setup({
    gatherDiffInfo: async () => ({ exempt: false, baseRef: "origin/main", range: "origin/main..HEAD", diffHash: "ccc", fileCount: 3 }),
    runReview: async () => ({ output: null, provider: null }),
  });

  const result = await handlers.get("tool_call")(
    { toolName: "bash", input: { command: "git push" } },
    { cwd: "/repo" },
  );

  assert.equal(result, undefined);
});

test("tool_result appends a coding reminder only to successful text content without mutation", async () => {
  const handlers = setup();
  const event = {
    toolName: "write",
    input: { path: "src/app.ts" },
    content: [{ type: "text", text: "Wrote src/app.ts" }],
    details: { changed: true },
    isError: false,
  };

  const result = await handlers.get("tool_result")(event, { cwd: workspace });

  assert.notEqual(result, event);
  assert.notEqual(result.content, event.content);
  assert.match(result.content[0].text, /test-driven-development/);
  assert.equal(event.content[0].text, "Wrote src/app.ts");
  assert.equal(result.details, event.details);
  assert.equal(result.isError, false);
});

test("tool_result leaves errors, image content, and non-source writes unchanged", async () => {
  const handlers = setup();
  const error = {
    toolName: "write",
    input: { path: "src/app.ts" },
    content: [{ type: "text", text: "write failed" }],
    details: { error: "disk full" },
    isError: true,
  };
  const image = {
    toolName: "write",
    input: { path: "src/app.ts" },
    content: [{ type: "image", data: "binary" }],
    details: {},
    isError: false,
  };
  const readme = {
    toolName: "write",
    input: { path: "README.md" },
    content: [{ type: "text", text: "Wrote README.md" }],
    details: {},
    isError: false,
  };

  assert.equal(await handlers.get("tool_result")(error, { cwd: workspace }), undefined);
  assert.equal(await handlers.get("tool_result")(image, { cwd: workspace }), undefined);
  assert.equal(await handlers.get("tool_result")(readme, { cwd: workspace }), undefined);
});

test("tool_call blocks read/write/edit of credential files", async () => {
  const handlers = setup();
  const handler = handlers.get("tool_call");

  for (const path of [
    "pi/auth.json",
    "../.local/share/opencode/auth.json",
    "~/.local/share/opencode/auth.json",
    "~/.local/share/opencode/mcp-auth.json",
    ".env",
    ".env.local",
    ".env.production",
    "config/.env.staging",
  ]) {
    for (const toolName of ["read", "write", "edit"]) {
      const result = await handler(
        { toolName, input: { path } },
        { cwd: workspace },
      );
      assert.equal(result?.block, true, `${toolName} ${path} should be blocked`);
    }
  }
});

test("tool_call allows safe env-like and documentation files", async () => {
  const handlers = setup();
  const handler = handlers.get("tool_call");

  for (const path of [
    ".env.example",
    ".env.sample",
    ".env.template",
    "docs/auth-setup.md",
    "src/config.json",
  ]) {
    for (const toolName of ["read", "write", "edit"]) {
      const result = await handler(
        { toolName, input: { path } },
        { cwd: workspace },
      );
      assert.equal(result, undefined, `${toolName} ${path} should be allowed`);
    }
  }
});

test("tool_call blocks destructive git via bash shell-policy", async () => {
  const handlers = setup();
  const handler = handlers.get("tool_call");

  const result = await handler(
    { toolName: "bash", input: { command: "git reset --hard HEAD~1" } },
    { cwd: workspace },
  );
  assert.equal(result.block, true);
  assert.match(result.reason, /不可逆 Git/);
});
