# session-owner 并发 guard 替换被误判为 registry invalid

## 现象

主仓 Pi `1.0.2` 合回后的全量 Node 26 回归中，现有测试 `test/session-owner-wrapper.test.mjs` 的合法并发场景失败：

```text
registry prepare failed: Error: registry guard is invalid
cause: Error: registry guard changed while opening
code: REGISTRY_UNAVAILABLE
```

同一临时、caller-owned `0700` registry root 由四个独立 Node 进程并发执行 `prepareLaunch → releaseOwnRecord`，父进程同时执行 `listLiveRecords`。该入口是 session-owner wrapper 的实际跨进程并发路径，不是手工拼接非法记录。

## 数据来源与首个偏离点

- 权威入口：`src/session-owner/registry.ts` 的 `prepareLaunch`、`releaseOwnRecord`、`listLiveRecords`。
- 资源事实：所有调用使用同一临时私有 registry root；guard 由 `publishExclusivePrivate` 完整写入临时文件并以 hard-link 原子发布，竞争进程可以合法地释放并替换 `.guard`。
- 调用链：`prepareLaunch → withGuardAsync → acquireGuard → privateJson`；或 `listLiveRecords → withGuard → acquireGuard → privateJson`。
- 首个偏离点：`privateJson` 在对 `.guard` 做初次 `lstat` 后，另一个合法 owner 完成释放/替换，随后 `open`/`fstat` 发现 inode 不同，抛出 `registry guard changed while opening`；`acquireGuard` 只对 `ENOENT` 重试，随后把该短暂替换当成永久 `registry guard is invalid`。
- 这不是损坏 JSON、权限错误、symlink、非 caller-owned 文件或 stale guard；这些情况必须继续 fail closed。

## 分类

**分类 1：预期 production 数据未被正确处理。** 合法的多个 launcher/reader 进程可共享 session-owner registry；并发替换 guard 是原子发布协议的正常竞争窗口。production 当前未正确处理该窗口。

## RED 证据

- 全量回归：`/tmp/pi-102-subagents075.ye2_0hoh/evidence/main-post-merge-full-26.8.1-v3.log`。
- 测试：`test/session-owner-wrapper.test.mjs:78`，断言并发 create/read/release 不应暴露部分 guard，也不应产生错误。
- 失败不是测试错误：错误明确来自 registry 的并发 inode 变化，且测试只通过公开 registry API 操作真实临时文件。

## 最小修复边界

只在 `acquireGuard` 的 guard 读取阶段，对精确的 `registry guard changed while opening` 在既有 guard deadline 内重新竞争；不重试 malformed JSON、权限/owner/type/symlink 失败，也不删除未知 guard。修复后保留并重跑既有并发测试及全量回归。

## 独立复核后的安全分支收紧

复核发现原`privateJson`把opened type/owner失败与dev/ino变化共用错误文本；以该文本重试会扩大安全失败语义。来源为本轮最小修复，不涉及不可信production数据兼容。确定性测试通过既有`ownershipUid`接点控制真实guard的lstat/open窗口，opened owner变foreign并移走guard时，修复前错误放行（Missing expected rejection）。现将opened regular-file/mode/owner验证先独立拒绝，只有dev/ino变化产生可重试错误，仍不删除未知guard。证据：`evidence/guard-opened-owner-red.log`。
