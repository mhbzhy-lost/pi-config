# async run 运行态读取缺陷（R8）

## 现场与首个偏离点

`var/upgrade/trace/t11b1-steer/run-r7g/events.jsonl` 显示 17:17:46.597 与
46.699 连续产生两个 `subagent:async-started`，第二个 runId
`ca01d66e-b7aa-45a6-a709-8462423e1f68` 的 pid 为 31442；子进程直到
18:14:14.474 才产生 `subagent:process-terminal`。然而 46.735 起 steer
控制面在约 140ms 内返回 `SUPERVISOR_STEER_NOT_ALLOWED`，诊断中的
`running:false, steerable:false` 与存活进程矛盾。

首个偏离点在 `extensions/subagent-runtime.ts` 的 `readRuntime`：它只读取
RPC `status` 顶层/details 的 `state` 与 `steerable` 字段。0.71 针对 async
run 的 status 将权威状态放在 `asyncSnapshot.runs[].state`，因此读取器把真实
running run 当成非运行态。R8 最小修复改为消费该原始状态投影，并以 running
状态表达 steerable 能力，不修改事件 payload 或 TUI 数据。

## TDD 证据

回归测试先以 `runtimeFromStatus` 的期望契约建立，随后在实现前运行并因导出符号
不存在失败（RED）；实现后 focused test 通过（GREEN）。

## 残余

三场景探针与全量验收结果写入 `var/upgrade/r8-report.md`；0.71 retained
resume 的原生限制不得由本地 runtime 读取器掩盖。
