import { execFileSync } from "node:child_process";
import path from "node:path";
import { materializeSettlementEvidence } from "../../scripts/lib/goal-engine/settlement-evidence.mjs";

type Identity = { goalId: string; taskId: string; attempt: number; runId: string; contractHash: string; head: string };
type Options = { identity: Identity; expectedCriteria: string[]; cwd: string };

function failure(error: unknown) {
  return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true };
}

/** Register only inside the generated executor child entrypoint. */
export function installAcceptanceEvidence(pi: any, options: Options) {
  if (!pi || typeof pi.registerTool !== "function") throw new TypeError("child ExtensionAPI is required");
  let closed = false;
  const tool = {
    name: "submit_acceptance_evidence",
    label: "Submit acceptance evidence",
    description: "Submit canonical, bound acceptance evidence for this executor run.",
    parameters: {
      type: "object", additionalProperties: false,
      required: ["outcome", "criteria", "commandsRun", "changedFiles"],
      properties: {
        outcome: { enum: ["succeeded", "failed"] },
        criteria: {
          type: "array", minItems: 1, maxItems: 32,
          items: {
            type: "object", additionalProperties: false, required: ["id", "status", "evidence"],
            properties: {
              id: { type: "string", minLength: 1, maxLength: 160 },
              status: { type: "string", enum: ["satisfied", "not-satisfied", "not-applicable"] },
              evidence: { type: "array", minItems: 1, maxItems: 32, items: { type: "string", pattern: "^(?:sha256:[a-f0-9]{64}|cas://sha256/[a-f0-9]{64})$" } },
            },
          },
        },
        commandsRun: {
          type: "array", maxItems: 32,
          items: {
            type: "object", additionalProperties: false, required: ["command", "result", "outputRef"],
            properties: {
              command: { type: "string", minLength: 1, maxLength: 4096 },
              result: { type: "string", enum: ["passed", "failed"] },
              outputRef: { type: "string", pattern: "^(?:sha256:[a-f0-9]{64}|cas://sha256/[a-f0-9]{64})$" },
            },
          },
        },
        changedFiles: { type: "array", maxItems: 32, items: { type: "string", minLength: 1, maxLength: 4096, pattern: "^(?!/)(?!.*(?:^|/)\\.\\.(?:/|$))[^\\0\\\\]+$" } },
      },
    },
    async execute(_id: string, input: unknown) {
      if (closed) return failure(new Error("acceptance evidence runtime is closed"));
      try {
        if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("evidence must be an object");
        if (Object.hasOwn(input, "identity")) throw new Error("identity is runtime-bound and must not be supplied");
        const { outcome, ...payload } = input as Record<string, unknown>;
        const evidence = { identity: options.identity, ...payload };
        const receipt = await materializeSettlementEvidence(evidence, {
          directory: path.join(options.cwd, ".pi-subagents", "acceptance-evidence"),
          expectedIdentity: options.identity,
          expectedCriteria: options.expectedCriteria,
          outcome,
        });
        return { content: [{ type: "text", text: `Acceptance evidence recorded: ${receipt.fingerprint}` }], isError: false, details: receipt };
      } catch (error) { return failure(error); }
    },
  };
  pi.registerTool(tool);
  const dispose = () => { closed = true; };
  pi.on?.("session_shutdown", dispose);
  return Object.freeze({ dispose, get closed() { return closed; } });
}

export default function acceptanceEvidence(pi: any) {
  const config = new URL(import.meta.url).searchParams;
  const identity = JSON.parse(config.get("identity") ?? "null");
  const expectedCriteria = JSON.parse(config.get("criteria") ?? "null");
  const runId = process.env.PI_SUBAGENT_RUN_ID;
  if (!identity || !runId || !Array.isArray(expectedCriteria)) throw new Error("acceptance evidence child identity is unavailable");
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: process.cwd(), encoding: "utf8" }).trim();
  return installAcceptanceEvidence(pi, { identity: { ...identity, runId, head }, expectedCriteria, cwd: process.cwd() });
}
