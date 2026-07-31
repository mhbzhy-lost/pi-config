# Bug：recovery tool promotion 授权 fanout-child

## 1. 现象

HEAD `152cfd4` 为让 revived Plan Runner 获得完整能力，在可信的
`recovery-descriptor.json` 中写入完整 `PLAN_ACTIVE_TOOLS`。task63z 的真实 flat Harness 显示这会使单次
revival 失败：初代 descriptor 已含完整工具，随后唯一的 revived Plan Runner `2315b41b` 在加载项目
Plan Runner entry 时退出，精确冲突为：

```text
Tool "subagent" conflicts with /Users/leshi.zhy/pi-config/pi/npm/node_modules/pi-subagents/src/extension/fanout-child.ts
```

Harness 命令为 `PLAN_HARNESS_PRESERVE=1 PI_REAL_BIN=/opt/homebrew/bin/pi node --test
test/plan-flat-runtime-harness.integration.mjs`，退出码为 1，TAP 为 1 fail。初代仅实际调用一次
`plan_open`；revived generation 在扩展初始化失败前没有加载工具或发出 tool call，故
`plan_continue=0`、`subagent=0`，Executor runs 为 0，Plan 未到 `validated`、`blocked` 或
`cancelled`。这不是 revival storm：记录恰有 initial 与一次 revival 两代，且 task63z 已清理 root，三个
PID death probe 均为 `ESRCH`。

## 2. 触发条件与证据

task63z 持久化的 initial descriptor 的 `tools` 已是完整 `PLAN_ACTIVE_TOOLS`：
`plan_open, plan_status, plan_continue, plan_verify, plan_block, plan_read_revision, plan_amend, subagent,
plan_executor_supervisor, read, grep`。private resume 后，revived descriptor 仍保持逐字段相同的完整工具
ceiling，证明 `152cfd4` 的 promotion 已持久化，但不能证明 revived capability 可用。

flat runtime 的两个运行目录均为 async root 直属顶层目录，缺少 `nested-subagent-runs`；`isNested: true`
只是 status 原始字段，不能改变该运行拓扑。broker 链包含一次 `revival.started`、`resume.invoked`、
`resume.succeeded`、`grant.issued` 与 `revival.succeeded`。因此失败点可定位为 revived launch 的扩展装载，
而不是 wake、resume transport、进程回收或重复复活。

## 3. 根因

pinned `pi/npm/node_modules/pi-subagents/src/runs/shared/pi-args.ts` 的
`resolvePiLaunchToolPlan()` 直接以 `declaredBuiltinTools.includes("subagent")` 计算
`fanoutAuthorized=true`。当 descriptor 明确含 `subagent` 时，它既是 explicit tools allowlist，也会令
`runtimeExtensions` 强制加入 `fanout-child.ts`；该分支没有关闭 fanout 的独立开关。

`152cfd4` 的 `pi/extensions/subagent-runtime.ts` 在 trusted recovery preparation 中将 descriptor 的
`tools` 覆盖为 `PLAN_ACTIVE_TOOLS`，其中正好含 `subagent`。这把 Capsule 在运行后管理 active tools 的
需求，错误提升为 pinned launch plan 的 fanout 授权。pinned launch 随即装载 upstream
`fanout-child.ts`，而项目的 Plan Runner entry 也自行注册项目 `subagent`，所以同名工具冲突并阻止启动。

## 4. 为什么完整工具提升错误

项目使用 flat runtime，明确禁止 `fanout-child`；Plan Runner entry 注册的项目 `subagent` 是项目 dispatch
与授权边界的一部分。让 pinned runtime 因 launch descriptor 中的 `subagent` 再注册 fanout-child，会产生
同名工具的加载冲突，并把本应是 flat、root-owned 的 dispatch 置入 nested fanout 环境，违反既定拓扑。

launch capability ceiling 与模型可见的 active list 是不同边界。初代 frontmatter/pre-open bootstrap 仍必须是
`plan_open,read,grep`，不能为回收问题扩大。Capsule 已在 `before_agent_start` 基于 durable Plan 调用
`setActiveTools(PLAN_ACTIVE_TOOLS)`；因此首轮及 revived 首轮模型仍应只由 Capsule 的精确项目工具集合管理，
无需在 descriptor 中声明完整工具来建立 bootstrap launch ceiling。

## 5. 正确修复与 TDD

trusted prepare 对 revived descriptor 必须删除 `tools` 自有字段，而不是写入空数组。字段不存在时，pinned
`resolvePiLaunchToolPlan()` 得到 `explicitToolAllowlist=false`、`fanoutAuthorized=false`，其
`runtimeExtensions` 不含 `fanout-child`，也不会建立 bootstrap launch ceiling。其余 descriptor 字段及
`systemPromptMode` 等 mode 必须原样保留。revived generation 此后生成的新 descriptor 也必须继续没有
`tools`。

TDD 应先固定成功 descriptor：prepare 后 `Object.hasOwn(descriptor, "tools")` 为 false，其他允许字段和
mode 保留。独立调用 pinned `resolvePiLaunchToolPlan()` 并断言
`fanoutAuthorized === false`、`runtimeExtensions` 不含 `fanout-child`。既有 security tests 必须不变，继续
验证可信路径、regular file、identity 与 fail-closed 条件；不得通过放宽这些校验实现修复。

## 6. 修复边界、验证与提交

不得修改 `node_modules`，不得加载或劫持 fanout，不得改工具名，也不得放宽 Capsule active list。仅 revival
descriptor 移除 `tools`；初代 frontmatter/pre-open bootstrap 保持不变。该策略遵循已定决策：revival launch
不设 explicit tools ceiling，模型 active tools 仍由 Capsule 精确管理。

本任务为 docs-only 豁免，未新增产品测试或运行 Harness；RED 证据来自 task63z 已保存的真实单次 revival
结果。未来最小 GREEN 应通过上述 focused descriptor 与 pinned launch-plan TDD，再重跑 flat Harness，确认
无 `fanout-child`、无工具冲突、`plan_continue` 与 Executor 可前进。提交必须只包含本文件，信息为
`docs(bug): 记录 recovery promotion 加载 fanout`；提交后确认 changed-files、空白检查和 index 均符合要求。
