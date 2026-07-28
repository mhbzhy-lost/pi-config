# Bug：Migration Contract 拒绝新增 MCP Skills

## 1. 现象

新增 `dp3-mcp` 与 `crash-mcp` 到 `skill-overrides/skills.local.list` 后，定向测试
`migration exposes exactly the required Skills` 稳定失败。实际集合比期望集合末尾多出这两个 Skill。

## 2. 影响

- `npm test` 无法通过，两个已经能被 whitelist extension 正确加载的 Skill 不能完成仓库验收。
- 若简单放宽精确集合断言，会削弱 migration contract 对意外 Skill 暴露的防护。

## 3. 稳定复现

```bash
node --test --test-name-pattern='migration exposes exactly the required Skills' test/migration-contract.test.mjs
```

结果为 `1 failed`；差异只包含实际集合新增 `dp3-mcp`、`crash-mcp`。

## 4. 证据

- `skill-overrides/skills.local.list` 已按顺序包含 `tmcp`、`dp3-mcp`、`crash-mcp`。
- `loadDesiredSkills()` 返回 22 个 Skill，两个新目录都具有可解析的 `SKILL.md`。
- `test/mcp-skill-cli.test.mjs` 已分别验证两个新 Skill 的白名单行和外部 `tmcp` 依赖。
- `test/migration-contract.test.mjs` 的 `expectedSkills` 仍在 `tmcp` 处结束，仅有 20 项。

## 5. 根因

Migration contract 有意把最终 Skill 暴露顺序保存为显式数组；新增本地 Skill 时只更新了配置源
`skills.local.list`，没有同步这份验收契约。加载器和 extension 行为正确，漂移发生在测试期望值。

## 6. 修复与验证策略

- 在 `expectedSkills` 的 `tmcp` 后按实际白名单顺序增加 `dp3-mcp`、`crash-mcp`，保持精确集合断言。
- 不改 `loadDesiredSkills()`，不放宽为子集判断，也不移除 migration contract。
- 先运行定向 migration 测试，再运行 `mcp-skill-cli`、Skill whitelist focused tests 和全量 `npm test`。
