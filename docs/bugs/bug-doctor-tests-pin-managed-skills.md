# Doctor 测试固定 Managed Skill fixture 与空断言

## 问题

`test/doctor.test.mjs` 的“配置成功”fixture 曾复制固定的 10 个 Skill 名称；生产 Doctor 已改由 `discoverManagedSkills(repoRoot)` 自动发现，这让测试重新成为名称事实来源并可能与实际目录漂移。

同文件的 additional managed Skill 用例还保留 global/local 分类，虽然计算了 `issues`，却没有任何断言。因此新增有效 Skill 未被自动发现、出现旧 whitelist 报错、frontmatter 解析失败，或未创建同步链接，都可能让测试虚假通过。

## RED 摘要

先将测试改为：

1. 从当前仓库的 `discoverManagedSkills(repoRoot)` 取得成功 fixture 的 Skill 名称，并用最小合法 frontmatter 创建 fixture；
2. additional managed Skill 用例断言没有 unexpected whitelist 或 managed Skill 解析错误，且该新增 Skill 被报告为未同步链接；
3. 通过可注入的临时全局 Skill 目录隔离 `~/.agents/skills`，使链接断言可重复。

在 Doctor 尚未支持 `globalSkillsDir` 注入时，定向测试应 RED：报告的是默认 `~/.agents/skills` 路径，而不是 fixture 注入的临时目录。修复后默认生产路径仍是 `~/.agents/skills`。
