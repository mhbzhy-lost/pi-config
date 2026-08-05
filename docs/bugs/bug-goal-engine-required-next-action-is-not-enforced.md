# Goal Engine 的 requiredNextAction 只是提示而非门禁

## 1. 预期行为

每次 Goal mutation 必须执行最近一次 `goal_status` 给出的唯一机器动作；动作应绑定 goal/version/session/tool/params，且一次调用后立即失效。

## 2. 实际行为

`requiredNextAction` 仅作为 JSON 文本返回。Agent 可以跳过 status、改变参数、在报错后继续串调用，Goal Engine 没有机械校验。

## 3. 稳定复现

TokenRec 会话中一次 settle error 明确要求先调用 status，随后却直接再次派发 subagent；另有 settle→integrate→accept 连续调用。现有 handler 只检查当下 task 状态，未要求 status 颁发的凭据。

## 4. 根因

状态机计算了建议动作，但没有把该建议持久化为可消费状态，也没有在 mutation 入口绑定 projection version、session 和参数。

## 5. 影响范围

Agent 可基于过期投影执行错误任务、重放同一动作或在失败后绕过恢复顺序；错误常在 workspace 或 evidence 已变化后才暴露。

## 6. 修复与验证

新增 append-only action offer 的纯逻辑：随机 nonce 与 goal/version/session/tool/params 生成 token；mutation 首先消费，token 重放、参数或版本漂移均拒绝。先写一次性、漂移和失败后重放 RED；本任务只实现纯接口，事件与七工具接线在 G6 完成。
