import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { startManagedValidation } from "../../../scripts/lib/goal-engine/managed-validation.mjs";

const [receiptText, handshake] = process.argv.slice(2);
if (!receiptText || !handshake) throw Error("public receipt and handshake path are required");
const receipt = JSON.parse(receiptText);
if (!receipt || typeof receipt.id !== "string" || typeof receipt.stateRoot !== "string") throw Error("invalid public receipt");
mkdirSync(dirname(handshake), { recursive: true, mode: 0o700 });
await startManagedValidation(receipt, { onProcessBound: async (bound) => {
  writeFileSync(handshake, JSON.stringify({ phase: "process_bound", pid: bound.pid }), { mode: 0o600, flag: "wx" });
  chmodSync(handshake, 0o600);
  await new Promise(() => {});
} });
