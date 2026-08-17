# Playwright 浏览器策略分散在全局 AGENTS

## 一句话描述
Playwright 的浏览器模式与登录态交接规则同时维护在 `pi/AGENTS.md` 和领域 Skill 中，且 Skill 未完整表达策略，容易造成 headed 模式被不当使用。

## 复现流程
1. 阅读 `skill-overrides/playwright/SKILL.md`，可见默认 headless 和手动登录时可省略 `--headless`，但没有完整规定用户明确要求 headed、登录态交接后回到 headless、已有登录态或无需用户干预时禁止 headed。
2. 阅读 `pi/AGENTS.md`，可见 `## Playwright 浏览器操作` 段重复承载这些规则。
3. 运行 `node --test test/playwright-skill-policy.test.mjs`；测试失败，首个断言表明 Skill 不含“默认 headless”的中文策略表述，且后续断言还将检查未承载的 headed 例外、登录态交接、禁止条件及仍存在的 AGENTS 段。

## 修复方案
1. 为本地 Playwright Skill 增加覆盖默认模式、headed 例外、登录态安全交接及禁止条件的测试。
2. 将完整策略集中到 Playwright Skill，登录态交接遵循 `browser-auth-session`，且不得输出 cookie 或 token。
3. 删除 `pi/AGENTS.md` 的 Playwright 专属段，保留其他全局规则。

## RED 记录
新增测试实际执行后以退出码 1 失败（1 个测试失败、0 个通过）。失败来自 Playwright Skill 缺少完整策略，非测试语法错误；此时 `pi/AGENTS.md` 仍含 `## Playwright 浏览器操作` 段。
