import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti.mjs";
import { compileCodingDispatchIR } from "../scripts/lib/subagent-dispatch/ir.ts";
import { renderCodingDispatchPrompt } from "../scripts/lib/subagent-dispatch/prompt.ts";

const jiti = createJiti(import.meta.url, {
  moduleCache: false,
  alias: {
    "@earendil-works/pi-ai": "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/index.js",
  },
});
const { parseAcceptanceReport } = await jiti.import("../pi/npm/node_modules/pi-subagents/src/runs/shared/acceptance.ts");

let state = {};
try {
  state = await import("./fixtures/deterministic-provider-state.mjs");
} catch {}

function decide(messages, toolNames = [], options = {}) {
  assert.equal(typeof state.decideDeterministicTurn, "function");
  return state.decideDeterministicTurn({ messages, toolNames, ...options });
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
  return streamProviderDone(provider, messages, tools);
}

async function streamProviderDone(provider, messages, tools) {
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

function privateWakePrompt() {
  return user("async resume wrapper\nA durable Root broker wake is pending.");
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

test("flat Attention mode requires supervisor approval before typed Executor writes", () => {
  const tools = ["contact_supervisor", "bash"];
  for (const writePath of ["README.md", "worker.txt"]) {
    const prompt = typedExecutorPrompt(writePath);
    const executorRunId = `executor-run-flat-attention-${writePath.replace(/[^A-Za-z0-9]/g, "-")}`;
    const taskId = `deterministic-${writePath.replace(/[^A-Za-z0-9]/g, "-")}`;
    const options = { attentionMode: true, executorRunId };
    const command = state.deterministicExecutorCommand(prompt.content[0].text);
    const marker = `PI_PLAN_FLAT_ATTENTION ${JSON.stringify({
      schemaVersion: "pi-plan-flat-attention-marker.v1",
      executorRunId,
      taskId,
      writePath,
    })}`;

    assert.deepEqual(decide([prompt], tools, options), {
      tool: { name: "contact_supervisor", arguments: { reason: "need_decision", message: marker } },
    });
    assert.deepEqual(decide([
      prompt,
      toolResult("contact_supervisor", "APPROVED"),
    ], tools, options), {
      tool: { name: "bash", arguments: { command } },
    });
    assert.deepEqual(decide([
      prompt,
      toolResult("contact_supervisor", "APPROVED"),
      toolResult("bash", "committed"),
    ], tools, options), { text: "PLAN_EXECUTOR_DECISION_DONE" });
  }
});

test("Root Main submits explicit interleaved Attention decisions", () => {
  const requestList = [
    { planId: "plan-a", requestId: "request-a-1", expectedProjectionVersion: 11, message: "Approve A1" },
    { planId: "plan-a", requestId: "request-a-2", expectedProjectionVersion: 12, message: "Approve A2" },
    { planId: "plan-b", requestId: "request-b-1", expectedProjectionVersion: 21, message: "Approve B1" },
    { planId: "plan-b", requestId: "request-b-2", expectedProjectionVersion: 22, message: "Approve B2" },
  ];
  const replies = [requestList[3], requestList[1], requestList[2], requestList[0]]
    .map(({ planId, requestId, expectedProjectionVersion, message }) => ({
      planId, requestId, expectedProjectionVersion, message,
    }));
  const staleDecision = user(`PI_PLAN_FLAT_ATTENTION_REPLIES\n${JSON.stringify({ replies: [requestList[0]] })}`);
  const decision = user(`PI_PLAN_FLAT_ATTENTION_REPLIES\n${JSON.stringify({ replies })}`);
  const messages = [
    rootMainPrompt(),
    planRunResult(rootMainPlanPaths[0]),
    planRunResult(rootMainPlanPaths[1]),
    staleDecision,
    toolResult("plan_attention_reply", "replied", requestList[0]),
    decision,
  ];

  for (const reply of replies) {
    assert.deepEqual(decide(messages, rootMainTools), {
      tool: { name: "plan_attention_reply", arguments: reply },
    });
    messages.push(toolResult("plan_attention_reply", "replied", reply));
  }
  assert.deepEqual(decide(messages, rootMainTools), { text: "PLAN_ROOT_ATTENTION_REPLIES_DONE" });

  const failed = [...messages.slice(0, -1), { ...messages.at(-1), isError: true }];
  assert.deepEqual(decide(failed, rootMainTools), { text: "PLAN_ROOT_ATTENTION_REPLY_FAILED" });
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
    user("A lifecycle update arrived. Call plan_status."),
  ], flatPlanTools.map((name) => ({ name })));

  assert.equal(done.reason, "toolUse");
  assert.deepEqual(done.message.content.map((part) => part.name), ["plan_status"]);
});

test("provider stream polls stale active status after a private wake", async () => {
  const contractA = { taskId: "task-63bl-a", agent: "executor", title: "Complete task A", prompt: "Complete task A." };
  const contractB = { taskId: "task-63bl-b", agent: "executor", title: "Complete task B", prompt: "Complete task B." };
  const handleA = { version: "coding-dispatch-handle.v1", dispatchId: "dispatch-63bl-a", taskId: contractA.taskId, agent: contractA.agent, title: contractA.title, contractHash: "a".repeat(64), runId: "executor-run-63bl-a", asyncDir: "/tmp/executor-run-63bl-a" };
  const handleB = { version: "coding-dispatch-handle.v1", dispatchId: "dispatch-63bl-b", taskId: contractB.taskId, agent: contractB.agent, title: contractB.title, contractHash: "b".repeat(64), runId: "executor-run-63bl-b", asyncDir: "/tmp/executor-run-63bl-b" };
  const staleActiveStatus = toolResult("plan_status", JSON.stringify({
    schemaVersion: "pi-plan-status.v1",
    tasks: [
      { taskId: contractA.taskId, attempts: [{ attemptId: "attempt-63bl-a", dispatchId: handleA.dispatchId, runId: handleA.runId, status: "active" }] },
      { taskId: contractB.taskId, attempts: [{ attemptId: "attempt-63bl-b", dispatchId: handleB.dispatchId, runId: handleB.runId, status: "active" }] },
    ],
  }));
  const done = await streamDone([
    flatPlanPrompt(),
    toolResult("plan_open", "opened"),
    toolResult("plan_continue", JSON.stringify({ state: "dispatch-required", dispatches: [{ attemptId: "attempt-63bl-a", dispatchId: handleA.dispatchId, contract: contractA }, { attemptId: "attempt-63bl-b", dispatchId: handleB.dispatchId, contract: contractB }] })),
    assistantSubagentCall(handleA.dispatchId, contractA),
    toolResult("subagent", "completed task A", handleA),
    assistantSubagentCall(handleB.dispatchId, contractB),
    toolResult("subagent", "completed task B", handleB),
    staleActiveStatus,
    privateWakePrompt(),
  ], flatPlanTools.map((name) => ({ name })));

  const toolCalls = done.message.content.filter((part) => part.type === "toolCall");
  assert.equal(done.reason, "toolUse");
  assert.equal(toolCalls.length, 1);
  assert.equal(toolCalls[0].name, "plan_status");
});

test("provider stream does not re-poll after a private wake has newer active status", async () => {
  const contractA = { taskId: "task-63bl-a", agent: "executor", title: "Complete task A", prompt: "Complete task A." };
  const contractB = { taskId: "task-63bl-b", agent: "executor", title: "Complete task B", prompt: "Complete task B." };
  const handleA = { version: "coding-dispatch-handle.v1", dispatchId: "dispatch-63bl-a", taskId: contractA.taskId, agent: contractA.agent, title: contractA.title, contractHash: "a".repeat(64), runId: "executor-run-63bl-a", asyncDir: "/tmp/executor-run-63bl-a" };
  const handleB = { version: "coding-dispatch-handle.v1", dispatchId: "dispatch-63bl-b", taskId: contractB.taskId, agent: contractB.agent, title: contractB.title, contractHash: "b".repeat(64), runId: "executor-run-63bl-b", asyncDir: "/tmp/executor-run-63bl-b" };
  const activeStatus = () => toolResult("plan_status", JSON.stringify({
    schemaVersion: "pi-plan-status.v1",
    tasks: [
      { taskId: contractA.taskId, attempts: [{ attemptId: "attempt-63bl-a", dispatchId: handleA.dispatchId, runId: handleA.runId, status: "active" }] },
      { taskId: contractB.taskId, attempts: [{ attemptId: "attempt-63bl-b", dispatchId: handleB.dispatchId, runId: handleB.runId, status: "active" }] },
    ],
  }));
  const done = await streamDone([
    flatPlanPrompt(),
    toolResult("plan_open", "opened"),
    toolResult("plan_continue", JSON.stringify({ state: "dispatch-required", dispatches: [{ attemptId: "attempt-63bl-a", dispatchId: handleA.dispatchId, contract: contractA }, { attemptId: "attempt-63bl-b", dispatchId: handleB.dispatchId, contract: contractB }] })),
    assistantSubagentCall(handleA.dispatchId, contractA),
    toolResult("subagent", "completed task A", handleA),
    assistantSubagentCall(handleB.dispatchId, contractB),
    toolResult("subagent", "completed task B", handleB),
    activeStatus(),
    privateWakePrompt(),
    activeStatus(),
  ], flatPlanTools.map((name) => ({ name })));

  assert.equal(done.reason, "stop");
  assert.equal(done.message.stopReason, "stop");
  assert.deepEqual(done.message.content, [{ type: "text", text: "PLAN_RUNNER_WAITING_LIFECYCLE" }]);
  assert.equal(done.message.content.some((part) => part.type === "toolCall"), false);
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

test("private wake continues an already opened Plan without plan_open", () => {
  assert.deepEqual(decide([privateWakePrompt()], flatPlanTools), {
    tool: { name: "plan_continue", arguments: { reason: "harness" } },
  });
});

test("private wake provider forwards a dispatch-required contract exactly", async () => {
  const contract = {
    task: "task-63v", agent: "executor", runId: "executor-run-63v", prompt: "Implement only the approved task.",
  };
  const done = await streamDone([
    privateWakePrompt(),
    toolResult("plan_continue", JSON.stringify({ state: "dispatch-required", dispatches: [{ contract }] })),
  ], flatPlanTools.map((name) => ({ name })));

  assert.equal(done.reason, "toolUse");
  assert.equal(done.message.stopReason, "toolUse");
  const toolCalls = done.message.content.filter((part) => part.type === "toolCall");
  assert.equal(toolCalls.length, 1);
  assert.equal(toolCalls[0].name, "subagent");
  assert.deepEqual(toolCalls[0].arguments, contract);
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

function typedExecutorPrompt(writePath) {
  return user(renderCodingDispatchPrompt(compileCodingDispatchIR({
    version: "dispatch-ir.v1",
    taskId: `deterministic-${writePath.replace(/[^A-Za-z0-9]/g, "-")}`,
    title: "Run deterministic executor command",
    agent: "executor",
    risk: "low",
    objective: "Exercise the deterministic executor command mapping.",
    workflow: { mode: "tdd" },
    requirements: ["Load test-driven-development and git-commit-convention."],
    context: { knownFacts: [], decisions: [], relevantFiles: ["test/deterministic-provider.test.mjs"] },
    boundaries: { writePaths: [writePath], excludedWork: [], forbiddenActions: [] },
    acceptance: { criteria: ["Run the fixed command."], commands: ["node --test test/deterministic-provider.test.mjs"] },
    execution: { timeoutMs: 300000 },
  }, { cwd: "/repo" })));
}

function assistantSubagentCall(id, contract) {
  return {
    role: "assistant",
    content: [{ type: "toolCall", id, name: "subagent", arguments: contract }],
    api: "fake",
    provider: "fake",
    model: "deterministic",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "toolUse",
    timestamp: 0,
  };
}

test("typed Executor prompts retain fixed command mapping without arbitrary scope", () => {
  const readmePrompt = typedExecutorPrompt("README.md");
  const workerPrompt = typedExecutorPrompt("worker.txt");
  const arbitraryPrompt = typedExecutorPrompt("arbitrary.txt");

  assert.equal(
    state.deterministicExecutorCommand(readmePrompt.content[0].text),
    "printf 'worker\\n' >> README.md && git add README.md && git commit -m 'test: 添加确定性 worker 标记'",
  );
  assert.equal(
    state.deterministicExecutorCommand(workerPrompt.content[0].text),
    "printf 'worker-2\\n' > worker.txt && git add worker.txt && git commit -m 'test: 添加第二个确定性 worker 标记'",
  );
  assert.equal(state.deterministicExecutorCommand(arbitraryPrompt.content[0].text), undefined);
});

test("private wake advances dispatch selection from assistant subagent calls", () => {
  const contractA = { task: "task-63a", agent: "executor", runId: "executor-run-a", prompt: "Run contract A." };
  const contractB = { task: "task-63b", agent: "executor", runId: "executor-run-b", prompt: "Run contract B." };
  const dispatch = toolResult("plan_continue", JSON.stringify({
    state: "dispatch-required", dispatches: [{ contract: contractA }, { contract: contractB }],
  }));

  assert.deepEqual(decide([
    privateWakePrompt(), dispatch, assistantSubagentCall("deterministic-subagent-1", contractA),
  ], flatPlanTools), { tool: { name: "subagent", arguments: contractB } });
});

test("provider stream allocates a new subagent toolCall id after an assistant call", async () => {
  const contractA = { task: "task-63a", agent: "executor", runId: "executor-run-a", prompt: "Run contract A." };
  const contractB = { task: "task-63b", agent: "executor", runId: "executor-run-b", prompt: "Run contract B." };
  const done = await streamDone([
    privateWakePrompt(),
    toolResult("plan_continue", JSON.stringify({ state: "dispatch-required", dispatches: [{ contract: contractA }, { contract: contractB }] })),
    assistantSubagentCall("deterministic-subagent-1", contractA),
  ], flatPlanTools.map((name) => ({ name })));

  const toolCalls = done.message.content.filter((part) => part.type === "toolCall");
  assert.equal(toolCalls.length, 1);
  assert.equal(toolCalls[0].name, "subagent");
  assert.notEqual(toolCalls[0].id, "deterministic-subagent-1");
});

test("provider instance dispatch progress survives projected history without its prior subagent call", async () => {
  const provider = await deterministicProvider();
  const contractA = { task: "task-63a", agent: "executor", runId: "executor-run-a", prompt: "Run contract A." };
  const contractB = { task: "task-63b", agent: "executor", runId: "executor-run-b", prompt: "Run contract B." };
  const projectedContext = [
    privateWakePrompt(),
    toolResult("plan_continue", JSON.stringify({ state: "dispatch-required", dispatches: [{ contract: contractA }, { contract: contractB }] })),
  ];
  const tools = flatPlanTools.map((name) => ({ name }));

  const first = await streamProviderDone(provider, projectedContext, tools);
  const second = await streamProviderDone(provider, projectedContext, tools);

  assert.deepEqual(first.message.content[0].arguments, contractA);
  assert.deepEqual(second.message.content[0].arguments, contractB);
});

test("provider instance gives repeated projected typed Executor bash calls monotonic IDs", async () => {
  const provider = await deterministicProvider();
  const prompt = typedExecutorPrompt("README.md");
  const tools = [{ name: "bash" }];

  const first = await streamProviderDone(provider, [prompt], tools);
  const second = await streamProviderDone(provider, [prompt], tools);
  const firstCall = first.message.content[0];
  const secondCall = second.message.content[0];

  assert.equal(firstCall.name, "bash");
  assert.equal(secondCall.name, "bash");
  assert.match(firstCall.id, /^deterministic-bash-\d+$/);
  assert.match(secondCall.id, /^deterministic-bash-\d+$/);
  assert.notEqual(secondCall.id, firstCall.id);
});

test("provider instance returns a typed Executor acceptance report after successful bash", async () => {
  const provider = await deterministicProvider();
  const fixedCommand = "printf 'worker\\n' >> README.md && git add README.md && git commit -m 'test: 添加确定性 worker 标记'";
  const basePrompt = typedExecutorPrompt("README.md");
  const prompt = {
    ...basePrompt,
    content: [{
      type: "text",
      text: `${basePrompt.content[0].text}\n\n## Acceptance Contract\nAcceptance level: verified\n\nCriteria:\n- criterion-1: Complete the fixed README.md command.\n\nRequired evidence: changed-files, tests-added, commands-run, validation-output, residual-risks, no-staged-files`,
    }],
  };
  const tools = [{ name: "bash" }];

  const bash = await streamProviderDone(provider, [prompt], tools);
  assert.equal(bash.message.content[0].name, "bash");
  const final = await streamProviderDone(provider, [
    prompt,
    {
      role: "toolResult",
      toolName: "bash",
      isError: false,
      details: null,
      content: [{ type: "text", text: "completed" }],
    },
  ], tools);
  const parsed = parseAcceptanceReport(final.message.content[0].text);

  assert.ok(parsed.report, parsed.error);
  assert.deepEqual(parsed.report.criteriaSatisfied, [{ id: "criterion-1", status: "satisfied", evidence: "README.md command completed." }]);
  assert.deepEqual(parsed.report.changedFiles, ["README.md"]);
  assert.deepEqual(parsed.report.testsAddedOrUpdated, []);
  assert.deepEqual(parsed.report.commandsRun, [{ command: fixedCommand, result: "passed", summary: "completed" }]);
  assert.ok(parsed.report.validationOutput?.length);
  assert.deepEqual(parsed.report.residualRisks, []);
  assert.equal(parsed.report.noStagedFiles, true);
  assert.ok(parsed.report.diffSummary);
});

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

test("fresh provider revival dispatches only the remaining unbound contract in a partial wave", async () => {
  const contractA = { taskId: "task-revival-a", agent: "executor", title: "Revival contract A", prompt: "Execute A." };
  const contractB = { taskId: "task-revival-b", agent: "executor", title: "Revival contract B", prompt: "Execute B." };
  const dispatch = toolResult("plan_continue", JSON.stringify({
    state: "dispatch-required",
    dispatches: [
      { attemptId: "attempt-revival-a", dispatchId: "dispatch-revival-a", contract: contractA },
      { attemptId: "attempt-revival-b", dispatchId: "dispatch-revival-b", contract: contractB },
    ],
  }));
  const status = toolResult("plan_status", JSON.stringify({
    schemaVersion: "pi-plan-status.v1",
    tasks: [
      { taskId: "task-revival-a", attempts: [{ attemptId: "attempt-revival-a", dispatchId: "dispatch-revival-a", runId: "run-revival-a", status: "active" }] },
      { taskId: "task-revival-b", attempts: [{ attemptId: "attempt-revival-b", dispatchId: "dispatch-revival-b", runId: null, status: "dispatch-requested" }] },
    ],
  }));
  const done = await streamDone([
    flatPlanPrompt(), toolResult("plan_open", "opened"), dispatch,
    user("A lifecycle update arrived. Call plan_status."), status,
  ], flatPlanTools.map((name) => ({ name })));
  const toolCalls = done.message.content.filter((part) => part.type === "toolCall");

  assert.equal(done.reason, "toolUse");
  assert.equal(toolCalls.length, 1);
  assert.equal(toolCalls[0].name, "subagent");
  assert.deepEqual(toolCalls[0].arguments, contractB);
});

test("fresh provider revival waits when every exact dispatch binding is active", async () => {
  const contractA = { taskId: "task-revival-a", agent: "executor", title: "Revival contract A", prompt: "Execute A." };
  const contractB = { taskId: "task-revival-b", agent: "executor", title: "Revival contract B", prompt: "Execute B." };
  const dispatch = toolResult("plan_continue", JSON.stringify({
    state: "dispatch-required",
    dispatches: [
      { attemptId: "attempt-revival-a", dispatchId: "dispatch-revival-a", contract: contractA },
      { attemptId: "attempt-revival-b", dispatchId: "dispatch-revival-b", contract: contractB },
    ],
  }));
  const status = toolResult("plan_status", JSON.stringify({
    schemaVersion: "pi-plan-status.v1",
    tasks: [
      { taskId: "task-revival-a", attempts: [{ attemptId: "attempt-revival-a", dispatchId: "dispatch-revival-a", runId: "run-revival-a", status: "active" }] },
      { taskId: "task-revival-b", attempts: [{ attemptId: "attempt-revival-b", dispatchId: "dispatch-revival-b", runId: "run-revival-b", status: "active" }] },
    ],
  }));
  const done = await streamDone([
    flatPlanPrompt(), toolResult("plan_open", "opened"), dispatch,
    user("A lifecycle update arrived. Call plan_status."), status,
  ], flatPlanTools.map((name) => ({ name })));
  const toolCalls = done.message.content.filter((part) => part.type === "toolCall");

  assert.equal(done.reason, "stop");
  assert.equal(toolCalls.length, 0);
  assert.deepEqual(done.message.content, [{ type: "text", text: "PLAN_RUNNER_WAITING_LIFECYCLE" }]);
});

test("fresh provider revival integrates when every exact dispatch binding is validated", async () => {
  const contractA = { taskId: "task-revival-a", agent: "executor", title: "Revival contract A", prompt: "Execute A." };
  const contractB = { taskId: "task-revival-b", agent: "executor", title: "Revival contract B", prompt: "Execute B." };
  const dispatch = toolResult("plan_continue", JSON.stringify({
    state: "dispatch-required",
    dispatches: [
      { attemptId: "attempt-revival-a", dispatchId: "dispatch-revival-a", contract: contractA },
      { attemptId: "attempt-revival-b", dispatchId: "dispatch-revival-b", contract: contractB },
    ],
  }));
  const status = toolResult("plan_status", JSON.stringify({
    schemaVersion: "pi-plan-status.v1",
    tasks: [
      { taskId: "task-revival-a", attempts: [{ attemptId: "attempt-revival-a", dispatchId: "dispatch-revival-a", runId: "run-revival-a", status: "validated" }] },
      { taskId: "task-revival-b", attempts: [{ attemptId: "attempt-revival-b", dispatchId: "dispatch-revival-b", runId: "run-revival-b", status: "validated" }] },
    ],
  }));
  const done = await streamDone([
    flatPlanPrompt(), toolResult("plan_open", "opened"), dispatch,
    user("A lifecycle update arrived. Call plan_status."), status,
  ], flatPlanTools.map((name) => ({ name })));
  const toolCalls = done.message.content.filter((part) => part.type === "toolCall");

  assert.equal(done.reason, "toolUse");
  assert.equal(toolCalls.length, 1);
  assert.equal(toolCalls[0].name, "plan_continue");
  assert.deepEqual(toolCalls[0].arguments, { reason: "integrate" });
});
