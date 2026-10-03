# resumed-child 集成挂起：upstream child 扩展传播缺陷

- 日期：2026-09-30
- 状态：已诊断，根因归属 upstream pi-subagents，维持集成门禁排除
- 关联：plan T7；var/upgrade/t7-resumed-child-diagnosis.md（本地证据）；
  var/upgrade/fix-resumed-child-fixture.md（fixture 一/二层）

## 现象

`test/subagent-auto-integration-resumed-child.integration.mjs` 四用例同族挂起
（~180s 预算耗尽）：`queue=[] intents=[] workspaces=[active]
auditDebts=[{kind:proof,status:unresolved}]`。auto-integration admission 从未发生。

## 根因（确定性证据）

1. 我方 `codingWorkflowSpawnParams`（extension.ts:359-364）正确地在 spawn leaf 注入
   `subagentOnlyExtensions: [child-extensions/integration-queue.ts]`
   （临时插桩捕获 `worktree:true, hasQueue:true` 实证）。
2. upstream `pi-subagents@0.71.0` 的 runs.run leaf→step 传播**丢弃**
   `subagentOnlyExtensions`：child `launchResolvedExtensions.configured/required`
   均为空，child 无 `subagent_integration` 工具，runner.stderr 无 disabled 记录。
3. child 因此不加载 integration-queue 扩展，agent_end 无 auto-integration lifecycle，
   coordinator 队列从不 enqueue → 测试等待 admission 恒不满足 → 挂起。

## 数据来源分类

非测试制造（真实生产代码 + 真实 Pi Host + 真实 runner）；原理 production 可达；
但偏离点在 `node_modules/pi-subagents` 的 leaf 字段传播，**pre-existing、非本次
merge 引入**（merge 前后挂起签名一致）。

## 处置

- 不在本仓对 upstream 传播缺陷做生产 hack。
- 集成门禁维持排除该文件，排除原因更新为本诊断。
- 修复需 upstream pi-subagents 让 runs.run leaf 保留 `subagentOnlyExtensions`
  /required child extensions；作为独立后续项跟进。

## 附带 fixture 修正（本轮）

scripted 模型回复补 `acceptance-report` 结构化块
（test/fixtures/recovery-resume/scripted-model-server.mjs）：原缺该块导致 child 被
acceptance gate 拒（`Structured acceptance report not found.`）。修正后 child
complete/checked，但 queue 仍空——证明 acceptance 为叠加的第二层 fixture 缺口，
非挂起根因。
