# P-SNAPSHOT-CONTRACT：只读确认快照契约（不升级）

执行时间：2026-09-23（本次执行；本环境未提供更精确的时钟证据）。

状态：证据收集中；未经现场检查前不宣称 GO。

## 源码证据

- `packages/pi-subagents-enhanced/src/workspace/ledger.ts:125` 的 `ensureStorage(paths)` 对 `stateRoot`、`repositoriesDir`、`repositoryDir`、`recordsDir`、`worktreesDir` 逐一调用 `ensureDirectory`；因此执行需要确保存储的操作时会创建缺失的 `records/`，不是只读观测行为。
- 同文件 `listScoped` 定义于 526 行，缺失目录判断在 534 行：`if (!existsSync(recordsDir)) continue;`。`list` 定义于 552 行，缺失目录判断在 559 行同样 `continue`。两者对缺失的 records 目录均跳过该 repository，不报错；就这两个列表函数的集合语义，可记录“目录缺失/该分区不参与结果”，不应将其默认为具有某个精确记录数（尤其不能将目录缺失静默记为 0）。其目录存在时的非目录或符号链接会抛 `MANAGED_WORKSPACE_STORAGE`。
- `packages/pi-subagents-enhanced/src/subagent-dispatch/coordinator-proof-outbox.ts:6` 的 `State` 声明 `pending: any[]`、`receipts: Record`、`debts: Record`、`supersessions: Record`；8 行 `empty()` 初始化为 `[]`、`{}`、`{}`、`{}`。`read()` 位于 40 行：检查 version、pending 数组、receipts 对象；兼容性回退将 debts/supersessions 缺失或非对象值替换为空对象（注意：源码没有把该兼容行为等同于严格 schema 验证）。现场计数仅反映解析后预期容器的长度。

## 四分区现场摘要

只在允许的四个已知 SHA-256 命名分区顶层观察；报告以 P1–P4 表示，不记录 hash 或完整绝对路径。`records`、`integration-queue`、`terminal-proof-outbox` 的类型如下：

| 分区 | records | integration-queue | terminal-proof-outbox |
|---|---|---|---|
| P1 | 缺失 | 存在，目录 | 存在，目录 |
| P2 | 存在，目录 | 存在，目录 | 存在，目录 |
| P3 | 缺失 | 存在，目录 | 存在，目录 |
| P4 | 缺失 | 存在，目录 | 存在，目录 |

`terminal-proofs.json` 解析成功，按集合计数（顺序为 pendingCount、receiptCount、debtCount、supersessionCount）：

| 分区 | pendingCount | receiptCount | debtCount | supersessionCount |
|---|---:|---:|---:|---:|
| P1 | 0 | 0 | 130 | 0 |
| P2 | 5 | 0 | 188 | 3 |
| P3 | 0 | 0 | 108 | 0 |
| P4 | 0 | 0 | 101 | 0 |

## Coordinator 与 worktree 观察

四个分区的 `coordinator.json` 均缺失（文件类型、JSON 解析均不适用）。worktree list 可安全观察到的条目数：P2 为 5；P1、P3、P4 为“未确认”（相应目录未能据本次限定的顶层观察确认为可安全计数的目录）。未读取任何 worktree 内容，也未输出路径或条目身份。

## 后续 P-SNAPSHOT 规则

- 对 `records/` 缺失，记录“缺失”，不能伪造为空目录、不能把该目录对应数量默认为 0。源码只证明 `list`/`listScoped` 会跳过缺失 records 目录；在这两个 API 语义范围内可记为未纳入列表，而不代表其他来源、现场完整性或业务状态得到证明。`ensureStorage` 会创建该目录，故快照本身不得调用它或任何可能初始化现场的操作。
- GO 仅限证据完整且结构符合契约：已核实目标分区身份但报告不暴露标识；`records`、queue、outbox、coordinator 类型与所需基线一致；所需 JSON 可解析且符合预期 schema；计数可安全取得；采集前后观察无意外复制/变化。缺失 records 按上一条显式记录是允许的源代码列表行为，但不能以此推导整个快照完整或自动批准 GO。
- 出现预期外类型（特别是符号链接、非目录/非普通文件）、权限不足或无法安全检查、应存在 JSON 不可解析/结构不符合契约、快照复制/采集期间任一相关输入变化、无法确认分区对应关系或计数时，一律 No-GO，并写明“来源未证实/NO-GO”；不得修复、初始化、重试写入或静默归零。
- outbox 计数只能输出四个集合长度。不得记录集合元素、runId、proofId、token、绝对路径、凭据或标识 hash；worktree 只报条目数量。

## 限制与结果

这是只读证据记录；没有修改现场、源码、测试或配置，没有执行 git 写操作。现场共发现 7 个顶层目录，但仅报告任务指定的四个已知 partition。coordinator 文件均未出现，worktree 计数有三处分区未确认；因此不能声称完整快照 GO，当前判定：来源未证实/NO-GO。未运行测试（纯文档/证据记录豁免）。
