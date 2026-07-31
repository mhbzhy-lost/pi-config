# Pi-subagents 兼容测试继承全局 Skill allowlist

## 1. 现象

`test/pi-subagents-compat.test.mjs` 的 real `DefaultResourceLoader` 测试在绑定 extensions 时加载仓库全局 `pi/extensions/skill-whitelist.ts`，并因 allowlist 中的 `crash-analyzer-usage` 缺少可解析 `SKILL.md` 而产生 `resources_discover` extension error。

## 2. 影响

目标测试本应验证 installed Supervisor runtime 被项目工具封装，却被用户当前 Skill 配置决定成败。累计 Plan 门禁出现 `290/291`，无法证明兼容层本身是否正确。

## 3. 时间线

- `c03b047` 真实 A2 已观察到同一全局 Skill 污染，并修复 flat Harness agentDir。
- 最终累计测试单独运行 `pi-subagents-compat.test.mjs`。
- real loader 再次加载 ambient `pi/` 资源并产生结构化 extension error。

## 4. 根因

兼容测试创建 `DefaultResourceLoader` 时使用仓库全局 coding-agent 目录，而测试只需要显式加载被测 subagent runtime extension。fixture 没有隔离与断言目标无关的 settings、Skills 和 extensions。

## 5. 触发条件

用户或仓库全局 `settings.json` 的 Skill allowlist 引用当前不可解析 Skill，且兼容测试调用 real resource discovery 时必现。

## 6. 修复与验证

测试创建并清理自有临时空 agentDir，继续显式加载被测 extension 与 installed runtime，不修改用户 settings、不复制全局 Skills。重跑 `test/pi-subagents-compat.test.mjs` 必须全部通过，且测试仍断言被测 ExtensionRunner 没有 error。
