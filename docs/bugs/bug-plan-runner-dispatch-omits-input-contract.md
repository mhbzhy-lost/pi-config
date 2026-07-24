# Bug: Plan Runner Dispatch Skill 未声明输入契约

## 现象

Agent 在用户选择 Plan Runner Dispatch 后正确加载了 skill 并调用 `plan_run`，但计划缺少 `pi-plan.v1` Execution Contract。工具返回解析错误后，Agent 连续猜测 JSON key、嵌套结构和放置位置，三次重试均失败。

## 影响

Plan Runner 无法进入 launcher 阶段；计划文件被写入无效 JSON，且用户只能在多次失败后得知存在隐藏格式要求。所有旧版 Superpowers 计划都可能复现。

## 根因

`plan-runner-dispatch/SKILL.md` 只描述启动工具和生命周期约束，没有说明 `parsePlanDocument()` 要求的精确 Execution Contract、Task/Deps/Files 语法，也没有提供调用前 preflight 方法。

## 促成因素

1. `plan_run` 错误只说明缺少 Contract，不返回合法模板。
2. writing-plans 输出格式与 Plan Runner 严格格式不是同一契约。
3. 多依赖 parser 存在第二项被解析为 `task-Task N` 的已知问题。
4. Skill 没有明确规定解析失败后禁止猜格式。

## 修复方向

在 dispatch skill 中前置声明唯一合法模板、Task 语法、无依赖省略规则、非空 Files 要求和当前多依赖限制；要求调用前使用仓库 parser 做 preflight，失败时读取 parser 错误并修正文档，禁止试错式调用。

## 防复发

自动化测试断言 skill 包含 schemaVersion、verification、requiredGates、四个 Gate、严格 Task 格式、preflight 命令和“禁止猜测”规则。以本次真实失败会话作为 writing-skills RED 场景。
