# Progress: plan-ir-v3-complete-capsule-contract

## Checkpoint

Current slice: `flat-runtime-task-8`
Status: active

### Evidence
- [Evidence-Backed] Flat runtime Tasks 1-6 are complete; Task 6 final gates passed exact `278/278`, cross-layer `107/107`, Root Broker `69/69`, typed/Boundary/Capsule `91/91`, doctor, syntax, diff, staging, and orphan scans.
- [Evidence-Backed] Task 7 established the private Root Supervisor target, Executor owner request ledger, pending/reply authorization, final frame validation, progress one-way notifications, startup mailbox, and child Plan Attention exactly-once.
- [Evidence-Backed] Task 7 focused behavior passed `10/10`; Root Broker `75/75`; runtime/adapter/typed `54/54`; Capsule/Dependencies `3/3`; protocol/client `7/7`.
- [Evidence-Backed] Task 6+7 cumulative key matrix passed `306/306`; `npm run doctor`, diff, staging, socket, and orphan checks passed.
- [Evidence-Backed] Task 7 completed two independent review rounds. Both Important findings were reproduced and fixed with separate bug documents, RED tests, and production GREEN commits; Round 2 found no new Critical/Important.
- [Evidence-Backed] Attached issue `root-session-identity-startup` root cause is proven: Root Broker startup used upstream `resolveCurrentSessionId()`, which selects absolute `getSessionFile()` for persisted sessions instead of safe `getSessionId()`. Stable identity and legacy display-ID mapping are captured in `todo-recovery-snapshot.json`.
- [Evidence-Backed] Task 8A process birth helper and started ownership ledger passed helper `7/7`, lifecycle `5/5`, and Root Broker `82/82` before ordered drain。
- [Evidence-Backed] Task 8B1 commits `1cee8bb`、`d64e5d3`、`f5dd0a9` establish ordered Executor -> Plan Runner drain, official-event terminal authority, cleanup debt retry, bounded pending stop, and bounded startup barriers.
- [Evidence-Backed] Parent gates pass: bounded waits `3/3`, ordered drain `5/5`, complete Root Broker `90/90`, protocol `8/8`, process birth helper `7/7`; stop-failure waiter no longer leaves the old 250ms timer.
- [Evidence-Backed] Independent review `09556c85-fdac-43bc-a655-eeeeb375c7f7` found no Critical and four Important issues. Stop-pending and startup-barrier blockers are fixed; late-start fencing and dispose retry debt remain explicit Task 8C work.
- [Evidence-Backed] After a full Pi process restart, read-only `subagent status` succeeded with zero active runs and available spawn budget; the Task 8 dispatch blocker is cleared.

### Conclusions
- [Evidence-Backed] Flat runtime Tasks 1-7 are complete; Task 8B1 ordered drain and bounded-wait remediation are complete, while Task 8B2-8D remain active.
- [Evidence-Backed] Goal is not complete; Tasks 8-10 and attached startup issue remain.
- [Evidence-Backed] Task 7 preserves domain topology `Main -> Plan Runner -> Executor` while runtime ownership remains flat under Root.

### What This State Cannot Tell Us
- It does not prove Task 8 graceful Root stop-all, Task 9 Host removal, or Task 10 real flat runtime Harness.
- It does not yet prove the production remediation of attached issue `root-session-identity-startup`; only the root cause is proven.
- Full clear-env repository regression and real migrated Harness remain final-stage evidence.

### Next Action
进入 Task 8B2：先清理 bounded-wait test helper 的 watchdog timer，再以 tests-only checkpoint固定 official sidecar/status proof polling、invalid proof拒绝、verified process-group SIGKILL与force后仍需official proof。
