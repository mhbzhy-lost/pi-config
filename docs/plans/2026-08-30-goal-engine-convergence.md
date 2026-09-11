# Goal Engine 收敛实施计划

**目标：** 在不扩展 Goal Engine 语义的前提下，完成一次可复现、可分类、可终止的收敛验收；只修有 production provenance 的 Critical/Important 问题，其余问题固定为已知限制。

**架构：** 本计划把当前 Goal Engine 视为冻结系统，使用独立 Pi Host、全新临时 Git 仓库和独立 state root 做实测。测试失败先做 provenance 分类，再决定是最小生产修复、测试/fixture 修复，还是记录限制；不使用 Goal Engine 编排本计划。

**技术栈：** Node.js ESM、Pi 0.84.3、`node:test`、managed worktree/validation lifecycle、append-only JSONL、临时 Git repo。

## 全局约束

- R0–R13 收敛任务不得由 Goal Engine 自己执行、编排或验收。
- 不新增 generation、event type、projection field、lifecycle state 或自动 continuation 语义。
- 生产逻辑缺陷遵循 bug-first、TDD；测试制造数据只修测试/fixture/harness。
- 禁止 raw Git worktree mutation、宽泛 staging、stash、reset、restore、rebase、amend 和 force cleanup。
- 不读取或输出凭据、`pi/auth.json`、cookie、token 或完整环境秘密。
- 无法证明 production provenance 时 fail closed，不增加预防性兼容逻辑。
- 终止条件：连续两轮 fresh Host 验收通过；无未分类 Critical/Important；资源、worktree、process、workspace、cleanup debt 归零或有明确人工处置记录；所有剩余问题已写入 summary 的已知限制。

## DAG

```text
T0 基线与冻结清单 ──┬──> T1 集成挂起 provenance
                    ├──> T2 fresh Host 实测矩阵
                    └──> T3 worktree/资源债务审计
T1 ────────────────> T4 最小生产修复（仅有证据时）
T2 ────────────────> T4
T3 ────────────────> T5 只读收口报告
T4 ────────────────> T5
T5 ────────────────> T6 第二轮回归与终止判定
```

## Waves

- Wave 1：T0
- Wave 2：T1、T2、T3（可并行）
- Wave 3：T4（仅当 T1/T2 证明 production 缺陷）
- Wave 4：T5
- Wave 5：T6

**关键路径：** T0 → T1/T2 → T4（如有）→ T5 → T6。

## 任务定义

### T0：基线与冻结清单

**Deps：** none

**WritePaths：** `docs/plans/2026-08-30-goal-engine-convergence.md`

**验收：** 记录 Git 状态、版本、测试入口差异、当前 37 个 Goal 模块/66 个 Goal 测试文件规模；明确本轮不新增协议。

### T1：集成挂起 provenance

**Deps：** T0

**WritePaths：** `docs/bugs/`（仅 production 缺陷时）、`test/`（仅测试问题时）

**验收：** 重现或否定 `goal-engine-extension.integration.mjs` 长时间悬挂；记录首个偏离点、实际入口、调用链、身份和资源事实。没有 production 证据时不得修改生产代码。

### T2：fresh Host 实测矩阵

**Deps：** T0

**WritePaths：** `var/` 之外的生产文件不得修改；仅允许测试临时目录

**验收：** 在全新 Pi Host/临时 repo/state root 运行 planned 回归、runtime PASS、runtime FAIL→repair→reverify、reload/crash/suspend 四类场景；记录真实退出码和残留资源。

### T3：worktree/资源债务审计

**Deps：** T0

**WritePaths：** `docs/audits/` 或最终 summary

**验收：** 只读盘点 managed worktree、lease、process、workspace、cleanup debt；不得依据 TTL 或 clean 状态删除任何资源。

### T4：最小生产修复

**Deps：** T1、T2

**WritePaths：** 由 provenance 精确限定；同时新增中文 bug 文档和最小 RED/GREEN 测试

**验收：** 仅修复被证明可由合法 production 入口产生的问题；保持旧 generation 语义和 exact-eight ABI 不变。

### T5：只读收口报告

**Deps：** T3、T4（如执行）

**WritePaths：** `docs/reviews/2026-08-30-goal-engine-convergence.md`

**验收：** 汇总两类失败分类、测试计数、真实 Host 证据、资源债务和已知限制；不再提出未授权的功能扩展。

### T6：第二轮回归与终止判定

**Deps：** T5

**WritePaths：** 仅 summary

**验收：** 第二轮 fresh Host 回归与全量测试；达到终止条件则标记收敛，否则只允许继续处理已分类 Critical/Important。
