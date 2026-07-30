# Bug: Task5C RED 的 prompt 断言冲突且 replay fixture 缺 inspector

## 症状

Task5C 测试一方面要求 Plan Runner prompt 包含 “no pending dispatch”，另一方面沿用旧断言完全禁止单词 `pending`，两者不可同时满足。V3 intent replay 测试使用 fake allocator 返回不存在的 workspace，却未注入 fake inspector；第二次 `continuePlan()` 因真实 `inspectAttemptWorkspace` 正确 fail closed。

## 影响

若按测试直接修改 production，只能删掉必要 prompt 语义，或放宽 Coordinator 的 pending lease 权威检查。前者让模型无法知道何时禁止调用，后者会允许伪造/失效 workspace 重放 durable dispatch。

## 复现

1. Prompt 同时匹配 `/no pending dispatch/` 和 `doesNotMatch(/\bpending\b/)`，逻辑矛盾。
2. 第一次 V3 prepare 使用 `/attempts/...` fake lease 成功提交 intent。
3. 第二次 replay 调用 production inspector，路径不存在并失败；失败发生在 fixture，不是 intent replay 逻辑。

## 根因

测试迁移只更新了目标结果，未同步缩窄 Standalone 阶段的旧 prompt 禁词，也把 allocator mock 与真实 inspector 混用，破坏了 workspace authority 测试边界。

## 修复

Prompt 测试只禁止旧的 Supervisor pending/timeout/wait-loop 指令，允许业务短语 “no pending dispatch”。V3 replay fixture 注入记录调用的 inspector，返回 `{ headCommit: candidate.baseCommit, clean: true }`，并断言 replay 恰好检查一次；不修改 Coordinator。

## 验证

校准后 Task5C production diff下 prompt测试通过；V3 second continue得到同一 exact dispatches、event数不变、spawn为零且 inspector调用一次。旧 production仍在首个result state断言RED，真实 child boundary注入仍RED。
