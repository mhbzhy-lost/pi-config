# subagent-dispatch Skill 首发 contract 非法根因

## 用户症状

主 agent 的两次 coding 派发都在 child 启动前被本地预检拒绝。delegate 原样复制旧 Skill 的 coding 示例时，`acceptance.commands` 触发 criteria-only schema 的 `INVALID_CONTRACT`；还将不存在的 `src/example.ts`、`test/example.test.mjs` 写入 `context.relevantFiles`，并把未核实陈述写成 `knownFacts`。

## 影响边界

影响使用 `executor` 或 `spark` 的首次 typed coding 派发：错误在编译 `dispatch-ir.v1` 时发生，child 不会启动。generic `delegate` passthrough 和 managed worktree 生命周期规则不是本缺陷的修改对象，必须继续保持。

## 执行链路

主 agent 读取 Skill 示例并填写 `subagent({...})`，本地调用 `compileCodingDispatchIR`。编译器严格检查对象形状、枚举、数组、路径、workflow 和 acceptance，成功后才渲染并启动 child。因此示例中的字段和事实会直接影响首发结果。

## 根因

旧示例沿用了过时 contract：`acceptance` 含 `commands`，而当前 schema 只接受 `criteria`。示例还使用绝对 `execution.cwd`，容易诱导把绝对路径放入只允许仓库相对 POSIX 路径的 `context.relevantFiles` 或 `boundaries.writePaths`。

另一个已观察到的预检失败是 `INVALID_PATH`：`relevantFiles` 不接受绝对路径。workflow 也被误填：`mode: "tdd"` 时禁止 `reason`；只有 `existing-tests` 和 `docs-only` 必填 `reason`。旧 guidance 没有要求先核实 cwd、路径和事实，导致不存在的示例路径和猜测被伪装成 known facts。

## 修复策略

用真实编译器测试从 Skill fenced coding example 提取的对象。将示例收敛为可编译的 criteria-only contract，并以正向 recipe 要求先核实 cwd、相关路径和事实，再依当前工具 schema 一次性填满 required slots；不确定信息不得写成 knownFacts、placeholder 或猜测字段。加入调用前机械检查：精确顶层/嵌套 shape、相对路径、workflow reason 条件、枚举、非空必填数组、正整数 timeout、criteria-only 与无额外字段。

## 回归保护

`test/subagent-dispatch-skill.test.mjs` 提取 fenced coding example 并调用 `compileCodingDispatchIR`，同时断言上述首发前核验 guidance；`test/subagent-dispatch-ir.test.mjs` 继续覆盖 schema 对 commands、路径和 workflow 的拒绝。聚焦测试与 `git diff --check` 是交付门槛。
