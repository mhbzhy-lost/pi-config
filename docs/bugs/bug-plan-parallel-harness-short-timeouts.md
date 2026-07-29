# Bug: parallel Plan Harness 固定 startup/status 预算导致真实回归抖动

## 症状
`test/plan-parallel-harness.integration.mjs` 在相同代码上交替通过或失败：parallel场景在两个Task均accepted/integrated后120秒status等待到期，尚未执行最后verify；Attention场景偶发5秒内未收到Standalone session start。

## 影响
Task 9真实Harness无法稳定形成全绿证据，且失败发生在控制流程已正确推进或进程尚未完成冷启动时，容易被误判为IR、Attention或provider回归。

## 复现
clear-env运行完整parallel Harness。当前慢机器上两Executor、Git worktree与Pi冷启动可能超过120秒；Standalone Host默认5秒startup在并发/冷缓存下也可超时。隔离重跑相同场景可通过。

## 根因
Harness直接复用production默认5秒Host startup和120秒status测试预算，并把整体test timeout固定300秒。测试目标是验证真实revision/prompt/hash/Attention/Gate协议，不是验证这些本机性能SLA；预算低于真实多进程尾延迟。

## 修复
仅修改Harness：通过注入`spawnStandaloneHost({...options, startupTimeoutMs: 30000})`提升测试startup预算；status等待默认提升到240秒；两个真实场景总timeout提升到480秒。production Host默认、Plan业务timeout与所有协议断言不变。

## 验证
完整parallel/attention Harness连续两轮通过；parallel最终validated且两个commit/cleanup/hash/prompt断言成立，Attention从pending经fenced reply恢复到validated。clear-env全量单元测试与doctor继续通过。
