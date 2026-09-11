# 统一委派 workspace harness pre-cutover 验收报告

日期：2026-09-10
计划：`docs/plans/2026-09-10-unified-delegation-workspace-harness.md`

## 验收范围

本报告覆盖 standalone delegation workspace harness 的 pre-cutover 验收。Goal cutover（T8/T13）已 deferred，不在本计划范围；本报告不宣称 Goal production cutover 完成。

## 测试结果

### 步骤 1：合同与 workspace focused tests

命令：`node --test test/subagent-generic-prompt-contract.test.mjs test/subagent-generic-prompt-contract-security.test.mjs test/subagent-execution-contract.test.mjs && npm run test:subagent-workspace`

结果：**PASS** 合同 13/13，workspace 35/35

### 步骤 2：standalone harness tests

命令：`npm run test:delegation-workspace-harness`

结果：**PASS** 60/60

### 步骤 3：静态与 package 验证

命令：`npm run typecheck && npm run verify:subagents-enhanced`

typecheck 复核结果：仍为 16 个错误，均为 Host peer typings 缺失及其直接下游错误，集中在 `@earendil-works/pi-coding-agent`、`@earendil-works/pi-tui` 和 Goal extension 的既有依赖链；本次改动涉及的模型黑名单、T14、workspace、execution-contract 文件没有新增 typecheck 错误。

package verification 结果：**PASS**。`pi-subagents@0.62.0` 已重新安装并应用 runtime patch；输出确认 `upstreamVersion: 0.62.0`、`patched: true`、`importEdges: 69`。

T14 stream recovery 回归：`node --test test/subagent-stream-read-error-retry.test.mjs`，**PASS 7/7**。覆盖同 provider 两次重试、第三次终止/成功、已有 ordered-models marker 时继续安装 recovery patch、通用 marker 唯一性、runner fixture 单次 completion、evidence gate、abortable backoff 和不切换模型。

复审发现的重复 `ordered-models.v3` marker 已修复并通过新增断言；`npm run verify:subagents-enhanced` 复核输出 `upstreamVersion: 0.62.0`、`patched: true`、`importEdges: 69`。

### 步骤 4：工作树和迁移证据

已核对本轮相关工作树状态：runtime patch 源码、package manifest/lock、测试和验证报告均有预期变更；没有执行 commit、stash、reset 或清理用户既有 dirty。`pi-subagents@0.62.0` 的安装产物已由 setup 脚本重新生成并通过 package verification。

已知 baseline 仍保留，未将其改写为本次成功证据。

## 任务证据矩阵

| 任务 | 关键实现 | 主要证据 | 状态 |
| --- | --- | --- | --- |
| T1 | `docs/research/2026-09-10-generic-subagent-prompt-contract.md` | 官方方法调研、五段 prompt 决策、provenance | 已完成 |
| T2 | `src/contracts/generic-prompt.ts`、`src/contracts/dispatch-ir.ts` | generic contract/security tests；合同 13/13 | 已完成 |
| T3 | `src/subagent-dispatch/execution-contract.ts`、`run-authorization.ts` | Host authorization、brand 伪造和 capability boundary tests | 已完成 |
| T4 | `src/subagent-dispatch/execution.ts`、`extension.ts` | shared execution integration、legacy adapter 回归 | 已完成 |
| T5 | `src/workspace/contract.ts`、`ledger.ts` | v2 ledger、v1 replay/golden compatibility tests | 已完成 |
| T6 | `src/workspace/git-worktree.ts`、`published-artifact.ts` | Git publish/apply、CAS、dirty origin tests | 已完成 |
| T7 | `src/workspace/service.ts` | terminal proof、action token、dirty publish/release、workspace lifecycle tests | 已完成 |
| T8 | Goal bridge | Goal 本地未启用 | DEFERRED |
| T9 | `src/workspace/administration.ts` | reconcile、recovery challenge、durable recovery tests | 已完成 |
| T10 | public workspace tool、TUI renderer、dispatch Skill | tool/TUI/Skill focused tests | 已完成 |
| T11 | `test/subagent-delegation-workspace.e2e.mjs`、`package.json` | standalone harness 60/60 | 已完成 |
| T12 | 本报告 | 步骤 1、2、4 已完成；typecheck baseline 阻塞步骤 3，待复审 | BLOCKED |
| T13 | Goal fresh Host smoke/cutover | 依赖 Goal R13；本地不启用 Goal | DEFERRED |
| T14 | `ordered-models-runtime-patch.ts` | stream recovery 7/7；marker 唯一性回归；package verification patched=true | 已完成 |
| T15 | `test/helpers/test-runtime.mjs` | runtime side-effects/tmp isolation tests | 已完成 |

T8（Goal bridge）和 T13（fresh Host Goal smoke）已 deferred。本地不启用 Goal，保持 exact-eight / `dispatch-ir.v1` / v1 replay 不变量。将来启用 Goal 须先满足 goal-obligation-runtime R13。

## 已知 baseline failures

- `test/subagent-dispatch-extension.test.ts:662` resolver identity reference-equality failure（既有 baseline，非本次改造引入）。
- typecheck 剩余 16 个 host peer typings 缺失错误（既有 baseline）。

## 当前结论

standalone delegation workspace 的合同、workspace、E2E harness 和 package verification 已通过。T14 marker 重复问题已完成修复并通过回归。根据用户决定，不再进行后续 reviewer 复审；因此本报告保留 T12 的 `BLOCKED` 状态：`typecheck` 仍有 16 个既有 Host peer typings 错误，且不将未复审结果宣称为整体验收通过。
