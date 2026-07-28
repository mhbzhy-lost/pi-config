# Typed Subagent Runtime 隔离与结构化派发实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: 使用 `test-driven-development` 逐项执行。步骤使用 checkbox（`- [ ]`）跟踪。当前 dirty worktree 不创建 commit，不修改或回退任务外变更。

**Goal:** 让主 Agent 只看到项目自有的 `subagent` typed facade 和项目自有的 `subagent_supervisor` facade；pi-subagents 仍由 Pi package manager 安装，但通过 zero-resource filter 禁用 upstream tools、skills、prompts、themes 和 commands。

**Architecture:** `pi-subagents@0.37.0` 在 `pi/settings.json` 中保留为 Pi-managed package，但 object entry 将 `extensions/skills/prompts/themes` 全部设置为 `[]`。项目 extension 从 Pi 安装目录导入 upstream runtime，用 default-deny `ExtensionAPI` membrane 保留 event、lifecycle、renderer 和 RPC bridge；自有 `subagent` facade 对 executor/spark 编译 `dispatch-ir.v1`，对其他 agent 原样 RPC spawn。Supervisor 合同由项目基于固定版本源码静态定义，membrane 仅在运行时截获 upstream 创建的、持有真实 pending/state 的 `execute` closure，并由项目自有 `subagent_supervisor` 原参数调用；生产运行时不动态推断 upstream schema。

**Tech Stack:** JavaScript ESM、Pi TypeScript extension、TypeBox、Node `crypto`、公开 `subagents:rpc:v1`、Node `node:test`。

---

## 文件职责

- `scripts/lib/subagent-dispatch/ir.mjs`：严格校验、规范化、路径规则、canonical hash 和 deep-freeze。
- `scripts/lib/subagent-dispatch/prompt.mjs`：确定性编译固定 section 的 child initial prompt。
- `scripts/lib/subagent-dispatch/rpc-client.mjs`：独立 RPC v1 client，source 固定为 `typed-subagent-runtime`。
- `scripts/lib/subagent-dispatch/runtime-membrane.mjs`：阻止 upstream 注册 model/human-facing resources；仅将 upstream `subagent_supervisor` 的私有执行句柄绑定到 adapter，同时保留 runtime API。
- `scripts/lib/subagent-dispatch/extension.mjs`：注册项目自有 `subagent` facade，负责 schema、routing、capability negotiation 和 typed handle。
- `scripts/lib/subagent-dispatch/supervisor-adapter.mjs`：拥有稳定 supervisor schema，并将调用原参数、原结果委托给当次 upstream runtime 的私有执行句柄。
- `pi/extensions/subagent-runtime.ts`：导入私有 upstream dependency 并启动 headless runtime 与两个项目 facade。
- `test/subagent-dispatch-ir.test.mjs`：IR 与 prompt 合同。
- `test/subagent-dispatch-rpc.test.mjs`：RPC envelope、timeout 和 dispose。
- `test/subagent-runtime-membrane.test.mjs`：资源隔离与 facade routing。
- `test/subagent-supervisor-adapter.test.mjs`：supervisor 私有绑定、无损委托和升级兼容合同。
- `test/subagent-runtime-resource-isolation.test.mjs`：package zero-resource filter、静态 independence 和项目所有 tool 门禁。

### Task 1：完成 dispatch-ir.v1 与固定 Prompt

**Files:**
- Create: `scripts/lib/subagent-dispatch/ir.mjs`
- Create: `scripts/lib/subagent-dispatch/prompt.mjs`
- Create: `test/subagent-dispatch-ir.test.mjs`

- [x] **Step 1: 保留并运行现有 RED 测试**

Run:

```bash
node --test test/subagent-dispatch-ir.test.mjs
```

Expected: FAIL，因为生产模块尚未完成或无法加载。

- [x] **Step 2: 实现严格规范化**

实现并导出：

```js
export class CodingDispatchContractError extends Error {}
export function compileCodingDispatchIR(input, { cwd }) {}
```

所有 object 拒绝 unknown keys；字符串 trim 后非空；数组最多 32 项、每项最多 4 KiB、trim 后保序去重。`taskId` 匹配 `^[A-Za-z0-9._-]{1,160}$`。路径只允许 repo-relative POSIX path 或末尾 `/**`，拒绝 absolute、`.`、`..`、空 segment、反斜杠、NUL 和中间 glob。

- [x] **Step 3: 固化 workflow 与 spark 范围**

`workflow.mode` 仅允许 `tdd|existing-tests|docs-only`；后两者必须有 `reason`，`tdd` 禁止 `reason`。`spark` 只允许 `risk:low`、一个 write path、最多 8 条 requirements；其他 coding 工作使用 executor。

- [x] **Step 4: 实现 canonical hash 与 deep-freeze**

Hash 使用规范化 IR（不含 `hash`）的递归 key-sort JSON，SHA-256 hex。数组顺序保留语义；最终对象和所有 nested objects/arrays 全部 frozen。

- [x] **Step 5: 编译固定 Prompt**

`renderCodingDispatchPrompt(ir)` 固定输出以下 section：

```text
# Coding Dispatch Contract v1
## Identity
## Objective
## Requirements
## Authoritative Known Facts
## Decisions Already Made
## Relevant Files
## Declared Write Scope
## Excluded Work
## Forbidden Actions
## Workflow
## Acceptance Criteria
## Verification Commands
## Escalation
## Required Report
```

动态值使用确定性 JSON scalar 编码，不能注入新 heading。Prompt UTF-8 最多 64 KiB；超限抛 `PROMPT_TOO_LARGE`。

- [x] **Step 6: 运行 GREEN**

Run:

```bash
node --test test/subagent-dispatch-ir.test.mjs
```

Expected: 全部 PASS。

### Task 2：实现独立 RPC v1 Client

**Files:**
- Create: `scripts/lib/subagent-dispatch/rpc-client.mjs`
- Create: `test/subagent-dispatch-rpc.test.mjs`

- [x] **Step 1: 写 RPC RED 测试**

覆盖 listener-before-emit、source identity、request/reply fencing、error envelope、timeout、duplicate request id、dispose 和方法白名单。期望 request：

```js
{
  version: 1,
  requestId,
  method: "spawn",
  params,
  source: { extension: "typed-subagent-runtime" },
}
```

- [x] **Step 2: 运行 RED**

Run: `node --test test/subagent-dispatch-rpc.test.mjs`

Expected: FAIL，模块不存在。

- [x] **Step 3: 实现最小 client**

导出 `createTypedSubagentRpcClient(events, options)`，仅提供 `ping/spawn/status/steer/interrupt/stop/dispose`。`spawn` 固定 `async:true`、`clarify:false`；不 import `scripts/lib/subagents-rpc-client.mjs`、`scripts/lib/plan/**` 或 Plan Capsule。

- [x] **Step 4: 运行 GREEN**

Run: `node --test test/subagent-dispatch-rpc.test.mjs`

Expected: 全部 PASS。

### Task 3：启动 Headless Runtime 并注册 Typed Facade

**Deps:** Task 1, Task 2

**Files:**
- Create: `scripts/lib/subagent-dispatch/runtime-membrane.mjs`
- Create: `scripts/lib/subagent-dispatch/extension.mjs`
- Create: `pi/extensions/subagent-runtime.ts`
- Create: `test/subagent-runtime-membrane.test.mjs`

- [x] **Step 1: 写 membrane RED 测试**

Fake upstream bootstrap 尝试 `registerTool`、`registerCommand`、`registerShortcut`、`registerMessageRenderer`、`on` 和 `events.on`。断言普通 upstream tool、command、shortcut 不会到达真实 Pi，renderer 与 event/lifecycle 正常透传；本步骤不保存普通 upstream tool definition 或 execute closure，Task 5 再以独立 TDD 周期增加 supervisor 私有执行句柄例外。

- [x] **Step 2: 写 facade RED 测试**

断言真实 Pi 注册项目自有 `subagent`；description 不包含 upstream 的 `CHAIN/PARALLEL/Fable/proactive skill` 方法论。Executor/spark 自由 `task` 调用 fail closed；完整 IR 编译后唯一 RPC spawn；非 coding agent 的 `task` 字符串保持字节一致；status/steer/interrupt/stop 映射到同名 RPC。项目自有 supervisor facade 在 Task 5 单独实现和验证。

- [x] **Step 3: 运行 RED**

Run: `node --test test/subagent-runtime-membrane.test.mjs`

Expected: FAIL，runtime membrane/extension 不存在。

- [x] **Step 4: 实现 default-deny membrane**

```js
export function createHeadlessSubagentApi(pi) {
  // ordinary registerTool/registerCommand/registerShortcut => no-op
  // Task 5 adds one private subagent_supervisor execution binding
  // lifecycle/events/renderers/UI runtime methods => bound passthrough
}
```

Membrane 只用于启动 upstream；项目 facade 始终注册到真实 `pi`。

- [x] **Step 5: 实现 typed facade routing**

Coding branch 识别 `version:"dispatch-ir.v1"`，compile + render 后 capability ping，要求 RPC version 1、spawn method、sessionId/sessionFile/cwd 完整，再 spawn。Generic branch 只接受非 `executor|spark` agent，保持 `task` 和允许的 execution fields 不变后 RPC spawn。Control branch只允许 RPC v1 支持的四个控制方法。

- [x] **Step 6: 返回 typed handle 并处理 reload**

Coding success details：

```js
{
  version: "coding-dispatch-handle.v1",
  dispatchId,
  taskId,
  agent,
  contractHash,
  runId,
  asyncDir,
}
```

不回显完整 prompt。使用 generation-fenced global cleanup；reload/shutdown dispose 当前 RPC client，旧 disposer 不能清理新实例。

- [x] **Step 7: 运行 GREEN**

Run:

```bash
node --test test/subagent-runtime-membrane.test.mjs test/subagent-dispatch-ir.test.mjs test/subagent-dispatch-rpc.test.mjs
```

Expected: 全部 PASS。

### Task 4：保留 Pi 包管理并关闭全部 Upstream Resource

**Deps:** Task 3

**Files:**
- Modify: `pi/settings.json`
- Modify: `scripts/doctor.mjs`
- Modify: `test/doctor.test.mjs`
- Create: `test/subagent-runtime-resource-isolation.test.mjs`

- [x] **Step 1: 写资源隔离 RED 测试**

断言 `pi/settings.json.packages` 中 pi-subagents 使用 object entry，source 精确固定为 `npm:pi-subagents@0.37.0`，且 `extensions/skills/prompts/themes` 均为 `[]`；`init-pi.sh` 继续调用 `pi install npm:pi-subagents@0.37.0`；自有 extension 从 Pi-managed `pi/npm/node_modules` 导入 upstream。

- [x] **Step 2: 运行 RED**

Run:

```bash
node --test test/subagent-runtime-resource-isolation.test.mjs test/doctor.test.mjs
```

Expected: FAIL，当前字符串 package entry 会自动加载全部 upstream resources。

- [x] **Step 3: 修改 package filter**

把 pi-subagents entry 改为：

```json
{
  "source": "npm:pi-subagents@0.37.0",
  "extensions": [],
  "skills": [],
  "prompts": [],
  "themes": []
}
```

保留 `init-pi.sh` 的 Pi package 安装路径，不新增自有 npm install 生命周期。

- [x] **Step 4: 增加 doctor 门禁**

Doctor 同时检查安装版本、自有 `subagent-runtime.ts` 可读、四类 upstream resource filter 全部为空，并检查自有生产模块没有 Plan Runner/Plan Capsule/shared RPC client import。

- [x] **Step 5: 运行 GREEN**

Run:

```bash
node --test test/subagent-runtime-resource-isolation.test.mjs test/doctor.test.mjs test/init-pi.test.mjs
```

Expected: 全部 PASS。

### Task 5：增加项目自有 Supervisor Facade 与私有执行绑定

**Deps:** Task 3, Task 4

**Files:**
- Create: `scripts/lib/subagent-dispatch/supervisor-adapter.mjs`
- Create: `test/subagent-supervisor-adapter.test.mjs`
- Modify: `scripts/lib/subagent-dispatch/runtime-membrane.mjs`
- Modify: `scripts/lib/subagent-dispatch/extension.mjs`
- Modify: `test/subagent-runtime-membrane.test.mjs`
- Modify: `test/pi-subagents-compat.test.mjs`

- [x] **Step 1: 固定源码事实与边界**

以已固定的 `pi-subagents@0.37.0` 源码为依据：package 只公开 default extension 等 exports，没有公开 supervisor service/RPC；`createNativeSupervisorChannel()` 创建的 parent tool `execute` closure 持有当次 runtime 的 `pending` map 与内部 `SubagentState`。因此不直接 import 私有 channel 后另建状态，不复制文件 channel 状态机，也不在生产运行时推断 TypeBox schema；运行时只绑定 upstream 已创建的真实执行 closure。

- [x] **Step 2: 写 supervisor adapter RED 测试**

覆盖以下合同：

- 主 Agent registry 只收到项目创建的 `subagent_supervisor` definition，不收到 upstream definition。
- 项目 schema 静态声明 `action/to/message/replyTo`，只暴露 parent closure 实际支持的 `reply|pending|status`；不把必然失败的 `send|ask` 或重复别名 `list` 暴露给模型。
- Membrane 只截获名称精确为 `subagent_supervisor` 且具有 `execute` function 的私有 target；upstream `subagent`、`subagent_wait` 和 `intercom` 继续丢弃。
- 项目 wrapper 把 `toolCallId/params/signal/onUpdate/ctx` 原样传给私有 target，并原样返回 resolved result；不 trim、clone、补字段或改写 error。
- 未绑定时从 active tools 移除项目 wrapper 并上报稳定 lifecycle error；重复绑定、reload 后旧 binding 被 dispose 时 fail closed。不同 Pi runtime 使用独立 cleanup ownership，不能互相 dispose。
- Upstream 通过 `getAllTools()` 检查同名工具时看不到项目 wrapper，确保它仍创建持有真实 pending/state 的 target。

- [x] **Step 3: 运行 RED**

Run:

```bash
node --test test/subagent-supervisor-adapter.test.mjs test/subagent-runtime-membrane.test.mjs
```

Expected: FAIL，当前 membrane 会丢弃 supervisor target，且项目 facade 尚不存在。

- [x] **Step 4: 实现静态项目合同与无损委托**

```js
export function createSupervisorAdapter() {
  let executeTarget;
  return {
    bind(execute) {
      if (typeof execute !== "function") throw new Error("SUPERVISOR_TARGET_INVALID");
      if (executeTarget) throw new Error("SUPERVISOR_TARGET_ALREADY_BOUND");
      executeTarget = execute;
    },
    execute(toolCallId, params, signal, onUpdate, ctx) {
      if (!executeTarget) throw new Error("SUPERVISOR_TARGET_UNAVAILABLE");
      return executeTarget(toolCallId, params, signal, onUpdate, ctx);
    },
    dispose() {
      executeTarget = undefined;
    },
  };
}
```

项目 `subagent_supervisor` tool 使用项目自有 label、description 和 TypeBox schema；其 `execute` 只调用 adapter，不读取 upstream definition 的 schema、description 或 renderer。

- [x] **Step 5: 修改 membrane 绑定规则**

`registerTool` 默认继续拒绝。唯一例外是检查 upstream definition 名称精确为 `subagent_supervisor`，再把 `definition.execute.bind(definition)` 交给 adapter.bind，但不保存或读取其 schema/description/renderer，也不调用真实 `pi.registerTool`；`intercom` fallback 仍拒绝。Membrane 给 upstream 的 `getAllTools()` 视图过滤项目同名 wrapper，真实 Pi registry 与主 Agent tool surface 不受该过滤影响。

- [x] **Step 6: 增加升级兼容门禁**

`test/pi-subagents-compat.test.mjs` 固定检查安装版本 `0.37.0`，真实启动该版本 upstream bootstrap，确认 `session_start` 后 private supervisor target 已绑定，并以固定项目参数验证 `status/pending` 调用可达。升级时若 upstream 不再注册、改名、改变 execute 调用约定或破坏现有 action 行为，测试与 reload fail closed；不实现通用 schema hash 或运行时声明探测。

- [x] **Step 7: 运行 GREEN**

Run:

```bash
node --test \
  test/subagent-supervisor-adapter.test.mjs \
  test/subagent-runtime-membrane.test.mjs \
  test/pi-subagents-compat.test.mjs
```

Expected: 全部 PASS。

### Task 6：更新 Agent 方法论并完成真实验证

**Deps:** Task 3, Task 4, Task 5

**Files:**
- Modify: `skill-overrides/subagent-dispatch/SKILL.md`
- Modify: `skill-overrides/skills.list`
- Create: `test/subagent-dispatch-skill.test.mjs`
- Modify: `docs/bugs/bug-subagent-coding-dispatch-task-is-untyped.md`
- Modify: `docs/bugs/bug-pi-subagents-package-autoload-bypasses-runtime-isolation.md`

- [x] **Step 1: 按 writing-skills 流程写 skill RED 测试**

断言 skill 已 allowlist；executor/spark 必须提交 `dispatch-ir.v1`；其他 agent 使用 generic branch；禁止自由 task coding dispatch；正文不教授 upstream chain/parallel 方法论。

- [x] **Step 2: 最小修改 skill 与 whitelist**

Skill 只说明何时选择 executor/spark、如何填合同、何时 generic passthrough，以及异步 handle/status 行为。控制在 250 words 内。

- [x] **Step 3: 运行 focused 与静态门禁**

```bash
node --test \
  test/subagent-dispatch-ir.test.mjs \
  test/subagent-dispatch-rpc.test.mjs \
  test/subagent-runtime-membrane.test.mjs \
  test/subagent-supervisor-adapter.test.mjs \
  test/subagent-runtime-resource-isolation.test.mjs \
  test/subagent-dispatch-skill.test.mjs \
  test/pi-subagents-compat.test.mjs \
  test/extension-reload-boundary.test.mjs
```

Expected: 全部 PASS。

- [x] **Step 4: 运行真实 SDK reload 与 smoke**

验证 `/reload` 等价 SDK path 返回 `extensionErrors: []`；主 Agent active tools 中 `subagent` 与 `subagent_supervisor` 的 source/description 均来自自有 extension；不存在 upstream `subagent`、`subagent_wait`、`intercom` 或 package prompt/skill。验证 supervisor `status/pending` 经私有 adapter 到达当次 upstream closure，generic `advisor` RPC spawn 和 typed spark/executor 各成功一次。

- [x] **Step 5: 完成文档证据**

记录测试数量、reload 耗时、RPC runId/asyncDir、主 Agent tool surface 和残余限制：RPC v1 不支持 upstream management/resume/schedule；supervisor facade 只无损委托固定版本的私有 execution closure，不把 upstream tool definition 暴露给主 Agent。
