# Resource serialized

**Goal:** Verify exclusive xcode resource scheduling and path ownership while the final Gate validates the combined files.

## Execution Contract

```json
{
  "schemaVersion": "pi-plan.v3",
  "revision": 1,
  "parentPlanHash": null,
  "verification": [
    {"id": "plan:combined-files", "command": "test -f one.txt && test -f two.txt", "cwd": ".", "timeoutMs": 120000}
  ],
  "requiredGates": ["deterministic", "plan-audit", "external-review", "final-completeness"],
  "resourceCapacities": {"xcode": 1},
  "executionDefaults": {"agent": "executor", "risk": "normal", "workflow": {"mode": "inherit-repository"}, "timeoutMs": 120000},
  "taskExecution": {"task-1": {}, "task-2": {}},
  "taskAcceptance": {
    "task-1": {"strategy": "structural-only", "reason": "Harness 仅验证资源串行与路径所有权，文件组合在最终 Gate 验证"},
    "task-2": {"strategy": "structural-only", "reason": "Harness 仅验证资源串行与路径所有权，文件组合在最终 Gate 验证"}
  }
}
```

### Task 1: First resource user

**Files:**
- Create: `one.txt`

**Resources:**
- `xcode`: `exclusive`

Create one.txt as the first exclusive xcode task and commit only its approved file.

### Task 2: Second resource user

**Files:**
- Create: `two.txt`

**Resources:**
- `xcode`: `exclusive`

Create two.txt as the second exclusive xcode task and commit only its approved file.
