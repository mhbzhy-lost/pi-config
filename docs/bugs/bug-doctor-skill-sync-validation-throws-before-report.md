# Bug: Doctor 在 Skill 同步校验失败时提前抛错

## 症状
切换到 `~/.agents/skills` 自动发现和 `sync-skills.mjs` 后，Doctor 调用 `loadDesiredSkills()` 遇到缺失 Skill 或非法 frontmatter 会直接抛出，无法返回完整 issues，也不会继续检查 Pi package、Root Broker 和 Goal Engine ABI。

## 影响
一个 Skill 配置错误会遮蔽其余环境诊断，CLI 只显示顶层异常；测试夹具和真实机器都无法一次获得完整修复清单，破坏 Doctor 既有的只读、汇总式健康检查契约。

## 复现
在 `skills.list` 中声明一个 frontmatter 缺失或 `description` 类型非法的 Skill，调用 `inspectConfiguration()`。函数在 `loadDesiredSkills(repoRoot, listPath, null)` 处拒绝，而不是把错误加入 issues 后继续执行。

## 根因
自动发现迁移把原先带 `try/catch` 的 `loadDesiredSkills()` 调用替换成直接 `await`。删除 `skills.local.list` 参数是预期变更，但同时误删了 Doctor 的错误聚合边界。

## 修复
继续传入 `null` 禁用旧 local list，同时恢复局部 `try/catch`：解析成功时检查全局 symlink，失败时把错误消息加入 issues，并继续后续 Doctor 检查。

## 验证
复用已有两个 RED：非法 allowlisted Skill frontmatter 和布尔 description 均应出现在 issues，且同一次检查仍报告缺失 package。补充运行 Doctor、Skill 自动发现、Goal Engine exact-seven 与全仓回归。
