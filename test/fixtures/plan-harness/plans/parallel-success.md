# Parallel harness success

**Goal:** Validate that independent approved tasks can execute concurrently while preserving their complete Executor instructions and verification identity.

## Execution Contract

```json
{
  "schemaVersion": "pi-plan.v3",
  "revision": 1,
  "parentPlanHash": null,
  "verification": [
    {"id": "plan:worker-1", "command": "grep -q '^worker$' README.md", "cwd": ".", "timeoutMs": 120000},
    {"id": "plan:worker-2", "command": "grep -q '^worker-2$' worker.txt", "cwd": ".", "timeoutMs": 120000}
  ],
  "requiredGates": ["deterministic", "plan-audit", "external-review", "final-completeness"],
  "resourceCapacities": {},
  "executionDefaults": {"agent": "executor", "risk": "normal", "workflow": {"mode": "inherit-repository"}, "timeoutMs": 120000},
  "taskExecution": {"task-1": {}, "task-2": {}},
  "taskAcceptance": {
    "task-1": {"strategy": "commands", "commandIds": ["plan:worker-1"]},
    "task-2": {"strategy": "commands", "commandIds": ["plan:worker-2"]}
  }
}
```

### Task 1: Add the worker marker

**Files:**
- Modify: `README.md`

Append exactly one `worker` line to README.md, commit only that approved change, and leave unrelated files untouched.

### Task 2: Add a second worker artifact

**Files:**
- Create: `worker.txt`

Create worker.txt containing exactly the `worker-2` marker, commit only that approved change, and leave unrelated files untouched.
