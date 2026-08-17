# 本仓共享 Skill

Git 管理的共享 Skill 唯一来源是 `skill-overrides/<name>/SKILL.md`。所有非隐藏直接子目录中 frontmatter 合法的 `SKILL.md` 会自动发现并同步到 `~/.agents/skills`。

个人 Skill 不由仓库管理，直接放在 `~/.agents/skills`。Pi Extension 仍在 `--no-skills` 下扫描全局与项目 Skill 目录。
