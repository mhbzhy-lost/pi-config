# 修订执行意图后旧执行仍可能继续

## 问题描述

用户发出交互式转向、追问、中止或执行修订后，若只等待旧 Executor 自然结束，已被撤销的执行意图仍会继续运行；其陈旧结果或工作区还可能被错误集成。

## 复现步骤

1. Goal 的 action offer 和一个绑定 lease 的 Executor run 均处于活动状态。
2. 用户提出执行修订，但系统未先持久化暂停、撤销 offer 并请求精确停止。
3. 旧 Executor 自然成功结束，随后尝试集成其 workspace/result。

## 修复方案

先生成 durable suspend 与撤销 offer 的事件计划；仅向严格绑定 goal/task/attempt/run/lease 的 Root Broker facade 请求停止并等待 official terminal proof。受影响工作区只输出 preserve/quarantine/discard 策略，暂停期间阻断 dispatch、integrate、finalize，修订只可经 challenge 绑定的一次性用户 capability 协调。

## 补充根因与边界

foundation 曾生成彼此不同的 suspensionId、在无 active offer 时伪造撤销事实，并把 capability nonce 在签发阶段写入进程内 Set。这使重载后 ownership/消费权威丢失，且 apply 不能与消费原子化。修复将 suspensionId 复用于事件，只有 active offer 才输出撤销事件；签发不消费 nonce，协调结果返回同一批 consumed/applied 事件并依据 projection 的 nonce digest 拒绝重放。Root Broker 的 stop 失败只返回稳定 attention code，不透传上游错误。
