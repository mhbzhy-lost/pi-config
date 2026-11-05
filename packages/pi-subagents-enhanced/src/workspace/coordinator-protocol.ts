import { Type } from "typebox";
// 协议校验交给官方 TypeBox 编译器（Host 公开 import 表里的 `typebox/compile`），
// 不再自维护 JSON Schema 分支遍历：旧遍历只认 const/type/pattern/anyOf，新增关键字
// （minLength/enum/items 约束等）会被静默忽略而误放行；Compile 一次编译成闭包，
// 所有已声明关键字都生效，语义仍以 schema 为唯一权威。
// pi-schema 是 Pi 1.5 的官方工具参数 validator，但增强包 manifest 未声明该依赖，
// 引入会改 package.json/package-lock 与安装闭包证据，故本轮不动（见巡检报告）。
import { Compile } from "typebox/compile";

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
const ErrorInfo = Type.Object({
  code: Type.Optional(Type.String()), keypath: Type.Optional(Type.String()),
  detail: Type.Optional(Type.Union([Type.String(), Type.Object({ state: Type.String(), allowedActions: Type.Array(Type.String()), nextAction: Type.String() }, { additionalProperties: false })])),
}, { additionalProperties: false });
const Reply = Type.Object({ protocol: Type.Literal(COORDINATOR_PROTOCOL_VERSION), requestId: Type.String(), repositoryId: Digest, ok: Type.Boolean(), result: Type.Optional(Type.Unknown()), error: Type.Optional(Type.String()), errorInfo: Type.Optional(ErrorInfo) }, { additionalProperties: false });
const RegistrationRequest = Type.Object({
  protocol: Type.Literal(COORDINATOR_PROTOCOL_VERSION), requestId: Type.String(), repositoryId: Digest,
  method: Type.Literal("broker.register"), brokerRegistry: Type.Object({
    protocol: Type.Literal("pi-root-subagent-broker-registry.v1"), rootSessionId: Type.String(), endpoint: Type.String(),
    pid: Type.Number(), processBirthIdentity: Digest,
  }, { additionalProperties: false }),
}, { additionalProperties: false });

// 每个协议 schema 只编译一次；Check 是官方编译器产出的纯闭包，不做额外缓存或改写。
const RequestValidator = Compile(Request);
const ParamsValidator = Compile(Params);
const ReplyValidator = Compile(Reply);
const RegistrationRequestValidator = Compile(RegistrationRequest);

function parse(validator: { Check(value: unknown): boolean }, value: unknown, label: string) {
  if (!validator.Check(value)) throw new TypeError(`Coordinator ${label} contains unknown field or violates strict protocol schema`);
  return structuredClone(value) as any;
}

export function parseCoordinatorRequest(value: unknown) {
  const result = parse(RequestValidator, value, "request");
  if (result.method === "workspace.attach" && !ParamsValidator.Check(result.params)) throw new TypeError("Coordinator params contains unknown field or violates strict schema");
  return result;
}

export function parseCoordinatorReply(value: unknown) { return parse(ReplyValidator, value, "reply"); }
export function parseCoordinatorRegistrationRequest(value: unknown) { return parse(RegistrationRequestValidator, value, "registration request"); }

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
