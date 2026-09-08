# Focused fixture drift: settlement and Broker authorization (2026-09-07)

## Provenance

| Focused fixture | RED divergence | Classification | Test-only resolution |
| --- | --- | --- | --- |
| `goal-engine-obligation-policy.integration.mjs`: active executor settlement | The fixture expected an active executor to suppress its dispatched managed-workspace action. T5's public v1 chain instead returns `goal_settle`. | Obsolete expectation; no graph defect. | Name the legal state and assert its exact `goal_settle` action while retaining the independent condition action. |
| `subagent-managed-worktree.integration.mjs`: rich terminal snapshot | The original standalone facade fixture supplied a non-Goal authorization, so a Broker proof could not be verified as Goal-owned. | Fixture authority drift; no Broker defect. | The bounded coordinator emits a `goal-run-binding-ticket.v2`; the production public coding facade constructs and registers the Goal-bound `RunAuthorization`. The fixture asserts its deep-frozen nested values and the Broker's verified authorization snapshot. |

The rich terminal fact continues to be introduced only with `broker.observeTerminal`; no status, log, shallow object, or caller-fabricated proof is used. Production graph and Broker sources were not changed.
