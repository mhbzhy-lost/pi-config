# Bug: Goal Contract 非 artifact evidence 无法独立验证

## 现象

Goal Contract 的 `amendments.jsonl` 允许在 `evidence` 中写入 `user-message:<id>`、`todo:<id>` 等字符串。当前恢复协议、validator 和审计文档都没有定义这些标识的解析位置、内容摘要或授权验证方式，但部分 `risk: high` amendment 已使用它们作为 applied 依据。

## 影响

新会话、独立 reviewer 或自动审计器只能看到一个标签，无法恢复原始用户授权或 Todo 内容，也不能证明证据未被替换。高风险 Objective、Scope、Non-Goals 或 DoD amendment 因此缺少可独立验证的授权链，削弱 Evidence Authority Ladder 和 Change Policy 的实际约束。

## 复现

1. 读取 `.state/goal-contract/goals/<goal-id>/amendments.jsonl`。
2. 找到 `evidence` 中的 `user-message:*` 或 `todo:*`。
3. 按 `goal-contract.md`、`recovery.md` 和 validator 查找解析协议。
4. 没有任何字段能定位原始内容、验证 hash，或判断该证据是否足以授权对应风险等级。

## 根因

`evidence` 目前是自由字符串数组，同时承担“人类可读引用”和“机器可验证授权”两种职责。Goal Contract 定义了 evidence lane 和 authority rank，却没有为非文件、非 commit 的会话证据建立 versioned descriptor、resolver 和内容完整性约束。

## 修复方案

引入结构化 evidence descriptor，例如：

```json
{
  "kind": "user_message",
  "source_id": "<stable-session-message-id>",
  "content_sha256": "<sha256>",
  "captured_at": "<ISO-8601>",
  "artifact_path": ".state/goal-contract/evidence/<sha256>.json"
}
```

高风险 amendment 必须引用可恢复 artifact，并由 validator 校验 kind、hash、artifact 存在性和授权范围。`todo` 证据同样要保存稳定 task identity 与快照，不能只记录显示编号。旧字符串证据仅作为 legacy diagnostic，不得单独授权新的高风险 amendment。

## 验证方式

- RED：高风险 amendment 只有 `user-message:*` 字符串时 validator 拒绝。
- GREEN：结构化 descriptor 指向存在且 hash 匹配的授权 artifact 时通过。
- 篡改 artifact、缺失 resolver、Todo identity 不匹配时均 fail closed。
- legacy Goal 可读取，但 audit 明确标记 `UNVERIFIABLE_LEGACY_AUTHORIZATION`，不得报告完整外部授权。

## 本次历史状态缓解

现有 `plan-ir-v3-complete-capsule-contract` 无法恢复已经丢失的原始消息和 Todo 快照。本次增加 `authorization-evidence.json`，保存从 amendment 记录可确认的摘要和字段范围；每条 amendment 记录 artifact 路径与 SHA-256，并明确标记 `legacy_unverifiable`。

时间语义显式分离：amendment 顶层 `ts` 保留原应用时间，artifact 使用 `original_amendments_applied_at` 和 `reconstructed_at`，descriptor 使用 `reconstructedAt`。事后重建时间不得被解释为原始授权在 amendment 应用前已经存在。

历史聚合 artifact 提交后视为不可变；修正或新增 amendment 必须创建新的 per-amendment artifact，禁止就地修改导致四条历史 descriptor 同时失效。旧 Todo 显示编号通过带 SHA-256 的 `todo-recovery-snapshot.json` 映射到稳定语义 alias，该 linked artifact 由同一 integrity audit 递归校验。

该 artifact 只改善恢复上下文和篡改检测，不把历史摘要提升为可验证用户授权，也不替代上述 validator/audit 的后续 fail-closed 实现。

## 本次机械门禁

`scripts/goal-contract-authorization-audit.mjs` 现已通过受版本控制的 `scripts/lib/goal-contract/authorization-audit.mjs` 执行以下 fail-closed 检查：

- `status=applied` 且 `risk=high` 的 amendment 必须提供 authorization descriptor。
- artifact 必须是 goal 目录内的相对路径，拒绝绝对路径、`..` 和 symlink 逃逸。
- artifact 必须存在且为普通文件。
- `artifactSha256` 必须是小写 64 位 SHA-256，并与提交内容完全匹配。
- authorization artifact 声明的 linked artifacts 同样必须保持 goal-relative、存在且 SHA-256 匹配。

Node test 覆盖匹配、内容漂移、文件缺失、路径逃逸、高风险 descriptor 缺失和 linked artifact 漂移；恢复协议记录每次 continuation 前必须运行的 audit 命令，`npm run doctor` 也会对 registry 中所有 Goal 自动执行同一检查。对 legacy 权威等级的专门 audit 信号仍属于后续工作。
