# D-AUDIT：历史 proof debt 只读分类（重试）

## 审计范围与时点

- 审计时间点：2026-09-24T19:41:43+0800。
- 输入仅为既有快照：四个分区各自的 `terminal-proof-outbox/terminal-proofs.json`（快照根为 `var/snapshots/2026-09-23-pre-remediation/`）以及 P1 的 `records/*.json`；P2–P4 records 按快照标记为 absent。
- 通过一个 Python 内存脚本读取四份 outbox 并聚合；未读取 workspace、worktree、live queue 或 live records，也未调用任何 mutation。
- 下列数字是快照时点的数值，不等于当前 live 数。报告不输出任何敏感标识符、凭据或未聚合字段值。

## 四分区快照聚合

| 分区 | pending | receipts | debts | supersessions | debt reason/category |
|---|---:|---:|---:|---:|---|
| P1 | 5 | 0 | 188 | 3 | trusted-run-binding-unavailable: 188 |
| P2 | 0 | 0 | 110 | 0 | trusted-run-binding-unavailable: 110 |
| P3 | 0 | 0 | 130 | 0 | trusted-run-binding-unavailable: 130 |
| P4 | 0 | 0 | 101 | 0 | trusted-run-binding-unavailable: 101 |

四份 outbox 的 debt reason 均归一化为脱敏类别 `trusted-run-binding-unavailable`；未发现其他 reason/category。时间点字段仅做范围聚合，不输出字段值：P1 observedAt 范围为 1789715577325–1790161523317，P2 为 1789720394936–1790162319609，P3 为 1789715709090–1790159454518，P4 为 1789888954839–1789987066180（均为快照内记录的毫秒时间值）。

P1 records 聚合：5 份；state 计数为 `cleanup-debt`: 4、`active`: 1；存在 `run` 字段：5/5；存在 `terminalProof` 字段：5/5。P2、P3、P4 records：按 snapshot 记录为 absent，不推断其状态或字段。

## 严格分类

### production 可达

仅可将快照真实 outbox schema 中可直接观察到的集合及聚合数字列为 production 可达：四分区的 pending/receipts/debts/supersessions 集合长度，以及 debt reason/category 的上述脱敏计数。快照同时显示了正常 schema 形状，但本报告不据此推断未被快照证明的入口、完整事件序列或运行时行为。

### fixture/测试制造

无。仅凭这些快照无法证明任何 debt 是 fixture 或测试制造，因此不作该分类。

### 来源未证实（默认，fail closed）

历史 debt 的 root receipt、完整事件 provenance、入口来源及 workspace 绑定链不在允许输入中；因此 debt 来源、是否由 production 正常事件顺序产生均未证实，默认 fail closed。P1 records 的字段存在性也只代表快照中的结构观察，不证明字段值、事件来源或 production 运行结果。

## 边界与风险

- B7 只防止新增的无 workspace debt；本报告不清理历史 debt，不调用任何 mutation。
- 快照时点不等于当前 live 数；不能由本报告推断 live queue、live records 或当前 outbox 状态。
- P2–P4 records absent 是快照事实，不能推断不存在对应 live records。
- 纯文档、只读审计适用 TDD 豁免：本次没有生产代码、配置或行为变更，故不新增测试；证据为唯一文档写入及只读 Python 聚合命令。
