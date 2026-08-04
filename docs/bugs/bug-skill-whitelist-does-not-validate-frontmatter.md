# Bug: Skill 白名单未验证 frontmatter 发现契约

## 现象

allowlisted `SKILL.md` 只要可读且路径位于允许根目录，白名单就会返回目录给 Pi discovery；缺少 frontmatter、名称与 allowlist 不符或 description 无效时，错误会延后到真实 Pi loader，Doctor 还可能直接中断。

## 影响

启动 discovery 不能 fail-closed，且 `npm run doctor` 无法为损坏的 allowlisted Skill 提供可操作诊断。

## 根因

`resolveSkillSource()` 仅做可读性和 realpath 边界检查，没有在返回 source path 前读取并校验 `SKILL.md` 的最小 frontmatter 契约。Doctor 未捕获该 discovery 错误。

## 促成因素

1. 测试 fixture 使用无 frontmatter 的 `# test` 内容。
2. 固定路径断言没有调用真实 Pi Skill loader。

## 修复方向

在 realpath 安全检查后验证严格的最小 frontmatter 子集：开头边界、唯一 `name`/`description`、名称与 allowlist 相同、description 非空；不引入 YAML 依赖。白名单和 extension 对错误 fail-closed，Doctor 将错误加入 issue 并继续检查。

## 防复发

单元测试覆盖缺失、名称不符、空或缺失 description、重复字段；production-shaped 测试经 `resources_discover` 和 Pi `loadSkillsFromDir` 验证 using-goal-engine 可发现。
