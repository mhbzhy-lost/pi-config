export const PLAN_IR_V3 = "plan-ir.v3";
export const DEPENDENCY_RECEIPTS = Object.freeze([
  "result-commit",
  "integrated-head",
  "changed-paths",
  "verification-summary",
]);

export function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function isRecursivelyFrozen(value) {
  if (!value || typeof value !== "object") return true;
  return Object.isFrozen(value) && Object.values(value).every(isRecursivelyFrozen);
}

export function assertPlanIRV3(ir) {
  if (ir?.version !== PLAN_IR_V3 || ir?.source?.schemaVersion !== "pi-plan.v3") {
    throw new Error("invalid plan-ir.v3 identity");
  }
  if (!Array.isArray(ir.nodes) || ir.nodes.length === 0 || !Array.isArray(ir.edges)) {
    throw new Error("invalid plan-ir.v3 graph");
  }
  if (ir.hash !== ir.hashes?.full || !/^[a-f0-9]{64}$/.test(ir.hash)) {
    throw new Error("invalid plan-ir.v3 hash");
  }
  if (!isRecursivelyFrozen(ir)) throw new Error("plan-ir.v3 must be recursively frozen");
  return ir;
}
