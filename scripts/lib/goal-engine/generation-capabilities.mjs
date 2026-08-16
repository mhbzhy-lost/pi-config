const LEGACY = Object.freeze({ taskContract: "legacy-commands", executorBinding: "legacy", settlement: "legacy", completion: "accept-auto", conditions: false, executionRevision: false });
const PLANNED = Object.freeze({ taskContract: "criteria-only", executorBinding: "strict", settlement: "dual-path", completion: "accept-auto", conditions: false, executionRevision: false });
const RUNTIME = Object.freeze({ taskContract: "criteria-only", executorBinding: "strict", settlement: "dual-path", completion: "goal-finalize", conditions: true, executionRevision: true });
const MATRIX = new Map([
  ["goal-engine.event.v1", LEGACY], ["goal-engine.event.v2", LEGACY], ["goal-engine.event.v3", LEGACY],
  ["planned.v1", PLANNED], ["goal-runtime.v1", RUNTIME],
]);

export function generationCapabilities(schemaVersion) {
  const capabilities = MATRIX.get(schemaVersion);
  if (!capabilities) throw new Error(`unknown generation: ${schemaVersion}`);
  return capabilities;
}
