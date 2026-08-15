# Worktree CLI 的 owner token 传递不安全

## 问题描述

`release` 与 `preserve` 允许把 owner token 放在命令行参数中，token 会暴露给进程列表、shell 历史和诊断记录；同时 create JSON 有意脱敏，调用方无法安全复用该值。

## 复现流程

1. 执行 `worktree-lifecycle.mjs release --owner-token <token>`。
2. token 出现在 argv，且 create/adopt JSON 不含 token，导致后续 CLI 调用不能建立安全能力通道。

## 修复方案

所有需要 owner capability 的 CLI 操作统一只读取 `--owner-token-stdin` 标志后的标准输入；旧 argv token 在 parser 和 shell policy 中拒绝。JSON receipt 始终不输出 token，fixture 测试仅在进程内读取私有 manifest 后通过 stdin 传递。
