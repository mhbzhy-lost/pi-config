# Audit queue 扫描被单个 repository 分区的缺失目录中断

## 1. 症状

`test/subagent-worktree-lifecycle.integration.mjs` 的用例
“aliased state root keeps queue, records, and coordinator in one canonical bucket without audit debt”
**间歇性**失败：

```
AssertionError [ERR_ASSERTION]: the queue must be visible in the canonical ledger bucket
  0 !== 1        (test/subagent-worktree-lifecycle.integration.mjs:323)
```

同一命令重复运行时有时 PASS、有时 FAIL（实测 1 失败 / 1 通过）。同一现场里 queue item 文件确实存在：
`<canonicalStateRoot>/repositories/<repositoryId>/integration-queue/<uuid>.json`。

## 2. 稳定复现

```bash
node --test --test-name-pattern="aliased state root keeps queue" \
  test/subagent-worktree-lifecycle.integration.mjs
```

因为触发条件取决于目录枚举顺序，需要重复运行才能观察到失败。

## 3. 首个偏离点

`packages/pi-subagents-enhanced/src/workspace/administration.ts` 中 `auditManagedWorkspaces`
的 queue 扫描：

```ts
const repositoriesRoot = path.join(inventory.stateRoot, "repositories");
try {
  for (const repositoryId of readdirSync(repositoriesRoot)) {
    const queueRoot = path.join(repositoriesRoot, repositoryId, "integration-queue");
    for (const name of readdirSync(queueRoot).filter(...)) { ... }
  }
} catch {}
```

`try/catch` 包住**整个循环**。任何一个 repository 分区没有 `integration-queue` 目录时，
`readdirSync(queueRoot)` 抛 ENOENT，异常直接跳出整个循环并被空 `catch {}` 吞掉：

- 已经收集到的 queue item 被丢弃；
- 排序在其后的 repository 分区完全不扫描。

## 4. 根因

合法现场里 `repositories/` 下**同时存在两个 repository 分区**（实测 probe 每次运行都出现两个）：

| 分区 | 用途 | 是否含 `integration-queue` |
| --- | --- | --- |
| `hash(git-common-dir)` | integration queue / proof outbox（`createIntegrationQueue({ repositoryId })`） | 是 |
| `hash(originRoot)`（storageRepositoryId） | workspace ledger 记录 | 否 |

因此 ENOENT 必然发生，`audit.queue.items` 的结果完全取决于 `readdirSync` 返回顺序：

- 含 queue 的分区排在前面 → 先收集到 1 条，之后 ENOENT 中断 → `items.length === 1`（PASS）；
- 不含 queue 的分区排在前面 → 立即 ENOENT 中断 → `items.length === 0`（FAIL）。

这是 production 可达的审计正确性缺陷：doctor 与 T9 acceptance 都依赖
`auditManagedWorkspaces` 的 queue 视图，缺失的 queue item 会让“queue 已 completed”这一
事实从审计中消失，同时空 `catch {}` 也吞掉了真实 I/O 错误。

## 5. 为什么既有测试能捕获

该用例用 `/var` 别名 state root 走完 allocate → enqueue → admission → rebase → publish →
terminal proof，然后断言 `audit.queue.items.length === 1` 且 `audit.debts` 为空 —— 这正是
“queue 必须出现在 canonical ledger 分区里”的合法 public contract。它不需要新断言就能暴露
该偏离点，只是因为依赖目录枚举顺序而表现为间歇失败。

## 6. 修复边界

只把失败隔离到**单个 repository 分区**：某个分区没有 `integration-queue` 目录时跳过该分区，
继续扫描其余分区。`repositories/` 根目录缺失仍按既有语义容忍。不得放宽 queue schema 判定，
不得吞掉 item 级别的真实解析错误，不得自动清理。

## 7. RED / GREEN

RED（实现前观察）：`test/subagent-worktree-lifecycle.integration.mjs`
“audit keeps every repository queue partition visible when another partition has no queue directory”
构造两个分区（无 queue 的分区目录名排序在前），断言 `audit.queue.items.length === 1`，
实现前得到 0。
