import { createRootBrokerClient } from "../src/subagent-dispatch/root-broker-client.ts";

type BrokerClient = {
  submitAcceptanceEvidence(input: Record<string, unknown>): Promise<unknown> | unknown;
  dispose?: () => void;
};
type Options = {
  client: BrokerClient;
  clock?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  retryWindowMs?: number;
  retryIntervalMs?: number;
};

function failure(error: unknown) {
  return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true };
}

/** Register only inside the generated executor child entrypoint. */
export function installAcceptanceEvidence(pi: any, options: Options) {
  if (!pi || typeof pi.registerTool !== "function") throw new TypeError("child ExtensionAPI is required");
  if (!options?.client || typeof options.client.submitAcceptanceEvidence !== "function") throw new TypeError("authenticated Root broker client is required");
  const clock = options.clock ?? Date.now;
  const sleep = options.sleep ?? ((milliseconds) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const retryWindowMs = options.retryWindowMs ?? 5_000;
  const retryIntervalMs = options.retryIntervalMs ?? 25;
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
        const startedAt = clock();
        let receipt: any;
        for (;;) {
          try {
            receipt = await options.client.submitAcceptanceEvidence(input as Record<string, unknown>);
            break;
          } catch (error: any) {
            if (error?.code !== "CONTEXT_NOT_READY" || closed || clock() - startedAt >= retryWindowMs) throw error;
            await sleep(retryIntervalMs);
          }
        }
        return { content: [{ type: "text", text: `Acceptance evidence recorded: ${receipt.fingerprint}` }], isError: false, details: receipt };
      } catch (error) { return failure(error); }
    },
  };
  pi.registerTool(tool);
  const dispose = () => {
    if (closed) return;
    closed = true;
    options.client.dispose?.();
  };
  pi.on?.("session_shutdown", dispose);
  return Object.freeze({ dispose, get closed() { return closed; } });
}

export default function acceptanceEvidence(pi: any) {
  const rootSessionId = process.env.PI_SUBAGENT_ORCHESTRATOR_SESSION_ID;
  const runId = process.env.PI_SUBAGENT_RUN_ID;
  if (!rootSessionId || !runId) throw new Error("acceptance evidence broker identity is unavailable");
  return installAcceptanceEvidence(pi, { client: createRootBrokerClient({ rootSessionId, callerRunId: runId }) });
}
