# Bug: Goal Contract practice profile 可在状态与合同间静默漂移

## 现象

`goal_contract.v1.1` 同时在 `state.json.practice_profile` 和 `goal-contract.md` 的 Evidence Lanes、Authority Ladder、Drift Detectors、Slice Ordering Gate 等章节表达实践约束。当前 validator 只检查两边各自字段/章节存在，不验证语义来自同一份 profile。

## 影响

后续 agent 可能只更新 Markdown 或只更新 JSON，导致人类阅读的合同与运行时消费的状态产生不同规则。恢复会话仍能通过现有 shape validator，却可能使用错误的 evidence 权威、漂移门禁或 slice 顺序，属于静默控制面分叉。

## 复现

1. 修改 `state.json.practice_profile` 中任一 drift detector。
2. 不修改 `goal-contract.md`。
3. 运行现有 Goal Contract validator。
4. validator 仍通过，无法证明两份表示同步。

## 根因

practice profile 缺少 canonical identity。Markdown 是人审表示，JSON 是机器表示，但两者没有共享 digest；现有校验只验证局部 shape，没有跨 artifact 一致性 oracle。

## 修复方案

对 `state.json.practice_profile` 使用递归 key 排序后的 canonical JSON 计算 SHA-256：

- `state.json` 顶层保存 `practice_profile_sha256`。
- `goal-contract.md` 保存 `practice-profile-sha256` marker。
- tracked Goal Contract integrity audit 重新计算 digest，并同时比较 JSON 声明和 Markdown marker。
- 缺 marker、非法 hash 或任一侧不匹配均 fail closed。

Markdown 章节仍用于人审；digest 不尝试从 Markdown 反向解析结构，而是证明该文档明确绑定了哪一个机器 profile identity。

## 验证方式

- profile、state 声明和 Markdown marker 完全一致时通过。
- 修改 profile 但不更新 hash 时失败。
- state hash 正确但 Markdown marker 不同时失败。
- marker 缺失或格式非法时失败。
- 当前 Goal 的 authorization artifact 与 practice profile 两组 integrity 检查都通过后，恢复命令才返回成功。

## 本次机械门禁

`state.json.practice_profile_sha256` 和 `goal-contract.md` 的 `practice-profile-sha256` marker 绑定同一个 canonical profile identity。`scripts/goal-contract-authorization-audit.mjs` 在每次恢复前重新计算递归 key 排序后的 canonical SHA-256，并同时校验两处声明。

Node test 覆盖完整匹配、profile 内容漂移和 Markdown marker 漂移；任一不一致都会令恢复 audit 非零退出。
