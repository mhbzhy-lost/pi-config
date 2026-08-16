import assert from "node:assert/strict";
import test from "node:test";
import { recoverObservation, recordObservation } from "../scripts/lib/goal-engine/observation-runner.mjs";
test("unknown process recovery remains cleanup debt and cannot record",async()=>{const result=await recoverObservation({phase:"process_bound",managedReceipt:{id:"x"}},{recoverManagedValidation:async()=>({phase:"cleanup_debt",cleanupDebt:true})});assert.equal(result.phase,"cleanup_debt");await assert.rejects(recordObservation({projection:{},runReceipt:result,artifactRef:{},worldSnapshot:{},services:{}}),/terminal|debt/i);});
