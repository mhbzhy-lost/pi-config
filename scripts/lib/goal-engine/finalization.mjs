const UNSUPPORTED_GENERATIONS = new Set([
  "goal-engine.event.v1",
  "goal-engine.event.v2",
  "goal-engine.event.v3",
  "planned.v1",
]);

export function finalizationUnsupportedError(eventSchemaVersion) {
  const error = new Error(`FINALIZATION_UNSUPPORTED_GENERATION: ${eventSchemaVersion ?? "unknown"}`);
  error.code = "FINALIZATION_UNSUPPORTED_GENERATION";
  return error;
}

// R1 deliberately has no successful finalization path. Keeping this guard pure
// ensures legacy goals cannot allocate review or execution resources.
export function finalizeGoal(projection, _options = {}) {
  if (UNSUPPORTED_GENERATIONS.has(projection?.eventSchemaVersion)) {
    throw finalizationUnsupportedError(projection.eventSchemaVersion);
  }
  throw finalizationUnsupportedError(projection?.eventSchemaVersion);
}
