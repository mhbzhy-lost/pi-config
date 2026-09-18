import { Type } from "typebox";

export const COORDINATOR_PROTOCOL_VERSION = "repository-workspace-coordinator.v1";
export const INTEGRATION_QUEUE_RECORD_VERSION = "workspace-integration-queue-item.v1";
export type WorkspaceOwnerScope = { kind: "standalone-subagent"; rootSessionId: string };
export type IntegrationQueueReceipt = {
  version: typeof INTEGRATION_QUEUE_RECORD_VERSION;
  queueItemId: string;
  repositoryId: string;
  sequence: number;
  workspaceId: string;
  leaseId: string;
  ownerScope: WorkspaceOwnerScope;
  strategy: "rebase-ff";
  targetRef: string;
  authorizedWorkspaceHead: string;
  observedTargetHead: string;
  admittedTargetHead?: string;
  candidateHead?: string;
  claimRevision?: number;
  admissionGeneration: number;
  integrationIntentId?: string;
  workspaceDispositionReceiptId?: string;
  attempt: number;
  state: "queued" | "admitted" | "rebasing" | "resolving-conflict" | "prepared" | "completed" | "blocked" | "preserved" | "cancelled";
};
const Digest = Type.String({ pattern: "^[a-f0-9]{64}$" });
const Owner = Type.Object({ kind: Type.Literal("standalone-subagent"), rootSessionId: Type.String() }, { additionalProperties: false });
const Params = Type.Object({ workspaceId: Type.String(), owner: Owner }, { additionalProperties: false });
const Request = Type.Object({
  protocol: Type.Literal(COORDINATOR_PROTOCOL_VERSION), requestId: Type.String(), repositoryId: Digest,
  role: Type.Union([Type.Literal("root-broker"), Type.Literal("root-host"), Type.Literal("admin"), Type.Literal("coordinator-internal")]),
  capability: Digest, method: Type.String(), params: Type.Record(Type.String(), Type.Unknown()),
}, { additionalProperties: false });
const Reply = Type.Object({ protocol: Type.Literal(COORDINATOR_PROTOCOL_VERSION), requestId: Type.String(), repositoryId: Digest, ok: Type.Boolean(), result: Type.Optional(Type.Unknown()), error: Type.Optional(Type.String()) }, { additionalProperties: false });
const RegistrationRequest = Type.Object({
  protocol: Type.Literal(COORDINATOR_PROTOCOL_VERSION), requestId: Type.String(), repositoryId: Digest,
  method: Type.Literal("broker.register"), brokerRegistry: Type.Object({
    protocol: Type.Literal("pi-root-subagent-broker-registry.v1"), rootSessionId: Type.String(), endpoint: Type.String(),
    pid: Type.Number(), processBirthIdentity: Digest,
  }, { additionalProperties: false }),
}, { additionalProperties: false });

function parse(schema: any, value: unknown, label: string) {
  if (!strictCheck(schema, value)) throw new TypeError(`Coordinator ${label} contains unknown field or violates strict protocol schema`);
  return structuredClone(value) as any;
}

function strictCheck(schema: any, value: any): boolean {
  if (schema.const !== undefined) return value === schema.const;
  if (schema.type === "object") {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
    if (!schema.properties) return true;
    return Object.keys(value).every((key) => schema.properties[key] !== undefined)
      && Object.entries(schema.properties).every(([key, child]: any) => value[key] === undefined ? schema.required?.includes(key) !== true : strictCheck(child, value[key]));
  }
  if (schema.type === "string") return typeof value === "string" && (!schema.pattern || new RegExp(schema.pattern).test(value));
  if (schema.type === "number") return typeof value === "number" && Number.isFinite(value);
  if (schema.type === "boolean") return typeof value === "boolean";
  if (schema.anyOf) return schema.anyOf.some((child: any) => strictCheck(child, value));
  return true;
}

export function parseCoordinatorRequest(value: unknown) {
  const result = parse(Request, value, "request");
  if (result.method === "workspace.attach" && !strictCheck(Params, result.params)) throw new TypeError("Coordinator params contains unknown field or violates strict schema");
  return result;
}

export function parseCoordinatorReply(value: unknown) { return parse(Reply, value, "reply"); }
export function parseCoordinatorRegistrationRequest(value: unknown) { return parse(RegistrationRequest, value, "registration request"); }

const permissions: Record<string, string[]> = {
  "root-broker": ["workspace.attach", "workspace.detach", "binding.register", "binding.revoke", "terminal.submit", "receipt.query", "queue.audit", "bind_run", "record_terminal_proof"],
  "root-host": ["workspace.status", "receipt.query"],
  admin: ["queue.audit", "workspace.audit", "workspace.reconcile", "authorized_reconcile"],
  "coordinator-internal": ["queue.claim", "queue.publish", "queue.fail"],
};

export function authorizeCoordinatorRequest(value: unknown, trusted: any) {
  const request = parseCoordinatorRequest(value);
  if (!trusted || request.repositoryId !== trusted.repositoryId) throw new TypeError("Coordinator repository scope mismatch");
  if (request.capability !== trusted.capability) throw new TypeError("Coordinator capability mismatch");
  if (request.role !== trusted.role || !permissions[request.role]?.includes(request.method)) throw new TypeError("Coordinator permission denied");
  if (request.role === "admin" && (request.method === "workspace.reconcile" || request.method === "authorized_reconcile") && !trusted.adminLeaseAuthorized) throw new TypeError("Coordinator admin authorization required");
  if (request.role === "coordinator-internal" && !trusted.internalWorker) throw new TypeError("Coordinator internal worker required");
  if (request.role === "root-broker" && request.params?.workspaceId && trusted.childBindings && !trusted.childBindings.has(request.params.workspaceId) && request.method.startsWith("queue.")) throw new TypeError("Coordinator child binding denied");
  if (request.role === "root-broker" && (request.method === "bind_run" || request.method === "record_terminal_proof")) {
    const owner = request.params?.owner;
    if (!owner || owner.kind !== trusted.ownerScope?.kind || owner.rootSessionId !== trusted.ownerScope?.rootSessionId) throw new TypeError("Coordinator foreign owner scope denied");
  }
  return Object.freeze({ request, ownerScope: trusted.ownerScope });
}
