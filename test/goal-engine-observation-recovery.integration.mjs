import assert from "node:assert/strict";
import test from "node:test";
const api = await import("../scripts/lib/goal-engine/observation-runner.mjs").catch(() => ({}));
test("unknown process recovery remains cleanup debt and cannot record or release",async()=>{ assert.equal(typeof api.recoverObservation,"function"); const receipt={phase:"process_bound",managedReceipt:{id:"x"}}; const result=await api.recoverObservation(receipt,{recoverManagedValidation:async()=>({phase:"cleanup_debt",cleanupDebt:true})}); assert.equal(result.phase,"cleanup_debt"); assert.throws(()=>api.recordObservation({projection:{},runReceipt:result,artifactRef:{},worldSnapshot:{},services:{}}),/terminal|debt/i); });
