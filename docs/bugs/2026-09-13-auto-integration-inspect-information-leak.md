# Auto Integration 检查结果暴露工作区身份信息

## 摘要

`inspect_auto_integration` 的生产返回面曾将工作区的 `path`、`branch`、`head`、
`originRef` 带给 child。该结果违反“child lifecycle 只获得最小状态”的安全合同：
检查生命周期状态不应成为工作区位置、分支拓扑或提交身份的读取接口。本记录供后续
hardening 修复引用；本记录不包含真实凭据、授权材料、会话内容或完整私有路径。

- **问题类型**：信息暴露 / 最小状态合同违约
- **影响面**：生产运行时可达的 managed workspace auto-integration 检查链
- **发现日期**：2026-09-13
- **优先级建议**：在恢复 production 修复前，先完成本记录所列验证与审查

## 合法入口与身份边界

合法入口是 child integration extension 注册的 `subagent_integration` 工具，动作
为 `inspect_auto_integration`（以及会返回检查结果的
`prepare_auto_integration`）。child 不得在输入中提供工作区身份字段；协议解析器对
这两个操作要求输入对象为空，身份必须由 Host/Root Broker 根据已绑定的 run 解析。

身份顺序应保持为：

1. Root Broker 验证调用者属于当前 root session 和 child run；
2. runtime 依据受信绑定解析唯一 managed workspace；
3. coordinator server 再以 `workspaceId`、`leaseId`、`runId` 和 owner scope 校验绑定；
4. coordinator 从 ledger/workspace service 读取状态；
5. 返回给 child 的结果只允许 lifecycle 状态、队列状态和完成判定所需的最小字段。

`workspaceId`、`leaseId`、owner scope 和 run identity 是授权校验材料，不是允许回显
给模型的工作区详情。问题记录只使用字段名，不记录其实际值。

## 权威数据来源

- **绑定权威**：coordinator server 的 `trustedWorkspace(binding)` 与 workspace
  service 的 owned/binding 校验。
- **队列权威**：integration queue 中按 binding 找到的 queue item；队列状态、revision
  和 admission generation 来自 queue ledger。
- **工作区完成权威**：workspace service 的 `inspectIntegrationCompletion(binding)`，
  包含 workspace state、receipt 存在性和 proof state 等生命周期判定。
- **Git 身份权威**：workspace ledger / Git worktree service 中的工作区路径、分支引用、
  HEAD 与 canonical origin ref；这些数据仅供 coordinator 内部校验和集成操作使用，
  不应进入 child 检查结果。

## 调用顺序与首个偏离点

### 正常调用链

`subagent_integration.execute`（`inspect_auto_integration`）
→ `coordinator.inspectAutoIntegration`
→ coordinator client 发送 `binding.register`
→ coordinator server 分派 `inspect_auto_integration`
→ `trustedWorkspace(binding)` 校验唯一 owned workspace
→ integration queue 按 binding 查找 item
→ workspace service 读取 completion state
→ coordinator 组装结果
→ Root Broker/runtime 将结果交给 child。

### 首个偏离点

首个偏离点位于 coordinator server 的 `inspectAutoIntegration` 结果组装边界：内部
`entry`（包含工作区路径、分支和 origin 信息）或其派生 Git 检查字段被放进对 child
可见的返回对象。此处把“内部授权/一致性数据”错误地当成了“child lifecycle
状态”，在跨过 coordinator→Root Broker 的返回边界时形成信息泄露；后续 transport
或协议校验并不能替代该边界上的字段裁剪。

## 数据泄露范围

可能暴露的字段及其风险分类如下：

| 字段 | 暴露内容类别 | 风险 |
| --- | --- | --- |
| `path` | managed workspace 文件路径 | 暴露本机目录布局、工作区定位信息 |
| `branch`（实现层可能对应 `branchRef`） | 工作区分支身份 | 暴露仓库内部命名与拓扑 |
| `head` | 工作区当前提交身份 | 暴露开发进度、提交关联线索 |
| `originRef` | canonical target 分支引用 | 暴露集成目标及仓库结构 |

这些字段可能在成功检查、准备后检查或状态变化期间随结果传播，并可能被 child
模型上下文、工具结果展示或运行日志间接保留。该问题不需要调用者自行提交上述
字段即可触发，因为来源是受信工作区记录，而泄露发生在返回面。

本问题不认定或记录任何凭据、grant token、session 正文、prompt 正文或完整私有
路径；上述字段名仅用于定位修复和验证范围。

## production 可达分类

- **可达性**：production reachable。真实 runtime 注册 child integration tool，且
  `inspect_auto_integration` 通过 Root Broker、coordinator client/server 到达生产
  managed workspace。
- **权限分类**：绑定后的 child 可合法执行 lifecycle 检查；不属于未授权任意工作区
  读取，也不能据此扩大 write scope。
- **泄露分类**：低权限状态查询路径上的 metadata disclosure；影响 confidentiality
  与最小状态合同，不等同于代码写入、集成发布或凭据泄露。
- **触发条件**：调用合法检查入口并接收 coordinator 返回结果；不要求模型输入
  `path`、`branch`、`head` 或 `originRef`。

## 禁止的修复方式

1. 不得通过放宽协议输入、让 child 自行传入或回显 `workspaceId`、路径、分支、HEAD
   或 origin 信息来“修复”绑定问题。
2. 不得把完整 workspace receipt、ledger record、Git inspection 或错误对象直接
   透传给 child。
3. 不得用字符串替换、日志过滤或 UI 隐藏代替 coordinator 返回边界上的字段裁剪。
4. 不得删除绑定校验、Root Broker 授权、queue 状态校验或 completion/proof 判定。
5. 不得把内部字段改名后继续返回，亦不得以哈希、截断或拼接形式保留可还原的路径、
   分支和提交身份，除非另有明确安全合同批准。
6. 不得借此问题修改 write scope、集成权限、凭据处理或 production 外的无关模块。

## 后续 hardening 与验证要求

修复应在 coordinator 返回边界建立明确的 allowlist：child 仅获得完成所需的最小
生命周期状态（例如队列/工作区/proof 的分类状态、布尔完成判定及必要的 revision），
不得包含 `path`、`branch`/`branchRef`、`head`、`originRef` 或完整 receipt。

验证必须覆盖：

1. 静态检查 `inspectAutoIntegration` 及 `prepareAutoIntegration` 的返回对象和
   runtime/broker 转发面，确认上述四类字段不会出现于 child-visible payload、错误
   文本或诊断字段。
2. 使用真实 Root Broker、coordinator socket/client、managed workspace、授权 run
   和真实 runtime teardown 顺序验证合法入口；不得只直接调用 coordinator handler。
3. 保留现有输入边界：两个 auto integration 操作的 `params.input` 仍为无额外字段的
   对象，模型提供身份字段必须被拒绝。
4. 覆盖队列不存在、queued、admitted、prepared、completed、preserved/debt 及绑定
   不匹配等状态，确认只返回允许的分类状态且不会泄露内部记录。
5. 对成功、失败和 transport 错误分别断言：错误只提供稳定的安全错误码/短消息，不
   携带内部 receipt、路径或 Git 诊断原文。
6. 对 child 可见的序列化结果做敏感字段扫描，并检查 diff，确保无凭据、授权材料、
   session/prompt 正文或完整私有路径进入测试 fixture、日志和文档。
7. hardening 完成后再运行针对性的协议、runtime membrane 和真实集成测试；本问题
   记录阶段不运行测试、不修改代码或测试。

## 只读证据索引

- `packages/pi-subagents-enhanced/src/workspace/coordinator-server.ts`：服务端
  `inspectAutoIntegration`、`trustedWorkspace` 与 auto integration 分派入口。
- `packages/pi-subagents-enhanced/src/workspace/coordinator-client.ts`：client 暴露的
  `inspectAutoIntegration` 合法调用面。
- `packages/pi-subagents-enhanced/child-extensions/integration-queue.ts`：child tool
  动作映射及 broker-backed 调用链。
- `test/subagent-auto-integration-plan.test.mjs`：已观察的协议测试意图——auto
  integration 不接受模型身份字段，模型提供身份字段应被拒绝；本任务未执行测试。
