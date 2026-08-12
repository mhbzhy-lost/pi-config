# Bug: parser 在 update 模式中错误识别带前导空格的 header

- **日期**: 2026-08-11
- **状态**: 修复中

## 一句话描述

`parsePatch` 在 update hunk 内将 ` *** Update File: b.txt`（前导空格 = context 行）误判为新文件 header，导致一个 update hunk 被拆成两个独立 hunk。

## 复现流程

```js
parsePatch(
  "*** Begin Patch\n*** Update File: a.txt\n@@\n-old a\n+new a\n *** Update File: b.txt\n@@\n-old b\n+new b\n*** End Patch"
)
// 期望 hunks.length === 1（单个 update，2 个 chunks）
// 实际 hunks.length === 2（被拆成两个 update hunk）
```

## 根因

Codex 原始实现（`streaming_parser.rs`）在 update 模式下用 `line.trim_end()`（仅去尾部空白）匹配 header，保留前导空格使 ` *** Update File:` 不匹配 `*** Update File: ` 前缀，从而正确落入 context 行分支。

移植时所有模式统一使用了 `line.trim()`（去首尾空白），导致 update 模式中带前导空格的行被错误识别为 header。

## 修复方案

在 update 模式下，header 匹配改用 `raw.trimEnd()` 而非 `raw.trim()`，与 Codex 行为一致。其他模式（started/add/delete）仍用 `trim()`。

## 对应测试

`test/apply-patch-parser.test.mjs` — "indented update marker is context line not header"
