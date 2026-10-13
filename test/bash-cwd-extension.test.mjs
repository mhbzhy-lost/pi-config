import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
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

function setup({ workspaceRoot, options = { commandPrefix: "source ~/.profile", shellPath: "/bin/zsh" }, getBashOptions } = {}) {
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
        const baseContext = {
          command: factoryOptions?.commandPrefix
            ? `${factoryOptions.commandPrefix}\n${input.command}`
            : input.command,
          cwd: ctx?.cwd || cwd,
          env: { PI_TEST: "1" },
        };
        const spawnContext = factoryOptions?.spawnHook?.(baseContext) ?? baseContext;
        executions.push({ cwd, id, input, signal, onUpdate, ctx, spawnContext });
        return { content: [{ type: "text", text: spawnContext.cwd }] };
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
    getBashOptions: getBashOptions ?? ((ctx) => ctx ? options : {}),
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
    assert.deepEqual(registered.promptGuidelines, ["base guideline", "可选；命令在此目录执行"]);
    assert.equal(registered.parameters.properties.cwd.type, "string");
    assert.match(registered.parameters.properties.cwd.description, /可选；命令在此目录执行/);
  });
});

test("delegates bash without cwd using current context options and native cwd precedence", async () => {
  await withWorkspace(async (workspaceRoot) => {
    const optionContexts = [];
    const { registered, factoryCalls, executions } = setup({ workspaceRoot, getBashOptions(ctx) {
      optionContexts.push(ctx);
      return ctx ? { commandPrefix: "source ~/.profile", shellPath: "/bin/zsh" } : {};
    } });
    assert.deepEqual(optionContexts, []);
    const signal = new AbortController().signal;
    const onUpdate = () => {};
    const ctx = { cwd: join(workspaceRoot, "context-directory") };

    await registered.execute("call-1", { command: "pwd", timeout: 5 }, signal, onUpdate, ctx);

    assert.equal(factoryCalls.length, 2);
    assert.deepEqual(factoryCalls[0], { cwd: workspaceRoot, options: {} });
    assert.deepEqual(factoryCalls[1], { cwd: workspaceRoot, options: {
      commandPrefix: "source ~/.profile",
      shellPath: "/bin/zsh",
    } });
    assert.deepEqual(executions, [{
      cwd: workspaceRoot,
      id: "call-1",
      input: { command: "pwd", timeout: 5 },
      signal,
      onUpdate,
      ctx,
      spawnContext: {
        command: "source ~/.profile\npwd",
        cwd: ctx.cwd,
        env: { PI_TEST: "1" },
      },
    }]);
    await registered.execute("call-no-context", { command: "pwd" }, signal, onUpdate, undefined);
    assert.deepEqual(optionContexts, [ctx, undefined]);
    assert.equal(factoryCalls.length, 3);
    assert.deepEqual(factoryCalls[2].options, {});
    assert.equal(executions[1].spawnContext.cwd, workspaceRoot);
    assert.equal(executions[1].spawnContext.command, "pwd");
  });
});

test("delegates bash with validated cwd through native spawnHook and fake operations", async () => {
  await withWorkspace(async (workspaceRoot) => {
    const nested = join(workspaceRoot, "packages", "app");
    await mkdir(nested, { recursive: true });
    const { codingAgent } = await loadPiTestRuntime(import.meta.url);
    const factoryCalls = [];
    const optionContexts = [];
    const executions = [];
    const hookContexts = [];
    const signal = new AbortController().signal;
    const updates = [];
    const onUpdate = (update) => updates.push(update);
    const ctx = {
      cwd: workspaceRoot,
      sessionManager: { getSessionId: () => "fake-session", getSessionFile: () => "/fake/session.jsonl" },
      model: { provider: "fake-provider", id: "fake-model" },
      thinkingLevel: "high",
      isProjectTrusted: () => true,
    };
    const options = {
      commandPrefix: "fake-prefix",
      shellPath: "/fake/shell",
      operations: { async exec(command, cwd, backendOptions) {
        executions.push({ command, cwd, backendOptions });
        backendOptions.onData(Buffer.from("fake-output"));
        return { exitCode: 0 };
      } },
      spawnHook(spawnContext) {
        hookContexts.push(spawnContext);
        return { command: `hook:${spawnContext.command}`, cwd: "/hook/cwd", env: { ...spawnContext.env, FAKE_HOOK: "1" } };
      },
    };
    let registered;
    createBashCwdExtension({ registerTool: (tool) => { registered = tool; } }, {
      workspaceRoot,
      getBashOptions(context) { optionContexts.push(context); return options; },
      createBashToolDefinition(cwd, factoryOptions) {
        factoryCalls.push({ cwd, options: factoryOptions });
        const definition = codingAgent.createBashToolDefinition(cwd, factoryOptions);
        const execute = definition.execute;
        return { ...definition, execute(id, input, forwardedSignal, forwardedUpdate, forwardedCtx) {
          assert.equal(forwardedCtx, ctx);
          assert.equal(forwardedSignal, signal);
          assert.equal(forwardedUpdate, onUpdate);
          assert.equal(input.cwd, undefined);
          return execute(id, input, forwardedSignal, forwardedUpdate, forwardedCtx);
        } };
      },
    });
    assert.deepEqual(optionContexts, []);
    const result = await registered.execute("call-2", { command: "pwd", timeout: 5, cwd: "packages/app" }, signal, onUpdate, ctx);
    assert.deepEqual(optionContexts, [ctx]);
    assert.equal(factoryCalls.length, 2);
    assert.deepEqual(factoryCalls[0], { cwd: workspaceRoot, options: {} });
    assert.equal(factoryCalls[1].options.operations, options.operations);
    assert.equal(factoryCalls[1].options.shellPath, "/fake/shell");
    assert.equal(hookContexts[0].cwd, workspaceRoot);
    assert.equal(executions[0].cwd, await realpath(nested));
    assert.equal(executions[0].command, "hook:fake-prefix\npwd");
    assert.equal(executions[0].backendOptions.signal, signal);
    assert.equal(executions[0].backendOptions.timeout, 5);
    assert.equal(executions[0].backendOptions.env.FAKE_HOOK, "1");
    assert.equal(executions[0].backendOptions.env.PI_SESSION_ID, "fake-session");
    assert.equal(executions[0].backendOptions.env.PI_SESSION_FILE, "/fake/session.jsonl");
    assert.equal(executions[0].backendOptions.env.PI_PROVIDER, "fake-provider");
    assert.equal(executions[0].backendOptions.env.PI_MODEL, "fake-model");
    assert.equal(executions[0].backendOptions.env.PI_REASONING_LEVEL, "high");
    assert.equal(result.structuredContent.exit_code, 0);
    assert.equal(result.structuredContent.output, "fake-output");
    assert.ok(updates.length > 0);
    assert.ok(registered.outputSchema);
    assert.equal(registered.promptSnippet, codingAgent.createBashToolDefinition(workspaceRoot, {}).promptSnippet);
  });
});

test("accepts an existing directory outside the workspace", async () => {
  await withWorkspace(async (workspaceRoot) => {
    const outside = await mkdtemp(join(tmpdir(), "bash-cwd-outside-"));
    try {
      const { registered, factoryCalls, executions } = setup({ workspaceRoot });
      await registered.execute("call-outside", { command: "pwd", cwd: outside }, undefined, undefined, { cwd: workspaceRoot });
      assert.equal(factoryCalls[1].cwd, workspaceRoot);
      assert.equal(executions[0].spawnContext.cwd, await realpath(outside));
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
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

test("bash-cwd preserves native renderers and resolves settings only from execution context", async () => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "bash-cwd-renderer-"));
  try {
    const extensionSource = await readFile(new URL("../pi/extensions/bash-cwd.ts", import.meta.url), "utf8");
    const mockPath = join(temporaryDirectory, "pi-mock.mjs");
    const extensionPath = join(temporaryDirectory, "bash-cwd.ts");
    const bashCwdExtensionUrl = pathToFileURL(new URL("../src/bash-cwd/index.ts", import.meta.url).pathname).href;
    const bashAsyncUrl = pathToFileURL(new URL("../src/bash-async/index.ts", import.meta.url).pathname).href;
    const { jiti, paths } = await loadPiTestRuntime(import.meta.url);

    await writeFile(mockPath, `
import { SettingsManager as NativeSettingsManager } from ${JSON.stringify(paths.codingAgent)};
export const settingsCalls = [];
export const storageReads = [];
export class SettingsManager {
  static create(cwd, agentDir, options) {
    settingsCalls.push({ cwd, agentDir, options });
    return NativeSettingsManager.fromStorage({ withLock(scope, fn) {
      storageReads.push(scope);
      fn(JSON.stringify(scope === "global"
        ? { shellCommandPrefix: "global-prefix", shellPath: "/fake/global-shell" }
        : { shellCommandPrefix: "project-prefix", shellPath: "/fake/project-shell" }));
    } }, options);
  }
}
export function createBashToolDefinition(cwd, options = {}) {
  return {
    name: "bash", parameters: { type: "object", properties: {} }, promptGuidelines: [],
    renderCall: "native-call", renderResult: "native-result",
    async execute(id, input, signal, onUpdate, ctx) {
      const base = { command: options.commandPrefix || input.command, cwd: ctx?.cwd || cwd, env: { PI_FAKE: "1" } };
      return options.spawnHook?.(base) ?? base;
    },
  };
}
`);
    const source = extensionSource
      .replace("@earendil-works/pi-coding-agent", pathToFileURL(mockPath).href)
      .replace("../../src/bash-cwd/index.ts", bashCwdExtensionUrl)
      .replace("../../src/bash-async/index.ts", bashAsyncUrl);
    await writeFile(extensionPath, source);

    const { default: bashCwd } = await jiti.import(extensionPath);
    const mock = await jiti.import(mockPath);
    const registered = [];
    const messageRenderers = [];
    bashCwd({
      registerTool: (tool) => registered.push(tool),
      on() {},
      registerCommand() {},
      // 完成回执绑定是已授权的 public Host 能力：mock 必须收集而非缺方法，
      // 否则入口在首次调用 registerMessageRenderer 时抛 TypeError（首次聚焦运行的实际偏离）。
      registerMessageRenderer: (customType, renderer) => messageRenderers.push({ customType, renderer }),
    });

    assert.equal(mock.settingsCalls.length, 0);
    assert.equal(registered.length, 2);
    assert.equal(registered[1].name, "bash_async");
    assert.equal(registered[1].outputSchema, undefined);
    assert.equal(registered[0].name, "bash");
    assert.equal(registered[0].renderShell, undefined);
    assert.equal(registered[0].renderCall, "native-call");
    assert.equal(registered[0].renderResult, "native-result");
    assert.deepEqual(messageRenderers.map(({ customType }) => customType), ["bash-async-complete"]);
    assert.equal(messageRenderers.length, 1);
    assert.equal(typeof messageRenderers[0].renderer, "function");
    await registered[0].execute("no-context", { command: "pwd" }, undefined, undefined, undefined);
    assert.equal(mock.settingsCalls.length, 0);
    assert.deepEqual(mock.storageReads, []);

    const untrustedCtx = { cwd: process.cwd(), isProjectTrusted: () => false };
    const untrustedResult = await registered[0].execute("no-cwd", { command: "pwd" }, undefined, undefined, untrustedCtx);
    assert.equal(untrustedResult.command, "global-prefix");
    assert.deepEqual(mock.storageReads, ["global"]);
    assert.deepEqual(mock.settingsCalls[0], {
      cwd: process.cwd(),
      agentDir: undefined,
      options: { projectTrusted: false },
    });
    const trustedCtx = { cwd: process.cwd(), isProjectTrusted: () => true };
    const trustedResult = await registered[0].execute("with-cwd", { command: "pwd", cwd: temporaryDirectory }, undefined, undefined, trustedCtx);
    assert.equal(trustedResult.command, "project-prefix");
    assert.equal(trustedResult.cwd, await realpath(temporaryDirectory));
    assert.deepEqual(mock.storageReads, ["global", "global", "project"]);
    assert.deepEqual(mock.settingsCalls[1], {
      cwd: process.cwd(),
      agentDir: undefined,
      options: { projectTrusted: true },
    });
    await registered[0].execute("missing-trust", { command: "pwd" }, undefined, undefined, { cwd: process.cwd() });
    assert.equal(mock.settingsCalls[2].options.projectTrusted, false);
    assert.deepEqual(mock.storageReads, ["global", "global", "project", "global"]);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("bash-cwd leaves compact display binding to the renderer-only owner", async () => {
  const extensionSource = await readFile(new URL("../pi/extensions/bash-cwd.ts", import.meta.url), "utf8");

  // renderShell/renderCall/renderResult/compact-tools 仍不得进入执行 owner；
  // pi-tui 仅作为已授权 completion MessageRenderer 的依赖注入能力放行，不承担工具渲染。
  assert.doesNotMatch(extensionSource, /renderShell|renderCall|renderResult|compact-tools/);
  const messageRendererBindings = [...extensionSource.matchAll(/registerMessageRenderer\(\s*["']([^"']+)["']/g)].map((match) => match[1]);
  assert.deepEqual(messageRendererBindings, ["bash-async-complete"]);
  assert.match(extensionSource, /import \{ Text, truncateToWidth \} from "@earendil-works\/pi-tui";/);
});
