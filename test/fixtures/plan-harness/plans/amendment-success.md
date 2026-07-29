# Amendment crash recovery

**Goal:** Exercise a complete approved amendment while its original Executor is active, then recover its supersede cleanup from the durable Plan Runner session.

## Execution Contract

```json
{
  "schemaVersion": "pi-plan.v3",
  "revision": 1,
  "parentPlanHash": null,
  "verification": [
    {"id": "plan:decision", "command": "test -f decision.txt", "cwd": ".", "timeoutMs": 120000}
  ],
  "requiredGates": ["deterministic", "plan-audit", "external-review", "final-completeness"],
  "resourceCapacities": {},
  "executionDefaults": {"agent": "executor", "risk": "normal", "workflow": {"mode": "inherit-repository"}, "timeoutMs": 120000},
  "taskExecution": {"task-1": {}},
  "taskAcceptance": {"task-1": {"strategy": "commands", "commandIds": ["plan:decision"]}}
}
```

### Task 1: Record the approved decision

**Files:**
- Create: `decision.txt`

Request the required blocking Supervisor decision. After it is resolved, deliberately remain active briefly, then create decision.txt containing exactly `approved`, commit only that approved file, and leave unrelated files untouched.
