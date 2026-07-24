# Bug: Doctor 错误拒绝本地 Skill 白名单

## 现象

实际配置加载 10 个全局 Skill 和 `skills.local.list` 中的本地 Skill，但新增第 5 个合法本地 Skill 后，`npm run doctor` 再次报错 `unexpected Skill whitelist`。

此前修复只把 Doctor 的硬编码期望从全局 10 项同步成“全局 10 项 + 当时本地 4 项”，因此任何后续本地扩展都会复发。

## 影响

Doctor 无法通过；任何把 `npm run doctor` 作为 deterministic Gate 的 Plan 都无法进入 `validated`，即使实现和其他测试全部正确。

## 根因

`loadDesiredSkills()` 会合并 `skills.list` 与 `skills.local.list`，但 `scripts/doctor.mjs` 的 `EXPECTED_SKILLS` 同时硬编码了全局项和本机项。本地清单本应是可扩展配置，Doctor 却把某一时刻的合并结果当成静态契约，形成第二个事实来源。

## 促成因素

1. Doctor 测试 fixture 没有创建 `skills.local.list`。
2. Migration contract 已更新为 14 项，但 Doctor 使用独立的重复常量。
3. 全量单元测试只验证 fixture，不执行真实 `npm run doctor`。

## 修复方向

Doctor 只固定校验受版本控制的 `skills.list` 全局清单；`skills.local.list` 由 `loadDesiredSkills()` 按实际内容解析和校验，不限制本地 Skill 的名称或数量。

## 防复发

Doctor 测试必须证明：全局清单漂移仍会失败，而新增合法、可解析的本地 Skill 不会产生 `unexpected Skill whitelist`。发布验证继续显式运行 `npm run doctor`，不能只依赖 `npm test`。
