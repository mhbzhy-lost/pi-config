# Bug: amendment runtime 装配删除 plan_open append 并缺失恢复门禁

## 症状
Task 6 dependencies 装配把 return 中的 `appendPlanEvent` 替换掉，真实 Capsule `plan_open` 无法追加 `plan.created`。supersede recovery 没有 dependencies 测试，pointer repair 失败会中止 cleanup，superseded checkpoint 一律 preserve，status/continue 也未先恢复。后续草案虽恢复 surface，却在 50ms cancel timer 无请求时重复 repair pointer，并让 workspace inspection 失败阻断安全 preserve。

## 影响
新 Plan 无法启动；crash 后旧 hash Attempt 可能继续运行或错误保留 clean never-started worktree；pointer cache I/O 可阻断权威 cleanup。Capsule tool schema 注册通过但真实 deps 端到端不可用。

## 复现
用真实 `createPlanRunnerDependencies()` 展开到 Capsule 后调用 plan_open，得到 append capability unavailable。构造 supersede-requested + writeCurrent rejection，backend cleanup 未调用；构造 superseded never-started clean，恢复 disposition 被硬编码为 preserve。

## 根因
高风险装配只新增了局部 helper/Capsule registration，没有先建立 dependencies 端到端 RED；修改 return surface 时覆盖了既有能力，恢复逻辑也没有复用统一 disposition/阶段函数。

## 修复
恢复 appendPlanEvent；注入 inspect workspace；抽取幂等 release 阶段供即时/recovery 共用；pointer 只在 stale/missing 时修复，错误收集后继续；cancel 先读请求、有请求才跑 recovery；inspection 不能确认 clean 时安全 preserve；status/continue/verify 前运行恢复栅栏；为真实 deps+Capsule 写三阶段、错误聚合、no-spawn、session、pointer 和 tool schema 测试。

## 验证
真实 deps Capsule plan_open 成功追加 plan.created；pointer/proof/release 各阶段 crash replay 收敛；clean never-started cleanup、dirty/terminal preserve；多 Attempt 继续并 AggregateError；关联 runtime migration/Host/Capsule tests 通过。
