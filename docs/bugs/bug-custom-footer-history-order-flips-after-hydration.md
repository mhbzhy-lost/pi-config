# Bug：Footer child history 在 hydrate 后顺序翻转

## 1. 现象

`SubagentSessionBrowserState.serialize()` 输出的 terminal runs 已按最新到最旧排列；同一数据经 `hydrate()` 恢复后，`recentChildren()` 再次反转 Map 顺序，结果变为最旧到最新。连续 reload 会使 history 顺序来回翻转。

## 2. 影响

Footer child browser 的 `history N` 展开顺序和无 active child 时的默认选择在 reload 前后不稳定。用户可能从最新完成任务跳到最旧任务，违反计划中 recent 按 run 新到旧排列及 reload 保留 roster 的合同。

## 3. 稳定复现

1. 依次创建并完成 `old`、`new` 两个 run。
2. 确认原状态 `recentChildren` 为 `[new, old]`。
3. 执行 `SubagentSessionBrowserState.hydrate(state.serialize())`。
4. 恢复状态的 `recentChildren` 变为 `[old, new]`，`enter()` 选择 `old`。

## 4. 证据

`serialize()` 调用 `children()`；该方法把 `recentChildren()` 追加到 active children，而 `recentChildren()` 对 Map 中 terminal runs 执行 `reverse()`。`hydrate()` 随后按序列化 children 的顺序重新插入 Map，因此已反转的数据再次被 `recentChildren()` 反转。

现有 persistence 测试只包含一个 run，无法观察顺序翻转；active/recent 排序测试没有经过 serialize/hydrate round trip。

## 5. 根因

持久化格式只保存扁平 children，没有保存 run 的稳定启动顺序或明确声明序列化顺序。恢复逻辑错误地把展示顺序当作 Map 的原始启动顺序，而展示层又无条件对 terminal run 的 Map 顺序取反，形成双重反转。

## 6. 修复与验证策略

先增加至少三个 terminal runs 的 round-trip 失败测试，固定 reload 前后 `recentChildren`、`children` 和 `enter()` 选择完全一致。最小修复应在 hydrate 时恢复内部 run 的启动顺序，或让持久化格式显式携带稳定顺序；不得取消运行时“最新 terminal run 在前”的展示合同，也不得破坏 active run 顺序、20-run cap 和 colon-containing run ID 保护。
