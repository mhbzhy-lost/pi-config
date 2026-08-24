import assert from "node:assert/strict";
import test from "node:test";
import { createGoalToolRenderers } from "../scripts/lib/goal-engine/tool-renderer.mjs";

const renderers = createGoalToolRenderers();
const render = (name, args, width = 200) => renderers[name].renderCall(args).render(width)[0];
const result = (name, value, options, context, width = 200) => renderers[name].renderResult(value, options, null, context).render(width)[0];

// Mirrors terminal column rules needed by this black-box renderer test.
const visibleWidth = (text) => [...text].reduce((columns, char) => columns + (/^[\u2e80-\u9fff\uff00-\uffef]$/u.test(char) ? 2 : 1), 0);

test("exact-eight Goal tools expose localized call and result summaries", () => {
  assert.deepEqual(Object.keys(renderers).sort(), ["goal_accept", "goal_amend", "goal_dispatch", "goal_finalize", "goal_init", "goal_integrate", "goal_settle", "goal_status"]);
  assert.equal(render("goal_init", { objective: "hidden", execution: { schema: "goal-runtime.v1", tasks: [{}, {}], conditions: [{}] } }), "goal_init | 运行时 | 任务 2 | 条件 1");
  assert.equal(render("goal_init", { objective: "hidden", tasks: [{}, {}] }), "goal_init | 计划 | 任务 2");
  assert.equal(render("goal_status", { goal_id: "g-1" }), "goal_status | 目标 g-1");
  assert.equal(render("goal_status", { list_cwd_goals: true }), "goal_status | 列表");
  assert.equal(render("goal_status", { transfer_challenge_id: "challenge-1" }), "goal_status | 转移 challenge-1");
  assert.equal(render("goal_dispatch", { task_id: "task-1", action_token: "secret" }), "goal_dispatch | 任务 task-1");
  assert.equal(render("goal_settle", { task_id: "task-1", outcome: "succeeded", action_token: "secret" }), "goal_settle | 任务 task-1 | 成功");
  assert.equal(render("goal_integrate", { task_id: "task-1", action: "discard", action_token: "secret" }), "goal_integrate | 任务 task-1 | 丢弃");
  assert.equal(render("goal_amend", { operation: "patch_active", action_token: "secret", add_tasks: [{}, {}], remove_tasks: ["old"], update_tasks: { a: {}, b: {} } }), "goal_amend | patch_active | 新增 2 | 移除 1 | 更新 2");
  assert.equal(render("goal_finalize", { goal_id: "g-1", approval_entry_id: "approval" }), "goal_finalize | 目标 g-1");

  const payload = { details: { value: JSON.stringify({ runtimeState: "active", machineAction: { tool: "goal_dispatch" }, task_id: "task-1", runnable: ["a", "b"], blocking: ["c"] }) } };
  assert.equal(result("goal_status", payload), "goal_status | 活跃 | 下一步 goal_dispatch | 任务 task-1 | 可运行 2 | 阻塞 1");
  assert.equal(result("goal_status", { content: [{ type: "text", text: JSON.stringify({ status: "queued", runnable: ["a"] }) }] }), "goal_status | 排队 | 可运行 1");
  assert.equal(result("goal_dispatch", { details: { value: { status: "partial", taskId: "task-1" } } }, { isPartial: true }), "goal_dispatch | 运行中 | 任务 task-1");
  assert.equal(result("goal_settle", { details: { value: { status: "error", code: "BAD_INPUT", raw: "never show" } } }), "goal_settle | 错误 | BAD_INPUT");
  assert.equal(result("goal_accept", { error: { code: "DENIED" }, content: [{ type: "text", text: "raw error" }] }, {}, { isError: true }), "goal_accept | 错误 | DENIED");
  assert.equal(result("goal_status", { details: { value: { lifecycle: "completed" } } }), "goal_status | 已完成");
  assert.equal(result("goal_status", { details: { value: { runtimeState: "suspended" } } }), "goal_status | 已暂停");
  assert.equal(result("goal_status", { details: { value: { readiness: "needs_clarification" } } }), "goal_status | 需澄清");
});

test("Goal renderer uses terminal column width and never echoes sensitive input", () => {
  const malicious = "token hash approval objective criteria raw JSON unicode-中文";
  for (const [name, renderer] of Object.entries(renderers)) {
    const components = [
      renderer.renderCall({ objective: malicious, action_token: malicious, goal_id: malicious, task_id: malicious }),
      renderer.renderResult({ details: { value: { status: malicious, machineAction: { tool: malicious }, task_id: malicious, raw: { token: malicious } } } }),
    ];
    for (const component of components) for (const width of [0, 1, 8, 80]) {
      const lines = component.render(width);
      assert.ok(lines.every((line) => visibleWidth(line) <= width));
      assert.ok(lines.every((line) => !line.includes(malicious) && !line.includes("{") && !line.includes("token")));
    }
  }
  assert.deepEqual(renderers.goal_status.renderCall({ goal_id: "任务-1" }).render(0), []);
  assert.equal(render("goal_status", { goal_id: "g-1" }, 1), "…");
  assert.equal(render("goal_status", { goal_id: "g-1" }, 8), "goal_st…");
  assert.equal(render("goal_status", { goal_id: "g-1" }, 12), "goal_status…");
  assert.equal(render("goal_init", { execution: { schema: "goal-runtime.v1", tasks: [], conditions: [] } }, 15), "goal_init | 运…");
  assert.equal(result("goal_status", { details: { value: "{bad" }, content: [{ type: "text", text: JSON.stringify({ status: "leaked" }) }] }), "goal_status | 完成");
});
