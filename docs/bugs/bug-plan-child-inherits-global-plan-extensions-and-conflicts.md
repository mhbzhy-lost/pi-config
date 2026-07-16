# Plan Child 继承全局 Plan Extensions 导致工具冲突

## 现象

`pi-subagents` custom agent 默认继承全局 extensions，再追加 `subagentOnlyExtensions`。Plan child 因而同时加载全局 `plan-capsule.ts`、`plan-runner.ts` 和专属入口，多个 Extension 注册同名 `plan_open` 后启动失败。

## 影响范围

真实 Plan Runner 无法启动；普通 executor/spark 也会继承不属于它们的 Plan tools，破坏权限边界。

## 复现步骤

使用真实 Pi 启动 plan-runner，async status 报 `Tool "plan_open" conflicts`。将 profile 的 `extensions` 显式设为空列表语义后，只加载 `subagentOnlyExtensions`，冲突消失。

## 根因

profile 测试只检查 `subagentOnlyExtensions` 文本，没有验证社区 runtime 对缺省 `extensions` 的继承语义；曾误把该字段当布尔值，实际它是逗号分隔路径列表。

## 修复方案

Plan Runner 与普通 worker profiles 均写 `extensions: ""`，让 `pi-subagents` 生成 `--no-extensions`；Plan Runner 再仅追加专属 `plan-runner.ts`。需要的安全能力由明确 child-safe入口提供，不继承 Parent Launcher/Capsule。

## 验证方式

profile contract 断言显式空 extensions；真实 E2E child无工具冲突、Plan Runner仅见Plan tools、executor无Plan/subagent工具。
