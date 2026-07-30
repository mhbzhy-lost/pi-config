# Bug：Root broker 正常关闭后保留授权状态

## 症状

Root broker 在已成功发放 caller 与 executor grant 后正常关闭，grant 文件会删除，但内存中的 callers、principals、runOwners、subscriptions、grantPaths、executorGrants 与 callerGrants 仍保留条目。

## 影响

已关闭 Root session 的授权身份仍可被同一进程持有，资源释放状态与实际授权边界不一致；清理 grant 失败时尤其难以判断 broker 是否已彻底失效。

## 复现

运行 `node --test test/root-subagent-broker.test.mjs` 中新增的正常关闭用例：先 grant caller、再 spawn executor、调用 `closeRootSession()`，断言 grant 文件不存在且所有 Root-owned 集合为空。现有实现会在集合断言处失败。

## 根因

`closeRootSession()` 只等待 pending grant、关闭 socket、删除文件和调用 upstream dispose；它没有将已完成授权、ownership、subscription 与 grant 记录纳入统一终结清理路径。

## 修复

在 close 的统一 `finally` 中清空所有 Root-owned 授权、ownership、subscription、socket、grant 与 pending 集合。保留原有清理异常，同时保证 upstream dispose 后内存状态已经释放。

## 验证

运行 Root broker 聚焦测试，覆盖正常关闭、grant 删除失败时仍 dispose 和集合清空，以及重复 close 只执行一次 dispose。
