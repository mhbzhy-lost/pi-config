// The capability matrix is a persisted-generation contract.  Keep each row
// literal so callers can narrow on generation-specific fields rather than
// widening the matrix to generic strings.
type GenerationCapabilities = Readonly<
  | { taskContract: "legacy-commands"; executorBinding: "legacy"; runBinding?: undefined; settlement: "legacy"; completion: "accept-auto"; conditions: false; executionRevision: false }
  | { taskContract: "criteria-only"; executorBinding: "strict"; runBinding?: undefined; settlement: "dual-path"; completion: "accept-auto" | "goal-finalize"; conditions: boolean; executionRevision: boolean }
  | { taskContract: "criteria-only"; executorBinding?: undefined; runBinding: "strict"; settlement: "execution-proof"; completion: "accept-auto" | "goal-finalize"; conditions: boolean; executionRevision: boolean }
>;

/** @type {GenerationCapabilities} */
const LEGACY = Object.freeze({ taskContract: "legacy-commands", executorBinding: "legacy", settlement: "legacy", completion: "accept-auto", conditions: false, executionRevision: false });
/** @type {GenerationCapabilities} */
const PLANNED = Object.freeze({ taskContract: "criteria-only", executorBinding: "strict", settlement: "dual-path", completion: "accept-auto", conditions: false, executionRevision: false });
/** @type {GenerationCapabilities} */
const RUNTIME = Object.freeze({ taskContract: "criteria-only", executorBinding: "strict", settlement: "dual-path", completion: "goal-finalize", conditions: true, executionRevision: true });
/** @type {GenerationCapabilities} */
const PLANNED_V2 = Object.freeze({ taskContract: "criteria-only", runBinding: "strict", settlement: "execution-proof", completion: "accept-auto", conditions: false, executionRevision: false });
/** @type {GenerationCapabilities} */
const RUNTIME_V2 = Object.freeze({ taskContract: "criteria-only", runBinding: "strict", settlement: "execution-proof", completion: "goal-finalize", conditions: true, executionRevision: true });
/** @type {Map<string, GenerationCapabilities>} */
const MATRIX = new Map<string, GenerationCapabilities>([
  ["goal-engine.event.v1", LEGACY], ["goal-engine.event.v2", LEGACY], ["goal-engine.event.v3", LEGACY],
  ["planned.v1", PLANNED], ["goal-runtime.v1", RUNTIME],
  ["planned.v2", PLANNED_V2], ["goal-runtime.v2", RUNTIME_V2],
]);

export function generationCapabilities(schemaVersion) {
  const capabilities = MATRIX.get(schemaVersion);
  if (!capabilities) throw new Error(`unknown generation: ${schemaVersion}`);
  return capabilities;
}

/**
 * New Goal dispatch authority is intentionally limited to the public v1
 * generations. Historical event generations replay only; v2 is frozen.
 */
export function isWritableGoalGeneration(schemaVersion) {
  return schemaVersion === "planned.v1" || schemaVersion === "goal-runtime.v1";
}

export function isRuntimeGeneration(schemaVersion) {
  return schemaVersion === "goal-runtime.v1" || schemaVersion === "goal-runtime.v2";
}

export function runtimeEventSchema(projection) {
  if (!isRuntimeGeneration(projection?.eventSchemaVersion)) throw new Error("runtime projection required");
  return projection.eventSchemaVersion;
}
