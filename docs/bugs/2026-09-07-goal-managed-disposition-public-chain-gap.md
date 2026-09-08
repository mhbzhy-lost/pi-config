# v1 public managed disposition receipt chain gap

## Provenance

The reachable v1 path is `goal_dispatch → managed workspace allocation → executor binding → goal_settle → goal_integrate → goal_accept`. The managed workspace service is the resource authority. Before this correction, `goal_integrate` read `lastRunProof/runBinding`, which are v2 fields, even for a settled planned.v1 task. A legal v1 task instead carries the authoritative `executorBinding/lastExecutorProof`; consequently the service received a pending terminal proof and rejected a valid integration before a Goal receipt could be appended.

## Required ordering and retry

The corrected path durably appends the existing disposition intent, reads the service, issues/disposes only when the service remains active, then appends the exact terminal service receipt. If service disposition completed but Goal receipt append failed, the retry observes the terminal service receipt and only appends its hash-checked Goal receipt. Receipt, owner, attempt, execution revision, workspace and lease mismatches remain reducer rejections. The retry RED fixture also found that the reducer compared the terminal disposition action but not an integration strategy; a service receipt claiming `merge` could satisfy a `cherry-pick` intent. The receipt reducer now binds `receipt.disposition.strategy` exactly to the integrate intent before mutating the Goal fact.

## Additional public-chain RED / GREEN

The first bounded public service-chain fixture reached a legal `dispatched` task with an active `managed-workspace.v1` receipt and strict executor binding, but `goal_status` offered no `goal_settle` action. This was a production graph gap: the managed-receipt active-state branch handled succeeded/failed/blocked states but shadowed the normal dispatched-state settlement action. The minimal fix restores `goal_settle` for that exact active/dispatched state; it does not alter the service or introduce a fallback.

The same RED then exposed a T4 regression in the planned.v1 dual-path evidence bridge: it selected v2-only `run` criteria, yielding an empty expected-criteria list for a valid planned executor-owned criterion. Planned dual-path settlement now selects its existing executor criteria; runtime neutral settlement retains `run` criteria. It also wrote the inspected head under the v2 `executionHead` key before constructing a planned receipt, which requires `executorHead`; the public v1 branch now emits only its canonical planned key.

## Scope

`managedDisposition` retains only Goal business linkage (attempt, execution revision, workspace/lease, intent and terminal receipt summary); it does not mirror the managed-workspace service state machine. Preserve remains a preserve receipt after explicit release, so the task returns to pending and can be redispatched. No legacy Git, lease-path, or raw-worktree fallback is involved.
