# Goal 派发标题缺省回退产生多行 title，被 title-registry 以 INVALID_TITLE 拒绝

日期：2026-10-27。状态：已修复（本仓最小双点修复 + 内存复现验证）；真实 Host 全链复跑由冒烟任务续跑。

**归类：合法 public/typed 入口触发的 production bug，归属 Goal 派发标题生成与 enhanced 层 dispatch-ir 缺省回退。** 计划合同里的任务正文是多行文档（这是 `pi/AGENTS.md` 要求的完整信息载体），Goal 派发没有显式提供展示 title，dispatch-ir 用 `task.slice(0,50)` 回退，多行正文必然带换行；title-registry 合同只接受单行、非空、≤256 字节，于是整次派发在 workspace 分配与 RPC ping 之后、child spawn 之前被 `INVALID_TITLE` 拒绝。调用参数没有错误，是数据形状冲突。

## 复现链（真实 smoke 已固定，类别 1）

真实运行证据：session `01a17dfa-58c1-7773-b9a0-36e3b56ac695`、plan `2572e6be-8bf2-4880-8e12-f60378b8fd5e`、workspace `918538e6-19d5-4c5c-9f8a-aed93b6ff542`；任务 A attempt 1 为 `blocked`（run 为 null、保留已分配 workspaceId），任务 B 仍 `pending`，无 child spawn（详见 [smoke 报告](../summaries/2026-10-27-goal-runtime-smoke.md)）。

1. [scheduler.ts](../../src/goal-runtime/scheduler.ts) 的 `prompt()` 生成“固定首行 + 换行 + 格式化 JSON”的多行正文。
2. 同文件 `dispatch()` 调用 `execution.start({ request: {...} })` 时**未提供 title**。
3. [dispatch-ir.ts](../../packages/pi-subagents-enhanced/src/contracts/dispatch-ir.ts) 的 `compileDispatchIR` 在缺 title 时回退 `task.slice(0, 50)`（原第 86 行）；多行正文切片必含 `\n`。
4. 链路继续：`ensureAllocated` 成功 → `onAllocated` 落盘 workspaceId → `rpc.ping` 能力协商成功 → [extension.ts](../../packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts) 的 `titleRegistry.prepare({ ..., title: runtimeIr.title })`。
5. [title-registry.ts](../../packages/pi-subagents-enhanced/src/subagent-dispatch/title-registry.ts) 的 `normalizeSubagentTitle` 以 `CONTROL_OR_LINE_BREAK` 拒绝，抛 `INVALID_TITLE`。
6. Goal 在 `invoked` 之后捕获异常，按“调用后异常”语义记为 unknown → `blocked`，禁止自动重派。这就是现场 A 状态 `blocked`、无 child 的结果。

## 根因（两处）

- **根因 1（Goal 侧，首个偏离点）**：派发请求没有显式 title，把展示标题的生成权交给下游缺省回退。展示字段与多行正文是不同数据形状，Goal 作为唯一知道计划/任务身份的一侧应自行派生标题。
- **根因 2（enhanced 侧，可复用陷阱）**：`compileDispatchIR` 的缺省回退 `task.slice(0, 50)` 直接切片正文，任何调用方省略 title 且 task 多行时都会踩同一个坑；回退值没有做单行化。

`extension.ts` 的 `titleRegistry.prepare` 与 `title-registry.ts` 的校验都是合同权威，行为正确，不改。

## 修复

1. [scheduler.ts](../../src/goal-runtime/scheduler.ts)：`start` 请求显式提供 `title`。新增模块内 `singleLine()`（控制符与换行折叠为空格并压缩空白、trim）与 `truncateBytes()`（按 UTF-8 字节截断且不切断码点），`dispatchTitle()` 生成
   `goal-<plan 短号> <taskId>: <task 首个可读片段>`，长度上界 256 字节；任务正文全为空白/控制符时退回 `goal-<plan 短号> <taskId>`，恒非空。请求对象改为先构造再传入，避免为补 title 改动 `PlanExecutionService` 的公开类型面。
2. [dispatch-ir.ts](../../packages/pi-subagents-enhanced/src/contracts/dispatch-ir.ts)：缺省回退改为 `fallbackTitle(agent, task)` —— 先把 task 单行化（控制符与换行折叠为空格、trim），再按码点截到 50 个，最后按字节兜底到 256 字节；单行化后为空时退到 agent，再退到固定文案 `subagent dispatch`，保证回退标题恒非空。**显式 title 仍走原 `string()` 校验，title-registry 合同未变。**
3. 既有测试无需改断言：仓库内没有任何用例断言旧 `slice(0,50)` 回退文本，也没有用例断言 Goal 派发“无 title”。未新增测试文件。

## 验证

一次性内存复现（不启动真实 Host 与 provider）：用真实 `createGoalRuntime` + 内存 store + 双打 execution，真实 `decodePlanContract`/`readPlanContract` 读取临时 plan 文件，任务正文为三行文本；断言捕获到的 `request.title` 无控制符/换行、≤256 字节，并被真实 `normalizeSubagentTitle` 接受；同时断言旧回退 `task.slice(0, 50)` 仍会抛 `INVALID_TITLE`（证明修复点正是这条陷阱），并用修复后的 `compileDispatchIR`（省略 title）复核回退标题同样是单行且被接受，显式 title 行为不变。

```
派发 title = "goal-2572e6be A: 实现 Goal 派发标题修复 验收：title-registry 不再 INVALID_TITLE 写路径：src/goal-runtime/scheduler.ts"
dispatch-ir 回退 title = "按以下已冻结计划合同执行；不得从父会话历史补充权限。 { \"objective\": \"多行任务标题复现\", \"cons"
REPRO OK：Goal 派发 title 与 dispatch-ir 回退均为单行且通过 title-registry
```

命令与结果：

| 命令 | 结果 |
| --- | --- |
| `npm run typecheck`（root + package） | 通过 |
| `node --test test/subagent-dispatch-ir.test.mjs test/subagent-dispatch-ir-coercion.test.mjs test/subagent-dispatch-writepaths-grammar.test.mjs test/subagent-dispatch-validation-errors.test.mjs test/subagent-generic-prompt-contract.test.mjs test/subagent-generic-prompt-contract-security.test.mjs test/subagent-dispatch-contract-hash-compat.test.mjs` | 24/24 通过 |
| `node --test test/subagent-dispatch-extension.test.ts` | 36/36 通过 |
| `node --test test/subagent-runtime-membrane.test.mjs` | 112/112 通过 |
| `node --test test/subagent-model-selection.integration.mjs` | 23/23 通过 |
| `node --test test/goal-runtime-contract.test.mjs` | 9/9 通过 |
| 一次性内存复现 `node /tmp/goal-title-repro.mjs` | 通过 |

本轮未启动真实 Host/provider，未访问或处置 `var/workspaces`，未改动用户 dirty 文件，未 stage/commit。

## 遗留

1. 真实全链复跑（正向 A→B、child spawn、proof、集成、accepted）由冒烟任务续跑，本报告不以双打结果冒充 child 终局证明。
2. `extension.ts` 的 generic 分支仍用 `normalizeSubagentTitle(input.title ?? input.task.slice(0, 50))` 自行回退，generic 调用方省略 title 且 task 多行时仍会 `INVALID_TITLE`。本轮按授权边界未改 `extension.ts`；建议后续让它复用 `compileDispatchIR` 已单行化的 `ir.title`，与本修复对齐。
3. `PlanExecutionService.start` 的 request 公开类型（[execution/index.ts](../../packages/pi-subagents-enhanced/src/execution/index.ts)）尚未声明 `title` 字段；本轮以结构化传参保持类型通过，建议后续补进该类型定义。
