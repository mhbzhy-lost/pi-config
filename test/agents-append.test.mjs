import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAgentsAppendExtension } from "../src/agents-append/index.ts";
import { loadPiTestRuntime } from "./helpers/pi-runtime.mjs";

const { jiti } = await loadPiTestRuntime(import.meta.url);
const { default: registerModelSystemPrompt } = await jiti.import(
  "../pi/extensions/model-system-prompt.ts",
);

function createMockPi() {
  const handlers = new Map();
  return {
    handlers,
    on(name, handler) {
      const registered = handlers.get(name) ?? [];
      registered.push(handler);
      handlers.set(name, registered);
    },
  };
}

async function runBeforeAgentStart(pi, initialEvent, ctx) {
  let event = initialEvent;
  const results = [];
  for (const handler of pi.handlers.get("before_agent_start") ?? []) {
    const result = await handler(event, ctx);
    results.push(result);
    if (result?.systemPrompt !== undefined) {
      event = { ...event, systemPrompt: result.systemPrompt };
    }
  }
  return { event, results };
}

test("registers one input preflight and the model rewriter before the Pi-only append handler", () => {
  const pi = createMockPi();

  registerModelSystemPrompt(pi);

  assert.equal(pi.handlers.get("input")?.length, 1);
  assert.equal(pi.handlers.get("before_agent_start")?.length, 2);
});

test("appends Pi-only global instructions to the current system prompt without a persistent message", async () => {
  const pi = createMockPi();
  createAgentsAppendExtension(pi, {
    agentsAppendPath: "/global/pi/AGENTS_APPEND.md",
    readFile: async () => "Pi-only rule",
  });

  const [handler] = pi.handlers.get("before_agent_start");
  const result = await handler(
    { systemPrompt: "base prompt with AGENTS.md" },
    {},
  );

  assert.deepEqual(Object.keys(result), ["systemPrompt"]);
  assert.match(
    result.systemPrompt,
    /^base prompt with AGENTS\.md[\s\S]*<pi_global_instructions source="PI_CODING_AGENT_DIR\/AGENTS_APPEND\.md">[\s\S]*Pi-only rule[\s\S]*<\/pi_global_instructions>$/,
  );
});

test("input preflight handles unreadable AGENTS_APPEND before agent processing", async () => {
  const pi = createMockPi();
  createAgentsAppendExtension(pi, {
    agentsAppendPath: "/secret/machine/path/AGENTS_APPEND.md",
    readFile: async () => {
      throw new Error("EACCES /secret/machine/path/AGENTS_APPEND.md");
    },
  });
  const notices = [];
  const [handler] = pi.handlers.get("input") ?? [];

  const result = await handler(
    { text: "run the task", source: "interactive" },
    { ui: { notify: (...args) => notices.push(args) } },
  );

  assert.deepEqual(result, { action: "handled" });
  assert.deepEqual(notices, [[
    "Required Pi global AGENTS_APPEND.md is missing or unreadable",
    "error",
  ]]);
});

test("input preflight handles empty AGENTS_APPEND before agent processing", async () => {
  const pi = createMockPi();
  createAgentsAppendExtension(pi, {
    agentsAppendPath: "/global/pi/AGENTS_APPEND.md",
    readFile: async () => " \n\t ",
  });
  const notices = [];
  const [handler] = pi.handlers.get("input") ?? [];

  const result = await handler(
    { text: "run through rpc", source: "rpc" },
    { ui: { notify: (...args) => notices.push(args) } },
  );

  assert.deepEqual(result, { action: "handled" });
  assert.deepEqual(notices, [[
    "Required Pi global AGENTS_APPEND.md is empty",
    "error",
  ]]);
});

for (const source of ["interactive", "rpc", "extension"]) {
  test(`valid ${source} input is checked once and then appended`, async () => {
    const pi = createMockPi();
    let reads = 0;
    createAgentsAppendExtension(pi, {
      agentsAppendPath: "/global/pi/AGENTS_APPEND.md",
      readFile: async () => {
        reads += 1;
        return "Pi-only rule";
      },
    });
    const [inputHandler] = pi.handlers.get("input");
    const [beforeAgentStart] = pi.handlers.get("before_agent_start");

    const inputResult = await inputHandler(
      { text: "run the task", source },
      { ui: undefined },
    );
    const promptResult = await beforeAgentStart(
      { systemPrompt: "base prompt" },
      {},
    );

    assert.deepEqual(inputResult, { action: "continue" });
    assert.match(promptResult.systemPrompt, /base prompt[\s\S]*Pi-only rule/);
    assert.equal(reads, 1);
  });
}

test("a later handled input cannot leave stale validated instructions for the next input", async () => {
  const pi = createMockPi();
  const contents = ["stale rule", "fresh rule"];
  let reads = 0;
  createAgentsAppendExtension(pi, {
    agentsAppendPath: "/global/pi/AGENTS_APPEND.md",
    readFile: async () => contents[reads++],
  });
  const [inputHandler] = pi.handlers.get("input");
  const [beforeAgentStart] = pi.handlers.get("before_agent_start");

  assert.deepEqual(
    await inputHandler({ text: "first", source: "interactive" }, {}),
    { action: "continue" },
  );
  // A later input handler handles "first", so before_agent_start is never emitted.
  assert.deepEqual(
    await inputHandler({ text: "second", source: "interactive" }, {}),
    { action: "continue" },
  );
  const result = await beforeAgentStart({ systemPrompt: "base prompt" }, {});

  assert.equal(reads, 2);
  assert.match(result.systemPrompt, /fresh rule/);
  assert.doesNotMatch(result.systemPrompt, /stale rule/);
});

test("before_agent_start consumes the validated instruction cache", async () => {
  const pi = createMockPi();
  let reads = 0;
  createAgentsAppendExtension(pi, {
    agentsAppendPath: "/global/pi/AGENTS_APPEND.md",
    readFile: async () => {
      reads += 1;
      return reads === 1 ? "cached rule" : "reloaded rule";
    },
  });
  const [inputHandler] = pi.handlers.get("input");
  const [beforeAgentStart] = pi.handlers.get("before_agent_start");

  await inputHandler({ text: "first", source: "rpc" }, {});
  const first = await beforeAgentStart({ systemPrompt: "base prompt" }, {});
  const second = await beforeAgentStart({ systemPrompt: "base prompt" }, {});

  assert.equal(reads, 2);
  assert.match(first.systemPrompt, /cached rule/);
  assert.match(second.systemPrompt, /reloaded rule/);
});

test("uses a blocking fallback prompt when AGENTS_APPEND is unreadable without input preflight", async () => {
  const pi = createMockPi();
  createAgentsAppendExtension(pi, {
    agentsAppendPath: "/secret/machine/path/AGENTS_APPEND.md",
    readFile: async () => {
      throw new Error("EACCES /secret/machine/path/AGENTS_APPEND.md");
    },
  });
  const [handler] = pi.handlers.get("before_agent_start");

  const result = await handler(
    { systemPrompt: "base prompt that must be replaced" },
    {},
  );

  assert.deepEqual(Object.keys(result), ["systemPrompt"]);
  assert.match(result.systemPrompt, /AGENTS_APPEND\.md is missing or unreadable/);
  assert.match(result.systemPrompt, /Do not call tools or modify any state/);
  assert.match(result.systemPrompt, /Report this configuration error/);
  assert.doesNotMatch(result.systemPrompt, /base prompt|secret|EACCES/);
});

test("uses a blocking fallback prompt when AGENTS_APPEND is empty without input preflight", async () => {
  const pi = createMockPi();
  createAgentsAppendExtension(pi, {
    agentsAppendPath: "/global/pi/AGENTS_APPEND.md",
    readFile: async () => " \n\t ",
  });
  const [handler] = pi.handlers.get("before_agent_start");

  const result = await handler(
    { systemPrompt: "base prompt that must be replaced" },
    {},
  );

  assert.deepEqual(Object.keys(result), ["systemPrompt"]);
  assert.match(result.systemPrompt, /AGENTS_APPEND\.md is empty/);
  assert.match(result.systemPrompt, /Do not call tools or modify any state/);
  assert.match(result.systemPrompt, /Report this configuration error/);
  assert.doesNotMatch(result.systemPrompt, /base prompt/);
});

test("the real entry appends after an ordinary model base prompt and ignores a cwd trap", async (t) => {
  const trapRoot = await mkdtemp(join(tmpdir(), "agents-append-cwd-trap-"));
  t.after(() => rm(trapRoot, { recursive: true, force: true }));
  await mkdir(join(trapRoot, ".pi"));
  await writeFile(
    join(trapRoot, ".pi", "AGENTS_APPEND.md"),
    "CWD_TRAP_MUST_NOT_LOAD",
  );
  const pi = createMockPi();
  registerModelSystemPrompt(pi);

  const { event, results } = await runBeforeAgentStart(
    pi,
    {
      systemPrompt: "ordinary base containing global AGENTS.md",
      systemPromptOptions: { cwd: trapRoot },
    },
    {
      model: { provider: "openai-codex", id: "gpt-5.6-terra" },
    },
  );

  assert.equal(results.length, 2);
  assert.equal(results[0], undefined);
  assert.ok(
    event.systemPrompt.indexOf("ordinary base containing global AGENTS.md") <
      event.systemPrompt.indexOf("<pi_global_instructions"),
  );
  assert.doesNotMatch(event.systemPrompt, /CWD_TRAP_MUST_NOT_LOAD/);
  assert.equal(results.some((result) => result?.message !== undefined), false);
});

test("reads only the configured global path rather than event or context cwd", async () => {
  const pi = createMockPi();
  const reads = [];
  createAgentsAppendExtension(pi, {
    agentsAppendPath: "/configured/pi/AGENTS_APPEND.md",
    readFile: async (...args) => {
      reads.push(args);
      return "Pi-only rule";
    },
  });
  const [handler] = pi.handlers.get("before_agent_start");

  await handler(
    {
      systemPrompt: "base prompt",
      systemPromptOptions: { cwd: "/event/cwd/trap" },
    },
    { cwd: "/context/cwd/trap" },
  );

  assert.deepEqual(reads, [["/configured/pi/AGENTS_APPEND.md", "utf8"]]);
});

test("the real entry appends only after the Peach model system prompt rewrite", async () => {
  const pi = createMockPi();
  registerModelSystemPrompt(pi);

  const { event } = await runBeforeAgentStart(
    pi,
    { systemPrompt: "generic prompt", systemPromptOptions: {} },
    {
      model: {
        provider: "openai-idealab-dogfooding",
        id: "Peach-07-17-DogFooding",
      },
    },
  );

  assert.ok(event.systemPrompt.indexOf("Stop Rules") >= 0);
  assert.ok(
    event.systemPrompt.indexOf("Stop Rules") <
      event.systemPrompt.indexOf("<pi_global_instructions"),
  );
  assert.doesNotMatch(event.systemPrompt, /^generic prompt/);
});

test("independent turns append exactly once without retaining a prior prompt", async () => {
  const pi = createMockPi();
  createAgentsAppendExtension(pi, {
    agentsAppendPath: "/global/pi/AGENTS_APPEND.md",
    readFile: async () => "Pi-only rule",
  });
  const [handler] = pi.handlers.get("before_agent_start");

  const first = await handler(
    { systemPrompt: "fresh base" },
    {},
  );
  const second = await handler(
    { systemPrompt: "fresh base" },
    {},
  );

  assert.equal(first.systemPrompt, second.systemPrompt);
  assert.equal(
    second.systemPrompt.match(/<pi_global_instructions /g)?.length,
    1,
  );
});
