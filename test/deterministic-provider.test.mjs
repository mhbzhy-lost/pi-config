import assert from "node:assert/strict";
import test from "node:test";

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

test("deterministic Plan Harness drives open, bounded wait, integration, and verify", () => {
  const prompt = user('PI_PLAN_HARNESS_STANDALONE\nexact bootstrap JSON:\n{"planId":"plan-1"}');
  const tools = ["plan_open", "plan_continue", "plan_status", "plan_verify", "subagent_wait", "subagent_supervisor"];
  const opened = toolResult("plan_open", "opened");
  const continued = toolResult("plan_continue", '{"state":"waiting-executors"}');
  const pendingOne = toolResult("subagent_supervisor", "none");
  const waited = toolResult("subagent_wait", "complete");
  const pendingTwo = toolResult("subagent_supervisor", "none");
  const activeStatus = toolResult("plan_status", '{"tasks":[{"status":"pending","attempts":[{"status":"active"}]}]}');
  assert.deepEqual(decide([prompt, opened, continued, pendingOne, waited, pendingTwo, activeStatus], tools), { tool: { name: "subagent_supervisor", arguments: { action: "pending" } } });

  const waitingAttention = toolResult("plan_status", '{"tasks":[{"attempts":[{"status":"waiting-attention"}]}]}');
  assert.deepEqual(
    decide([prompt, opened, continued, pendingOne, waited, pendingTwo, waitingAttention], tools),
    { text: "PLAN_HARNESS_WAITING_ATTENTION" },
  );

  const status = toolResult("plan_status", '{"tasks":[{"status":"pending","attempts":[{"status":"validated"}]}]}');
  const integrated = toolResult("plan_continue", '{"state":"ready-to-verify"}');

  assert.deepEqual(decide([prompt], tools), { tool: { name: "plan_open", arguments: { planId: "plan-1" } } });
  assert.deepEqual(decide([prompt, opened], tools), { tool: { name: "plan_continue", arguments: { reason: "harness" } } });
  assert.deepEqual(decide([prompt, opened, continued], tools), { tool: { name: "subagent_supervisor", arguments: { action: "pending" } } });
  assert.deepEqual(decide([prompt, opened, continued, pendingOne], tools), { tool: { name: "subagent_wait", arguments: { all: false, timeoutMs: 1000 } } });
  assert.deepEqual(decide([prompt, opened, continued, pendingOne, waited], tools), { tool: { name: "subagent_supervisor", arguments: { action: "pending" } } });
  assert.deepEqual(decide([prompt, opened, continued, pendingOne, waited, pendingTwo], tools), { tool: { name: "plan_status", arguments: {} } });
  assert.deepEqual(decide([prompt, opened, continued, pendingOne, waited, pendingTwo, status], tools), { tool: { name: "plan_continue", arguments: { reason: "integrate" } } });
  assert.deepEqual(decide([prompt, opened, continued, pendingOne, waited, pendingTwo, status, integrated], tools), { tool: { name: "plan_verify", arguments: {} } });
  assert.deepEqual(decide([prompt, opened, continued, pendingOne, waited, pendingTwo, status, integrated, toolResult("plan_verify", "validated")], tools), { text: "PLAN_HARNESS_DONE" });
});

test("deterministic Plan Runner delivers only a durable Root Attention reply", () => {
  const prompt = user('PI_PLAN_HARNESS_STANDALONE\nexact bootstrap JSON:\n{"planId":"plan-1"}');
  const rootReply = {
    role: "custom",
    customType: "pi-plan-attention-reply-v1",
    content: "APPROVED",
    details: { requestId: "request-1" },
  };
  assert.deepEqual(
    decide([prompt, rootReply], ["subagent_supervisor"]),
    { tool: { name: "subagent_supervisor", arguments: { action: "reply", replyTo: "request-1", message: "APPROVED" } } },
  );
});

test("standalone compatibility child completes with its exact tool inventory", () => {
  assert.deepEqual(
    decide([user("PI_SUBAGENTS_COMPAT_CHILD_COMPLETE")], ["contact_supervisor", "read"]),
    { text: "COMPAT_OK tools=contact_supervisor,read" },
  );
});

test("standalone compatibility attention child asks its direct supervisor", () => {
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

test("standalone compatibility attention child completes after supervisor reply", () => {
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

test("standalone completion parent spawns through the harness tool then uses official wait", () => {
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

test("standalone attention parent resolves the exact supervisor request and waits again", () => {
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
