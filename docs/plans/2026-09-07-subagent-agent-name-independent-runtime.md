# Subagent Runtime Agent 名称去耦实现计划

> **给执行 agent：** 必须逐任务执行本计划；步骤使用 `- [ ]` 复选框跟踪。执行方式由计划完成后的用户选择决定。

**目标：** 让 subagent 与 Goal runtime 只依据显式调用合同、可信 Host 授权和持久化 ownership 判断能力，不再依据实际 agent 名称 `executor` 选择 coding 路径、授予 Root Broker 权限或验证 Goal proof；任意已发现的 `agents/*.md` profile 都可作为 coding target，同一 profile 走 generic 调用时不获得 coding/Goal 权限。

**架构：** `agent` 仅作为待发现、待启动和待核对的 profile identity；`dispatch-ir.v1` 的结构分支授予 coding execution kind，generic 结构授予 generic kind。新增 Host-owned `RunAuthorization`，由 typed facade 根据调用分支和 Goal ticket 生成；Root Broker 消费该授权并签发 capability grant，不再从 `subagent:async-started.agent` 推断权限。Goal 新 generation 使用 `agentProfile`、`runBinding` 和 execution proof；旧 `task.executor_bound`、`executorBinding`、`role:"executor"` 与 v1 proof 只在集中 legacy compat 中读取并立即归一化。

**技术栈：** TypeScript、Node.js 22.19+、TypeBox JSON Schema、Pi Extension API、pi-subagents 0.62.0 compatibility layer、Root Broker JSON 协议、Goal JSONL event store、Node test runner。

## 全局约束

- production 新路径不得以 `agent === "executor"`、`agent !== "executor"`、`enum/const: ["executor"]`、`CODING_AGENTS` 或等价名称判断选择行为或授予权限。
- 不得把 `executor` 改名为 `coding-agent`、`worker` 等另一个硬编码名称来规避本目标。
- agent Markdown/frontmatter 属于可编辑 profile 配置，只能提供 prompt、tools、models 等执行配置；不得自声明 `coding`、`acceptance.submit`、Goal ownership 或 Root Broker privileged capability。
- coding/generic 权限由调用结构决定：包含 `version:"dispatch-ir.v1"` 的完整 typed contract 是 coding；`{agent,title,task}` 是 generic。实际 agent 名称不能改变 execution kind。
- `dispatch-ir.v1` 保持版本号：本改动只放宽既有 `agent` identity 的可接受集合，不删除字段、不改变 hash 输入；所有旧 `agent:"executor"` 调用继续有效。
- Broker grant/proof 与 Goal event/task shape 会删除或替换持久化字段，必须分别写入新 schema/generation；不得把这类破坏性变化伪装成 v1 兼容扩展。
- coding 与 generic 均必须先 discover 精确目标 profile，再发生 Goal prepare、workspace allocation、RPC ping、title registration 或 child spawn；未知 profile fail closed。
- 同一 profile 名称必须可分别用于 coding 和 generic；generic 调用不得获得 checked coding acceptance、Goal ticket、acceptance evidence tool 或 privileged Broker grant。
- Host-owned `RunAuthorization` 是 runtime capability 的唯一来源；普通 coding 仅获 `root.subscribe`，Goal coding 额外获 `acceptance.submit`，generic worktree只注册 terminal identity且 capabilities 为空。
- Root Broker 不得再通过监听任意名称为 `executor` 的 started event 自动建立 principal、写 grant 或接受 evidence。
- 新 Broker writer 使用 capability grant 与 execution proof 的中性 schema；旧 grant/proof 只允许由 dedicated legacy decoder 读取，不得产生新的 v1 `role:"executor"` artifact。
- Goal 新 writer 使用新 generation，不原地改写 `planned.v1` / `goal-runtime.v1`；历史 generation 必须原样 replay，并在 compat 边界投影为中性内部状态。
- Goal 新 task contract 必须显式持久化 `agentProfile`；不得在 core runtime 中为缺失值默认为 `executor`。旧 generation 的历史默认只允许存在于 legacy adapter。
- 新 Goal projection 使用 `runBinding`、`lastRunProof`、`runIds`；新事件使用 `task.run_bound`。旧字段和事件名只在 replay adapter 或 legacy presentation 中出现。
- acceptance evaluator 在新 generation 使用 `run` / `coordinator`，新 coordinator predicates 使用 `run-bound` / `run-terminal-proof`；旧 `executor` evaluator/predicates仅作历史输入归一化。
- `executorHead` 等不参与 agent 选择或授权的 workspace/Git 领域字段不在本计划内做纯命名重构；是否改名不得阻塞安全目标。
- TUI/browser 中把 `executor` 当普通 display fixture 的测试无需批量改名；验收关注授权与控制流，不对展示字符串做镜像断言。
- agent discovery 继续只能经 `packages/pi-subagents-enhanced/src/compat/pi-subagents-0.62.ts` 消费 upstream 深层 API。
- 所有生产行为变更严格遵循 TDD；bug 修复任务先建立中文问题记录并观察精确 RED。
- 测试异常先记录数据来源、首个偏离点和完整调用链，并按 production 可达、fixture 污染或来源未证实分类；不得为非法 fixture 增加 production fallback。
- 不使用 Goal Engine 自举执行或验收本计划；涉及 Goal runtime 的任务仍按计划 DAG 由 Subagent-Driven 或用户明确授权的 Inline 方式执行。
- 不修改 `pi/settings.json`、`pi/models.json`、现有 agent `models` 顺序或本机 provider 配置。
- 保留当前工作区内与本计划无关的 compact-rendering、统一 model selector 和用户配置改动，不回退、不覆盖、不归因。
- 不创建 commit 或 push，除非用户另行明确授权。

## 目标文件结构

```text
packages/pi-subagents-enhanced/
  src/subagent-dispatch/
    run-authorization.ts          # execution kind、capability、binding 与 Goal authority 的严格 Host-owned 合同
    legacy-executor-compat.ts     # 旧 Broker grant/proof 的唯一 executor 字面兼容边界
    extension.ts                  # 名称无关 typed/generic 分流、discovery 与显式授权注册
    root-broker-protocol.ts       # capability grant v2 与现有 request/push/response codec
    root-broker-server.ts         # 只接受显式 RunAuthorization，不从 agent 名称推断 owner
    root-broker-client.ts         # 按 required capability 打开 root/acceptance client
    root-broker-registry.ts       # 中性的 run coordinator / execution proof facade
  child-extensions/
    root-session-owner.ts         # 要求 root.subscribe capability
    acceptance-evidence.ts        # 要求 acceptance.submit capability

src/goal-engine/
  run-binding.ts                  # 新 generation 的 ticket、run binding 与 execution proof
  legacy-executor-compat.ts       # planned.v1 / goal-runtime.v1 replay 与 presentation adapter
  events.ts                       # planned.v2 / goal-runtime.v2 与 task.run_bound reducer
  dispatch.ts                     # 从 task.agentProfile 生成名称无关 dispatch-ir.v1
  task-definition.ts              # agentProfile、run evaluator 与中性 predicates
  obligation-contract.ts          # goal-runtime.v2 task codec
  generation-capabilities.ts      # v1/v2 generation matrix
  extension.ts                    # 中性 coordinator、settlement、recovery 与 status

test/
  subagent-run-authorization.test.mjs
  subagent-agent-name-independence.integration.mjs
  subagent-broker-capabilities.integration.mjs
  goal-engine-run-binding.integration.mjs
  goal-engine-agent-profile-compatibility.integration.mjs
```

最终删除或停止导出的旧实现入口：

```text
src/goal-engine/executor-binding.ts
bindGoalExecutorCoordinator*
findGoalExecutorCoordinator
inspectRootBrokerExecutorProof
persistGoalExecutorBindingAuthority
RootBrokerServer.startedFacts 的名称推断路径
RootBrokerServer.ensureExecutorOwner
```

## 核心接口

```ts
type ExecutionKind = "coding" | "generic";
type RunCapability = "root.subscribe" | "acceptance.submit";

type RunBindingIdentity = {
  runId: string;
  asyncDir: string;
  sessionId: string;
  pid: number;
  agentProfile: string;
};

type GoalRunAuthority = {
  ticketId: string;
  goalId: string;
  taskId: string;
  attempt: number;
  contractHash: string;
  workspaceId: string;
  executionRevision: number;
  expectedCriteria: string[];
};

type RunAuthorization = {
  version: "subagent-run-authorization.v1";
  kind: ExecutionKind;
  binding: RunBindingIdentity;
  capabilities: RunCapability[];
  goal: GoalRunAuthority | null;
};

createRunAuthorization(input): Readonly<RunAuthorization>;
registerAuthorizedRun(authorization): Promise<void> | void;
inspectExecutionProof(runId): ExecutionProof | null;
```

授权矩阵固定为：

| 调用路径 | kind | capabilities | Goal authority |
| --- | --- | --- | --- |
| generic，无 worktree | `generic` | 不注册 | 无 |
| generic，managed worktree | `generic` | `[]` | 无；仅 terminal tracking |
| standalone typed coding | `coding` | `["root.subscribe"]` | 无 |
| Goal typed coding | `coding` | `["root.subscribe","acceptance.submit"]` | 必须与 Goal ticket 精确绑定 |

## DAG

```text
T1（中性 RunAuthorization 合同）
  ├──> T2（dispatch codec/schema 名称去耦） ──> T4（typed facade 显式授权接入）
  ├──> T3（Broker capability v2） ────────────> T4
  └──> T5（Goal v2 task/event/runBinding codec）

T3 ──> T7（legacy Broker/Goal compat）
T5 ──> T7

T4 ───────────────┐
T5 ───────────────┼──> T6（Goal coordinator/settlement 接入）
T7 ───────────────┘

T4 ───────────────┐
T6 ───────────────┼──> T8（Doctor、Skill 与改名 canary）
T7 ───────────────┘

T8 ──> T9（完整回归、fresh Host 与 cleanup 验收）
```

依赖边说明：

- `T1 -> T2/T3/T5`：三条实现线统一消费 `ExecutionKind`、`RunCapability`、`RunBindingIdentity` 和 `RunAuthorization`，避免各自创造相近但不兼容的 capability 结构。
- `T2,T3 -> T4`：typed facade 只有在名称无关 codec 与 Broker authorization API 同时稳定后才能切断名称判断。
- `T3,T5 -> T7`：legacy adapter 需要同时知道新 proof/capability shape 和新 Goal projection shape，才能做单向归一化。
- `T4,T5,T7 -> T6`：Goal coordinator 必须消费名称无关 spawn、v2 task/event codec 和历史 replay adapter。
- `T4,T6,T7 -> T8`：公共指导与改名 canary 必须针对最终 standalone、Goal 和 legacy 行为，不得提前固定半成品 API。
- `T8 -> T9`：最终验收针对已经删除旧生产入口的发行闭包。

## Waves

- Wave 1：T1
- Wave 2：T2、T3、T5（可并行；分别写 dispatch、Broker、Goal codec，WritePaths 不重叠）
- Wave 3：T4、T7（可并行；T4 接 runtime，T7 写 compat）
- Wave 4：T6
- Wave 5：T8
- Wave 6：T9

**关键路径：** T1 → T5 → T7 → T6 → T8 → T9。T2/T3/T4 是并行支路，但 T4 未完成时 T6 不得接入新 coordinator。

---

### Task 1：建立中性 RunAuthorization 与问题基线

**Deps：** `none`

**WritePaths：**
- `docs/bugs/2026-09-07-subagent-runtime-agent-name-coupling.md`
- `packages/pi-subagents-enhanced/src/subagent-dispatch/run-authorization.ts`
- `test/subagent-run-authorization.test.mjs`

**Resources：** `none`

**Files：**
- Create：中文问题记录
- Create：RunAuthorization 纯合同模块
- Create：纯合同测试

**接口契约：**
- Consumes：上文固定的 `ExecutionKind`、binding、可选 Goal ticket 事实。
- Produces：`createRunAuthorization(input)`、`capabilitiesForRun({kind, goal})`、`assertRunAuthorization(value)`。
- capability 只能由函数根据调用路径计算；输入若直接携带任意 capabilities 必须被拒绝。

**验收标准：** 授权矩阵确定、对象 exact/frozen、agentProfile 只作身份字段；generic 无法获得 privileged capability；Goal capability 缺 ticket 任一身份字段时 fail closed。

- [ ] **步骤 1：记录 production 名称耦合调用链**

问题记录至少覆盖：typed schema/IR 的固定 enum、generic 名称排除、Root Broker `startedFacts`、`ensureExecutorOwner`、Goal `compileTaskContract`、proof 的 `role:"executor"`，并区分 display fixture 与授权判断。

- [ ] **步骤 2：编写授权矩阵 RED**

```js
assert.deepEqual(createRunAuthorization({ kind: "coding", binding, goal: null }).capabilities, ["root.subscribe"]);
assert.deepEqual(createRunAuthorization({ kind: "generic", binding, goal: null }).capabilities, []);
assert.deepEqual(createRunAuthorization({ kind: "coding", binding, goal }).capabilities, ["acceptance.submit", "root.subscribe"]);
assert.throws(() => createRunAuthorization({ kind: "generic", binding, goal }));
```

- [ ] **步骤 3：运行测试确认 RED**

运行：`node --test test/subagent-run-authorization.test.mjs`

预期：FAIL，原因是模块/导出尚不存在。

- [ ] **步骤 4：实现 strict pure contract**

校验 safe identity、绝对 asyncDir、正整数 pid、canonical capability 顺序、Goal exact fields；返回深冻结对象。

- [ ] **步骤 5：运行 GREEN 与 mutation check**

运行同一测试；再临时验证 generic 加 `acceptance.submit`、删除 ticketId 校验或按 agentProfile 名称分支时至少一个断言失败。

---

### Task 2：让 dispatch-ir.v1 与工具 schema 接受任意已发现 profile

**Deps：** `T1`（理由：coding/generic 只输出 execution kind，后续授权消费 T1 合同）

**WritePaths：**
- `packages/pi-subagents-enhanced/src/contracts/dispatch-ir.ts`
- `packages/pi-subagents-enhanced/src/subagent-dispatch/ir.ts`
- `packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts`
- `test/subagent-dispatch-ir.test.mjs`
- `test/subagent-dispatch-schema-coercion.test.mjs`
- `test/subagent-dispatch-schema-security.test.mjs`
- `test/subagent-model-selection.integration.mjs`

**Resources：** `none`

**Files：** Modify：双 codec、tool union schema、discovery preflight 与测试。

**接口契约：**
- `agent` 在 coding/generic 两个分支使用同形非空、无控制字符、最大 256 字节字符串。
- branch 由 `version`/完整字段结构判别；名称不参与 branch 判别。
- `resolveSpawnModel` 继续通过 compat discovery 精确查找 profile，UNKNOWN_AGENT 发生在所有副作用前。

**验收标准：** `coder-alpha`、`package.coder-alpha` 可编译 coding IR；名为 `executor` 的 profile 可走 generic；混合/缺字段调用仍被 schema 拒绝；hash 继续包含实际 agent identity。

- [ ] **步骤 1：把名称限制改成行为 RED**

新增 custom profile coding 接受、same-profile generic 接受、空白/控制字符拒绝断言；保留结构混合拒绝。

- [ ] **步骤 2：运行 RED**

运行：

```bash
node --test test/subagent-dispatch-ir.test.mjs \
  test/subagent-dispatch-schema-coercion.test.mjs \
  test/subagent-dispatch-schema-security.test.mjs \
  test/subagent-model-selection.integration.mjs
```

预期：custom coding 被 `AGENTS`/enum 拒绝，generic `executor` 被 `not`/`CODING_AGENTS` 拒绝。

- [ ] **步骤 3：修改 codec 与 schema**

删除两个 `AGENTS` set、`CODING_AGENTS`、coding enum、generic name exclusion 和 executeGeneric 名称拒绝；复用统一 agent identity normalization。

- [ ] **步骤 4：收紧 discovery-before-effects**

无论是否传 model，coding/generic 都先 discover 目标 profile；不能仅在 model resolution 时发现 agent。返回的 profile identity 必须与请求精确一致。

- [ ] **步骤 5：运行 GREEN 与相关回归**

重复 RED 命令，并运行 `test/subagent-dispatch-extension.test.ts`；预期全部 PASS。

---

### Task 3：新增 Root Broker capability grant 与显式 run authorization

**Deps：** `T1`（理由：消费 canonical RunAuthorization 与 capability 集合）

**WritePaths：**
- `packages/pi-subagents-enhanced/src/subagent-dispatch/root-broker-protocol.ts`
- `packages/pi-subagents-enhanced/src/subagent-dispatch/root-broker-server.ts`
- `packages/pi-subagents-enhanced/src/subagent-dispatch/root-broker-client.ts`
- `packages/pi-subagents-enhanced/src/subagent-dispatch/root-broker-registry.ts`
- `packages/pi-subagents-enhanced/child-extensions/root-session-owner.ts`
- `packages/pi-subagents-enhanced/child-extensions/acceptance-evidence.ts`
- `test/root-subagent-broker-protocol.test.mjs`
- `test/root-subagent-broker.test.mjs`
- `test/root-subagent-broker-r10b-suspension.integration.mjs`
- `test/subagent-acceptance-evidence.integration.mjs`
- `test/subagent-broker-capabilities.integration.mjs`

**Resources：** 临时 Unix socket；同一测试文件串行运行。

**Files：** Modify：Broker codec/server/client/registry/child extensions；Create：capability integration test。

**接口契约：**

```ts
type BrokerGrantV2 = {
  schemaVersion: "pi-root-subagent-broker-grant.v2";
  rootSessionId: string;
  runId: string;
  callerToken: string;
  capabilities: ("root.subscribe" | "acceptance.submit")[];
};

RootBrokerServer.registerAuthorizedRun(auth: RunAuthorization): Promise<void>;
createRootBrokerClient({ rootSessionId, callerRunId, requiredCapability });
```

`registerAuthorizedRun` 原子注册 terminal identity；coding capability 才写 grant；Goal authority 才允许 evidence。`subagent:async-started` 事件本身永远不能授权。

**验收标准：** 未授权但名称为 executor 的 event 无 principal/grant；任意 agentProfile 的合法 authorization 可订阅；只有 Goal coding authorization 可提交 evidence；binding 任一字段漂移均拒绝。

- [ ] **步骤 1：新增 capability/grant RED**

测试 v2 exact codec、canonical capability 顺序、required capability、无 authorization 拒绝。

- [ ] **步骤 2：新增名称提权 RED**

```js
await events.emit("subagent:async-started", { ...binding, agent: "executor" });
assert.equal(broker.inspectExecutionProof(binding.runId), null);
await assert.rejects(client.subscribe(), /GRANT_NOT_READY|unauthorized/);
```

- [ ] **步骤 3：运行 RED**

运行 Broker protocol/server/acceptance focused tests；预期 v2 导出缺失且旧名称事件仍获 grant。

- [ ] **步骤 4：实现 v2 并停止名称推断**

新增 `registerAuthorizedRun`、中性 principal/capability maps、`inspectExecutionProof`；`observeStarted` 不再创建 owner，只可核对已预授权 binding或删除该监听路径。

- [ ] **步骤 5：让 child extension 要求 capability**

root owner client 要求 `root.subscribe`；acceptance client 要求 `acceptance.submit`。仅持有 token但缺 capability也必须拒绝。

- [ ] **步骤 6：运行 GREEN 与 socket 回归**

运行本任务全部测试；预期普通 health/subscription、terminal proof、shutdown drain 和 socket 权限回归不变。

---

### Task 4：typed facade 按调用分支注册授权并移除 executor 特判

**Deps：** `T2`（名称无关 schema/discovery）；`T3`（显式 authorization API）

**WritePaths：**
- `packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts`
- `packages/pi-subagents-enhanced/extensions/subagent-runtime.ts`
- `packages/pi-subagents-enhanced/src/subagent-dispatch/workflow-spawn.ts`
- `test/subagent-dispatch-extension.test.ts`
- `test/subagent-runtime-membrane.test.mjs`
- `test/subagent-managed-worktree.integration.mjs`
- `test/pi-subagents-project-workflow.integration.mjs`

**Resources：** 测试内 fake RPC/event bus；真实 Host 测试串行。

**Files：** Modify：facade/runtime/spawn 与 integration tests。

**接口契约：**
- production runtime 注入 `registerAuthorizedRun(auth)`，替代 `registerFacadeRun(binding)`。
- coding onBinding 立即构造授权：Goal ticket存在时加入 Goal authority与 acceptance capability，否则 standalone capability。
- generic managed-worktree onBinding 注册 capabilities `[]`；generic 无 worktree无需注册。
- authorization 注册必须发生在 child root extension 的重试窗口内，并早于 terminal event 丢失风险；若 terminal 已发生，Broker 从 official artifact恢复。

**验收标准：** custom-coder coding 获严格 prompt/checked acceptance/root lifecycle；同一 custom-coder generic不获 capability；无 worktree coding仍能 root subscribe；快速完成 child terminal proof不丢失。

- [ ] **步骤 1：编写 same-profile 双路径 RED**

同一个 discovery fixture `coder-alpha` 分别调用 typed/generic，断言 workflow profile相同但 authorization matrix不同。

- [ ] **步骤 2：编写无 worktree与快速终止 RED**

覆盖 coding `execution.worktree:false` 的 root subscription，以及 terminal event 先于 execute return 的 recovery。

- [ ] **步骤 3：运行 RED**

运行 extension/runtime/worktree/project workflow tests；预期 custom coding schema或 authorization callback失败。

- [ ] **步骤 4：接入 RunAuthorization**

在 collector `onBinding` 的可信 Host callback中附加 `agentProfile` 与 kind；Goal capability只能来自已确认 ticket，不能从 input/frontmatter读取。

- [ ] **步骤 5：删除旧 facade 名称入口**

移除 production `registerFacadeRun` 注入和所有 executor name guard；terminal-only generic registration也统一走空 capability authorization。

- [ ] **步骤 6：运行 GREEN**

重复 focused tests，额外运行 `test/subagent-workflow-spawn.test.mjs` 与 package typecheck。

---

### Task 5：建立 Goal v2 agentProfile、runBinding 与中性 acceptance codec

**Deps：** `T1`（Goal run authority使用统一 identity/capability术语）

**WritePaths：**
- `src/goal-engine/generation-capabilities.ts`
- `src/goal-engine/task-definition.ts`
- `src/goal-engine/obligation-contract.ts`
- `src/goal-engine/events.ts`
- `src/goal-engine/dispatch.ts`
- `src/goal-engine/run-binding.ts`
- `test/goal-engine-generation-capabilities.integration.mjs`
- `test/goal-engine-obligation-contract.integration.mjs`
- `test/goal-engine-dispatch.integration.mjs`
- `test/goal-engine-runtime-events.integration.mjs`
- `test/goal-engine-run-binding.integration.mjs`

**Resources：** `none`

**Files：** Create：run-binding 与测试；Modify：Goal pure codecs/reducers。

**接口契约：**
- 新 generation：`planned.v2`、`goal-runtime.v2`。
- v2 task exact fields增加 `agentProfile`，不能为空且计入 task/execution contract hash。
- v2 event `task.run_bound`；projection字段 `runBinding`、`lastRunProof`、`runIds`。
- v2 evaluator为 `run|coordinator`；predicates为 `run-bound|run-terminal-proof|workspace-integrated-released|task-accepted`。
- `compileTaskContract` 从 task.agentProfile写入 dispatch `agent`，不接受默认值。

**验收标准：** v2 goal缺 agentProfile在任何持久化前失败；agentProfile变更触发 contract hash/执行 amendment；task.run_bound唯一且不可替换；纯 reducer中无 profile名称比较。

- [ ] **步骤 1：新增 v2 contract RED**

覆盖 task agentProfile required/exact/hash-sensitive；旧 v1 fixture仍可单独 replay。

- [ ] **步骤 2：新增 task.run_bound RED**

验证 binding identity包含实际 agentProfile，重复 runId、替换 binding、profile mismatch均拒绝。

- [ ] **步骤 3：运行 RED**

运行 generation/contract/events/dispatch tests；预期 v2 schema未知、task字段被拒绝。

- [ ] **步骤 4：实现 generation matrix 与纯 codec**

新增 v2 capabilities，例如 `{ runBinding:"strict", settlement:"execution-proof", ... }`；不要复用名为 executorBinding 的 capability key。

- [ ] **步骤 5：实现 run-binding.ts**

从旧 `executor-binding.ts` 提取名称无关 ticket/receipt/binding逻辑，函数命名为 `prepareRunBindingTicket`、`assertRunBindingTicketCurrent`、`runBoundEventData`、`assertExecutionSettlementProof`。

- [ ] **步骤 6：运行 GREEN**

重复 focused tests，验证 v2 writer仅产生 task.run_bound 与中性 projection字段。

---

### Task 6：切换 Goal coordinator、settlement、recovery 与 status 到中性 run

**Deps：** `T4`（名称无关 typed facade）；`T5`（Goal v2 codec）；`T7`（历史 projection 已可归一化）

**WritePaths：**
- `src/goal-engine/extension.ts`
- `src/goal-engine/suspension.ts`
- `src/goal-engine/current-world.ts`
- `src/goal-engine/obligation-policy.ts`
- `src/goal-engine/reconciliation.ts`
- `src/goal-engine/finalization.ts`
- `packages/pi-subagents-enhanced/src/subagent-dispatch/root-broker-registry.ts`
- `test/goal-engine-extension.integration.mjs`
- `test/goal-engine-executor-binding.integration.mjs`
- `test/goal-engine-suspension.integration.mjs`
- `test/goal-engine-obligation-policy.integration.mjs`
- `test/goal-engine-finalization.integration.mjs`
- `test/goal-engine-agent-profile-compatibility.integration.mjs`

**Resources：** Goal integration tests使用临时 state roots；禁止写当前 `var/goals`。

**Files：** Modify：Goal orchestration/status/recovery 与 registry；Create：agent profile compatibility test。

**接口契约：**
- registry导出 `bindGoalRunCoordinator*`、`findGoalRunCoordinator`、`inspectRootBrokerExecutionProof`、`persistGoalRunBindingAuthority`。
- Goal coordinator对 v2 contract的实际 agentProfile不设名称限制；bind时要求 proof agentProfile与 task/runBinding精确一致。
- settlement evidence identity使用 `executionHead` / `executionProof`；legacy presentation由 T7 adapter负责。

**验收标准：** `coder-alpha` Goal task可 dispatch、bind、submit acceptance、settle、integrate、accept；改名后的另一个 profile同样工作；generic 同名调用不能提交 evidence；Goal status新 generation不暴露 executorBinding。

- [ ] **步骤 1：编写 custom Goal profile RED**

用临时 agent discovery fixture和 v2 goal task `agentProfile:"coder-alpha"`，执行完整四阶段 coordinator flow。

- [ ] **步骤 2：编写 proof/profile mismatch RED**

授权 profile、started event profile、proof profile、task profile任一不同都必须在持久化 binding/settlement前失败。

- [ ] **步骤 3：运行 RED**

运行 extension/binding/suspension/finalization focused tests；预期 coordinator仍要求 handle.agent executor或旧 proof role。

- [ ] **步骤 4：迁移 coordinator 与所有 active-resource读取**

统一访问 `runBinding`；suspension/current-world/reconciliation使用 execution kind与绑定事实，不使用 agent名称或 executor字段判断 active authority。

- [ ] **步骤 5：迁移 settlement 与 acceptance**

Goal ticket生成 acceptance capability；evidence校验绑定 run/profile/contract/workspace；generic/standalone coding无 Goal authority时拒绝。

- [ ] **步骤 6：运行 GREEN**

运行本任务全部 focused tests及 Goal local convergence；预期 v2完整闭环通过。

---

### Task 7：集中 legacy executor compat 并禁止旧 schema 新写入

**Deps：** `T3`（Broker v2 shape稳定）；`T5`（Goal v2 projection稳定）

**WritePaths：**
- `packages/pi-subagents-enhanced/src/subagent-dispatch/legacy-executor-compat.ts`
- `packages/pi-subagents-enhanced/src/subagent-dispatch/root-broker-protocol.ts`
- `src/goal-engine/legacy-executor-compat.ts`
- `src/goal-engine/events.ts`
- `src/goal-engine/executor-binding.ts`
- `test/root-subagent-broker-protocol.test.mjs`
- `test/goal-engine-generation-compatibility.integration.mjs`
- `test/goal-engine-executor-binding.integration.mjs`
- `test/goal-engine-agent-profile-compatibility.integration.mjs`

**Resources：** 历史 JSONL fixtures；只读 replay。

**Files：** Create：两个 compat 模块；Modify：protocol/events/tests；Delete：旧 executor-binding 实现文件。

**接口契约：**
- Broker compat仅接受 exact v1 grant/proof并映射到 v2 capabilities/execution proof；不得导出用于写 v1 artifact的 builder。
- Goal compat将 `task.executor_bound`、executorBinding、lastExecutorProof、evaluator executor映射到 canonical run state；历史默认 profile仅在该 adapter中为 `executor`。
- legacy status若必须保持旧 public shape，由 generation-aware presenter从 canonical projection派生，不让 core逻辑读取旧字段。

**验收标准：** 所有历史 event versions replay结果不变；new init/mutation无法写 v1 grant/proof或 task.executor_bound；production `executor` 字面只存在于两个 legacy compat 文件和非授权展示文案。

- [ ] **步骤 1：固化 golden replay RED**

读取已有 v1/v2/v3/planned.v1/goal-runtime.v1 fixtures，断言归一化后得到 runBinding与同等 lifecycle/settlement结果。

- [ ] **步骤 2：新增 writer prohibition RED**

拦截所有新 artifact/event，断言 schema不是旧版本、event不是 task.executor_bound、proof不含 role executor。

- [ ] **步骤 3：运行 RED**

运行 generation compatibility 与 broker protocol tests；预期 compat导出缺失或新 writer仍写旧 shape。

- [ ] **步骤 4：实现单向 adapter并迁移调用方**

compat只做 old→canonical；禁止 canonical→old，除 generation-aware历史只读 presentation。

- [ ] **步骤 5：删除旧 executor-binding.ts**

调用方清零后删除，不保留一行 re-export facade；历史函数名不得继续成为新 runtime API。

- [ ] **步骤 6：运行 GREEN 与字面边界检查**

运行 replay tests，并用 `rg`人工检查名称判断仅在 compat许可路径；自动化测试验证行为，不建立源码全文镜像。

---

### Task 8：更新 Doctor、公共 Skill 与真实改名 canary

**Deps：** `T4`（standalone名称无关）；`T6`（Goal名称无关）；`T7`（legacy边界完成）

**WritePaths：**
- `scripts/doctor.ts`
- `skill-overrides/subagent-dispatch/SKILL.md`
- `pi/agents/executor.md`
- `packages/pi-subagents-enhanced/README.md`
- `test/doctor.test.mjs`
- `test/subagent-dispatch-skill.test.mjs`
- `test/pi-subagents-project-workflow.integration.mjs`
- `test/subagent-agent-name-independence.integration.mjs`

**Resources：** isolated Pi Host fixture；最多1个并发实例。

**Files：** Modify：Doctor/Skill/default profile/README/tests；Create：rename canary。

**接口契约：**
- Doctor检查 execution/capability schema与所请求 profile是否可发现，不检查固定 `executor.md` 或 executor专属 extension shape。
- Skill说明 agent是profile identity、调用结构决定kind、frontmatter不授予privilege。
- `pi/agents/executor.md` 可继续作为默认普通profile，但正文不得暗示名称自带runtime权限。

**验收标准：** 临时项目只创建 `coder-alpha.md` 而无 executor.md，typed coding与Goal全链通过；复制为 `coder-beta.md`并改请求后行为一致；同一 profile generic无privilege；Doctor两种名称均通过。

- [ ] **步骤 1：运行无新指导 pressure RED**

fresh-context parent面对 custom coder时，记录是否错误改名为executor或用generic绕过 typed contract。

- [ ] **步骤 2：编写真实 rename canary RED**

isolated project只含 coder-alpha profile；运行 typed coding、generic、Goal三路径。旧runtime应在 coding schema或Goal handle处失败。

- [ ] **步骤 3：修改 Doctor 与指导**

Doctor消费中性 generation/capability API；Skill使用正向矩阵，不用“除executor外”措辞；README记录安全授权来源。

- [ ] **步骤 4：运行同场景 GREEN**

fresh-context parent正确使用 typed coding并保留 custom profile；generic权限区分准确。

- [ ] **步骤 5：运行自动化 GREEN**

运行 Doctor、Skill、project workflow与 rename canary；验证不存在 executor.md时仍通过。

---

### Task 9：完整回归、发行闭包与 fresh Host 验收

**Deps：** `T8`（所有 runtime/Goal/compat/指导路径完成）

**WritePaths：**
- `docs/reviews/2026-09-07-subagent-agent-name-independent-runtime-verification.md`

**Resources：** isolated fresh Pi Host，最多1个；若操作当前 Host，必须先执行服务器状态门禁并取得用户明确操作。

**Files：** Create：中文验证记录。

**接口契约：** Consumes完整实现；Produces可复现的类型、package、unit/integration、legacy replay、fresh Host和资源清理证据。

**验收标准：** 全仓测试通过；fresh Host中 profile改名不影响coding/Goal；同名generic不提权；历史replay通过；无旧writer；所有workspace typed处置且无资源残留。

- [ ] **步骤 1：运行静态与 package 验证**

```bash
npm run typecheck
npm --prefix packages/pi-subagents-enhanced run verify:package
```

- [ ] **步骤 2：运行 focused tests**

```bash
node --test \
  test/subagent-run-authorization.test.mjs \
  test/subagent-dispatch-ir.test.mjs \
  test/subagent-dispatch-extension.test.ts \
  test/subagent-broker-capabilities.integration.mjs \
  test/root-subagent-broker.test.mjs \
  test/goal-engine-run-binding.integration.mjs \
  test/goal-engine-agent-profile-compatibility.integration.mjs \
  test/subagent-agent-name-independence.integration.mjs
```

- [ ] **步骤 3：运行历史 replay 与完整测试**

```bash
node --test test/goal-engine-generation-compatibility.integration.mjs
npm test
```

- [ ] **步骤 4：检查名称授权边界**

人工审查 production 命中：实际 profile名称不得参与if/enum/set membership/role授权；legacy executor字面只能位于明确 compat 文件。TUI fixture和非授权Git字段记录为允许项。

- [ ] **步骤 5：fresh Host 三路径 canary**

在临时clean Git项目创建 `coder-alpha.md`：

1. typed coding，无Goal，确认root lifecycle和actual model；
2. 同profile generic，确认无coding acceptance/privileged grant；
3. Goal v2 task，确认runBinding、acceptance.submit、settle/integrate/accept。

将文件改名为 `coder-beta.md`并只更新请求/合同数据，重复三条路径；runtime行为必须等价。

- [ ] **步骤 6：验证非法提权**

在 profile extra frontmatter中伪造 capability 字段，确认 discovery最多保留为untrusted extraFields，runtime授权不变；名称为executor的未授权started event也不得获grant。

- [ ] **步骤 7：处置资源并记录**

对每个managed workspace调用 `workspace_status`，使用返回的 action token执行允许的discard/integrate/preserve，再release preserved；禁止raw worktree mutation。记录最终0 active child和无残留workspace。

- [ ] **步骤 8：生成验证记录并停止**

记录requested profile、execution kind、capabilities、Goal generation、actual model、proof schema、命令结果与资源处置；不commit、不push。

## 计划自检

- **规格覆盖：** dispatch、generic、Broker、Goal、acceptance、Doctor、Skill、legacy replay与真实改名均有独立任务。
- **权限来源：** capability只来自调用分支与可信Goal ticket；frontmatter永不提权。
- **历史边界：** 旧executor字面只读归一化，不产生新旧artifact，不混写generation。
- **DAG一致性：** T2/T3/T5并行，T4/T7并行，Goal接入等待三项具体产物，最终canary等待完整汇合。
- **WritePaths冲突：** Wave 2无重叠；T4与T7无重叠；热点 `extension.ts`、`events.ts` 均通过依赖串行。
- **占位扫描：** 所有接口、版本、路径、命令和验收行为均已明确，无待补实现项。
- **非目标：** 不批量改TUI display fixture、不改workspace Git术语、不改本机model/settings、不提交。
