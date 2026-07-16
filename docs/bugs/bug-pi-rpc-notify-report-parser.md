# Bug：生命周期 Probe 将 notify 记录二次 stringify 后截取 JSON

## 1. 现象

真实 `spawn` 已执行到 `/lifecycle-probe` 的 `ctx.ui.notify()`，但测试解析报告时抛出 `Unexpected non-whitespace character after JSON`。

## 2. 影响

测试无法读取已经返回的 structured spawn details 和 `asyncDir/status.json`，因此会把证据解析失败误当成 spawn 门禁失败，后续 status/interrupt/stop 验证无法开始。

## 3. 稳定复现

运行 `PI_REAL_BIN="$(command -v pi)" node --test test/pi-subagents-runtime.integration.mjs`。ping 用例通过，spawn 用例在 `test/pi-subagents-runtime.integration.mjs:151` 对 notification 字符串执行 `JSON.parse` 时稳定失败。

## 4. 证据

Pi RPC `notify` 的结构是 `{type:"extension_ui_request", method:"notify", message:string}`，其中 `message` 已经包含 `PREFIX + JSON.stringify(report)`。当前 `findNotification()` 先对整个 record 执行 `JSON.stringify(record)`，调用方再用全局反斜杠替换尝试还原嵌套字符串；切片会连同 record 的尾部字段和右花括号一起交给 `JSON.parse`。

## 5. 根因

解析器没有按 Pi RPC 的 typed notify schema读取 `record.message`，而是把结构化 record 降级成字符串搜索，再尝试手工反转 JSON escaping。这个转换不可逆且边界不明确，导致 prefix 后不仅包含报告 JSON，还包含外层 record 的剩余内容。

## 6. 修复与验证策略

保留当前真实失败作为 RED；把 helper 改为只匹配 `type:"extension_ui_request"`、`method:"notify"` 且 `message.startsWith(prefix)` 的 record，并直接对 `message.slice(prefix.length)` 执行一次 `JSON.parse`。先重跑真实 spawn 用例确认 details 与 status artifact GREEN，再继续下一生命周期项。
