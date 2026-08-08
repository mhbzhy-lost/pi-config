# Bug：goal_settle 信任子代理自证

## 现象
Planned task 的成功结算只接受调用者的一条 evidence；没有读取 executor workspace 中子代理提交的 YAML，也没有主 Agent 独立复核证据。

## 影响
伪造或漂移的 task、goal、run、attempt、contract、HEAD、hash 或 terminal proof，可能把未覆盖全部 criteria 的结果标为 succeeded。两条路径若复用同一 immutable reference，也不能提供独立验证；发布 artifact 与事件分离时会产生无 authority 的半完成状态。

## 根因
`goal_settle` 将 caller evidence 当作结算 authority，未把 executor binding、受保护 child artifact、main verification、content-addressed combined artifact 与 settled/checkpoint event 作为一个 fail-closed 的原子边界。

## 复现条件
1. Planned succeeded 仍按旧 API 只提交 `evidence`。
2. child YAML 缺失、非 0600、symlink、读取期间被替换，或其 canonical 内容与 receipt 不一致。
3. 子路径或主路径遗漏 criterion，主路径复用 child immutable ref，或 changedFiles 超出已检查 scope。
4. 任何 identity、proof、outcome、hash 或 combined publication/event batch 发生冲突或失败。

## 期望行为
仅 planned.v1 的 succeeded 强制 `subagent_evidence:{sha256,content}` 与 `main_verification` 两条 normalized evidence；均覆盖全部 criteria，且 main 至少一个 immutable ref 与 child 不同。实现读取真实 0600 regular child YAML、逐级拒绝 symlink/identity drift/replacement，绑定 canonical bytes 与 caller content。combined YAML 以 no-replace durable publication 写入 stateRoot，随后原子追加 settled 与 checkpoint；失败不产生 settlement authority。legacy replay 与 failed/blocked 保持旧语义，`goal_accept` ABI 不变。

## 修复方案
复用 settlement-evidence codec 实施最小双路径门禁：扩展 settled reducer 的 planned shape 验证和 evidence 保存；在 store lock 中完成 no-replace content-addressed publication，并仅在 publication 成功后调用 `appendEventBatch`。为所有 Planned succeeded fixture 提供真实 child artifact 和独立 main evidence helper，覆盖 identity、文件系统、防竞态与批写失败的 fail-closed 矩阵。
