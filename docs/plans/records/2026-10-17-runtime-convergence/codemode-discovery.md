> 2026-10-17 规划输入归档。来源：delegate run `2041a376-b1b9-47c8-be52-5cc8d8d38888`；以下保留只读源码归因报告原文。此后本会话的 codemode 缺失工具现象与报告的 model-only 边界一致；不将其扩张为真实 provider/CLI 已验证。

# code_mode 无法发现 subagent 独立工具：只读源码归因报告

## 1. 结论与现象定义

用户现象可精确定义为：在某个未提供具体返回证据的 `code_mode` 调用中，模型似乎无法通过 codemode 的工具目录或脚本接口发现 `pi-subagents-enhanced` 的 subagent 系列工具。

源码能够证明的设计事实是：这 14 项工具并不属于 codemode 的 callable/discovery 面。它们全部使用 `exposure: "model-only"`；该 exposure 的语义是“active 时声明给模型，永不允许其他工具通过 `ctx.executeTool()` 调用”。因此，主 Host 的模型可以看到并直接调用这些工具，codemode 脚本不能调用它们，codemode 的 `ALL_TOOLS`、`searchTools()`、`describeTool()` 也不会返回它们。这是现有契约规定的隔离边界，不是 catalog 漏列。

对“本次用户观察是否由 production 数据未被正确处理”的判断仍然是 **blocked-evidence / 来源尚未证实**：没有提供实际 codemode 脚本、返回头和错误文本，也没有同一运行中的 Host tool exposure/active/callable 快照。现有源码与 synthetic SDK 记录证明预期行为，但不能把一个未附具体回执的运行现象进一步归因到某个 production 缺陷。

## 2. 工具发现与注册边界

### 2.1 codemode 文档和宿主 exposure 契约

- `node_modules/@earendil-works/pi-coding-agent/docs/codemode.md:32-52` 定义了脚本可用的 `tools.<name>()`、`ALL_TOOLS`、`searchTools()`、`describeTool()` 和 `describeNamespace()`；这些接口面向“session 可调用工具”。文档还说明 deferred 工具可不出现在初始描述中，但可由发现接口查找。
- `node_modules/@earendil-works/pi-coding-agent/docs/extensions.md:154-164` 给出 exposure 权威语义：`direct` 在 active 时可被 nested 调用；`model-only` 在 active 时声明给模型但永不 callable；`codemode` 注册即 callable 且列入 codemode；`deferred` 可由 codemode/tool search 间接发现；`pi.getAllTools()` 是注册工具的元数据视图。
- `node_modules/@earendil-works/pi-coding-agent/docs/settings.md:40-42` 说明 `codemode.mode` 与 inline catalog 预算只改变可调用工具如何呈现，不会把 `model-only` 变为 callable。

这里有两个容易混淆的视图：SDK 的 `getAllTools()` 可包含注册元数据和 exposure；codemode 执行器使用的是 callable 集合，不是完整 `getAllTools()`。因此“SDK 看到注册工具”不能推出“codemode 能发现/调用工具”。

### 2.2 codemode discovery 的实际调用链

1. Host 的 `AgentSession._getCallableTools()`：
   - `node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js:1135-1143` 只返回 exposure 为 `codemode`、`deferred`，或 exposure 为 `direct` 且当前 active 的工具。
   - `model-only` 没有任何满足条件的分支，因此被排除。
   - nested 调用走同一集合：`agent-session.js:386-400` 将 `_getCallableTools()` 交给 nested runner；`agent-session.js:1067-1069` 的 `getCallableToolNames()` 也只报告该集合。

2. codemode 执行器拿到 callable 子集：
   - `node_modules/@earendil-works/pi-coding-agent/dist/extensions/codemode/execute.js:323-327` 从 `ctx.tools` 取得 callable 工具，生成 `samples` 与 sandbox tools。
   - `execute.js:339-343` 的脚本工具调用最终只执行 `ctx.executeTool(tool.name, ...)`，所以不存在绕过 `_getCallableTools()` 的第二入口。
   - `execute.js:429-432` 说明 discovery globals 针对脚本 nested tools；`execute.js:432-457` 的 `searchTools()` 在传入的 `tools` 集合上排名；`execute.js:461-469` 的 `describeTool()` 也只在同一集合中查找。
   - `node_modules/@earendil-works/pi-coding-agent/dist/extensions/codemode/tool.js:89-90` 的 `getCodemodeCallableTools()` 只去掉 codemode 自身，说明它不会额外扩大集合；输入集合已经由 Host callable 过滤完成。

3. codemode 描述/catalog 仍然基于 callable 集合：
   - `tool.js:210-222` 的 `prepareCodemodeLoadout()` 使用 `loadout.callable`，再按 mode 和 direct exposure决定声明/列出；它不会把 model-only 加回 catalog。
   - 因此，`ALL_TOOLS`、初始 codemode description、`searchTools()` 和 `describeTool()` 都不能发现这 14 项，属于一致的同一边界。

## 3. 14 项工具的注册、model-only 暴露与旧名迁移

### 3.1 14 项清单

14 项由三组组成：

- subagent 7 项：`subagent_roster`、`subagent_start`、`subagent_run_status`、`subagent_run_steer`、`subagent_run_interrupt`、`subagent_run_resume`、`subagent_run_stop`，定义在 `packages/pi-subagents-enhanced/src/subagent-dispatch/operation-tools.ts:188-290`。
- workspace 4 项：`managed_workspace_list`、`managed_workspace_status`、`managed_workspace_dispose`、`managed_workspace_release`，定义在 `packages/pi-subagents-enhanced/src/workspace/operation-tools.ts:58-132`。
- supervisor 3 项：`supervisor_request_pending`、`supervisor_request_status`、`supervisor_request_reply`，定义在 `packages/pi-subagents-enhanced/src/subagent-dispatch/supervisor-operation-tools.ts:99-161`。

三组 factory 分别在以下位置把每个定义设为 `exposure: "model-only"`：

- `operation-tools.ts:312-315`；
- `workspace/operation-tools.ts:190-194`；
- `supervisor-operation-tools.ts:163-167`。

`docs/plans/records/2026-10-16-operation-tools/contract.md:1-3、§2.1-§3` 冻结的合同也明确规定这 14 项是模型工具、固定 operation/action 由 factory 注入，schema 不接受调用方 `action`。

### 3.2 main Host 的唯一注册面

`packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts:1995-2014` 构造三组 operation tools：subagent 7 项、workspace 4 项；只有存在受控 supervisor adapter 时才构造 supervisor 3 项。注册发生在：

- `extension.ts:2018-2019` 注册 subagent 和 workspace 11 项；
- `extension.ts:2051` 注册 supervisor 3 项。

由于三组定义都是 `model-only`，按宿主规则注册即进入 active/model-visible 集合，但不会进入 callable/nested 集合。supervisor 3 项还受 adapter 存在与 bind 状态约束；`extension.ts:1701-1707、2128-2135` 在未 bind 时将它们从 active 集合停用，并抛出 `SUPERVISOR_TARGET_UNAVAILABLE`。这会影响主模型是否看到这 3 项，但不是 codemode 对 model-only 工具的普遍发现边界。

### 3.3 旧 union 工具名

架构文档 `docs/architecture/subagent-operation-tools.md:3-15、28-29、41-43` 明确说明 fresh Host 只注册 14 项，旧 `subagent`、`subagent_worktree`、`subagent_supervisor` 只保留历史显示/兼容实现，不再作为 fresh Host 模型工具注册。

实现证据：

- `extension.ts:1995-2003` 注释和 factory 接线只注册新的 operation tools；
- `runtime-membrane.ts:175-188` 对 upstream 的旧 `subagent_supervisor` 只做 bind 捕获，并从 `getAllTools()` 过滤，不把 upstream 旧定义注册到 Host；
- `test/subagent-runtime-membrane.test.mjs:45-60、1009-1027` 断言注册集合恰为 14 项且不含 3 个旧 union 名；
- `test/operation-guidance-contract.test.mjs:63-75` 断言 14 项齐备且旧 union 名不进入新工具面。

因此，若某个 synthetic fixture 中出现旧 `subagent_supervisor`，必须先检查 fixture 是否手动注册；不能直接归因于 fresh production Host 注册回退。

## 4. child、nested 与 SDK synthetic probe 边界

### 4.1 child early-return

`packages/pi-subagents-enhanced/extensions/subagent-runtime.ts:207-208`：当 `PI_SUBAGENT_CHILD=1` 或 `PI_SUBAGENT_FANOUT_CHILD=1` 时直接 return。该入口在 child 中不安装 typed runtime，因此 main Host 的 14 项不会因 child 启动而注册。

`packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts:2102-2111` 的 required-child 注入只传入 `root-session-owner`、`integration-queue` 及可选 shared extension 的 `{id,path}`；没有把 14 项注入 child。child 自有的 `subagent_integration` 等工具属于另一 capability 面，不属于这 14 项。

架构合同 `docs/architecture/subagent-operation-tools.md:28-29` 把这一点列为硬边界：child runtime 保持 early-return 和 agent `tools` 白名单，不因 main 工具拆分扩展 child 权限。

### 4.2 nested/codemode 隔离

`model-only` 工具被 Host `_getCallableTools()` 排除后，codemode 不能通过 `tools.<name>()` 调用，也不能通过 `searchTools()` 或 `describeTool()`补回。已有测试以真实 SDK nested pipeline 检验这一点：

- `test/joint-upgrade-model-only.test.mjs:10-12` 创建 SDK synthetic session 和 codemode extension；
- `test/joint-upgrade-model-only.test.mjs:24-38` 对控制工具逐一断言 active/model-visible、`getCallableToolNames()` 不包含它们，并断言 `tools.<name>({})` 的 codemode 调用返回错误；
- `test/joint-upgrade-model-only.test.mjs:30-31` 断言旧 `subagent`、`subagent_worktree` 不再是 active 工具。

该测试在 fixture 中手动注册旧 `subagent_supervisor`（`test/joint-upgrade-model-only.test.mjs:14-15`）来覆盖 adapter 兼容路径；这个手动注册是测试制造的数据，不能当作 production fresh Host 旧名回归证据。

### 4.3 synthetic SDK probe 的证据边界

`docs/plans/records/2026-10-16-operation-tools/acceptance.md:8-15` 和 `docs/architecture/subagent-operation-tools.md:39-43` 记录的 fresh synthetic SDK probe 结果是：14 项全部 active/model-only，旧三名不 active，14 项均不可 nested 调用，`supervisor_request_pending` 与 `subagent_roster` 两项 smoke 成功。记录明确说明 probe 使用测试自造 session，不读取用户配置/session。

该证据足以证明当前 synthetic SDK/Host 组合符合设计边界；它不等同于真实 CLI/TUI/用户 Host/provider 运行证明。验收记录也明确保留 provider 真兼容、真实 CLI/TUI 旧 fixture 迁移为未覆盖范围。

## 5. 首个可证偏离点与数据来源分类

### 首个可证行为

沿调用链最早能确定的行为是：Host 在 `agent-session.js:1139-1143` 将 `model-only` 工具排除出 callable 集合；codemode 随后在 `execute.js:323-327、432-469` 只基于该集合建立 sandbox 与 discovery API。故“code_mode 似乎发现不到”首先对应的是 exposure 设计边界，而不是注册后 catalog 忘记收录。

### 分类

- **预期 production 数据未被正确处理：未证明。** 没有证据显示某个合法 production Host 将一个应当 callable 的工具注册为 model-only，或显示 codemode catalog 错误地丢弃了 exposure 为 `codemode`/`deferred` 的工具。
- **测试/探针制造的非预期数据：仅适用于 fixture 中手动旧名。** `joint-upgrade-model-only.test.mjs:14-15` 手动注册旧 `subagent_supervisor` 是测试覆盖 adapter 的合成数据；若现象来自该 fixture，分类应为测试/探针数据，不能修 production fallback。
- **本次用户现象：来源尚未证实 / blocked-evidence。** 设计证据说明 model-only 不应被 code_mode 发现，但缺少实际调用证据，不能证明用户运行的是预期的 model-only 排除、supervisor 未 bind、Host 版本/扩展闭包差异，还是其他现象。

所以当前结论是：**设计上不能被 code_mode 发现；production 缺陷尚未证明。**

## 6. 最小后续验证与修复边界

只需收集同一次、非敏感的 code_mode 运行摘要即可解除 blocked-evidence：

1. codemode 原始脚本中是否调用了 `ALL_TOOLS`、`searchTools("subagent")`、`describeTool("subagent_start")` 或 `tools.subagent_start(...)`；
2. 返回的 `Script completed/Script failed` 头、错误文本和 `details.calls` 中的工具名/status；不需要完整 session；
3. 同一 Host 的非敏感工具投影：相关 14 名的 `{name, exposure}`，active tool names，callable tool names；不需要 settings/models/auth/凭据/authority/state；
4. 是否为 main Host、是否 child/fanout child、supervisor adapter 是否 bind；只需布尔/枚举事实；
5. Host/package 的物理版本标识，以及是 fresh Host 还是 reload/resume；不需要读取用户配置或 session 正文。

验证后的边界判断：

- 若目标是让这 14 项继续保持编排安全边界，则无需修复；应把模型调用路径与 codemode 脚本路径分开说明。
- 若产品需求明确要求 codemode 能间接调用这些操作，需重新评审 exposure/权限合同，并同步 nested、child、owner/CAS、supervisor gate 与审计测试；不能仅把它们加入 `ALL_TOOLS`，也不能加一个绕过 `_getCallableTools()` 的 fallback。
- 若实际摘要显示 `exposure` 为 `codemode`/`deferred` 的其他工具未被发现，才进入 codemode/Host production 缺陷定位；现有证据不支持提前添加兼容分支。

## 7. 明确排除的错误归因

- 不是 `inlineBudget` 导致这 14 项永远不可发现：预算只影响已经进入 callable catalog 的工具是否 inline 展示；未列出的 callable 工具仍可由 `searchTools()`/`describeTool()`查找。`model-only` 在更早的 Host callable 过滤处已被排除。
- 不是 `ALL_TOOLS` 的 QuickJS sandbox 序列化遗漏：`pi-codemode` 的 prelude 只是接收 Host 已生成的工具列表；`pi-coding-agent/dist/extensions/codemode/execute.js:323-327` 已在进入 sandbox 前完成 callable 过滤。
- 不是 schema 的 `additionalProperties:false`、顶层 union 迁移或固定 action 注入导致 code_mode discovery 失败；这些只影响主模型直接调用时的参数验证/路由，工具是否进入 codemode catalog 由 exposure 决定。
- 不是 child agent 的 `tools` 白名单单独导致 main Host 的 code_mode 看不到工具；main/child 隔离发生在 extension early-return，nested 隔离发生在 Host callable 过滤，两层均有独立代码证据。
- 不能把旧 union 名的历史 raw 文本、TUI renderer 映射或 synthetic fixture 中的手动注册当作 fresh Host 新 schema 仍注册旧工具的证据。
- 不能把 synthetic SDK probe 的成功 smoke 或 492/492 验收记录扩张为真实 provider、真实 CLI/TUI 或用户 session 现象已经验证。

## 8. 只读验证记录与残余风险

本次只读读取了 codemode 文档及必要交叉引用、Host codemode/AgentSession 实现、14 项 factory、main/child 注册入口、相关架构/合同/验收文档与测试 fixture。未运行测试、tsc、真实 Host、provider、网络或危险进程；未修改仓库文件。

残余风险是：当前没有用户所指的具体 code_mode 返回证据；因此无法区分“模型尝试发现 model-only 工具而得到预期找不到”与“某个实际 Host 版本/扩展装载异常”。另有真实 provider/CLI/TUI 覆盖未由 synthetic probe 证明，但这不改变源码层对 model-only discovery 边界的结论。
