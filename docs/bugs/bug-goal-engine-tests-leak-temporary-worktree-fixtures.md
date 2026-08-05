# Bug：Goal Engine 测试泄漏临时 Git 仓库与 worktree fixture

## 1. 现象

系统临时目录中累计存在 52,613 个 `ge-ws-*` 与 `ge-ext-*` 目录，合计约 6.46 GiB。其中 27,250 个来自 workspace 测试 fixture，25,363 个来自 Extension 测试 fixture；当前测试进程结束后目录仍保留。

## 2. 影响

反复运行 Goal Engine 回归会持续占用 inode 与磁盘空间，降低目录扫描、备份和系统临时目录维护效率。测试本身可能继续通过，因此泄漏会在磁盘压力或系统清理前长期隐藏。

## 3. 复现步骤

1. 记录系统临时目录中 `ge-ws-*`、`ge-ext-*` 的数量和容量。
2. 运行 `node --test test/goal-engine-workspace.test.mjs test/goal-engine-extension.test.mjs`。
3. 测试结束后重新统计同名目录。
4. 观察数量增加，且新建临时 origin、state root 与 linked worktree 没有被测试 teardown 删除。

## 4. 根因

`test/goal-engine-workspace.test.mjs` 的 `initRepo()`、`tmpStateRoot()` 以及 `test/goal-engine-extension.test.mjs` 的 `tmpCwd()` 使用 `mkdtempSync()` 创建 fixture，但没有统一登记到 `node:test` 的 `after`/`t.after` 清理器。个别测试只清理自己要模拟的部分资源，并不负责整个 fixture 根目录生命周期。

## 5. 为什么此前未发现

测试断言集中在事件、Git identity 和资源状态，没有把“测试进程结束后临时目录基数不增长”纳入验收。fixture 位于操作系统临时目录，不会污染主仓 `git status`；开发期间多次完整回归逐步放大了累积量。

## 6. 修复方向

提供统一的 test fixture arena：每次 `mkdtemp` 都登记根目录，文件级 `after()` 在成功、失败和异常用例后递归释放。需要保留中间资源的测试只在用例期间保留，不跨测试进程。新增泄漏回归，证明 suite 结束后受管前缀没有新增目录；历史临时目录另用只读 inventory 加显式确认批量回收。
