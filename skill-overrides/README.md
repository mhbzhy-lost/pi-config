# 本仓 Skill 覆盖

仅当 Pi 需要不同于固定 vendor 版本的行为时，才在这里放置完整的
`<name>/SKILL.md` 目录。

源优先级：

1. `skill-overrides/<name>/SKILL.md`
2. `vendor/superpowers/skills/<name>/SKILL.md`

只有 `agents/skills.list` 中列出的名称会由白名单 Extension 注入 Pi。
