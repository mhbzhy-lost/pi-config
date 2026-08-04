# Bug: Skill frontmatter 行内注释绕过 scalar 校验

## 现象

allowlisted `SKILL.md` 的 `description: true # comment`、`false # comment` 与 `null # comment` 会通过本地白名单校验，但真实 Pi `loadSkillsFromDir` 加载零个 Skill。

## 影响

白名单 extension 会向 Pi 提供实际不可加载的目录；配置错误未在本地提前失败，导致本地 validator 与 Pi loader 的结果不一致。

## 根因

本地 validator 直接对包含 YAML 行内注释的 raw value 做 scalar 正则判断，未先按 YAML 单行规则识别引号外、由空白引入的 `#` 注释；因此非字符串 scalar 加注释后避开了 boolean/null 拒绝分支。

## 促成因素

1. 既有 scalar 差分矩阵未覆盖 boolean/null 后接行内注释。
2. validator 没有一个受限的单行 scalar lexer，无法区分 quoted `#` 与实际注释。

## 修复方向

实现无依赖的单行 scalar 子集 lexer：仅将引号外、由空白引入的 `#` 视为注释，先验证注释前 scalar；plain scalar 拒绝 YAML structural `: `。保持 quoted 与 plain 注释描述可用，并对本地不支持或 Pi 拒绝的复杂 scalar fail-closed，错误为 `unsupported string scalar`。

## 防复发

以真实 Pi loader 为 oracle 建立 differential matrix：锁定 `true # comment`、`false # comment`、`null # comment`、`true: false` 为双方拒绝；锁定 `"true" # comment`、`plain fixture # comment`、`yes # comment` 为双方接受且 Pi 返回 string description；同时覆盖 YAML single quote doubling 与安全 double-quote escape。
