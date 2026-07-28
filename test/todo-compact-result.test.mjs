import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti.mjs";

const jiti = createJiti(import.meta.url, {
  moduleCache: false,
  alias: {
    "@earendil-works/pi-ai": "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/index.js",
    "@earendil-works/pi-coding-agent": "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/index.js",
    "@earendil-works/pi-tui": "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-tui/dist/index.js",
    "typebox/value": "/Users/leshi.zhy/pi-config/pi/npm/node_modules/typebox/build/value/index.mjs",
    typebox: "/Users/leshi.zhy/pi-config/pi/npm/node_modules/typebox/build/index.mjs",
  },
});
const todoRendererModule = await jiti.import("../pi/extensions/todo-compact-renderer.ts").catch(() => undefined);

const theme = {
  bold: (text) => text,
  fg: (_color, text) => text,
};

function registerTodoDefinition() {
  assert.ok(todoRendererModule, "tracked todo compact renderer should load");
  let definition;
  todoRendererModule.default({
    registerTool(tool) { definition = tool; },
    registerCommand() {},
    registerShortcut() {},
    on() {},
  });
  assert.ok(definition, "todo compact renderer should register the upstream tool");
  return definition;
}

test("todo compact rendering lives in a tracked reload-safe extension", async () => {
  const source = await readFile(
    new URL("../pi/extensions/todo-compact-renderer.ts", import.meta.url),
    "utf8",
  ).catch(() => "");

  assert.ok(todoRendererModule, "tracked todo compact renderer should exist");
  assert.doesNotMatch(source, /view\/format|compact-result\.mjs/);
  assert.equal(todoRendererModule.TODO_CALL_PREFIX, "∗ ");
  assert.equal(todoRendererModule.TODO_RESULT_PREFIX, "  └ ");
});

test("todo keeps the upstream execution and renders collapsed action/status on one line", async () => {
  const definition = registerTodoDefinition();
  assert.equal(definition.renderShell, "self");

  const result = await definition.execute(
    "todo-test-call",
    { action: "create", subject: "Record regression" },
    undefined,
    undefined,
    { sessionManager: { getSessionId: () => "todo-renderer-test" } },
  );
  assert.equal(result.details.tasks[0].subject, "Record regression");

  const context = { expanded: false, state: {} };
  const call = definition.renderCall(
    { action: "create", subject: "Record regression" },
    theme,
    context,
  );
  const output = definition.renderResult(result, { expanded: false }, theme, context);
  const lines = [...call.render(120), ...output.render(120)].filter((line) => line.trim());

  assert.deepEqual(lines, ["∗ todo + Record regression · ○ pending"]);
});

test("todo expanded rendering preserves call/result hierarchy markers", async () => {
  const definition = registerTodoDefinition();
  const result = await definition.execute(
    "todo-expanded-call",
    { action: "create", subject: "Inspect details" },
    undefined,
    undefined,
    { sessionManager: { getSessionId: () => "todo-renderer-expanded-test" } },
  );
  const context = { expanded: true, state: {} };

  assert.match(
    definition.renderCall({ action: "create", subject: "Inspect details" }, theme, context).render(120)[0],
    /^∗ todo \+ Inspect details/,
  );
  assert.equal(
    definition.renderResult(result, { expanded: true }, theme, context).render(120)[0],
    "  └ ○ pending",
  );
});

test("todo list and clear actions use readable labels", () => {
  assert.ok(todoRendererModule, "tracked todo compact renderer should load");
  assert.equal(todoRendererModule.formatCompactAction("list"), "list");
  assert.equal(todoRendererModule.formatCompactAction("clear"), "clear");
  assert.equal(todoRendererModule.formatCompactAction("update"), "→");
});

const tasks = [
  { id: 1, subject: "First task", status: "completed" },
  { id: 2, subject: "Second task", status: "in_progress" },
  { id: 3, subject: "Deleted task", status: "deleted" },
];

test("todo list summary reports visible task count", () => {
  assert.ok(todoRendererModule, "tracked todo compact renderer should load");
  assert.equal(todoRendererModule.formatCompactResultSummary({ action: "list", tasks, params: {} }, ""), "2 tasks");
});

test("todo filtered list summary reports matching task count and status", () => {
  assert.ok(todoRendererModule, "tracked todo compact renderer should load");
  assert.equal(
    todoRendererModule.formatCompactResultSummary({ action: "list", tasks, params: { status: "completed" } }, ""),
    "1 completed task",
  );
});

test("todo get summary includes status and subject", () => {
  assert.ok(todoRendererModule, "tracked todo compact renderer should load");
  assert.equal(
    todoRendererModule.formatCompactResultSummary({ action: "get", tasks, params: { id: 2 } }, ""),
    "in progress · Second task",
  );
});

test("todo clear summary preserves its result copy", () => {
  assert.ok(todoRendererModule, "tracked todo compact renderer should load");
  assert.equal(
    todoRendererModule.formatCompactResultSummary({ action: "clear", tasks: [], params: {} }, "Cleared 3 tasks"),
    "Cleared 3 tasks",
  );
});

test("rpiv-todo package extension is disabled because the tracked wrapper owns registration", async () => {
  const settings = JSON.parse(await readFile(new URL("../pi/settings.json", import.meta.url), "utf8"));
  const configured = settings.packages.find((entry) => {
    const source = typeof entry === "string" ? entry : entry.source;
    return source === "npm:@juicesharp/rpiv-todo";
  });

  assert.deepEqual(configured, {
    source: "npm:@juicesharp/rpiv-todo",
    extensions: [],
  });
});
