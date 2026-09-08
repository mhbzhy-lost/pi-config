# Goal orphan fixture provenance (2026-09-08)

## Removed fixture pollution

The former orphan/preserved-release integration fixtures rewrote
`events.jsonl`, `projection.json`, and the registry after dispatch.  That
created a state no public Goal or workspace-service lifecycle can produce.
Those rollback helpers have been replaced with append-failure fixtures.

## Legal construction

* **Allocation orphan:** the workspace service durably allocates a receipt and
  `task.workspace_allocated` is injected to fail before durable.  No Goal
  ledger is rolled back.  A fresh status reads the service inventory.
* **Terminal receipt gap:** `goal_integrate` invokes the public workspace
  service disposition, then injection fails the
  `task.managed_workspace_disposition_receipt` append (before durable or
  durable-then-throw).  Retry reads the terminal service receipt and appends
  only the missing Goal receipt.
* **Inventory drift:** after the legal allocation gap, only the persisted
  service record dimension is removed; Git root and Goal ledger are unchanged.

## Current production breakpoint

On the legal allocation gap, fresh `goal_status` returns no orphan blocking
reason, so production does not emit the required orphan human challenge.  The
retained production challenge tests now use this legal fixture and demonstrate
the missing discovery path.  No fallback to ledger rollback or Git-root damage
is used.
