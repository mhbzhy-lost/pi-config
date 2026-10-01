# 波 2X supervisor / dispatch 诊断静默根因记录

## 范围与分类

本记录依据 `var/upgrade/silent-swallow-audit.md` 的 A7、B4、C4、A2、C7，以及
`var/upgrade/silent-swallow-decisions.md` 的 A2 决策和统一原则建立。现场代码均位于
supervisor / dispatch 簇；本轮只提升可观测性，不改变任何 fail-closed 判定。

- **A7（类别 1，生产缺陷）**：`src/subagent-dispatch/extension.ts:1206-1208,1250-1252,1602`
  的登记/投递失败路径丢失原 error；补偿 `commitDelivery({success:false})` 的 blocked 或
  rejection 未被诊断。后果是无法区分原始投递错误与补偿持久化错误。最小修复是带原 error
  与 cause 链记录登记失败；补偿 blocked 记录，补偿 rejection 以原错误为主因聚合。审计判定
  不影响 fail-closed。
- **B4（类别 1，生产缺陷）**：`supervisor-control-plane.ts:127-134` owner receipt
  存储异常，以及 `:identityForRun` runtime 读取异常被转为不可用/undefined，但没有诊断。
  后果是控制面仍正确拒绝不可信 owner，却无法知道是 broker 不可用还是 runtime 读取失败。
  最小修复是记录原始错误和 cause，保留 owned/unowned/unavailable 三态及 unknown_run 唯一
  unowned 规则。不影响 fail-closed。
- **A2（类别 1，主 agent 已决策）**：`subagent-runtime.ts:70-75` 异步 submit 的
  `debt/skipped` 或 rejection 被丢弃。`delivered` 必须继续表示“已接受并触发投递”，
  不能改成恢复完成或以异步结局改写回执；最小修复是独立诊断 submit 结局，保留 intent
  身份、phase、原始 error/cause。不影响 fail-closed。
- **C7（类别 1，生产缺陷）**：`subagent-runtime.ts:425-448` dispose 时 broker/
  coordinator close 异常被静默吞掉。后果是关闭故障不可见。最小修复是记录每个原始错误并
  聚合为 secondary errors，在不覆盖已有 primary 的前提下抛出；不改变安全判定。
- **C4（待进一步判定，本轮不实施）**：审计明确要求补充 ready-gate debt 重试和 setup
  cleanup 的 dispose 错误契约证据，决策文件未覆盖。根据任务门禁，本轮不修改 C4 的
  `extension.ts:1474-1481,1697-1707`，列为待决。

## 证据与 TDD

生产代码前先落盘本记录。每条 RED 输出写入 `var/upgrade/wave2x-*-red.log`，修复后
对应 GREEN 输出写入同名 `*-green.log`；验收报告引用这些现场日志。所有测试均使用
`env -u PI_SUBAGENT_CHILD -u PI_SUBAGENT_FANOUT_CHILD TMPDIR=/tmp`，不运行完整 integration gate。
