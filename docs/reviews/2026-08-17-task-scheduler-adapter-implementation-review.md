# Scheduler Adapter 实现独立审查

- 审查日期：2026-08-17
- 基线：`@earendil-works/pi-coding-agent@0.84.2`
- 范围：项目自有 adapter、secure store、Pi 入口、四个 task-scheduler 测试、架构契约、既有 cleanliness review，以及本机精确安装的 Pi 0.84.2 类型与运行时代码
- 方法：静态逐行审查、Pi 官方 loader/schema smoke、真实事件形状复现、临时目录中的聚焦测试；未执行第三方 scheduler 默认 extension，未读取凭据或真实 scheduler state
- **最终 Gate：BLOCK**

## 1. 结论摘要

当前实现能被 Pi 0.84.2 的官方 extension loader 加载，四个工具的普通 JSON Schema 也能被当前 Pi validator 编译；工具返回值形状和 `throw -> isError: true` 语义成立。但这只是“可加载”，不是“可安全运行”。

实际 Pi 的 `agent_settled`、`agent_start`、`tool_call` 都没有 `occurrenceId`。当前实现依赖测试伪造的字段，因此 scheduled turn 的只读工具膜完全不执行，occurrence 也永远不能因真实 `agent_settled` 完成。与此同时，确认框调用签名错误、授权没有持久化的精确绑定、`sendUserMessage` 的 `void` 错误通道被误当作可等待、timer/lease/reload 状态机存在多处丢跑与失活后写入。以上均为上线阻断项。

## 2. Pi 0.84.2 官方 ABI 核验

| 核验项 | 官方实际语义 | 当前实现结论 |
|---|---|---|
| `registerTool` | `ToolDefinition` 要求 `label`，`parameters` 类型为 TypeBox `TSchema`，`execute` 返回 `AgentToolResult`；见官方 `dist/core/extensions/types.d.ts:342-372` | 四个定义没有 `label`，参数对象没有 `TypeBox.Kind`；不过 0.84.2 validator 对普通 JSON Schema 有兼容路径，官方 loader smoke 确实加载成功 |
| ToolResult | `content` 为 text/image block，`details` 可为任意结构；`execute` 抛错由 agent-core 转成 `isError: true`；见官方 `agent-loop.js:453-478` | `result()` 的基本形状有效；create/get/delete 的显式 `throw` 错误语义有效 |
| `ctx.ui.confirm` | `confirm(title: string, message: string, opts?)`；timeout/cancel 返回 `false`；见官方 `types.d.ts:35-40,68-72` | 实现传入单个对象，真实 TUI 会显示 `[object Object]\nundefined`，RPC 会发出对象型 `title` 且缺 `message`；没有 timeout |
| 无 UI | TUI/RPC 的 `hasUI=true`；JSON/print 为 `false`，无 UI confirm 默认 `false` | create/delete 的显式无 UI拒绝方向正确；无 UI `session_start` 不取 runtime lease、不 arm timer，list/get 仍会首次初始化状态文件 |
| `agent_start` / `agent_settled` | 两者事件都只有 `type`；`agent_settled` 表示重试、压缩重试和 queued continuation 全部结束；见官方 `types.d.ts:536-548` | 当前读取不存在的 `event.occurrenceId`，无法关联 |
| `tool_call` | 字段为 `type/toolCallId/toolName/input`，没有 occurrence；见官方 `types.d.ts:649-691` | 当前只有事件自带伪造 occurrence 时才门禁；真实调用直接放行 |
| `sendUserMessage` | ExtensionAPI 返回 `void`；idle 时立即触发 turn，streaming 时 `followUp` 入队；内部异步错误由 runtime 捕获并仅报 extension error；见官方 `types.d.ts:929-937`、`agent-session.js:1107-1134,1855-1863` | `await pi.sendUserMessage(...)` 立即完成，不能证明消息已接受、Agent 已启动或执行成功 |

官方 loader smoke 输出为：`extensions=1, errors=0, tools=4`；四个 schema 均通过 0.84.2 `validateToolArguments`，但四个 `label` 都是 `undefined`，四个根 schema 都没有 `TypeBox.Kind`。因此不能把“当前运行时兼容加载”误写成“符合官方 TypeScript ABI”。

## 3. 正向核验

1. `pi/settings.json:17-23` 对 `@amaster.ai/pi-task-scheduler@0.1.9` 的 `extensions/skills/prompts/themes` 全部设为 `[]`，符合 Pi 官方 package filter 的“不加载任何该类资源”语义。
2. `pi/npm/package.json:5-7` 与 lock 中的实际解析均为 scheduler/shared `0.1.9`、croner `10.0.1`，并有 registry integrity；当前项目 adapter import 图不触达任何第三方 scheduler 文件，所以本实现路径没有执行上游默认 extension。
3. secure store 的状态目录/文件权限、owner、symlink、未知成员、原子 rename、文件与目录 fsync、随机 owner token、fencing、过期 takeover 和每次事务重读，方向正确；聚焦 secure-store 测试通过。
4. 自动派发文本带 task/occurrence 来源头且显式 `expandPromptTemplates:false`；长 timer 有 32 位分段；工具错误采用 `throw`。

这些正向点不能抵消下列 blocker。

## 4. Findings

### F-01 — BLOCKER：真实 Pi 事件无法关联 occurrence，只读工具膜完全失效

- **位置**：`scripts/lib/task-scheduler/adapter.mjs:70-72,82-83`；`test/task-scheduler-adapter.test.mjs:85-89`。
- **复现**：先用 `dispatchForTest` 建立 active occurrence，再发送官方形状 `{type:"tool_call",toolCallId,toolName:"write",input}`，handler 返回 `undefined`；再发送 `{type:"agent_settled"}`，occurrence 仍为 `agent-running`。本次复现实际输出：`{"writeDecision":null,"occurrenceStatus":"agent-running"}`。
- **原因/影响**：Pi 0.84.2 的两个事件都没有 `occurrenceId`。所有 scheduled turn 的 `write/edit/bash/subagent/...` 均不会被此膜阻断；active occurrence 又永远不清除，后续 timer 会被 `activeOccurrences.size` 挡住。
- **最小修复**：仅在 Agent idle 时派发；通过 `input(source="extension")`、`before_agent_start.prompt`、`message_start` 中不可伪造的内部 nonce/header 建立唯一 pending→running 关联，`agent_start` 只确认开始，唯一 active run 在无歧义的 `agent_settled` 结算；任何关联歧义 fail-closed。
- **新增 RED**：使用官方 0.84.2 事件对象且绝不添加 `occurrenceId`；scheduled `write` 必须 block、仓库内 `read` 必须放行、真实 `agent_settled` 必须只结算对应 occurrence。

### F-02 — HIGH：即使修复关联，allowlist 与路径 containment 仍可绕过或误判

- **位置**：`scripts/lib/task-scheduler/adapter.mjs:12,42-43,69,83`；`test/task-scheduler-adapter.test.mjs:65`。
- **复现**：`grep/find/ls` 的 `path` 是可选项；省略时 built-in 使用 `ctx.cwd`，当前 `candidate` 为空却把 `contained` 保持为 `true`。此外只按工具名放行，其他 extension 可覆盖同名 `read`；containment 使用未 canonicalize 的 `repoRoot` 而 store 使用 `secureRepoRoot`。
- **影响**：session cwd 变化时可在授权仓库外读；同名恶意/写副作用工具可冒充只读工具；symlink cwd 还会产生错误拒绝。现有测试只证明数组子集，不执行一次门禁。
- **最小修复**：绑定 canonical workspace；缺省 path 时显式 canonicalize `ctx.cwd`；逐个处理四个 built-in 的真实参数；启动时校验 `pi.getAllTools().sourceInfo` 为预期 built-in，未知/被覆盖工具一律 block。
- **新增 RED**：`grep/find/ls` 省略 path 且 cwd 越界必须 block；仓库内/外 symlink；同名 custom `read`；非字符串 path；真实 built-in 四工具的表驱动 containment。

### F-03 — BLOCKER：确认框签名错误，用户看不到授权内容，授权也未精确绑定

- **位置**：`scripts/lib/task-scheduler/adapter.mjs:33-35,78-79`；`test/task-scheduler-adapter.test.mjs:19-23,43-44,79`；契约 `docs/architecture/task-scheduler-adapter-contract.md:13-15`。
- **复现**：真实签名是 `confirm(title,message,opts)`，当前只传 `{title,message}` 一个参数。TUI 模板字符串化后只显示 `[object Object]` 和 `undefined`；测试 fake 对任意单参数都返回 true，所以虚假通过。
- **影响**：prompt hash、period、repo、session、policy 等并未以可读方式展示；无 timeout 的 RPC 可无限等待。create 未展示 prompt preview/state root/task ID，delete 甚至不展示待删 task ID。持久化 `authorization` 只含时间、次数和 policy，dispatch 不验证 promptHash/period/session/repo/grant 绑定。
- **最小修复**：调用 `confirm("Authorize scheduled task", message, {timeout})`；确认前生成 task/grant ID，并显示预览/hash、规范周期、canonical workspace、state root、真实 session、policy、expiry/maxRuns；把这些字段或 binding digest 作为严格 grant 持久化，每次 dispatch 原子重验。
- **新增 RED**：捕获 confirm 的三个实参并逐字段断言；TUI/RPC 形状、取消、timeout、throw、无 UI；确认后篡改 prompt/period/session/repo/policy 任一字段，dispatch 必须拒绝且审计。

### F-04 — BLOCKER：把 `sendUserMessage:void` 当成可等待交付，缺少 start/deadline/error 状态

- **位置**：`scripts/lib/task-scheduler/adapter.mjs:7,60-66,71`；官方 `types.d.ts:929-937`、`agent-session.js:810-843,867-885,1107-1134,1855-1863`。
- **复现**：Pi 暴露给 extension 的 wrapper 不返回内部 Promise，并把内部 rejection 仅转成 extension error。因而 line 64 的 `await` 不会收到“无模型/无认证/队列失败”等错误；`pi.sendUserMessage` 缺失时实现还会静默跳过发送并继续 arm。
- **影响**：状态在发送前直接写成 `agent-running`，没有 `dispatching/queued-to-agent/agent_start`；`maxOccurrenceDeadlineMs` 只定义从未使用；发送失败、永久排队、Agent 超时均可长期占住全局 occurrence。
- **最小修复**：把 `sendUserMessage` 视为 fire-and-forget；先持久化 claim，再等待官方 `input/message_start/agent_start` 观测确认；设置 start deadline 与 run deadline，使用当前 run 的 `ctx.abort()`，超时记 `indeterminate/interrupted`，绝不称业务 success。
- **新增 RED**：idle、streaming+followUp、无模型导致内部 rejection、未出现 start、超时 abort、agent retry/compaction/followUp 后才 settled；每条路径断言完整状态序列和错误审计。

### F-05 — BLOCKER：timer、并发、预算、missed 与 reload 状态机不闭合

- **位置**：`scripts/lib/task-scheduler/adapter.mjs:50-65,71-73,85`。
- **复现**：两个 timer 同时触发时都可在第一个 `await readTask` 前看到 `activeOccurrences.size===0`，随后各自 claim；反之，timer 在已有 active occurrence 时直接 return 且不重排，任务永久丢失。maxRuns/expiry 命中也只 return，不改 status/audit/nextRunAt。
- **影响**：既可能并发两个 scheduled Agent，又可能第一轮后永久停跑；runCount 只在永远匹配不到的 settled 增加。崩溃后持久化的 `agent-running` 未在 reload 标为 indeterminate，session_start 只处理 due `nextRunAt`，可能对不确定执行再次派发。delete 也不终止 in-flight。
- **最小修复**：在任何 await 前取得进程内 dispatch mutex，并在同一持久事务原子 claim 全局 in-flight/attempt budget；所有 return 分支在 `finally` 重排或显式完成/过期；启动时把遗留 dispatching/queued/running 标为 indeterminate，不自动重放；maxRuns 按已 claim attempt 消耗。
- **新增 RED**：fake clock + controllable timer 覆盖同刻两任务、busy tick、发送异常、maxRuns=1、expiry、多个 missed interval、长 timer、shutdown during flight、崩溃后 reload、任务删除/重排。

### F-06 — BLOCKER：失去/未取得 runtime lease 后，stopped 实例仍可用临时 lease 写状态

- **位置**：`scripts/lib/task-scheduler/adapter.mjs:46-48,73,78-79,85`；`test/task-scheduler-runtime.integration.mjs:18-24`。
- **复现**：第二实例 `session_start` 获取 lease 失败后调用 `shutdown()`，但 create/delete 不检查 `stopped/active/runtimeLease`。第一实例释放 lease后，在第二个 stopped 实例调用 create，会走 line 48 的临时 lease并成功写入；本次实际输出：`{"status":"armed","listCount":1}`。
- **影响**：inactive/stopped 工具可在稍后静默复活并返回 `armed`，但没有 timer owner；这正是 runtime test 用 `tools.size===4` 完全没有验证的路径。
- **附加竞态**：renew 会改变 `expiresAt`，而事务可能在 renew Promise 完成但 `runtimeLease` 赋新值前捕获旧 snapshot，排队后被 store 拒绝；renew failure 的 `.catch(() => adapter.shutdown())` 没有等待/兜底，shutdown 中的审计事务也可能再次失败并形成未处理 rejection。
- **最小修复**：显式状态 `initializing/active/inactive/stopping/stopped`；create/delete 在确认前要求 active 且持有 live runtime lease；删除通用临时写 lease路径；renew 与 transact 共享 adapter 级 mutex并原子替换 snapshot；shutdown 全路径不抛、可重复并报告 indeterminate。
- **新增 RED**：第二实例在 owner 存活、owner 释放后、lease 过期后都必须明确 throw；确认函数不得被调用；renew/transact 交错、renew loss、shutdown with in-flight、重复 shutdown/reload。

### F-07 — BLOCKER：task schema 过宽且 dispatch 不重新扫描，持久化内容可绕过授权与扫描

- **位置**：`scripts/lib/task-scheduler/adapter.mjs:14-25,59-63`；`scripts/lib/task-scheduler/secure-store.mjs:35,45-54,89-93`。
- **复现**：`validateTask` 允许任意 status、未知字段、缺失/非数字 runCount、任意 authorization 内部字段、任意 occurrence/audit 元素、任意日期字符串；不验证 prompt 类型、promptHash 与 prompt 一致、period/expiry 上限或 ID 唯一。dispatch 只在 create 时调用 `safePrompt`，从状态重载后不重扫。
- **影响**：合法 JSON 的篡改/旧 schema 可替换 prompt、伪造 grant 或破坏状态机后仍被发送。secure store 只在读取时限制 1 MiB，atomic write 前不限制序列化大小，事务可“成功写入后把下一次 read 锁死”。
- **最小修复**：状态和所有嵌套对象 exact-key schema；枚举状态、严格整数/日期/数组项、唯一 task/occurrence ID、promptHash/binding digest、canonical repo/session/grant 一致性；commit 前按 UTF-8 byte 检查；每次 dispatch 在 claim 事务内重新扫描 prompt 与完整 grant。
- **新增 RED**：逐项未知字段/错误类型/坏日期/重复 ID/hash mismatch/授权字段缺失/超限 period/超大写入；持久化后注入 invisible Unicode、secret、prompt injection，reload/dispatch 必须 fail-closed。

### F-08 — HIGH：真实 session 未绑定，所有同仓库 session 共享并 arm 全部任务

- **位置**：`pi/extensions/task-scheduler.ts:4-5`；`scripts/lib/task-scheduler/adapter.mjs:42-49,59,78,85`。
- **复现**：入口未传 sessionId；`sessionId()` 永远返回字符串 `"default"`，从不调用 `ctx.sessionManager.getSessionId()`。list/get/readTask/session_start 均不按 task.sessionId 或 task.repoRoot 过滤。测试使用不存在的 `/safe/repo`，line 43 又把 store 的 repo root悄悄替换成 `process.cwd()`。
- **影响**：授权显示的 session 并非真实 Pi session；new/resume/fork/reload 可看到和 arm 其他 session 的任务，session 边界与契约不成立。
- **最小修复**：在 `session_start` 用 `ctx.cwd` canonical path 与 `ctx.sessionManager.getSessionId()` 初始化该 runtime；所有 CRUD、timer、claim、grant 都强制 exact scope；不存在 repo 必须拒绝，不能回退到另一个 workspace。
- **新增 RED**：同 repo 两个 session、两个 repo 同 session 字符串、new/resume/fork/reload；list/get/arm 只能触达当前 scope，旧 runtime shutdown 后不得复用旧 ctx。

### F-09 — MEDIUM：当前“可加载”依赖宽松运行时，未满足声明的 Extension/Tool TypeScript ABI

- **位置**：`pi/extensions/task-scheduler.ts:2-5`；`scripts/lib/task-scheduler/adapter.mjs:75-81`。
- **复现**：官方 loader 可加载，但 smoke 显示四个 `label=undefined`、`typeboxKind=false`。入口把 `pi` 声明为 `unknown`，async factory 还返回 adapter 对象；官方 `ExtensionFactory` 是 `(pi:ExtensionAPI)=>void|Promise<void>`。
- **影响**：TUI label 缺失，编译期无法发现 confirm/event/sendUserMessage 等本次核心 ABI 错误；未来 Pi 收紧 plain JSON Schema 兼容时会失效。
- **最小修复**：入口和 adapter 使用 `ExtensionAPI/ExtensionContext` 类型；参数用 `Type.Object/Type.String/Type.Integer/Type.Optional`；补 label；factory 只完成注册并返回 void；保留运行时业务校验。
- **新增 RED**：对真实入口执行 `tsc --noEmit`；官方 loader + `validateToolArguments`；断言每个 definition 有 label 与 `TypeBox.Kind`；用 agent-core 执行一次非法参数和 execute throw，断言 tool result `isError:true`。

### F-10 — HIGH：package resource isolation 配置成立，但“复用精确安装纯 API”并未发生

- **位置**：`scripts/lib/task-scheduler/adapter.mjs:1-4`；`pi/extensions/task-scheduler.ts:2`；`test/task-scheduler-package-isolation.test.mjs:10-31`；安装包 `pi/npm/node_modules/@amaster.ai/pi-task-scheduler/dist/index.d.ts:127-174`。
- **复现**：adapter import 图只有 node built-in 与项目 `secure-store.mjs`，对 scheduler/shared/croner 零 import。package test 只断言 settings/package 文本与安装命令，无法证明 adapter 使用任何纯 API。
- **判断**：上游默认 resource 确实被 `extensions:[]` 隔离；但精确安装的三个包对运行行为完全无贡献。上游根导出还在同一模块导出 default extension，没有一个明确的、不会加载 extension 模块的受支持 core subpath。
- **最小修复**：二选一并明确架构：取得带独立 `./core` export 的已审版本，只 import 纯 normalization/next-run API；或者承认项目完全自有实现，删除无用 scheduler/shared/croner 依赖及“复用”声明。不得从 root/default 导入后声称未加载 extension。
- **新增 RED**：静态解析 adapter 完整 import graph；断言只触达获准 core subpath且 default extension 模块不在图中；再用 Pi 官方 package resource discovery 断言上游 extension/command/tool 为零，而非只检查 JSON 文本。

### F-11 — HIGH：现有 7 个通过测试存在系统性虚假绿色

- **位置**：`test/task-scheduler-adapter.test.mjs:9-29,39-90`；`test/task-scheduler-runtime.integration.mjs:8-24`；`test/task-scheduler-secure-store.test.mjs:11-96`；`test/task-scheduler-package-isolation.test.mjs:10-31`。
- **复现**：聚焦命令显示 `7/7 pass`，但 fake Pi 不验证 label/schema，不提供真实 `sendUserMessage/isIdle`，confirm 接受错误单参数，事件伪造 `occurrenceId`；runtime 只看 `tools.size`；allowlist 只做数组子集；没有一次真实 tool_call write 阻断。
- **缺口**：没有官方 loader 测试、真实 event shape、TUI/RPC confirm、agent_start/settled/followUp、deadline、并发 timer、maxRuns/expiry/missed/reload、stopped write、adapter renew、严格 adapter task schema、package resource discovery。
- **最小修复**：保留 secure-store 单元测试，但新增基于 Pi 0.84.2 官方 loader/runner 的 ABI contract suite；为 timer/clock/send/lifecycle 注入可控接口；所有安全断言验证副作用和状态，不以 `tools.size`、helper fallback 或数组包含关系代替。
- **新增 RED**：至少先加入 F-01、F-03、F-05、F-06 四组 RED；修复前必须分别看到真实 write 未阻断、confirm 形状错误、并发/丢跑、stopped create 成功。

## 5. 可执行修复顺序

1. **先切断风险入口**：在修复完成前不启用 timer；create/delete 对非 active live lease 明确 throw。
2. **改正官方 ABI**：TypeScript 化入口/adapter、TypeBox schema、label、正确 confirm 三参数和 timeout。
3. **重建 occurrence 关联与工具膜**：禁止 busy 时派发；用官方 input/message/agent 生命周期关联；先写 RED 证明真实 `write` 被阻断。
4. **重建持久状态机**：原子 claim、单并发、attempt budget、queued/start/settled/deadline、missed/expiry/completed、reload indeterminate。
5. **收紧 store 与 scope**：exact schema、commit byte limit、dispatch 重扫、真实 session/canonical repo、两 session 隔离。
6. **修复 lease 生命周期**：去掉 stopped 临时写，串行 renew/transact，丢 lease后稳定 shutdown。
7. **明确 package 方案**：安全 core subpath复用或删除无用依赖；补官方 package discovery/import graph 测试。
8. **最后做真实 Pi smoke**：隔离 agent dir/state、禁止第三方资源，覆盖 TUI 或 RPC confirm、idle/streaming followUp、真实 tool result `isError`；不得读取真实凭据/state。

## 6. Review Gate

**BLOCK。** 当前实现不能启用 scheduled timer，也不能视为满足架构契约。最直接的阻断理由是：真实 Pi tool call 没有 occurrence 字段，故只读膜不执行；真实 settled 也没有该字段，故 occurrence 不完成。确认、lease、timer 和 schema 还各自存在独立 blocker。

通过条件：F-01、F-03、F-04、F-05、F-06、F-07 全部有先失败后通过的 RED；F-02、F-08、F-09、F-10 完成；官方 loader/runner contract suite 与隔离 Pi smoke 通过；复审后方可改为 PASS。

## 7. 审查边界与残余风险

- 未启动完整 Pi TUI/RPC，因为这可能触达 ambient extension、真实 session state 或凭据；本次以精确 0.84.2 官方 loader、类型、runner 源码和隔离事件复现核验 ABI。缺少完整 Pi smoke 本身已列为 F-11 测试缺口。
- 未执行 `@amaster.ai/pi-task-scheduler` 默认 extension；只静态读取已安装 manifest/声明/import。
- 仓库开始前已有大量未提交改动；本任务只新增本报告，未修改代码、测试或 config，未 stage/commit/push/stash。

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "以 Pi 0.84.2 官方 types、loader、validator、agent-session 与 agent-core runner 核验 schema、confirm、sendUserMessage、agent_start/settled/tool_call 和 throw/isError；官方 loader smoke 实际加载 1 个 extension、4 个工具。"
    },
    {
      "id": "criterion-2",
      "status": "satisfied",
      "evidence": "F-01 至 F-10 覆盖授权与无 UI、工具膜/containment、Agent 生命周期、timer/并发/maxRuns/expiry/missed/reload、runtime lease/第二实例/stopped 临时写、secure store schema/状态根、package import。"
    },
    {
      "id": "criterion-3",
      "status": "satisfied",
      "evidence": "F-11 逐项指出 fake Pi ABI、伪造 occurrenceId、错误 confirm fake、tools.size 与数组子集替代副作用断言、缺官方 runner 与真实 Pi smoke，并给出所需 RED。"
    },
    {
      "id": "criterion-4",
      "status": "satisfied",
      "evidence": "每个 finding 均给出严重度、位置、复现、影响、最小修复和 RED；第 5 节给出修复顺序，第 6 节给出 BLOCK gate 与转 PASS 条件。"
    },
    {
      "id": "criterion-5",
      "status": "satisfied",
      "evidence": "唯一新增文件为中文报告 docs/reviews/2026-08-17-task-scheduler-adapter-implementation-review.md。"
    }
  ],
  "changedFiles": [
    "docs/reviews/2026-08-17-task-scheduler-adapter-implementation-review.md"
  ],
  "testsAddedOrUpdated": [],
  "commandsRun": [
    {
      "command": "node --test test/task-scheduler-adapter.test.mjs test/task-scheduler-runtime.integration.mjs test/task-scheduler-secure-store.test.mjs test/task-scheduler-package-isolation.test.mjs",
      "result": "passed",
      "summary": "7 个测试全部通过；F-11 说明这些通过为何没有覆盖真实 ABI 与关键安全副作用。"
    },
    {
      "command": "Pi 0.84.2 loadExtensions + validateToolArguments 隔离 smoke",
      "result": "passed",
      "summary": "加载 1 个项目 extension、0 loader error、4 个工具；普通 JSON Schema 当前可验证，但 label 缺失且无 TypeBox.Kind。"
    },
    {
      "command": "使用官方 tool_call/agent_settled 字段形状的 occurrence 复现脚本",
      "result": "passed",
      "summary": "得到 writeDecision=null、occurrenceStatus=agent-running，证实真实事件不会启用膜或完成 occurrence。"
    },
    {
      "command": "两个 adapter 实例的 stopped 临时 lease 写复现脚本（仅临时目录）",
      "result": "passed",
      "summary": "第二实例取 lease 失败并 stopped 后，第一实例释放 lease，第二实例仍 create 成功并持久化 1 个 armed task。"
    },
    {
      "command": "git status --short；git diff --cached --name-only",
      "result": "passed",
      "summary": "确认仓库原有大量未提交改动；本任务未产生 staged 文件。"
    }
  ],
  "validationOutput": [
    "官方 loader：extensions 1，errors 0，tools scheduler_create/scheduler_delete/scheduler_get/scheduler_list。",
    "官方 schema smoke：四个工具 validated=true；四个 label=undefined；四个 typeboxKind=false。",
    "真实事件形状：writeDecision=null；agent_settled 后 occurrenceStatus=agent-running。",
    "失活实例复现：status=armed；listCount=1。",
    "Review gate：BLOCK。"
  ],
  "residualRisks": [
    "未运行会触达 ambient 配置/凭据/真实 state 的完整 Pi TUI/RPC；需要后续在全隔离 agent dir 与假模型中补 smoke。",
    "未执行第三方 scheduler 默认 extension；package isolation 的动态 resource discovery 仍需后续 RED/smoke。",
    "renew 10 秒周期与真实进程崩溃窗口主要由静态时序审查确认，尚无可控 clock 的 adapter 级测试。",
    "仓库存在任务开始前的既有未提交改动，本报告未审查或改动它们。"
  ],
  "noStagedFiles": true,
  "diffSummary": "仅新增一份中文 Scheduler Adapter 实现独立审查报告；未修改代码、测试或配置。",
  "reviewFindings": [
    "blocker: scripts/lib/task-scheduler/adapter.mjs:70-83 - 依赖 Pi 真实事件不存在的 occurrenceId，工具膜不执行且 occurrence 不 settled。",
    "blocker: scripts/lib/task-scheduler/adapter.mjs:33-35,78-79 - confirm 签名错误，授权详情不可见且 grant 未精确绑定。",
    "blocker: scripts/lib/task-scheduler/adapter.mjs:60-66 - 把 void sendUserMessage 当交付回执，无 start/deadline/error 状态。",
    "blocker: scripts/lib/task-scheduler/adapter.mjs:50-65,85 - timer 可并发 claim、busy 时永久丢跑，maxRuns/expiry/missed/reload 不闭合。",
    "blocker: scripts/lib/task-scheduler/adapter.mjs:46-48,73,85 - inactive/stopped 实例可在 owner 释放后用临时 lease 写入。",
    "blocker: scripts/lib/task-scheduler/adapter.mjs:14-25,59-63 - task schema/授权绑定过宽且 dispatch 不重扫持久化 prompt。"
  ],
  "manualNotes": "package 的 extensions:[] 隔离配置有效，但当前 adapter 完全没有复用精确安装的 scheduler 纯 API；最终 gate 为 BLOCK。"
}
```
