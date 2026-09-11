# Root Broker terminal reader convergence

## Root cause

The Broker already had a strict sidecar reader for settlement/restart, but
`pollTerminalArtifact` separately used an unguarded async JSON read before
calling `acceptTerminalProof`. Consequently stop/drain could bypass the
regular-file, non-symlink, link-count, owner, mode, and TOCTOU checks used by
settlement. The three lifecycle paths could therefore accept the same writer
artifact under different security facts.

## Reader and production call-site inventory

| Reader/wrapper | Production caller | Return shape | Responsibility |
| --- | --- | --- | --- |
| `readAndAcceptOfficialTerminalArtifact` | settlement, restart recovery, poll/stop/drain | accepted frozen terminal proof | Sole artifact authority: secure `process-terminal.json` read, `parseProcessTerminal`, observed/run identity checks and `acceptTerminalProof`. |
| `executorProofSnapshot` / `inspectExecutionProof` | runtime workspace proof provider and typed-subagent extension facade | `root-broker.execution-proof.v2` snapshot or `null` | Synchronous in-memory projection only; it never reads a sidecar. |
| `inspectExecutionProofForSettlement` | registry settlement adapter | async execution-proof snapshot or `null` | Loads the canonical artifact only for verified Goal-owned runs, then snapshots it. |
| `recoverExactTerminalProof` | no current production caller; focused restart coverage | `{state:"observed", proof}` or attention code | Retained restart attention wrapper using the canonical artifact authority. |
| `pollTerminalArtifact` | `observeOfficialProof`, `drainRun`, `forceCleanup` | proof or `undefined` | Keeps cancellation, deadline and cleanup semantics; repeatedly invokes the canonical artifact authority. |
| `stopGoalOwnedRun` | registry owned-stop facade | observed proof or attention code | Keeps exact Goal authority and stop-specific attention semantics. |
| `inspectRootBrokerExecutionProof` | subagent runtime / managed workspace adapters | legacy-normalized proof or `null` | Synchronous registry projection adapter. |
| `inspectExecutionProofForSettlement` (registry) | intended settlement boundary | legacy-normalized proof or `null` | Async registry adapter from the canonical snapshot. |

The compatibility names `inspectExecutorProofAsync` and
`inspectRootBrokerExecutorProofAsync` remain delegated aliases. `rg` finds the
existing Goal extension import and the package Doctor check, so conditional
removal evidence (no production call sites plus replacement coverage) is not
yet met. They contain no independent parsing or authority logic.

`status.json`, logs, caller evidence, facade-only records, and unbound runs are
not in this inventory because none can become terminal proof.

## RED/GREEN

RED added one upstream `writeAtomicJson`-shape artifact consumed independently
through settlement, restart recovery, and owned stop. It initially failed
because `inspectExecutionProofForSettlement` did not exist. GREEN routes all
three through `readAndAcceptOfficialTerminalArtifact`; the test asserts equal
proof ID, outcome, and non-conflict facts. Existing security negatives retain
0600/0644, owner uid, regular/non-symlink, nlink=1, malformed, foreign,
non-observed, facade-only, and conflict coverage.
