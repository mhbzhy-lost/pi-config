# Planned task contract 将验收标准误作 commands 的问题

## 现象
旧 reducer 把 `acceptance.criteria` 当字符串，并要求 `acceptance.commands`；新 Planned record 因而不能表达可追溯的 criterion，也可能把 shell 文本带入 dispatch。旧终态续接门禁还把合法事件硬编码为 v3，使已完成 Planned Goal 无法继续记录 continuity。

## 根因
持久化 record generation 与 taskDef 内局部标签混淆，dispatch 没有从结构化 criterion 做确定性 transport 编码，终态续接判断也没有复用同一 generation 规则。

## 影响
新旧日志可被混用，或 criterion 的 id、statement、evidenceKinds 在 dispatch/replay 中丢失；commands 可能越过 Planned 边界；Planned Goal 完成后的 session、discovery 与 reopen 记录会被错误拒绝。

## 修复
`planned.v1` 是整条 event record generation。仅该 generation 的新 mutation 可写入；legacy v1/v2/v3 仅 replay。Planned criterion 严格为 `{id,statement,evidenceKinds}`，dispatch 使用 canonical JSON 字符串传递该三元组；已完成 Goal 的合法 continuity 事件继续使用原 generation。

## 验证
覆盖 generation 混用/降级的原子拒绝、criterion 的字段和值域拒绝、及 dispatch 无 commands 且 criteria 编码稳定。

## 防回归
任何新增 Planned event 均保持 `schemaVersion: planned.v1`；不得以 taskDef 字段或自由字符串代替 record generation。
