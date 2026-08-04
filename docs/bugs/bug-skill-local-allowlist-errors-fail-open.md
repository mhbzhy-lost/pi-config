# Bug：本地 Skill 白名单错误被静默放行

## 症状

`skills.local.list` 不存在时本应可选；但文件存在且包含非法名称、重复项，或读取目标为目录而触发 `EISDIR` 时，`loadDesiredSkills()` 会吞掉错误并继续只加载全局白名单。

## 影响

本地配置错误不会阻止 extension discovery，也不会进入 Doctor 的 issues；操作者会误以为本地 Skill 已生效，实际安全/配置边界被静默改变。

## 复现

在 fixture 的 `skill-overrides/skills.local.list` 写入 `Bad_Name` 或重复名称，或将该路径建为目录；调用 `loadDesiredSkills()` 仍返回全局 Skill。`resources_discover` 同样继续返回路径，Doctor 没有具体错误。

## 根因

本地 list 的 `readFile()` 与 `parseSkillList()` 被无条件 `catch {}` 包裹，未区分可选文件缺失的 `ENOENT` 和其他读取、语法错误。

## 修复

仅在读取错误的 `code === "ENOENT"` 时忽略本地 list；其余错误原样传播。Doctor 已捕获 `loadDesiredSkills()` 错误并继续其他检查，因此会把具体错误加入 issues。

## 验证

先以 tests-only 覆盖缺失文件合法忽略、非法/重复/`EISDIR` fail-closed、extension 拒绝和 Doctor 报错后继续检查，确认旧实现 RED；最小实现后运行 Skill whitelist、extension、Doctor、migration 测试及 Doctor CLI。
