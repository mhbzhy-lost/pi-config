# 三个核心 Skill 仍耦合 Superpowers 源

## 一句话描述

三个核心 Skill 仍从 `vendor/superpowers` 加载，且项目行为规则同时散落在 `pi/AGENTS.md`，导致运行时依赖和规则归属未解耦。

## 复现流程

1. 读取 `~/.agents/skills/test-driven-development`、`~/.agents/skills/writing-skills` 和 `~/.agents/skills/writing-plans` 软链，确认其目标来源。
2. 对三个名称调用 `resolveSkillSource()`，确认当前解析结果仍在 `vendor/superpowers/skills/`。
3. 检查 `.gitmodules` 和 `vendor/superpowers`，确认子模块元数据及 gitlink 仍存在。
4. 读取 `pi/AGENTS.md`，确认其中仍有 `## TDD` 和 `## Skill 行为 Override`。

## 修复方案

1. 将 `test-driven-development`、`writing-skills` 和 `writing-plans` 完整本地化到 `skill-overrides/`，并保留原白名单名称。
2. 将 TDD、Skill 编写和计划行为规则迁入各自 Skill；`pi/AGENTS.md` 仅保留全局 Bugfix、Subagent、Worktree 与输出安全规则。
3. 将 Skill 解析根收窄为 `skill-overrides/`，删除 Superpowers 子模块及其运行时回退。
4. 保留历史 `docs/superpowers/` 作为归档，不将其纳入运行时依赖判定。

## RED 证据

实际命令：

```bash
node --test test/core-skills-local.test.mjs
```

实际结果：退出码 `1`，5 个测试均为预期 RED（`pass 0`、`fail 5`）。

- `TDD local skill`：缺少 `skill-overrides/test-driven-development/SKILL.md`。
- `writing-skills local skill`：缺少 `skill-overrides/writing-skills/SKILL.md`。
- `writing-plans local skill`：缺少 `skill-overrides/writing-plans/SKILL.md`。
- `AGENTS keeps only global rules`：现有 `pi/AGENTS.md` 仍匹配 `## TDD`（并仍有待迁移的 Override）。
- `repository has no Superpowers runtime dependency`：`.gitmodules`、`vendor/superpowers` 仍存在，且三个白名单 Skill 均解析至 `vendor/superpowers/skills/` 而非 `skill-overrides/`。

失败均对应尚未完成的迁移产物或现存旧配置；测试已成功加载，没有语法或导入错误。
