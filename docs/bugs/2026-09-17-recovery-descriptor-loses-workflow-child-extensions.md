# 2026-09-17 resumed child 丢失 workflow 注入的 integration child 扩展

## 现象

真实进程验收（R8）中，upstream `resume` 恢复的 child session 能正常收到 recovery prompt 并执行 git 操作，但从不推进 integration queue：无 `subagent_integration` 生命周期、无 admission/rebase/publish，queue item 停留在退出时的阶段，resume intent 以同一 fingerprint 反复创建直至 attempt 上限 preserve。

## 根因

pi-config patch `workflow-child-extensions.v1`（`packages/pi-subagents-enhanced/src/subagent-dispatch/ordered-models-runtime-patch.ts`）只把 workflow spawn 注入的 `subagentOnlyExtensions`（root-session-owner + integration-queue）合入 launch toolPlan；`async-execution.ts` 写入的 recovery descriptor 仍读 `recoveryAgentConfig.subagentOnlyExtensions`（agent profile 原始列表，managed coding child 为空）。`resume` 走 `applySteeringRecoveryAgentConfig` 读 descriptor 重建 child 配置，因此 resumed child 不加载任何 managed integration child 扩展。

证据：失败现场的 `async-subagent-runs/<runId>/recovery-descriptor.json` 无 `subagentOnlyExtensions` 字段；同 run 的原始 launch cfg 中 `steps[0].subagentOnlyExtensions` 为完整列表。

## 修复

patch 升级为 `workflow-child-extensions.v2`：recovery descriptor 的 `subagentOnlyExtensions` 改为捕获 `effectiveSubagentOnlyExtensions`（agent 原始列表与 workflow 注入列表的并集）。RED/GREEN：
- `test/workflow-child-extensions-descriptor.test.mjs`（v2 变换单测，4/4）；
- `test/subagent-auto-integration-resumed-child.integration.mjs`（真实进程 resume 全链路，4/4 × 3 次）。

## 分类

预期 production 数据未被正确处理（类别 1）：managed coding child 的 launch 配置是合法 public 入口产生的，resume 是受支持的恢复路径，v1 patch 遗漏 descriptor 捕获属实现缺陷。
