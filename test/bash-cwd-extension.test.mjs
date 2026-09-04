import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { createBashCwdExtension } from "../src/bash-cwd/extension.ts";
import { loadPiTestRuntime } from "./helpers/pi-runtime.mjs";

async function withWorkspace(run) {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "bash-cwd-extension-"));
  try {
    await run(workspaceRoot);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
}

function setup({ workspaceRoot, options = { commandPrefix: "source ~/.profile", shellPath: "/bin/zsh" } } = {}) {
  let registered;
  const factoryCalls = [];
  const executions = [];
  const factory = (cwd, factoryOptions) => {
    factoryCalls.push({ cwd, options: factoryOptions });
    return {
      name: "bash",
      description: "base description",
      promptGuidelines: ["base guideline"],
      parameters: {
        type: "object",
        properties: { command: { type: "string" } },
        required: ["command"],
      },
      renderCall: "render-call",
      renderResult: "render-result",
      async execute(id, input, signal, onUpdate, ctx) {
        executions.push({ cwd, id, input, signal, onUpdate, ctx });
        return { content: [{ type: "text", text: cwd }] };
      },
    };
  };
  createBashCwdExtension({
    registerTool(definition) {
      registered = definition;
    },
  }, {
    workspaceRoot,
    createBashToolDefinition: factory,
    getBashOptions: () => options,
  });
  return { registered, factoryCalls, executions };
}

test("registers a same-name bash override with the base presentation fields and cwd parameter", async () => {
  await withWorkspace(async (workspaceRoot) => {
    const { registered } = setup({ workspaceRoot });

    assert.equal(registered.name, "bash");
    assert.equal(registered.description, "base description");
    assert.equal(registered.renderCall, "render-call");
    assert.equal(registered.renderResult, "render-result");
    assert.deepEqual(registered.promptGuidelines, ["base guideline", "可选；命令在此目录执行；必须在工作区内"]);
    assert.equal(registered.parameters.properties.cwd.type, "string");
    assert.match(registered.parameters.properties.cwd.description, /可选；命令在此目录执行；必须在工作区内/);
  });
});

test("delegates bash without cwd to the original definition", async () => {
  await withWorkspace(async (workspaceRoot) => {
    const { registered, factoryCalls, executions } = setup({ workspaceRoot });
    const signal = new AbortController().signal;
    const onUpdate = () => {};
    const ctx = { cwd: workspaceRoot };

    await registered.execute("call-1", { command: "pwd", timeout: 5 }, signal, onUpdate, ctx);

    assert.equal(factoryCalls.length, 1);
    assert.deepEqual(executions, [{
      cwd: workspaceRoot,
      id: "call-1",
      input: { command: "pwd", timeout: 5 },
      signal,
      onUpdate,
      ctx,
    }]);
  });
});

test("delegates bash with validated cwd through a factory definition using mirrored options", async () => {
  await withWorkspace(async (workspaceRoot) => {
    const nested = join(workspaceRoot, "packages", "app");
    await mkdir(nested, { recursive: true });
    const { registered, factoryCalls, executions } = setup({ workspaceRoot });

    await registered.execute("call-2", { command: "pwd", cwd: "packages/app" }, undefined, undefined, { cwd: workspaceRoot });

    assert.equal(factoryCalls.length, 2);
    assert.deepEqual(factoryCalls[1], {
      cwd: await (await import("node:fs/promises")).realpath(nested),
      options: { commandPrefix: "source ~/.profile", shellPath: "/bin/zsh" },
    });
    assert.equal(executions[0].input.cwd, undefined);
    assert.equal(executions[0].input.command, "pwd");
  });
});

test("rejects invalid declared cwd before executing bash", async () => {
  await withWorkspace(async (workspaceRoot) => {
    const { registered, factoryCalls, executions } = setup({ workspaceRoot });

    await assert.rejects(
      registered.execute("call-3", { command: "pwd", cwd: "../outside" }, undefined, undefined, { cwd: workspaceRoot }),
      /工作区|cwd/i,
    );
    assert.equal(factoryCalls.length, 1);
    assert.deepEqual(executions, []);
  });
});

test("bash-cwd keeps the compact bash renderers while remaining the sole bash owner", async () => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "bash-cwd-renderer-"));
  try {
    const extensionSource = await readFile(new URL("../pi/extensions/bash-cwd.ts", import.meta.url), "utf8");
    const mockPath = join(temporaryDirectory, "pi-mock.mjs");
    const tuiPath = join(temporaryDirectory, "tui-mock.mjs");
    const extensionPath = join(temporaryDirectory, "bash-cwd.ts");
    const bashCwdExtensionUrl = pathToFileURL(new URL("../src/bash-cwd/extension.ts", import.meta.url).pathname).href;
    const compactRendererUrl = pathToFileURL(new URL("../src/compact-tools/renderer.ts", import.meta.url).pathname).href;

    await writeFile(mockPath, `
export class SettingsManager {
  static create() { return { getShellCommandPrefix: () => undefined, getShellPath: () => undefined }; }
}
export function createBashToolDefinition() {
  return {
    name: "bash", parameters: { type: "object", properties: {} }, promptGuidelines: [],
    renderCall: "native-call", renderResult: "native-result", execute() {},
  };
}
`);
    await writeFile(tuiPath, "export class Container {} export class Text {} export const sliceByColumn = () => ''; export const truncateToWidth = () => ''; export const visibleWidth = () => 0;");
    const source = extensionSource
      .replace("@earendil-works/pi-coding-agent", pathToFileURL(mockPath).href)
      .replace("@earendil-works/pi-tui", pathToFileURL(tuiPath).href)
      .replace("../../src/bash-cwd/extension.ts", bashCwdExtensionUrl)
      .replace("../../src/compact-tools/renderer.ts", compactRendererUrl);
    await writeFile(extensionPath, source);

    const { jiti } = await loadPiTestRuntime(import.meta.url);
    const { default: bashCwd } = await jiti.import(extensionPath);
    const registered = [];
    bashCwd({ registerTool: (tool) => registered.push(tool) });

    assert.equal(registered.length, 1);
    assert.equal(registered[0].name, "bash");
    assert.equal(registered[0].renderShell, "self");
    assert.equal(typeof registered[0].renderCall, "function");
    assert.equal(typeof registered[0].renderResult, "function");
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("bash-cwd explicitly owns its renderShell setting", async () => {
  const extensionSource = await readFile(new URL("../pi/extensions/bash-cwd.ts", import.meta.url), "utf8");

  assert.match(extensionSource, /renderShell:\s*["']self["']/);
});
