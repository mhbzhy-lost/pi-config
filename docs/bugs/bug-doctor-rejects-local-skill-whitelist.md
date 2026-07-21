# Bug: Doctor 错误拒绝本地 Skill 白名单

## 现象

实际配置加载 10 个全局 Skill 和 `skills.local.list` 中 4 个本地 Skill，但 `npm run doctor` 报错 `unexpected Skill whitelist`。

## 影响

Doctor 无法通过；任何把 `npm run doctor` 作为 deterministic Gate 的 Plan 都无法进入 `validated`，即使实现和其他测试全部正确。

## 根因

`loadDesiredSkills()` 会合并 `skills.list` 与 `skills.local.list`，但 `scripts/doctor.mjs` 的 `EXPECTED_SKILLS` 仍只列出全局 10 项，运行时契约和 Doctor 静态期望不一致。

## 促成因素

1. Doctor 测试 fixture 没有创建 `skills.local.list`。
2. Migration contract 已更新为 14 项，但 Doctor 使用独立的重复常量。
3. 全量单元测试只验证 fixture，不执行真实 `npm run doctor`。

## 修复方向

将 Doctor 期望列表同步为全局 10 项加本地 4 项，并让接受配置的测试 fixture 同时覆盖两个列表。

## 防复发

Doctor 接受测试必须创建与仓库相同的 global/local Skill 分层；发布验证继续显式运行 `npm run doctor`，不能只依赖 `npm test`。
