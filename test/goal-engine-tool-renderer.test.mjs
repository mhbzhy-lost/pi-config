import assert from "node:assert/strict";
import test from "node:test";
import { createGoalToolRenderers } from "../scripts/lib/goal-engine/tool-renderer.mjs";

const renderers = createGoalToolRenderers();
const render = (name, args) => renderers[name].renderCall(args).render(200)[0];
const result = (name, value, options, context) => renderers[name].renderResult(value, options, null, context).render(200)[0];

test("exact-eight Goal tools expose real call and result summaries", () => {
  assert.deepEqual(Object.keys(renderers).sort(), ["goal_accept", "goal_amend", "goal_dispatch", "goal_finalize", "goal_init", "goal_integrate", "goal_settle", "goal_status"]);
  assert.equal(render("goal_init", { objective: "hidden", execution: { schema: "goal-runtime.v1", tasks: [{ id: "a" }, { id: "b" }], conditions: [{ id: "c" }] } }), "goal_init | runtime | tasks 2 | conditions 1");
  assert.equal(render("goal_init", { objective: "hidden", tasks: [{ id: "a" }, { id: "b" }] }), "goal_init | planned | tasks 2");
  assert.equal(render("goal_status", { goal_id: "g-1" }), "goal_status | goal g-1");
  assert.equal(render("goal_status", { list_cwd_goals: true }), "goal_status | list");
  assert.equal(render("goal_status", { transfer_challenge_id: "challenge-1" }), "goal_status | transfer challenge-1");
  assert.equal(render("goal_dispatch", { task_id: "task-1", action_token: "secret" }), "goal_dispatch | task task-1");
  assert.equal(render("goal_settle", { task_id: "task-1", outcome: "succeeded", action_token: "secret" }), "goal_settle | task task-1 | succeeded");
  assert.equal(render("goal_integrate", { task_id: "task-1", action: "discard", action_token: "secret" }), "goal_integrate | task task-1 | discard");
  assert.equal(render("goal_integrate", { task_id: "task-1", strategy: "cherry-pick", action_token: "secret" }), "goal_integrate | task task-1 | cherry-pick");
  assert.equal(render("goal_accept", { task_id: "task-1", approval_entry_id: "approval" }), "goal_accept | task task-1");
  assert.equal(render("goal_amend", { operation: "patch_active", reason: "r", action_token: "secret", add_tasks: [{}, {}], remove_tasks: ["old"], update_tasks: { a: {}, b: {} } }), "goal_amend | patch_active | add 2 | remove 1 | update 2");
  assert.equal(render("goal_amend", { operation: "resolve_blocked", reason: "r", action_token: "secret", blocked_resolution: "retry", blocked_task_id: "task-1" }), "goal_amend | resolve_blocked | add 0 | remove 0 | update 0");
  assert.equal(render("goal_amend", { operation: "triage", reason: "r", action_token: "secret", resolve_discoveries: [] }), "goal_amend | triage | add 0 | remove 0 | update 0");
  assert.equal(render("goal_amend", { operation: "reopen_completed", reason: "r", action_token: "secret", basis: { epoch: 1 }, resolve_discoveries: [], add_tasks: [{}] }), "goal_amend | reopen_completed | add 1 | remove 0 | update 0");
  assert.equal(render("goal_amend", { operation: "detach_session", reason: "r", action_token: "secret" }), "goal_amend | detach_session | add 0 | remove 0 | update 0");
  assert.equal(render("goal_amend", { operation: "propose_update_goal", reason: "r", changes: { objective: "hidden" } }), "goal_amend | propose_update_goal | add 0 | remove 0 | update 0");
  assert.equal(render("goal_amend", { operation: "update_goal", challenge_id: "challenge-1", action_token: "secret" }), "goal_amend | update_goal | add 0 | remove 0 | update 0");
  assert.equal(render("goal_amend", { operation: "propose_transfer_session", goal_id: "g-1", reason: "r" }), "goal_amend | propose_transfer_session | add 0 | remove 0 | update 0");
  assert.equal(render("goal_amend", { operation: "transfer_session", goal_id: "g-1", challenge_id: "challenge-1", reason: "r", action_token: "secret" }), "goal_amend | transfer_session | add 0 | remove 0 | update 0");
  assert.equal(render("goal_amend", { operation: "propose_execution_change", goal_id: "g-1", reason: "r", changes: { update_tasks: [{ id: "a" }, { id: "b" }, { id: "c" }] } }), "goal_amend | propose_execution_change | add 0 | remove 0 | update 3");
  assert.equal(render("goal_amend", { operation: "resume_runtime", action_token: "secret" }), "goal_amend | resume_runtime | add 0 | remove 0 | update 0");
  assert.equal(render("goal_finalize", { goal_id: "g-1", approval_entry_id: "approval" }), "goal_finalize | goal g-1");

  const payload = { details: { value: JSON.stringify({ runtimeState: "active", machineAction: { tool: "goal_dispatch" }, task_id: "task-1", runnable: ["a", "b"], blocking: ["c"] }) } };
  assert.equal(result("goal_status", payload), "goal_status | active | next goal_dispatch | task task-1 | run 2 | block 1");
  assert.equal(result("goal_status", { content: [{ type: "text", text: JSON.stringify({ status: "queued", runnable: ["a"] }) }] }), "goal_status | queued | run 1");
  assert.equal(result("goal_dispatch", { details: { value: { status: "partial", taskId: "task-1" } } }, { isPartial: true }), "goal_dispatch | running | task task-1");
  assert.equal(result("goal_settle", { details: { value: { status: "error", code: "BAD_INPUT", raw: "never show" } } }), "goal_settle | error | BAD_INPUT");
  assert.equal(result("goal_accept", { error: { code: "DENIED" }, content: [{ type: "text", text: "raw error" }] }, {}, { isError: true }), "goal_accept | error | DENIED");
});

test("Goal renderer is ASCII bounded and never echoes sensitive input", () => {
  const malicious = "token hash approval objective criteria raw JSON unicode-\u4e2d\u6587";
  for (const [name, renderer] of Object.entries(renderers)) {
    for (const expanded of [false, true]) {
      const components = [
        renderer.renderCall({ objective: malicious, action_token: malicious, goal_id: malicious, task_id: malicious }, null, { expanded }),
        renderer.renderResult({ details: { value: { status: malicious, machineAction: { tool: malicious }, task_id: malicious, raw: { token: malicious } } } }, {}, null, { expanded }),
      ];
      for (const component of components) for (const width of [0, 1, 8, 80]) {
        const lines = component.render(width);
        assert.ok(lines.every((line) => /^[\x20-\x7e]*$/.test(line) && line.length <= width));
        assert.ok(lines.every((line) => !line.includes(malicious) && !line.includes("{") && !line.includes("token")));
      }
    }
  }
  assert.equal(result("goal_status", { details: { value: "{bad" }, content: [{ type: "text", text: JSON.stringify({ status: "leaked" }) }] }), "goal_status | done");
});
