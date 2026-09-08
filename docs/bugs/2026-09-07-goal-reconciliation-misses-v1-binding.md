# Reconciliation v1 binding fixture classification

## Finding

The original focused test constructed `{ executorBinding: { state: "active" } }` on a
`pending` task. This is not a valid `planned.v1` binding: the v1 reducer requires the
exact binding identity fields and writes it only after `task.dispatched`.

## Provenance check

The focused fixture now obtains the task through the legal `planned.v1` reducer sequence:
`goal.created` → `task.dispatched` → `task.executor_bound`. That task is `dispatched`, so
the pre-existing reconciliation owner-state classification already returns
`block_until_terminal` before considering a binding field.

## Disposition

This is test-manufactured data, not a production reconciliation defect. No compatibility
reader or runtime owner-selection behavior was added; reconciliation retains its existing
resource attribution and fail-closed decisions.
