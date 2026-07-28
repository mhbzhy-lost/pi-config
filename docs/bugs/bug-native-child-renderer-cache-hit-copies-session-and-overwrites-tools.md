# Bug：Native renderer cache hit 仍复制全文件且完成工具可被后续错误覆盖

## 1. 现象

安全快照修复后，`render()` 每次都先调用 `checkPath()`；该函数在 cache key 判断前创建临时目录并复制完整 session。即使 rendered cache 命中，仍完成一次最多 64 MiB 的全量复制后才删除 snapshot。

同时，toolResult 更新对应 `ToolExecutionComponent` 后没有从 `pendingTools` 删除。后续任一 assistant 以 aborted/error 结束时，会遍历整个 Map，把此前已经成功的工具覆盖为 interrupted。

## 2. 影响

500ms footer poll 和重复 TUI render 会持续复制不断增长的 child session，100 次 cache-hit <100ms 的性能目标失去意义，并产生额外 I/O。Conversation 中“成功工具 → 后续失败工具”的常见序列会把历史成功结果错误标成失败。

## 3. 稳定复现

- Cache：对 fingerprint 不变的 session 连续 render 两次，第二次仍进入 `mkdtemp/open snapshot/readSync/writeSync`，只是 `openSession` 次数保持 1。
- Tool：assistant A toolCall 收到成功 toolResult；assistant B 含另一个 toolCall 并以 aborted 结束。A 的 component 仍留在 pending Map，因此也收到 interrupted error result。

当前新增测试没有统计 cache-hit snapshot copy，也没有构造跨 assistant 的成功/aborted tool 序列。

## 4. 证据

`render()` 在计算 key 和读取 `this.rendered.get(key)` 前调用 `checkPath()`；`checkPath()` 无条件创建 `native-child-session-*` 并复制 `stat.size` 字节。Cached branch 只负责事后删除 snapshot。

`case "toolResult"` 仅调用 `pendingTools.get(...).updateResult(item)`，未 `delete`。aborted/error 分支随后遍历并覆盖 Map 中所有 entries。

另外，原修复 dispatch 明确要求 real flushed-session partial tail、custom text 与 aborted/error 测试；当前测试仍保留旧 partial fixture，未断言 custom text，也没有 aborted/error test。

## 5. 根因

文件身份验证、fingerprint 获取和 snapshot 物化被合并成一个步骤，导致 cache lookup 无法在复制前发生。Tool reconstruction 则复制了 Pi main 的 error-finalization 分支，却遗漏 main 在 tool execution end 后清除 pending 状态的生命周期。

## 6. 修复与验证策略

先增加 RED 测试：cache hit 和同 fingerprint 的新 render variant不得创建 snapshot；成功 toolResult 必须从 pending 集合移除，后续 aborted 只终结真正 pending tool；完整 flushed session 加 partial tail 必须保留完整消息；custom fallback 文本必须出现。实现应把“open+fstat+trusted-root+fingerprint”与“从已打开 fd 创建 snapshot”拆开，仅在 parsed-session cache miss/fingerprint 变化时复制，并在 toolResult 后 delete。保留 fd 到 cache 决策完成后再关闭，所有错误路径可靠清理。
