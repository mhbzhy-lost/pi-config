// S5 引导迁移合同测试（计划 §2.3、§S5；docs/plans/records/2026-10-16-operation-tools/contract.md §2.1-§2.3/§4）。
//
// 边界（如实声明，不夸大）：
// - 本文件只做「文本迁移」合同核对：14 个新工具 description/prompt 短说明与 S0 对象/必填/权威一致；
//   本仓自有 spawn/reminder 回执不再无条件建议 integrate/discard，改指 managed_workspace_status 实时权威；
//   AGENTS_GLOBAL 旧调用示例切到新工具名并保留治理/授权/恢复政策；bash_async 第4条只补 Host/RPC 限定。
// - 对 extension.ts / completion-reminder.ts 的 receipt 断言采用「源码文本 + 真实 factory」两层：
//   factory 层覆盖 description/schema/guidelines 的真实导出值；源码层只核对自有文案与 details 字段未被改写。
//   行为层的 spawn 回执整句由 test/subagent-runtime-membrane.test.mjs 覆盖（该文件原第 1419 行
//   逐字钉住旧句，经父层授权仅按选项 A 修正为匹配新文案，其他断言与生产逻辑未动）。
// - 不导入、不启动 Host、不联网、不调用 provider；不读取 settings/models/auth/session/authority/state。
// - 不给 reviewer 加权限：只断言 profile 的 tools 白名单里仍没有 contact_supervisor。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { createSubagentOperationTools } from "../packages/pi-subagents-enhanced/src/subagent-dispatch/operation-tools.ts";
import { createSupervisorOperationTools } from "../packages/pi-subagents-enhanced/src/subagent-dispatch/supervisor-operation-tools.ts";
import {
  createWorkspaceOperationTools,
  WORKSPACE_OPERATION_TOOL_NAMES,
} from "../packages/pi-subagents-enhanced/src/workspace/operation-tools.ts";

const ROOT = join(import.meta.dirname, "..");
const read = (relative) => readFileSync(join(ROOT, relative), "utf8");

const globalMd = () => read("pi/AGENTS_GLOBAL.md");
const reviewerMd = () => read("pi/agents/reviewer.md");
const executorMd = () => read("pi/agents/executor.md");
const extensionTs = () => read("packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts");
const reminderTs = () => read("packages/pi-subagents-enhanced/src/workspace/completion-reminder.ts");
const bashAsyncTs = () => read("src/bash-async/index.ts");
const agentsSharedTs = () => read("src/agents-shared/index.ts");

function subagentTools() {
  return createSubagentOperationTools({ executeStart: () => {}, executeControl: () => {} });
}

function workspaceTools() {
  const service = {
    listOwned: () => [],
    statusOwned: () => ({ receipt: { workspaceId: "w", state: "released", leaseId: "l" } }),
    issueOwnedDisposition: () => ({ receipt: { workspaceId: "w", state: "active", leaseId: "l" } }),
    disposeOwned: () => ({ workspaceId: "w", state: "released" }),
    releaseOwned: () => ({ workspaceId: "w", state: "released" }),
  };
  return createWorkspaceOperationTools({ service, resolveRootSessionId: () => "root-1" });
}

function supervisorTools() {
  return createSupervisorOperationTools({ execute: () => ({ content: [], isError: false, details: {} }) });
}

function byName(tools) {
  return Object.fromEntries(tools.map((tool) => [tool.name, tool]));
}

/* ------------------------------------------------------------------ */
/* 1. 14 新工具 description/prompt 与 S0 对象/必填/权威一致             */
/* ------------------------------------------------------------------ */

test("引导合同：14 新工具名齐备、旧 union 名不进入新工具面", () => {
  const names = [...subagentTools(), ...workspaceTools(), ...supervisorTools()].map((tool) => tool.name);
  assert.equal(names.length, 14, `新模型工具必须恰好 14 个：${names.join(",")}`);
  assert.deepEqual(names.slice(0, 7), [
    "subagent_roster", "subagent_start", "subagent_run_status", "subagent_run_steer",
    "subagent_run_interrupt", "subagent_run_resume", "subagent_run_stop",
  ]);
  assert.deepEqual(names.slice(7, 11), [...WORKSPACE_OPERATION_TOOL_NAMES]);
  assert.deepEqual(names.slice(11), ["supervisor_request_pending", "supervisor_request_status", "supervisor_request_reply"]);
  for (const legacy of ["subagent", "subagent_worktree", "subagent_supervisor"]) {
    assert.equal(names.includes(legacy), false, `旧 union 名 ${legacy} 不得重新出现在新工具面`);
  }
});

test("引导合同：每工具 description 首句给对象/必填，并声明各自的权威边界", () => {
  const all = [...subagentTools(), ...workspaceTools(), ...supervisorTools()];
  for (const tool of all) {
    assert.equal(typeof tool.description, "string");
    assert.ok(tool.description.length > 0, `${tool.name} 需要非空 description`);
    // S0 冻结的必填事实：要么写明必填/可选/无参数，要么声明该工具不接受参数。
    assert.match(
      tool.description,
      /必填|可选|无参数|不接受其他参数|只接受空对象/,
      `${tool.name} description 必须给出对象与必填/可选事实`,
    );
    assert.equal(tool.exposure, "model-only", `${tool.name} 必须保持 model-only`);
    // 参数手册下移到 tool 旁文本：description 不得膨胀成 GLOBAL 的整表复制。
    assert.ok(tool.description.length < 1_200, `${tool.name} description 应保持短说明：${tool.description.length}`);
  }
  // 每工具都必须声明自己不是什么第二权威（对象/权威一致）。
  const by = byName(all);
  assert.match(by.managed_workspace_status.description, /权威/);
  assert.match(by.supervisor_request_reply.description, /不代表.*消费|提交已记录/);
  assert.match(by.subagent_start.description, /terminal proof/);
});

test("引导合同：workspace 四工具以实时 status 为唯一权威、coding integrate 由 child 拥有", () => {
  const by = byName(workspaceTools());
  assert.match(by.managed_workspace_status.description, /实时/, "status 必须声明实时权威");
  assert.match(by.managed_workspace_status.description, /allowed_dispositions/);
  assert.match(by.managed_workspace_status.description, /action_token/);
  assert.match(by.managed_workspace_list.description, /managed_workspace_status/, "list 只投影名册，动作权威仍是 status");
  assert.match(by.managed_workspace_dispose.description, /CHILD_OWNS_INTEGRATION/, "dispose 必须写明 coding child-owned");
  assert.match(by.managed_workspace_dispose.description, /以 status 当前 allowed_dispositions 包含的处置|allowed_dispositions/);
  // released 终态 + release 为独立分支，不得写成 dispose 之后的串联续步。
  assert.match(by.managed_workspace_release.description, /released[^\n]*终态/);
  assert.doesNotMatch(by.managed_workspace_release.description, /必须先|先经|之后才能/);
});

test("引导合同：supervisor reply/pending/status 把「提交≠消费」写进 description 而非只放 guideline", () => {
  const by = byName(supervisorTools());
  for (const name of ["supervisor_request_pending", "supervisor_request_status", "supervisor_request_reply"]) {
    assert.match(by[name].description, /不消费请求|不代表|不等于/, `${name} description 必须自带只读/未消费边界`);
  }
  assert.match(by.supervisor_request_reply.description, /replyTo 与 message 均必填非空/);
  assert.match(by.supervisor_request_reply.description, /只代表提交已记录，不代表子代理已收到、已消费/);
  assert.match(by.supervisor_request_reply.description, /to 为可选，仅在无控制面或控制面停用路径/);
  assert.match(by.supervisor_request_status.description, /queued 不等于 child 已收到或已消费/);
  // gate 计划的 inspect/clear 仍由该计划注册，本迁移不创建第 15/16 工具。
  assert.equal(Object.hasOwn(by, "subagent_supervisor_inspect"), false);
  assert.equal(Object.hasOwn(by, "subagent_supervisor_clear"), false);
});

test("引导合同：subagent_start/run_* 把 workspace 处置权威指向 managed_workspace_status，不复制旧参数手册", () => {
  const by = byName(subagentTools());
  assert.match(by.subagent_start.description, /agent、task 必填/);
  assert.match(by.subagent_start.description, /acceptance\.criteria 必填/);
  assert.match(by.subagent_start.description, /managed_workspace_status/, "start 必须把工作区处置权威指向 status");
  assert.match(by.subagent_start.description, /不在此预判 integrate 或 discard/);
  assert.match(by.subagent_start.description, /integration queue 自主拥有/);
  assert.match(by.subagent_start.description, /不是 terminal proof/);
  assert.match(by.subagent_run_status.description, /不构成 workspace 处置权威/);
  assert.match(by.subagent_run_status.description, /不要轮询等待/);
  assert.match(by.subagent_run_resume.description, /新 run（新子会话）/);
  assert.match(by.subagent_run_resume.description, /stopped 的 run 不可 resume/);
  assert.match(by.subagent_run_resume.description, /不提供模型换模/);
  assert.match(by.subagent_run_steer.description, /supervisor gate/);
  assert.match(by.subagent_roster.description, /无参数/);
  // 新 14 工具的自有文案不得残留旧 union 调用示例（旧 factory 的兼容文本不在此列）。
  for (const tool of [...subagentTools(), ...workspaceTools(), ...supervisorTools()]) {
    const corpus = [tool.description, tool.promptSnippet ?? "", ...(tool.promptGuidelines ?? [])].join("\n");
    for (const legacyCall of [/subagent\(\{/, /subagent_worktree\(\{/, /subagent_supervisor\(\{/]) {
      assert.doesNotMatch(corpus, legacyCall, `${tool.name} 旁文本不得给出旧 union 调用示例`);
    }
  }
});

/* ------------------------------------------------------------------ */
/* 2. 本仓自有 spawn/reminder 回执：无条件 integrate/discard 已移除     */
/* ------------------------------------------------------------------ */

test("引导合同：extension.ts 两处 workspaceNotice 改按实时状态权威，且 raw details 字段未被改写", () => {
  const source = extensionTs();
  assert.equal(source.split("const workspaceNotice = workspace").length - 1, 2, "coding 与 generic 各一处 workspaceNotice");
  assert.equal(source.split("call managed_workspace_status({workspace_id:").length - 1, 2, "两处 notice 都必须指向 managed_workspace_status");
  assert.equal(source.split("do not assume integrate or discard").length - 1, 2, "两处都必须取消无条件 integrate/discard 建议");
  assert.doesNotMatch(source, /then integrate or discard to finish/);
  // 模型可见的 receipt 文本（ASYNC_SPAWN_GUIDANCE + 两处 workspaceNotice）不得残留旧 union 调用示例；
  // 旧 union 自身保留的兼容 description 不在本项断言范围（它不再注册，因此不是模型可见文本）。
  const spawnGuidance = /const ASYNC_SPAWN_GUIDANCE = "[^""\n]*";/m.exec(source)?.[0] ?? "";
  assert.ok(spawnGuidance.length > 0, "ASYNC_SPAWN_GUIDANCE 常量必须仍在");
  assert.doesNotMatch(spawnGuidance, /subagent_worktree\(\{action:/);
  const noticeBodies = source.split("const workspaceNotice = workspace").slice(1).map((chunk) => chunk.split("\n")[0]);
  assert.equal(noticeBodies.length, 2);
  for (const body of noticeBodies) assert.doesNotMatch(body, /subagent_worktree/);
  // 不改 raw details/session/event：receipt 仍只投影既有公开字段与既有 handle 形状。
  assert.match(source, /details: \{ \.\.\.handle, modelSelection: modelSelectionDetails\(selection\)/);
  assert.match(source, /details: \{ \.\.\.binding, agent: normalizedInput\.agent, title, modelSelection/);
  assert.match(source, /\.\.\.\(workspace \? workspacePublic\(workspace\) : \{\}\)/);
  // 旧 union 的兼容定义仍可保留（供实现复用/兼容测试），但唯一注册点已换成新工具名。
  assert.match(source, /for \(const definition of subagentOperationTools\) pi\.registerTool\(definition\);/);
  assert.equal(source.includes("pi.registerTool(tool);"), false, "旧 subagent union 不得重新注册");
  assert.equal(source.includes("pi.registerTool(workspaceTool);"), false, "旧 subagent_worktree union 不得重新注册");
});

test("引导合同：completion-reminder 只指状态权威，details/customType/发送去重逐字不变", async () => {
  const source = reminderTs();
  assert.doesNotMatch(source, /then integrate or discard to finish/);
  assert.doesNotMatch(source, /subagent_worktree/, "本仓 reminder 必须改用新工具名");
  assert.match(source, /managed_workspace_status\(\{workspace_id:/);
  assert.match(source, /do not assume integrate or discard/);
  assert.match(source, /CHILD_OWNS_INTEGRATION/);
  // 提醒发送与去重合同保持原样（S5 只动 content 文本）。
  for (const invariant of [
    'customType: "subagent-workspace-reminder"',
    'schemaVersion: "subagent-workspace-reminder.v1"',
    "workspaceState: receipt.state",
    'mode: "standalone-subagent"',
    "{ deliverAs: \"followUp\", triggerTurn: false }",
    "delivered.add(key)",
    "SUBAGENT_WORKSPACE_REMINDER_AMBIGUOUS",
    "SUBAGENT_WORKSPACE_REMINDER_DELIVERY_DEBT",
  ]) {
    assert.ok(source.includes(invariant), `reminder 不变量丢失：${invariant}`);
  }
});

/* ------------------------------------------------------------------ */
/* 3. AGENTS_GLOBAL：旧示例→新工具名映射，治理政策保留                */
/* ------------------------------------------------------------------ */

test("引导合同：AGENTS_GLOBAL 示例切到新工具名并给一次旧→新映射", () => {
  const md = globalMd();
  assert.doesNotMatch(md, /subagent\(\{/, "GLOBAL 不得再保留旧 subagent({…}) 调用示例");
  assert.doesNotMatch(md, /subagent_worktree\(\{/, "GLOBAL 不得再保留旧 subagent_worktree({…}) 调用示例");
  for (const name of [
    "subagent_roster", "subagent_start", "subagent_run_status", "subagent_run_steer", "subagent_run_interrupt",
    "subagent_run_resume", "subagent_run_stop", "managed_workspace_list", "managed_workspace_status",
    "managed_workspace_dispose", "managed_workspace_release", "supervisor_request_pending",
    "supervisor_request_status", "supervisor_request_reply",
  ]) {
    assert.ok(md.includes(name), `GLOBAL 必须给出新工具名 ${name}`);
  }
  // 旧名只允许出现在一次性映射说明里，并显式声明旧通知不构成新 schema。
  assert.match(md, /旧名一次性映射/);
  assert.match(md, /不构成新工具的 schema/);
  assert.match(md, /历史 raw 文本/);
});

test("引导合同：AGENTS_GLOBAL 保留治理/授权/恢复/预算政策，只下移逐操作参数", () => {
  const md = globalMd();
  for (const [label, needle] of [
    ["默认委派", "默认委派 subagent 执行"],
    ["计划 inline", "计划编写必须本会话 inline"],
    ["执行方式询问", "用户选择前不得自动开始计划执行"],
    ["首轮 reviewer 自动唯一一次", "且仅自动这一轮"],
    ["后续 reviewer 需授权", "每轮派发前都必须取得用户明确授权"],
    ["30 分钟组织预算", "30 分钟是单个派发预计执行时长"],
    ["dirty/managed workspace 规则", "origin dirty 时不得自动 stash/reset/覆盖"],
    ["禁止 raw git worktree", "禁止 raw git worktree 命令操作 managed workspace"],
    ["coding child-owned 集成", "CHILD_OWNS_INTEGRATION"],
    ["terminal proof", "都不等于 terminal proof"],
    ["工单需用户确认", "任何工单、申请流程，直接向用户取得确认"],
    ["模型不可用恢复顺序", "不得把 provider 请求失败当作自动换模的触发条件"],
    ["resume 决策顺序", "本规则只描述主管对既有 `subagent_run_resume` 能力的决策顺序"],
  ]) {
    assert.ok(md.includes(needle), `GLOBAL 政策丢失（${label}）：${needle}`);
  }
  // 逐操作长表不得回流 GLOBAL：参数手册归 tool 旁文本。
  assert.equal(md.includes("allowedActionsFor"), false);
});

test("引导合同：child 边界保守措辞、contact_supervisor 可用性与 profile 白名单关系显式说明", () => {
  const md = globalMd();
  assert.match(md, /`contact_supervisor` 在该 child 实际可用时/);
  assert.match(md, /不可用时不得指示 child 调用不存在的工具/);
  assert.match(md, /以其 profile 的 `tools` 白名单为事实/);
  assert.match(md, /不得为绕过这一点给 reviewer 追加工具权限/);
  // 刻意差异与 owner 同步责任已记录；SHARED/agents-shared 本迁移不改。
  assert.match(md, /src\/agents-shared\/index\.ts/);
  assert.match(md, /不改 `pi\/AGENTS_SHARED\.md` 的政策/);
  const sharedSource = agentsSharedTs();
  assert.match(sharedSource, /经 contact_supervisor（reason: \\"need_decision\\"）上报并等待决定/, "agents-shared 注入文本本任务未改");
});

test("引导合同：不给 reviewer 追加工具权限；executor/delegate 白名单保持原样", () => {
  const toolsOf = (md) => /^tools:\s*(.+)$/m.exec(md)?.[1]?.trim() ?? "";
  const reviewer = toolsOf(reviewerMd());
  assert.equal(reviewer, "read,grep,find,ls,bash", `reviewer tools 白名单不得变化：${reviewer}`);
  assert.equal(reviewer.includes("contact_supervisor"), false);
  assert.ok(toolsOf(executorMd()).includes("contact_supervisor"), "executor 仍保留 contact_supervisor");
});

/* ------------------------------------------------------------------ */
/* 4. bash_async：clear_queue 限定 Host/RPC 非本工具参数               */
/* ------------------------------------------------------------------ */

test("引导合同：bash_async 第4条只补 clear_queue 主体限定，不新增命令拦截", () => {
  const md = bashAsyncTs();
  assert.match(md, /clear_queue 是 Host\/RPC 侧操作、不是本工具参数/);
  // 合法 sleep 载荷/retry/backoff/测试模拟延迟/用户 delay 例外逐字保留。
  assert.match(md, /真实命令内部的 retry\/backoff、测试自身的模拟延迟、用户任务里明确要求的 delay 都按任务照常执行/);
  assert.match(md, /不要为等待回执执行 sleep\/wait/);
  // 不新增命令拦截：既没有按命令内容拒执行的分支，也没有硬拒措辞。
  assert.doesNotMatch(md, /command\.includes\(['"]sleep['"]\)/, "不得新增按 sleep 字样拒执行的拦截");
  assert.equal(md.split("throw new Error(\"bash_async").length - 1, 0);
});
