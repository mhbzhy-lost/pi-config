# Root cleanup runtime fixture 缺少 persisted session API

## 1. 现象

在 HEAD `f651330` 上，Root cleanup 的 standalone root suite 共 131 项，其中 130 项通过、1 项失败。失败的是 `test/root-subagent-broker.test.mjs` 第 1083 行定义的单项；其在第 1118 行触发真实 `pi/extensions/subagent-runtime.ts` 后报错：`TypeError: sessionManager.getSessionFile is not a function`。

栈固定为 `pi-subagents/src/shared/session-identity.ts:7` -> `pi/extensions/subagent-runtime.ts:135` -> 测试第 1118 行。该失败使 full suite 的基线不能完成，并不表示 queued-push 实现回归。

## 2. 证据

HEAD `f651330` 的 queued-push focused 测试为 25/25 GREEN，related 测试为 35/35 GREEN。standalone root suite 的结果稳定为 130/131；第 1083 行目标单项为精确的现有 RED，错误和栈如上所述。

因果隔离还使用 `HEAD^` 的 server 内容运行同一检查，结果仍为 130/131 且具有同一栈。因此失败不由 queued-push 的实现造成。父级在独立运行该单项时也复现相同 RED，排除由完整 suite 顺序或当前调用环境单独引入的假象。

## 3. 根因

测试声称加载真实 `pi/extensions/subagent-runtime.ts`，但给 `sessionManager` 的部分 mock 只提供 `getSessionId`。pinned 的真实 `SessionIdentityManager` 合同同时包含 `getSessionFile` 和 `getSessionId`；`resolveCurrentSessionId` 会先读取 persisted session file。

因此，fixture 没有满足其所加载真实 runtime 的完整身份 API 合同。将 partial mock 传入真实依赖链，违反了 complete real fixture 规则，并在进入目标 cleanup 行为之前抛出 TypeError。

## 4. 正确修复

正确修复只改 `test/root-subagent-broker.test.mjs` 的该处 fixture：为 `sessionManager` 增加 `getSessionFile: () => '/sessions/runtime-root-cleanup.jsonl'`，或提供同等稳定的 absolute persisted identity；既有 `getSessionId` 保持为 logical Root socket identity。

不得改变 production 的 identity 回退顺序，也不得让 runtime 绕过 persisted identity。真实 runtime 应继续优先解析 persisted session identity，测试必须补全其承诺使用的真实 API。

## 5. TDD/验证

本项适用 TDD 豁免：现有目标测试已经是精确且可独立复现的 true RED，新增测试只会重复相同覆盖。先保留本文记录的 RED 证据；随后的一行 fixture 修复应使该单项变为 1/1 GREEN、standalone root suite 自然变为 131/131，再运行 Root upstream/startup 相关检查。

queued-push 的 focused 25/25 与 related 35/35 GREEN 是独立证据，不能把当前 fixture TypeError 归因于其实现。验证时还须保持 `HEAD^` server 内容下相同 130/131、同栈的 baseline 隔离结论。

## 6. 影响边界

影响边界仅为 `test/root-subagent-broker.test.mjs` 中加载真实 Root cleanup runtime 的一处 `sessionManager` fixture。此文档不授权修改 server、runtime、pinned `node_modules` 或其他测试、Harness、migration 文件。

该缺口阻塞的是 full suite 基线，而非 queued-push 的已验证行为。修复应是单一 fixture API 补全；logical Root socket identity 与 persisted session identity 的职责边界必须保持不变。
