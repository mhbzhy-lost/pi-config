import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { createSecurityGatesExtension } from "../scripts/lib/security-gates-extension.mjs";

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function setup() {
  const handlers = new Map();
  createSecurityGatesExtension({
    on(name, handler) {
      handlers.set(name, handler);
    },
  });
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

test("tool_call ignores forged bash input directories and uses only context cwd", async () => {
  const handlers = setup();
  const result = await handlers.get("tool_call")(
    {
      toolName: "bash",
      input: {
        command: "rm -rf outside",
        workdir: "/Users/shared",
        cwd: "/Users/shared",
      },
    },
    { cwd: workspace },
  );

  assert.equal(result, undefined);
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

test("tool_call runs external review only for permitted real git push commands", async () => {
  const calls = [];
  const handlers = new Map();
  createSecurityGatesExtension({
    on(name, handler) {
      handlers.set(name, handler);
    },
  }, {
    runExternalReview: async (options) => {
      calls.push(options);
      return { block: true, reason: "review denied" };
    },
    hookPath: "/hooks/external-review-gate.sh",
    logPath: "/pi-config/var/logs/external-review-gate.log",
  });

  const denied = await handlers.get("tool_call")(
    { toolName: "bash", input: { command: "git push origin main" } },
    { cwd: workspace },
  );
  const dryRun = await handlers.get("tool_call")(
    { toolName: "bash", input: { command: "git push --dry-run origin main" } },
    { cwd: workspace },
  );
  const skipped = await handlers.get("tool_call")(
    { toolName: "bash", input: { command: "EXTERNAL_REVIEW_SKIP=1 git push origin main" } },
    { cwd: workspace },
  );

  assert.equal(denied.block, true);
  assert.equal(denied.reason, "review denied");
  assert.equal(dryRun, undefined);
  assert.equal(skipped, undefined);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "git push origin main");
  assert.equal(calls[0].hookPath, "/hooks/external-review-gate.sh");
  assert.equal(calls[0].logPath, "/pi-config/var/logs/external-review-gate.log");
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
