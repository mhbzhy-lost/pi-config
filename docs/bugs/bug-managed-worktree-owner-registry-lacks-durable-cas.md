# Bug：Managed worktree 缺少 durable owner registry 与 CAS

## 1. 现象

当前只读 inventory 会读取 `.state/worktree-lifecycle/leases/*.json`，但仓库没有生产级 registry writer，也没有受控的 create、release、preserve API。调用方只能先执行 `git worktree add`，再自行拼写不完整 manifest；并发 owner、写入中断或旧 receipt 都没有统一拒绝规则。

## 2. 影响

Git worktree 可能在 durable allocation intent 之前出现，崩溃后成为无主资源；同一 id 的并发分配可能互相覆盖。PID 复用、旧 owner token、path/branch/common-dir 漂移还可能让过期调用方释放 replacement owner 的 worktree。若 remove 或 released 写入只完成一半，系统会产生 phantom released，或遗失仍需保留的 cleanup debt。

## 3. 复现步骤

1. 在真实临时 Git 仓中让两个进程同时为同一 id 建立 allocation。
2. 在 intent write、`git worktree add`、identity reinspection、activate write、`git worktree remove` 或 released write 边界注入失败。
3. 用第一次分配的 owner token 重试或操作 replacement manifest。
4. 观察现有代码没有可调用接口来证明唯一 owner、幂等恢复或安全拒绝，也不能稳定记录 partial resource 状态。

## 4. 根因

现有 lifecycle Task 1 仅实现只读事实分类。它把 manifest 当输入，却没有定义 manifest exact schema、同目录原子替换、writer lock receipt、PID birth identity、owner token CAS 和合法状态转换。Git mutation 与 manifest mutation 因而不在同一个可恢复协议内。

## 5. 为什么此前未发现

既有测试覆盖 inventory 的 clean、dirty、sequencer、missing、active 和 unmanaged 分类，但没有真实并发 writer，也没有逐个 crash 边界的“未执行 / 已执行后抛错”矩阵。单进程 happy path 无法暴露 PID 复用、stale receipt 或 remove 后发布失败。

## 6. 修复方向

实现冻结的六个 registry/managed API。任何 Git 副作用前先以 mode `0600`、同目录 temporary file + rename 持久化 `allocating` manifest；每次 mutation 校验 canonical origin、Git common-dir、path、branch、前置 state、owner token 与 PID birth identity。Create 按 intent→add→identity→active；release 仅允许 owner 授权、clean、无 sequencer的 reclaimable worktree，以不带 `--force` 的 worktree-only remove 回收并保留 branch。每个 crash 边界都必须可幂等重试；无法证明时保留资源并写 `cleanup-debt`，绝不发布 phantom `released`。
