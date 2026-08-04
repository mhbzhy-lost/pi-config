# Bug: Skill frontmatter scalar 与 Pi loader 不一致

## 现象

allowlisted `SKILL.md` 的 `description: true`、`123`、`~`、`.nan` 等 YAML 隐式非字符串 scalar 会通过本地白名单校验，但真实 Pi `loadSkillsFromDir` 加载零个 Skill。

## 影响

白名单 extension 会向 Pi 提供实际不可加载的目录；Doctor 不会报告具体的 frontmatter 错误，因而对该错误 fail-open。

## 根因

本地 validator 仅排除少数 literal，未限制 description 为真实 Pi loader 可接受的非空字符串 scalar。

## 促成因素

1. 单元测试只覆盖 `null`、数组和对象。
2. 差分测试只覆盖当前 production Skill，未覆盖 YAML 隐式 scalar 边界。

## 修复方向

采用明确的单行字符串 scalar 子集：允许非空 quoted scalar 及以 Unicode letter 开头的 plain description；拒绝 null、boolean、number、日期、非有限数和 block scalar。以真实 Pi loader 的差分测试作为 oracle，Doctor 捕获错误并继续检查。

## 防复发

为非法与 quoted 合法 scalar 建立 Pi differential matrix，并验证 Doctor 对 boolean/number description 输出具体 frontmatter issue 后仍继续其他检查。
