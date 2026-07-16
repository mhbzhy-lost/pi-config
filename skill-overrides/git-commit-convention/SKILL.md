---
name: git-commit-convention
description: Use when writing a git commit message, creating a commit, amending a commit message, or drafting a PR title. Also use when the Pi security-gates Extension rejects a commit message.
---

# Git Commit Convention

## Format

```
type(scope): 中文祈使句
```

`scope` 可选。

## Type Whitelist

英文小写，仅以下值：

`feat` `fix` `refactor` `perf` `test` `docs` `style` `chore` `build` `ci` `revert`

## Subject Rules

- 必须包含至少一个中文字符
- 不超过 50 字
- 不以句号（`。` / `.`）结尾
- 祈使句动词开头（增加 / 修复 / 重构），不用过去时（已修复 / 实现了 / 修复了）
- 禁止零信息词单独作为 subject（fix / update / bugfix / wip / 修改 / 更新）
- 描述做了什么，why 写到 body

## AI Signature

**Prohibited.** Commit message 任何位置不得出现：

- `Co-Authored-By: Claude/Copilot/Cursor` (or any AI tool name)
- `Generated with Claude`
- `AI-assisted`
- 任何等效的 AI 辅助标识

改动描述中提及 AI 工具文件名（如 `claude-config`）不受此限制。

## Body Guidelines

- body 解释 why 而非 what（diff 已说明 what）
- 一次 commit 对应一个逻辑变更，不合并无关改动
- 修复 + 测试可放一个 commit；重构 + 修复必须拆开
- PR 标题遵循 subject 规则

## Example

```
feat(plugins): 增加 commit message 门禁

Pi security-gates Extension 校验 bash 工具中的 git commit message。

Ref: #2847
```

## Mechanical Validation

Pi `security-gates` Extension 会自动校验 type 白名单、中文字符、句号结尾、过去时、零信息 subject、AI 署名等可机械判定的规则。校验失败时 Extension 会拦截 commit 并返回错误码。

本 skill 覆盖的是 Extension 无法机械校验的主观约束（body 质量、commit 拆分、PR 标题）。
