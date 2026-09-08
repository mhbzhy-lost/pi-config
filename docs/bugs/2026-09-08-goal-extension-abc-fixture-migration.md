# Goal extension A/B/C fixture migration (2026-09-08)

The extension fixtures now use canonical managed-workspace receipts as their only workspace provenance.  The configured-state-root fixture allocates from external state while retaining the service dirty-origin preflight.  Historical v1/v2 state is read-only/recovery-only.

Public lifecycle expectations assert `task.managed_workspace_disposition_intent` and `task.managed_workspace_disposition_receipt`; fixture fault injection targets the receipt append.  Cleanup resolves only a currently present canonical receipt and is a no-op for an already released record.

Negative fixtures start with a legal canonical receipt and corrupt only their target dimension.  Assertions use stable error codes plus structured remediation/next-action data, with identity failures preceding commit-range assertions and a missing canonical record classified as `EXECUTOR_WORKSPACE_MISSING`.

Focused baseline: A/B/C patterns were 21 RED before the migration and 21 GREEN afterwards.  The full extension run is retained as production residual evidence for D/E and unrelated production-facing clusters; no production files were changed here.
