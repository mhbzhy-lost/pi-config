import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti.mjs";

const jiti = createJiti(import.meta.url, {
  moduleCache: false,
  alias: {
    "@earendil-works/pi-ai": "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/index.js",
  },
});

let state = {};
try {
  state = await import("./fixtures/deterministic-provider-state.mjs");
} catch {}

function decide(messages, toolNames = []) {
  assert.equal(typeof state.decideDeterministicTurn, "function");
  return state.decideDeterministicTurn({ messages, toolNames });
}

function user(text) {
  return { role: "user", content: [{ type: "text", text }] };
}

async function deterministicProvider() {
  let provider;
  const fixture = await jiti.import("./fixtures/deterministic-provider.mjs");
  fixture.default({ registerProvider(_name, definition) { provider = definition; } });
  assert.ok(provider?.streamSimple);
  return provider;
}

async function streamDone(messages, tools) {
  const provider = await deterministicProvider();
  let done;
  const model = { ...provider.models[0], api: provider.api, provider: "fake" };
  for await (const event of provider.streamSimple(model, { messages, tools })) {
    if (event.type === "done") done = event;
  }
  assert.ok(done, "provider stream emits done");
  return done;
}

test("deterministic executors map only approved harness paths to fixed commands", () => {
  assert.equal(typeof state.deterministicExecutorCommand, "function");
  assert.match(state.deterministicExecutorCommand("Allowed paths: README.md"), /README\.md/);
  assert.match(state.deterministicExecutorCommand("Allowed paths: worker.txt"), /worker\.txt/);
  assert.equal(state.deterministicExecutorCommand("Allowed paths: arbitrary.txt"), undefined);
});

test("deterministic Executor waits for a supervisor decision before writing its approved path", () => {
  const prompt = user("Execute Task 1\nAllowed paths: decision.txt");
  const tools = ["contact_supervisor", "bash"];
  const requested = decide([prompt], tools);
  assert.deepEqual(requested, {
    tool: {
      name: "contact_supervisor",
      arguments: { reason: "need_decision", message: "Approve the deterministic Plan Harness change" },
    },
  });
  const replied = toolResult("contact_supervisor", "Reply from supervisor: APPROVED");
  const write = decide([prompt, replied], tools);
  assert.equal(write.tool.name, "bash");
  assert.match(write.tool.arguments.command, /decision\.txt/);
  assert.deepEqual(decide([prompt, replied, toolResult("bash", "committed")], tools), { text: "PLAN_EXECUTOR_DECISION_DONE" });
});

const flatPlanTools = ["plan_open", "plan_continue", "plan_status", "plan_verify", "subagent", "plan_executor_supervisor"];
const flatBootstrap = {
  planId: "plan-1",
  revision: 3,
  manifestSha256: "a".repeat(64),
  planIrHash: "b".repeat(64),
  baseCommit: "ec66a16",
  worktree: "/tmp/plan-1",
  allowPlanCommits: true,
};
function flatPlanPrompt() {
  return user(`Open the approved Plan revision by calling plan_open exactly once with ${JSON.stringify(flatBootstrap)}.`);
}

const rootMainTools = ["plan_run", "plan_attention_reply"];
const rootMainPlanPaths = ["/tmp/root-main-first.plan.md", "/tmp/root-main-second.plan.md"];
function rootMainPrompt() {
  return user(`PI_PLAN_FLAT_ROOT_HARNESS\n${JSON.stringify({ planPaths: rootMainPlanPaths })}`);
}

function planRunResult(planPath) {
  return toolResult("plan_run", "launched", {
    schemaVersion: "pi-plan-handle.v4",
    planPath,
    planRunnerRunId: `run-${planPath.split("/").at(-1)}`,
  });
}

test("Root Main launches the first declared plan before any tool result", () => {
  assert.deepEqual(decide([rootMainPrompt()], rootMainTools), {
    tool: { name: "plan_run", arguments: { planPath: rootMainPlanPaths[0] } },
  });
});

test("Root Main launches the second declared plan after the first launch result", () => {
  assert.deepEqual(decide([
    rootMainPrompt(),
    planRunResult(rootMainPlanPaths[0]),
  ], rootMainTools), {
    tool: { name: "plan_run", arguments: { planPath: rootMainPlanPaths[1] } },
  });
});

test("Root Main stops waiting after both declared plan launches without polling", () => {
  const turn = decide([
    rootMainPrompt(),
    planRunResult(rootMainPlanPaths[0]),
    planRunResult(rootMainPlanPaths[1]),
  ], rootMainTools);

  assert.deepEqual(turn, { text: "PLAN_ROOT_WAITING" });
  assert.equal(turn?.tool, undefined);
});

test("Root Main provider stream stops waiting after both declared plan launches", async () => {
  const done = await streamDone([
    rootMainPrompt(),
    planRunResult(rootMainPlanPaths[0]),
    planRunResult(rootMainPlanPaths[1]),
  ], rootMainTools.map((name) => ({ name })));

  assert.equal(done.reason, "stop");
  assert.equal(done.message.stopReason, "stop");
  assert.deepEqual(done.message.content, [{ type: "text", text: "PLAN_ROOT_WAITING" }]);
});

test("Root Main stops launching after a failed plan_run", () => {
  assert.deepEqual(decide([
    rootMainPrompt(),
    { ...planRunResult(rootMainPlanPaths[0]), isError: true },
  ], rootMainTools), { text: "PLAN_ROOT_LAUNCH_FAILED" });
});

test("provider stream waits for lifecycle instead of falling through to plan_verify", async () => {
  const dispatch = toolResult("plan_continue", JSON.stringify({
    state: "dispatch-required", dispatches: [{ contract: { task: "task-10a" } }],
  }));
  const done = await streamDone([
    flatPlanPrompt(), toolResult("plan_open", "opened"), dispatch, toolResult("subagent", "started"),
  ], flatPlanTools.map((name) => ({ name })));

  assert.deepEqual(done.message.content, [{ type: "text", text: "PLAN_RUNNER_WAITING_LIFECYCLE" }]);
  assert.equal(done.reason, "stop");
  assert.equal(done.message.stopReason, "stop");
  assert.equal(done.message.content.some((part) => part.type === "toolCall"), false);
});

test("provider stream polls plan_status when a lifecycle follow-up arrives", async () => {
  const dispatch = toolResult("plan_continue", JSON.stringify({
    state: "dispatch-required", dispatches: [{ contract: { task: "task-10a" } }],
  }));
  const done = await streamDone([
    flatPlanPrompt(), toolResult("plan_open", "opened"), dispatch, toolResult("subagent", "started"),
    { role: "custom", customType: "pi-root-subagent-lifecycle-v1", content: "started", details: {} },
  ], flatPlanTools.map((name) => ({ name })));

  assert.equal(done.reason, "toolUse");
  assert.deepEqual(done.message.content.map((part) => part.name), ["plan_status"]);
});

test("provider stream preserves executor bash fallback when state is undefined", async () => {
  const done = await streamDone([user("Allowed paths: README.md")], [{ name: "bash" }]);

  assert.equal(done.reason, "toolUse");
  assert.deepEqual(done.message.content.map((part) => part.name), ["bash"]);
});

test("flat Plan Runner parses the production bootstrap and opens the exact revision", () => {
  assert.deepEqual(decide([flatPlanPrompt()], flatPlanTools), {
    tool: { name: "plan_open", arguments: flatBootstrap },
  });
});

test("flat Plan Runner forwards each dispatch-required contract unchanged to subagent", () => {
  const contract = { task: "task-10a", agent: "executor", runId: "executor-run-1", prompt: "Implement only the approved task." };
  assert.deepEqual(decide([
    flatPlanPrompt(),
    toolResult("plan_open", "opened"),
    toolResult("plan_continue", JSON.stringify({ state: "dispatch-required", dispatches: [{ contract }] })),
  ], flatPlanTools), { tool: { name: "subagent", arguments: contract } });
});

test("flat Plan Runner waits for a lifecycle follow-up after subagent starts", () => {
  const dispatched = toolResult("plan_continue", JSON.stringify({ state: "dispatch-required", dispatches: [{ contract: { task: "task-10a" } }] }));
  assert.deepEqual(decide([
    flatPlanPrompt(), toolResult("plan_open", "opened"), dispatched, toolResult("subagent", "started"),
  ], flatPlanTools), { text: "PLAN_RUNNER_WAITING_LIFECYCLE" });
});

test("flat Plan Runner dispatches the second dispatch wave with its raw contract", () => {
  const contractA = {
    task: "task-10a", agent: "executor", runId: "executor-run-1", prompt: "Implement the first approved task only.",
  };
  const contractB = {
    task: "task-10b", agent: "executor", runId: "executor-run-2", prompt: "Implement the second approved task after integrating the first.",
  };
  const secondDispatch = toolResult("plan_continue", JSON.stringify({
    state: "dispatch-required", dispatches: [{ contract: contractB }],
  }));

  assert.deepEqual(decide([
    flatPlanPrompt(),
    toolResult("plan_open", "opened"),
    toolResult("plan_continue", JSON.stringify({ state: "dispatch-required", dispatches: [{ contract: contractA }] })),
    toolResult("subagent", "first task completed"),
    { role: "custom", customType: "pi-root-subagent-lifecycle-v1", content: "First lifecycle update.", details: { dispatchId: "dispatch-1", runId: "executor-run-1", state: "completed" } },
    toolResult("plan_status", '{"tasks":[{"status":"validated","attempts":[{"status":"validated"}]}]}'),
    secondDispatch,
  ], flatPlanTools), { tool: { name: "subagent", arguments: contractB } });
});

test("flat Plan Runner integrates after the second validated wave", () => {
  const contractA = {
    task: "task-10a", agent: "executor", runId: "executor-run-1", prompt: "Implement the first approved task only.",
  };
  const contractB = {
    task: "task-10b", agent: "executor", runId: "executor-run-2", prompt: "Implement the second approved task after integrating the first.",
  };

  assert.deepEqual(decide([
    flatPlanPrompt(),
    toolResult("plan_open", "opened"),
    toolResult("plan_continue", JSON.stringify({ state: "dispatch-required", dispatches: [{ contract: contractA }] })),
    toolResult("subagent", "first task completed"),
    { role: "custom", customType: "pi-root-subagent-lifecycle-v1", content: "First lifecycle update.", details: { dispatchId: "dispatch-1", runId: "executor-run-1", state: "completed" } },
    toolResult("plan_status", '{"tasks":[{"status":"validated","attempts":[{"status":"validated"}]}]}'),
    toolResult("plan_continue", JSON.stringify({ state: "dispatch-required", dispatches: [{ contract: contractB }] })),
    toolResult("subagent", "second task completed"),
    { role: "custom", customType: "pi-root-subagent-lifecycle-v1", content: "Second lifecycle update.", details: { dispatchId: "dispatch-2", runId: "executor-run-2", state: "completed" } },
    toolResult("plan_status", '{"tasks":[{"status":"validated","attempts":[{"status":"validated"}]},{"status":"validated","attempts":[{"status":"validated"}]}]}'),
  ], flatPlanTools), { tool: { name: "plan_continue", arguments: { reason: "integrate" } } });
});

test("flat Plan Runner polls plan_status after a lifecycle follow-up arrives", () => {
  const dispatched = toolResult("plan_continue", JSON.stringify({ state: "dispatch-required", dispatches: [{ contract: { task: "task-10a" } }] }));
  assert.deepEqual(decide([
    flatPlanPrompt(), toolResult("plan_open", "opened"), dispatched, toolResult("subagent", "started"),
    { role: "custom", customType: "pi-root-subagent-lifecycle-v1", content: "A lifecycle update arrived. Call plan_status.", details: { dispatchId: "dispatch-1", runId: "executor-run-1", state: "started" } },
  ], flatPlanTools), { tool: { name: "plan_status", arguments: {} } });
});

test("flat Plan Runner reconciles Attention requests through plan_status", () => {
  assert.deepEqual(decide([
    flatPlanPrompt(),
    toolResult("plan_open", "opened"),
    { role: "custom", customType: "subagent_supervisor_request", content: "Approve the change.", details: { id: "request-1", runId: "executor-run-1" } },
  ], flatPlanTools), { tool: { name: "plan_status", arguments: {} } });
});

test("flat Plan Runner fences durable Attention replies through plan_executor_supervisor", () => {
  const reply = { role: "custom", customType: "pi-plan-attention-reply-v1", content: "APPROVED", details: { requestId: "request-1", runId: "executor-run-1" } };
  const messages = [flatPlanPrompt(), toolResult("plan_open", "opened"), reply];
  const expected = {
    tool: { name: "plan_executor_supervisor", arguments: { action: "reply", replyTo: "request-1", to: "executor-run-1", message: "APPROVED" } },
  };
  assert.deepEqual(decide(messages, flatPlanTools), expected);
  assert.deepEqual(decide([...messages, toolResult("plan_executor_supervisor", "replied", { replyTo: "request-1" })], flatPlanTools), {
    tool: { name: "plan_continue", arguments: { reason: "harness" } },
  });
});

test("flat Plan Runner integrates validated work", () => {
  const status = toolResult("plan_status", '{"tasks":[{"status":"pending","attempts":[{"status":"validated"}]}]}');
  assert.deepEqual(decide([flatPlanPrompt(), toolResult("plan_open", "opened"), toolResult("plan_continue", "started"), status], flatPlanTools), {
    tool: { name: "plan_continue", arguments: { reason: "integrate" } },
  });
});

test("flat Plan Runner verifies after integration", () => {
  const status = toolResult("plan_status", '{"tasks":[{"status":"pending","attempts":[{"status":"validated"}]}]}');
  const integrated = toolResult("plan_continue", '{"state":"ready-to-verify"}');
  assert.deepEqual(decide([flatPlanPrompt(), toolResult("plan_open", "opened"), status, integrated], flatPlanTools), {
    tool: { name: "plan_verify", arguments: {} },
  });
});

test("flat Plan Runner stops after verification", () => {
  const status = toolResult("plan_status", '{"tasks":[{"status":"pending","attempts":[{"status":"validated"}]}]}');
  const integrated = toolResult("plan_continue", '{"state":"ready-to-verify"}');
  assert.deepEqual(decide([flatPlanPrompt(), toolResult("plan_open", "opened"), status, integrated, toolResult("plan_verify", "validated")], flatPlanTools), {
    text: "PLAN_RUNNER_DONE",
  });
});

test("top-level compatibility child completes with its exact tool inventory", () => {
  assert.deepEqual(
    decide([user("PI_SUBAGENTS_COMPAT_CHILD_COMPLETE")], ["contact_supervisor", "read"]),
    { text: "COMPAT_OK tools=contact_supervisor,read" },
  );
});

test("top-level compatibility attention child asks its direct supervisor", () => {
  assert.deepEqual(
    decide([user("PI_SUBAGENTS_COMPAT_CHILD_ATTENTION")], ["contact_supervisor", "read"]),
    {
      tool: {
        name: "contact_supervisor",
        arguments: {
          reason: "need_decision",
          message: "Approve compatibility probe",
        },
      },
    },
  );
});

test("top-level compatibility attention child completes after supervisor reply", () => {
  assert.deepEqual(
    decide([
      user("PI_SUBAGENTS_COMPAT_CHILD_ATTENTION"),
      {
        role: "toolResult",
        toolName: "contact_supervisor",
        content: [{ type: "text", text: "Supervisor replied: APPROVED" }],
      },
    ], ["contact_supervisor", "read"]),
    { text: "COMPAT_OK tools=contact_supervisor,read" },
  );
});

function toolResult(toolName, text = "ok", details) {
  return {
    role: "toolResult",
    toolName,
    content: [{ type: "text", text }],
    ...(details === undefined ? {} : { details }),
  };
}

test("top-level completion parent spawns through the harness tool then uses official wait", () => {
  const prompt = user("PI_SUBAGENTS_COMPAT_PARENT_COMPLETE");
  assert.deepEqual(decide([prompt], ["compat_spawn", "subagent_wait"]), {
    tool: { name: "compat_spawn", arguments: { mode: "complete" } },
  });
  assert.deepEqual(decide([prompt, toolResult("compat_spawn")], ["compat_spawn", "subagent_wait"]), {
    tool: { name: "subagent_wait", arguments: { all: true, timeoutMs: 30000 } },
  });
  assert.deepEqual(decide([
    prompt,
    toolResult("compat_spawn"),
    toolResult("subagent_wait", "complete"),
  ], ["compat_spawn", "subagent_wait"]), { text: "COMPAT_PARENT_DONE" });
});

test("top-level attention parent resolves the exact supervisor request and waits again", () => {
  const prompt = user("PI_SUBAGENTS_COMPAT_PARENT_ATTENTION");
  const tools = ["compat_spawn", "compat_status", "compat_inspect_nested_events", "compat_pause", "subagent_wait", "subagent_supervisor"];
  const spawned = toolResult("compat_spawn");
  const observed = toolResult("compat_status", "contact_supervisor observed", { currentTool: "contact_supervisor" });
  const nestedInspection = toolResult("compat_inspect_nested_events", "inspected", {
    eventFileCount: 0,
    routeFileCount: 1,
  });
  const paused = toolResult("compat_pause", "paused");
  const pendingEmpty = toolResult("subagent_supervisor", "pending", { pending: [] });
  const pending = toolResult("subagent_supervisor", "pending", {
    pending: [{ id: "request-123", runId: "run-456" }],
  });
  const reply = toolResult("subagent_supervisor", "replied", { replyTo: "request-123" });

  assert.deepEqual(decide([prompt], tools), {
    tool: { name: "compat_spawn", arguments: { mode: "attention" } },
  });
  assert.deepEqual(decide([prompt, spawned], tools), {
    tool: { name: "compat_status", arguments: {} },
  });
  assert.deepEqual(decide([prompt, spawned, observed], tools), {
    tool: { name: "compat_inspect_nested_events", arguments: {} },
  });
  assert.deepEqual(decide([prompt, spawned, observed, nestedInspection], tools), {
    tool: { name: "compat_pause", arguments: {} },
  });
  assert.deepEqual(decide([prompt, spawned, observed, nestedInspection, paused], tools), {
    tool: { name: "subagent_supervisor", arguments: { action: "pending" } },
  });
  assert.deepEqual(decide([prompt, spawned, observed, nestedInspection, paused, pendingEmpty], tools), {
    tool: { name: "compat_pause", arguments: {} },
  });
  const pausedAgain = toolResult("compat_pause", "paused");
  assert.deepEqual(decide([prompt, spawned, observed, nestedInspection, paused, pendingEmpty, pausedAgain], tools), {
    tool: { name: "subagent_supervisor", arguments: { action: "pending" } },
  });
  assert.deepEqual(decide([prompt, spawned, observed, nestedInspection, paused, pendingEmpty, pausedAgain, pending], tools), {
    tool: {
      name: "subagent_supervisor",
      arguments: { action: "reply", replyTo: "request-123", message: "APPROVED" },
    },
  });
  assert.deepEqual(decide([prompt, spawned, observed, nestedInspection, paused, pendingEmpty, pausedAgain, pending, reply], tools), {
    tool: { name: "subagent_wait", arguments: { all: true, timeoutMs: 30000 } },
  });
  assert.deepEqual(decide([
    prompt,
    spawned,
    observed,
    nestedInspection,
    paused,
    pendingEmpty,
    pausedAgain,
    pending,
    reply,
    toolResult("subagent_wait", "complete"),
  ], tools), { text: "COMPAT_PARENT_DONE" });
});
