# Subagent 不可用 agent 模型候选问题记录

日期：2026-09-05
分类：预期 production 数据未被正确处理

## 真实数据来源与入口

本问题来自 reload 后的真实 executor canary，不是手工拼接 event、projection 或缺字段 mock。canary 通过公开 typed `subagent` coding 入口提交完整 `dispatch-ir.v1`，其中显式传入 bare model `gpt-5.6-luna`。Host 的 agent discovery 读取 `pi/agents/executor.md` 的有序 `models`；该列表中 `codex-pool/gpt-5.6-luna` 位于 `openai-codex/gpt-5.6-luna` 之前，顺序本身是有效配置且不应修改。当前 Host available model registry 不包含前者，但包含后者。

真实回执将请求解析为 `codex-pool/gpt-5.6-luna`，随后 workflow child active registry 报 `Unknown subagent model`，并建议当前可用的 `openai-codex/gpt-5.6-luna`。另外两条真实 delegate canary 已成功启动：global bare 路径返回结构化 warning，qualified 路径不返回 warning；因此异常限定在存在 agent candidates 的 bare-ID 分支。

## 首个偏离点与调用链

完整调用链为：

1. typed coding contract：`model: "gpt-5.6-luna"`。
2. `resolveSpawnModel` 调用 agent discovery，取得 executor 的 ordered models。
3. `resolveModelSelection` 进入 `agent-candidates` 分支。
4. 旧实现只按 bare ID 在 agent models 中执行 `find`，未验证 canonical candidate 是否存在于 `availableModels`。
5. resolver 返回声明中的首项 `codex-pool/gpt-5.6-luna`。
6. extension 将该 canonical model 写入 workflow child。
7. workflow child active registry 拒绝该模型并报告 unknown model；可用候选 `openai-codex/gpt-5.6-luna` 未被选择。

首个偏离点是第 4 步：agent candidate 的声明顺序应在“当前 available 的同 ID 候选”集合内生效，而不是允许不可用首项绕过 active registry 可用性约束。

## 预期行为与修复边界

- bare ID 且 agent 声明了 `models` 时，按声明顺序选择第一个 ID 相同且完整 `provider/model-id` 存在于 `availableModels` 的候选。
- 声明候选均不可用时，返回 `MODEL_NOT_AVAILABLE`；该 miss 是 terminal，不搜索 agent 列表外的 global catalog。
- 模型选择必须发生在 Goal、workspace、RPC、title 等 spawn 副作用之前。
- qualified、无 agent models 的 global bare、未传 model 的 default fallback 行为保持不变。
- 不改变 `pi/agents/executor.md` 的候选顺序，不为过期 fixture 增加 production fallback。

## TDD 证据

RED fixture 复刻 canary：agent candidates 依次为不可用 `codex-pool/gpt-5.6-luna` 与可用 `openai-codex/gpt-5.6-luna`，available catalog 仅包含后者；旧实现错误返回前者。集成 RED 同时验证 typed executor child 必须收到后者，并验证无可用声明候选时，即使 global catalog 含 agent 列表外同 ID 模型，也必须在任何 spawn 副作用前失败。
