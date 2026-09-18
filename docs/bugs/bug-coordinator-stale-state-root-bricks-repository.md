# Coordinator metadata 的 stateRoot 不一致会永久 brick repository coordinator

## 1. 症状

在真实 repository（`/Users/leshi.zhy/pi-config`）中，两个既有测试稳定失败：

- `test/pi-subagents-compat.test.mjs:183` “loads exactly one enhanced runtime and footer from a local package source”：
  `assert.equal(process.env.PI_ROOT_SUBAGENT_BROKER_ENABLED, "1")` 得到 `undefined`。
- `test/pi-runtime.integration.mjs:19` “configured enhanced local package registers one authoritative subagent tool owner”：
  `assert.deepEqual(errors, [])` 得到一条 `session_start` extension_error。

两者都不是断言自身逻辑的问题，而是 Host 的 `session_start` 被 fail-closed 中断。

## 2. 稳定复现

```bash
node --test test/pi-subagents-compat.test.mjs
node --test test/pi-runtime.integration.mjs   # 第一个用例不依赖 PI_REAL_BIN
```

## 3. 首个偏离点

`packages/pi-subagents-enhanced/src/workspace/coordinator-registry.ts:70`，`claim()` 抛
`Error: Coordinator state root scope mismatch`。调用链：

`extension.ts:beforeSessionStart` → `subagent-runtime.ts:314 beforeUpstreamSessionStart` →
`subagent-runtime.ts:50 connectRuntimeCoordinator` → `coordinator-registry.ts claim()`。

`subagent-runtime.ts` 只在 coordinator 连接成功后才设置 `PI_ROOT_SUBAGENT_BROKER_ENABLED = "1"`，
所以 claim 抛错时该 marker 保持未设置，compat 测试的断言随之失败；runtime 集成测试则观察到
`session_start` 的 extension_error。

## 4. 根因

`.git/.pi-coordinator/coordinator.json` 记录的是**当前 repository 唯一 coordinator** 的
`canonicalStateRoot`（现场为 `/Users/leshi.zhy/pi-config/var/workspaces`，由存活 Host 持有）。
上述两个测试在同一 repository（`cwd = repoRoot`）启动 Host，但把 `PI_CODING_WORKSPACE_DIR`
指向独立临时目录，因此 canonical stateRoot 必然不同。

修复前的判定顺序是“**先比较 stateRoot，后判断 owner 存活**”：

```ts
if (recorded !== canonicalStateRoot()) throw new Error("Coordinator state root scope mismatch");
let alive = ...; if (alive) return existing; await unlink(metadataPath);
```

于是 stale takeover 分支永远走不到。用 scratch registry 验证（不改现场 metadata）：

| 记录的 owner | 记录的 stateRoot | claim 结果 |
| --- | --- | --- |
| 存活（pid/birthIdentity 匹配） | 不同 | `Coordinator state root scope mismatch` |
| **已死亡（pid=1、birthIdentity 伪造）** | 不同 | `Coordinator state root scope mismatch` |

即：只要 metadata 存在且 stateRoot 不同，**即使记录的 coordinator 早已死亡**也会拒绝。
后果是 production 可达的可用性缺陷：一次以不同 `PI_CODING_WORKSPACE_DIR` 启动的 Host 留下的
metadata，会让后续所有 Host 的 `session_start` 永久 fail-closed，直到人工删除
`.git/.pi-coordinator/coordinator.json`。这与既有 GREEN 用例
`test/managed-workspace-coordinator.integration.mjs` “registry rejects malformed metadata and
supports stale takeover” 所要求的“stale metadata 必须可回收”相矛盾。

存活场景下的拒绝是**正确且必须保留**的：endpoint 由 repository hash 唯一派生
（`/tmp/pi-workspace-coordinator-<uid>/<repoHash32>.sock`），两个存活 coordinator 无法共享同一
endpoint，不同 stateRoot 就是真实 split brain。既有 GREEN 用例
“coordinator registry uses one endpoint per common dir and canonical state root” 已固定该契约。

## 5. 为什么既有测试能捕获

`test/pi-subagents-compat.test.mjs` 与 `test/pi-runtime.integration.mjs` 都用**隔离的临时
`PI_CODING_WORKSPACE_DIR`** 在真实 repository 启动 Host，并断言 `session_start` 完整完成
（marker 被设置 / `errors` 为空）。这正是 production 条件：Host 必须能在“repository 记录的
coordinator 属于另一个已死亡 state root”时正常启动。它们不需要新断言就能暴露该偏离点。

## 6. 修复边界（收紧版 takeover）

只有满足全部条件时才允许替换记录的 coordinator：

1. 记录的 owner 已确认死亡：`captureProcessBirthIdentity(existing.pid)` 抛错，或返回值与
   `existing.birthIdentity` 不匹配；
2. `repositoryId` 一致；
3. 不使用 wall-clock TTL，也不以“socket 文件缺失”作为接管依据。

存活 owner + 不同 canonical stateRoot 仍然严格抛 `Coordinator state root scope mismatch`；
存活 owner + 相同 canonical stateRoot 仍然直接返回既有 metadata。

替换必须：

- 通过既有 `temp + rename` 原子写入，endpoint 复用同一 repository endpoint，保证 endpoint owner
  与记录的 canonical state root 不会分裂；
- 把被放弃的 canonical state root 追加进 metadata 的 `supersededStateRoots`，由
  `auditManagedWorkspaces` 继续产出 `state-root-split-brain` / `migration-debt`；
  不得静默抹除历史，也不得放宽 proof/audit settlement。

## 7. RED / GREEN

RED（实现前观察）：

```bash
node --test --test-name-pattern="confirmed dead coordinator owner" \
  test/managed-workspace-coordinator.integration.mjs
# ✖ ... Error: Coordinator state root scope mismatch
#   at Object.claim (coordinator-registry.ts:70)
```

新增用例：`test/managed-workspace-coordinator.integration.mjs`
“a confirmed dead coordinator owner is replaced for a new canonical state root while its
abandoned root stays audit debt”，同时断言存活 owner 的拒绝行为不变。
