# Planned task contract 将验收标准误作 commands 的问题

## 现象
旧 reducer 与 production Extension 都把 `acceptance.criteria` 当字符串，并要求 `acceptance.commands`。`goal_init` 仍写 legacy v3，后续 action、workspace、settle、accept 与 continuity writer 也固定写同一 legacy 版本，导致已切换的 strict reducer 拒绝新 Goal，或让 Goal dispatch 产出 strict Subagent schema 不接受的 commands。

## 根因
持久化 record generation 与 taskDef 内局部标签混淆；Extension 用进程级常量选择事件版本，而不是从 projection 选择 generation。初始化、amend 和 dispatch 预检也继续调用 legacy task validator，未将结构化 criterion 贯穿 production writer。

## 影响
新 Planned Goal 无法创建或在重启后继续生命周期；新旧日志可能混用，criterion 的 `id`、`statement`、`evidenceKinds` 会在 dispatch/replay 中丢失，commands 还可能越过 Planned 边界。已完成 Planned Goal 的 session、discovery、checkpoint 与 reopen 记录同样会被错误拒绝。

## 修复
`planned.v1` 作为整条 event record generation：空 projection 的新建只写 Planned；后续 writer 从 projection 选择并保持 generation。Production `goal_init`、`goal_amend` 与 dispatch 只接受严格 `{id,statement,evidenceKinds}` criteria，所有 Planned transport 不含 commands。历史 v1/v2/v3 仍按原 legacy generation replay，并可沿合法 legacy 升级路径完成，不向其追加 `planned.v1`。

## 验证
先以 production Extension 测试观察 strict init 与完整生命周期 RED，再验证 init、amend、session、continuity、action、dispatch、workspace、settle、integrate、accept、complete 全部保持 `planned.v1`。组合运行 dispatch、events、extension 共 241 项，覆盖 commands/additional properties 原子拒绝、结构化 criterion 稳定编码，以及 legacy v2 dispatch 继续按 legacy generation 写入。

## 防回归
任何新 Planned event 均保持 `schemaVersion: planned.v1`；不得以 taskDef 字段、自由字符串或 compatibility default 代替 record generation。新增 writer 必须显式携带 projection，generation 未知、混合或降级时一律 fail closed。
