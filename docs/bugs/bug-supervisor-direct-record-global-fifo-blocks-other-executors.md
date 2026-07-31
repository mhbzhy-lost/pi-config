# Bug：Supervisor direct record 全局 FIFO 会跨 Executor 阻塞

## 症状

Root-owned adapter把同一Plan的所有Supervisor push放进一个generation-local数组，并在drain中从head顺序调用`recordSupervisorRequest`。如果head因active Attempt暂不匹配或领域校验永久失败，循环立即抛出，后续其他Executor的合法request完全不处理。

## 影响

一个Executor的坏请求可阻塞同Plan下其他并行Executor的Attention，扩大故障域。该行为还额外承诺了协议从未要求的跨Executor全局顺序，与Broker既定“每个Executor FIFO、全局仅做容量上限”语义冲突。

## 复现

1. 同一Plan的Executor A、B依次发送request。
2. A的request在Plan projection中不匹配active Attempt，recorder拒绝。
3. B的request身份、body和active Attempt均合法。
4. 单数组drain在A处抛出；B从未被调用。后续hook仍从A开始，形成永久阻塞。

## 根因

adapter把所有Executor共用的arrival queue误作一个必须全局串行成功的事务。它没有按`details.runId`维护head资格，也没有在单轮drain中隔离某个Executor的失败。

Plan event writer确实需要串行append，但这不要求跨Executor失败传播；只要求同Executor后续request不得越过其失败head。

## 修复

queue item保留`executorRunId`。每轮drain按arrival order串行尝试，但某Executor首项失败后仅冻结该Executor在本轮的后续项；继续处理其他Executor的head。成功项完成record与ACK阶段后删除；失败项保留到下一lifecycle hook重试。

整体drain在处理完其他可运行项后仍报告首个错误，保持fail closed和可观察性。不得跳过同Executor FIFO，不承诺跨Executor顺序。

## 验证

RED构造Executor A永久失败、Executor B合法的相邻push；一次`agent_settled`应尝试A并成功提交/ACK B，同时整体返回A错误。再加入A的第二项，证明它在A首项失败时不得被尝试。

运行adapter focused和完整Plan链，确认requestId dedupe、每Executor FIFO和single-writer event version不回归。
