import { chmodSync, existsSync, mkdirSync, openSync, closeSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { startManagedValidation } from "../../../src/goal-engine/managed-validation.ts";

const [mode, receiptText, handshake] = process.argv.slice(2);
if (!['before_process_ack', 'action_running', 'terminal_bound'].includes(mode) || !receiptText || !handshake) throw Error("mode, public receipt and handshake path are required");
const receipt = JSON.parse(receiptText);
if (!receipt || typeof receipt.id !== "string" || typeof receipt.stateRoot !== "string") throw Error("invalid public receipt");
mkdirSync(dirname(handshake), { recursive: true, mode: 0o700 });
function signal(value) { const fd = openSync(handshake, "wx", 0o600); try { writeFileSync(fd, JSON.stringify(value)); } finally { closeSync(fd); } chmodSync(handshake, 0o600); }
function waitForever() { setTimeout(() => process.exitCode = 124, 30_000).unref(); return new Promise(() => {}); }
await startManagedValidation(receipt, {
  onProcessBound: async (bound) => {
    if (mode !== "before_process_ack") return;
    signal({ phase: "process_bound", pid: bound.pid });
    await waitForever();
  },
  onTerminalBound: async () => {
    if (mode !== "terminal_bound") return;
    signal({ phase: "terminal_bound" });
    await waitForever();
  },
});
