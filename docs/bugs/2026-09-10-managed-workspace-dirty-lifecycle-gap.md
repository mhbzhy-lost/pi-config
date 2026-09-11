# 问题：managed workspace 的 dirty 生命周期没有可释放闭环

## 现象

workspace 的未提交变更会阻止 destructive disposition；调用 preserve 后，`release()` 仍尝试直接移除 dirty worktree。Git 拒绝移除时，service 将 lease 置为 `cleanup-debt`，因此普通 dirty result 没有 durable publication 后再释放的路径。该缺口只能由新的 v2 lease 修复：活跃 v1 lease 的 replay、mutate、completion 与 disposition 语义冻结，绝不能将其转换成 publish/apply 对象。

## Provenance

- 实际入口：standalone generic/coding workspace 均经 `extension.ts` 的 `standaloneWorkspaceRequest()`、`ensureAllocated()`、`bindRun()` 进入 `src/workspace/service.ts`。
- 权威身份：managed workspace ledger 中的 lease owner、root session、tool call 与 Git worktree registration 是权威资源身份；调用方状态文本或 completion 不是释放授权。
- 事件或资源顺序：v1 reserve -> allocate -> active -> bind run -> workspace 产生未提交文件 -> terminal proof/状态检查发现 `workspace-dirty` -> preserve -> `release()` -> `releaseManagedGitWorkspace()` 的 Git remove -> Git 拒绝 dirty worktree -> `cleanup-debt`。未来 v2 必须为 public policy codec -> v2 allocation -> official observed terminal proof -> owned status -> issue action token -> publish -> release；source dirty 只在 apply 时阻断。
- 首个偏离点：`workspace/contract.ts` 目前没有 public v2 request/policy codec，因而没有合法的 publishable lease。v2 codec 到位后，下一偏离点才是 service 缺少由 official observed proof、status 和 action token 门控的 `publishOwned()`；`releaseForLease()` 对 v1 preserved state 的现有冻结语义不因 v2 修复而改变。
- 数据来源分类：**production**。这是公共 workspace service 对正常 filesystem/Git 状态的实际调用链；未使用手写 ledger、伪造 event 或 fixture-only 身份。

## 影响

source dirty 应允许 **v2** allocation/publish，而 workspace dirty 不得静默丢弃。当前只能按 v1 preserve 后留下 cleanup debt，无法把 v2 结果先固化再安全释放。

## RED 证据

`test/managed-workspace-lifecycle-contract.test.mjs` 首先要求 public `createManagedWorkspaceRequestV2()` 接受独立 policy，并验证 base commit identity 可为 40 或 64 位；当前首个 RED 为 `public v2 request/policy codec must exist before publish/apply is available`。该测试独立验证 v1 receipt 没有 policy/publication/application，仍只允许冻结 disposition。T5 的 v2 codec GREEN 后，后续 RED 才要求 v2 通过 official observed terminal proof、owned status 与 issue action token 调用 `publishOwned()`，而非直接调用无授权 service method；dirty origin 下的 `applyOwned()` 仍不得应用。
