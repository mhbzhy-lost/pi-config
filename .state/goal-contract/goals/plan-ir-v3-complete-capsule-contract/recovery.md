# Recovery: plan-ir-v3-complete-capsule-contract

Read these files before acting:

1. `.state/goal-contract/registry.json`
2. this file
3. `state.json`
4. `goal-contract.md`
5. `feature-list.json`
6. last 20 lines of `evidence.jsonl`

If `evidence.jsonl` contains fewer than 20 lines, read every available line. An empty file is missing recovery evidence and must stop continuation as `needs_recovery`.

Before continuing, verify amendment authorization artifacts:

```bash
node scripts/goal-contract-authorization-audit.mjs .state/goal-contract/goals/plan-ir-v3-complete-capsule-contract
```

## Current State
- Status: active
- Phase: implementation
- Current slice: flat-runtime-task-8

## Next Action
进入 Task 8B2：先修复 bounded-wait 测试 helper 的残留 watchdog timer，再建立 official `process-terminal.json` / `status.json.processTerminal` polling 与 verified process-group force-kill 的独立 RED。

## Unattended Execution
- Active plans: `docs/superpowers/plans/2026-07-29-plan-ir-v3-complete-capsule-contract.md`, `docs/superpowers/plans/2026-07-29-plan-runner-flat-rpc-remove-thin-host.md`
- Todo recovery snapshot: `todo-recovery-snapshot.json` (SHA-256 `b2660a256c090731ac6dc0c5451aebac91a3bbca501d793c8c5e80a5ac473f87`). Stable aliases: `ir-v3-plan-closeout` complete; `flat-runtime-foundation` complete; `flat-runtime-root-lifecycle` active; `flat-runtime-finalization` pending.
- Attached issue: stable alias `root-session-identity-startup` tracks the new Pi conversation startup failure `rootSessionId must be a safe non-path identity`; root cause is proven as `getSessionFile()` being used instead of `getSessionId()`. It must be fixed before final verification but does not interrupt Task 8.
- Ordering gate: Task 8 depends on completed Tasks 4, 6, and 7; Task 9 waits for Task 8.
- Stop only after every listed todo, attached startup issue, and both final verification matrices pass.

## Latest Evidence
- Task 8A process birth helper and started ownership ledger are complete: helper `7/7`, started ownership `7/7`, lifecycle `5/5`, Root Broker `82/82` before the ordered-drain RED additions.
- Task 8B1 ordered drain 与 review remediation 已完成：`1cee8bb`、`d64e5d3`、`f5dd0a9`；父级 focused bounded `3/3`、ordered `5/5`、Root Broker `90/90`、protocol `8/8`、birth helper `7/7`。
- 独立 review `09556c85-fdac-43bc-a655-eeeeb375c7f7` 无 Critical，4项 Important：stop pending 与 startup barrier 无界等待已由 `bcaf5c6`、`8efd363` 文档化并修复；late-start fence 与 dispose retry debt保留到8C。
- `f5dd0a9` 将 terminal deadline 安装到 stop request之前，pending stop不再阻塞proof/debt，startup barrier timeout保留cleanup ownership并允许retry；stop-failure waiter不再残留250ms timer。
- Task 7 Root private Supervisor target, owner request ledger, pending/reply fence, final frame validation, progress notification, startup mailbox, and child Attention exactly-once are complete.
- Task 7 focused behavior `10/10`, Root Broker `75/75`, runtime/adapter/typed `54/54`, Capsule/Dependencies `3/3`, and protocol/client `7/7` passed.
- Task 6+7 cumulative key matrix passed `306/306`; `npm run doctor`, diff, staging, and orphan checks passed.
- Two independent Task 7 review rounds completed. Lifecycle churn dedupe and mailbox route-failure ordering findings were reproduced and fixed through separate bug documents and RED/GREEN commits.

## Warnings
- Do not infer hidden context from chat summary.
- Do not silently rewrite contract fields.
- Use confidence labels for major conclusions.
- Do not read or use paths outside the repository working tree.
- Root Broker tests use one fixed socket path; never run two `root-subagent-broker.test.mjs` processes concurrently.
