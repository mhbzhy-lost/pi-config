# Bug：Skill 清单成为第二事实来源

## 问题

`skill-overrides/skills.list` 与 `skills.local.list` 要求在新增或删除 Skill 时额外维护名称；目录中的 `SKILL.md` 已经是实际源，两个清单会漂移并漏同步。

## 复现

在 `skill-overrides/<name>/SKILL.md` 新增一个 frontmatter 合法的直接子目录，但不编辑清单。旧同步与 Doctor 不会将它视为受管 Skill。

## 修复

受管集合改为枚举 `skill-overrides` 的非隐藏直接子目录。每个条目须通过 realpath 边界、目录名与 frontmatter `name` 一致性及非空 `description` 校验；任一候选非法时拒绝整个发现集。个人 Skill 直接位于 `~/.agents/skills`，不由仓库清单管理。
