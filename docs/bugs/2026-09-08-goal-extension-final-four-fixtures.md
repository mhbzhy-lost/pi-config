# Goal extension final four fixture migration

## Canonical authority

| Fixture | Previous fixture gap | Canonical fixture and observed contract |
| --- | --- | --- |
| dirty failed/blocked no-commit | Dispatch fixture always supplied a `succeeded` proof, so failed settlement had no terminal authority. | The bound coordinator proof map is changed to an official verified `failed` terminal proof for the already-bound run. Failed dirty discard reaches the managed service and is rejected by its current terminal/workspace policy; blocked preserve retains the workspace. |
| rogue after started | The rogue commit was made before disposition, with no durable current intent boundary. | `createManagedWorkspaceService`'s `dispose/after-intent` fault appends the rogue commit only after the Goal `task.managed_workspace_disposition_intent` is durable. The current service maps its release-time HEAD/cleanliness rejection to `GIT_INFRASTRUCTURE_ERROR`; the Goal intent remains and origin HEAD is unchanged. |
| settlement inspection-internal race | Unreachable legacy `inspectExecutorWorkspace` injection did not participate in the service authority path. | The managed service `status/after-inspection` fault commits between its initial inspection and bounded confirmation inspection; `goal_settle` returns `EXECUTOR_SETTLEMENT_HEAD_MISMATCH` with no Goal mutation. |
| disposition inspection-internal race | Same legacy injection gap. | The managed service `status/after-inspection` fault commits between canonical inspections for integrate, discard, and preserve. Each returns `EXECUTOR_SETTLEMENT_HEAD_MISMATCH` before a legacy disposition-started event or Git side effect. |

No facade/status proof, legacy inspector/event injection, sleep, or real concurrency is used.
