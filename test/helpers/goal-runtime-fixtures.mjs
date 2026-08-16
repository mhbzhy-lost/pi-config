export const runtimeRegistries = Object.freeze({
  adapters: Object.freeze({ oracle: Object.freeze({ deterministic: true }) }),
  environments: Object.freeze({ local: Object.freeze({ available: true }) }),
  fixtures: Object.freeze({ sample: Object.freeze({ available: true }) }),
});

export function runtimeInit(overrides = {}) {
  const execution = {
    schema: "goal-runtime.v1",
    tasks: [{
      id: "task-1", description: "Harden runtime task contract", deps: [], writePaths: ["src/**"],
      acceptance: { criteria: [{ id: "contract", statement: "Runtime task contract compiles", evidenceKinds: ["tests"] }] }, workflow: "tdd",
    }],
    conditions: [{
      id: "condition-1", role: "terminal", enforcement: "final",
      statement: "Tests pass", observable: "test suite", expected: "passing",
      depends_on: [{ kind: "task", id: "task-1" }], oracle_ref: "oracle",
      environment_ref: "local", fixture_refs: ["sample"],
      invalidation: { paths: ["src/**"], task_ids: ["task-1"] },
      remediation: { policy: "user-approved", allowed_paths: ["src/**"], max_attempts: 1 },
      stability: { mode: "single", require_fresh_environment: true },
    }],
    write_policy: { allowed_paths: ["src/**", "test/**"] },
    budgets: { max_observations: 4, max_repairs: 2, max_elapsed_minutes: 30, max_no_progress: 2 },
  };
  return { objective: "Harden runtime", execution: { ...execution, ...overrides.execution }, ...overrides };
}
