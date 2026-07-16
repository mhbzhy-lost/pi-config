# Bug：Nested safety fixture 将最大深度误解为剩余派生层数

## 1. 现象

`compat-plan` 的 active status 显示 `currentTool:"contact_supervisor"`，原因是 nested `subagent` 被 depth limit 阻断；测试 profile 配置了 `maxSubagentDepth: 1`，预期却是一层 nested worker 成功。

## 2. 影响

Plan child 无法完成计划要求的一层安全 fanout，Task 1 会错误判定 nested runtime 不兼容。当前 sentinel 还会把 active tools 写成 undefined，并混用 ordinary/nested artifact，无法证明三层权限边界。

## 3. 稳定复现

运行 nested integration：top-level Plan child 已处于 depth 1，调用 `subagent` 时得到 max-depth guidance并保持 waiting 状态。检查 fixture 可见 `maxSubagentDepth:1`；sentinel 对 `pi.getActiveTools()` 的字符串数组执行 `.map(tool => tool.name)`；同一 compat-worker 同时加载 ordinary 和 nested sentinel。

## 4. 证据

上游 `checkSubagentDepth()` 使用 `blocked = depth >= maxDepth`，默认最大深度为 2；top-level child 的 `PI_SUBAGENT_DEPTH` 为 1，因此允许一个 sub-subagent需要 max 2。Pi 文档明确 `getActiveTools()` 返回 `string[]`。agent frontmatter 的 max 只能收紧 inherited limit，不能把 1解释为“再允许一层”。

## 5. 根因

测试把绝对 depth cap 当成剩余额度，并再次误读 Pi active-tools API；同时用一个 profile承载普通与 nested 两种观测角色，导致 artifact 来源不唯一。三个错误共同使 depth 和 capability 断言都不可信。

## 6. 修复与验证策略

把 Plan profile 设为 `maxSubagentDepth:2`，表示 main(0) → Plan(1) → worker(2)，worker 在 cap 处不能再派生。sentinel 直接排序 `pi.getActiveTools()` 字符串。创建独立 `compat-ordinary` profile写 ordinary artifact，`compat-worker` 只写 nested artifact，Plan 只写 plan artifact。真实运行后分别断言 ordinary 无 subagent、Plan 有 child-safe subagent、nested worker 无 subagent，并从 status/events/session取得 nested lifecycle 证据。
