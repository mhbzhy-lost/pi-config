import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import test from "node:test";
import { createSecurityGatesExtension } from "../src/security-gates/extension.ts";

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

test("shell policy allows ordinary git push without invoking external review", async () => {
  let gatherCalls = 0;
  let reviewCalls = 0;
  const handlers = setup({
    shellPolicy: () => undefined,
    workspaceBypass: async () => false,
    gatherDiffInfo: async () => { gatherCalls++; return {}; },
    runReview: async () => { reviewCalls++; return { output: null }; },
  });

  const result = await handlers.get("tool_call")(
    { toolName: "bash", input: { command: "git push origin main" } },
    { cwd: workspace },
  );

  assert.equal(result, undefined);
  assert.equal(gatherCalls, 0);
  assert.equal(reviewCalls, 0);
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
