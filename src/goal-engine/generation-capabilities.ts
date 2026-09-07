const LEGACY = Object.freeze({ taskContract: "legacy-commands", executorBinding: "legacy", settlement: "legacy", completion: "accept-auto", conditions: false, executionRevision: false });
const PLANNED = Object.freeze({ taskContract: "criteria-only", executorBinding: "strict", settlement: "dual-path", completion: "accept-auto", conditions: false, executionRevision: false });
const RUNTIME = Object.freeze({ taskContract: "criteria-only", executorBinding: "strict", settlement: "dual-path", completion: "goal-finalize", conditions: true, executionRevision: true });
const PLANNED_V2 = Object.freeze({ taskContract: "criteria-only", runBinding: "strict", settlement: "execution-proof", completion: "accept-auto", conditions: false, executionRevision: false });
const RUNTIME_V2 = Object.freeze({ taskContract: "criteria-only", runBinding: "strict", settlement: "execution-proof", completion: "goal-finalize", conditions: true, executionRevision: true });
const MATRIX = new Map([
  ["goal-engine.event.v1", LEGACY], ["goal-engine.event.v2", LEGACY], ["goal-engine.event.v3", LEGACY],
  ["planned.v1", PLANNED], ["goal-runtime.v1", RUNTIME],
  ["planned.v2", PLANNED_V2], ["goal-runtime.v2", RUNTIME_V2],
]);

export function generationCapabilities(schemaVersion) {
  const capabilities = MATRIX.get(schemaVersion);
  if (!capabilities) throw new Error(`unknown generation: ${schemaVersion}`);
  return capabilities;
}

export function isRuntimeGeneration(schemaVersion) {
  return schemaVersion === "goal-runtime.v1" || schemaVersion === "goal-runtime.v2";
}

export function runtimeEventSchema(projection) {
  if (!isRuntimeGeneration(projection?.eventSchemaVersion)) throw new Error("runtime projection required");
  return projection.eventSchemaVersion;
}
