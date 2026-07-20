# Smoke Test: Plan Runner 基础功能验证

> 沙盒任务，验证 plan-runner worktree 创建、executor 派发、task 执行、提交流程。

## Execution Contract

```json
{"schemaVersion":"pi-plan.v1","verification":["node -e \"require('fs').existsSync('sandbox/smoke.txt') || process.exit(1)\""],"requiredGates":["deterministic","plan-audit","external-review","final-completeness"]}
```

### Task 1: 创建 smoke test 文件

**Files:**
- Create: `sandbox/smoke.txt`
