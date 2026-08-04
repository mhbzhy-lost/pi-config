# Bug: Skill frontmatter 行内注释绕过 scalar 校验

## 现象

allowlisted `SKILL.md` 的 `description: true # comment`、`false # comment` 与 `null # comment` 会通过本地白名单校验，但真实 Pi `loadSkillsFromDir` 加载零个 Skill。`description: "" # comment` 与 `description: '' # comment` 也会被本地错误接受，而 Pi 同样加载零个 Skill 并报告 description required。

## 影响

白名单 extension 会向 Pi 提供实际不可加载的目录；配置错误未在本地提前失败，导致本地 validator 与 Pi loader 的结果不一致。

## 根因

本地 validator 的 scalar 校验已通过 lexer 使用 canonical value，但最终 emptiness 检查仍使用 raw value；`'' # comment` 和 `"" # comment` 因而不等于 raw `''`/`""`，绕过空值拒绝。此前直接对 raw value 做 scalar 正则判断也会让非字符串 scalar 加注释后避开 boolean/null 拒绝分支。

## 促成因素

1. 既有 scalar 差分矩阵未覆盖空 quoted scalar 后接行内注释。
2. emptiness 与 scalar validation 没有统一使用同一个 comment-aware canonical scalar。

## 修复方向

实现无依赖的单行 scalar 子集 lexer：仅将引号外、由空白引入的 `#` 视为注释，令 emptiness 与 scalar validation 共同使用注释前的 canonical scalar；plain scalar 拒绝 YAML structural `: `。保持 quoted 与 plain 注释描述可用，并对本地不支持或 Pi 拒绝的复杂 scalar fail-closed，错误为 `unsupported string scalar`。

## 防复发

以真实 Pi loader 为 oracle 建立 differential matrix：锁定 `true # comment`、`false # comment`、`null # comment`、`"" # comment`、`'' # comment` 与 `true: false` 为双方拒绝；锁定 `"true" # comment`、`plain fixture # comment`、`yes # comment` 为双方接受且 Pi 返回 string description；同时覆盖 YAML single quote doubling 与安全 double-quote escape。
