# superseded 依赖导致 Goal 状态停滞

## 问题描述

当 active Planned Goal 的 pending task 仍依赖已 superseded 的 source task 时，`goal_status` 的 runnable 为空且不签发 `goal_amend` capability，协调者无法安全地显式修正 DAG。

## 真实复现

1. 初始化 source task 与依赖它的 pending dependent task。
2. dispatch source，settle 为 `blocked`，再通过 typed `goal_integrate` discard workspace。
3. 使用 `resolve_blocked` 的 `supersede` 增加 replacement task；replacement 可以已 accepted 或仅已存在。
4. dependent 仍保留对 superseded source 的依赖，此时无法 runnable，`goal_status` 也没有 `goal_amend` machine action 或 action token。

## 修复方案

保留既有 runnable、workspace、终态和未分诊事项的优先级。只有全部普通 task action 均为空时，识别 pending task 的 superseded dependency debt，并签发绑定该 dependent task 的 `goal_amend` capability。协调者必须显式使用 `patch_active` 更新 deps；引擎不猜测 replacement，也不改写历史事件。
