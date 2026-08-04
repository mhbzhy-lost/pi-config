# Goal 初始化会持久化无法派发的派生契约

## 现象

`goal_init` 只校验 task 定义的原始字段后便持久化 `goal.created`。但实际派发会把 `goalId.taskId`、任务描述/criteria 与 Goal DoD 组合为 dispatch IR；Goal objective、scope、nonGoals、DoD 及已完成任务的 evidence 也会进入 IR context。于是原始定义合法的 Goal 仍可能在后续 `goal_dispatch` 才因 160 字节 taskId、32 项数组或 4096 字节字符串限制失败。

## 影响

状态已经写入、用户已开始生命周期后才发现 pending task 无法派发；直接重放 v2 `goal.created`/`goal.amended` 也能绕过 handler。累积 completed/evidence context 无上限时，后续任务还会因历史上下文增长而延迟失败。

## 根因

初始化、事件投影和 dispatch 编译之间没有共同的最终派生契约门禁；生命周期可选上下文没有确定性有界投影。

## 复现

1. 用接近 160 字节的 goalId 与 taskId 初始化，或令 `1 + criteria + dod > 32`。
2. 也可提供超过 4096 字节的 objective/scope/nonGoals/DoD 派生项。
3. 初始化成功，但派发时 `compileCodingDispatchIR` 拒绝；直接 apply v2 事件同样未被阻止。

## 期望与修复

以 `compileTaskContract`/`compileCodingDispatchIR` 为唯一 oracle：v2 create 构造 projection 后、v2 amend 构造候选后，逐个编译所有 pending task。handler 在 append 前进行相同预演，并将契约错误包装为包含 observed、remediation、`stateChanged=false` 的 `INVALID_GOAL_CONTRACT`。可选 completed/evidence facts 与 relevant files 必须稳定地最多保留 32 项，跳过超过 4096 bytes 的完整项；Goal 核心 metadata 则硬拒绝。v1 历史重放保持兼容。
