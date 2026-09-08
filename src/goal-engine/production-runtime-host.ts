import { createHash } from "node:crypto";
import { closeSync, constants as fsConstants, existsSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { captureCurrentWorld } from "./current-world.ts";
import { createObservationAdapterRegistry } from "./observation-adapters.ts";
import { prepareManagedValidation, startManagedValidation, recoverManagedValidation, inspectManagedValidation, releaseManagedValidation, stopOwnedManagedValidation } from "./managed-validation.ts";
import { stopRootBrokerGoalOwnedRun } from "../../packages/pi-subagents-enhanced/src/subagent-dispatch/root-broker-registry.ts";
import { findManagedWorkspaceService } from "../../packages/pi-subagents-enhanced/src/workspace/registry.ts";
import { publicManagedWorkspaceReceipt } from "../../packages/pi-subagents-enhanced/src/workspace/contract.ts";

type OwnedStopBinding = { goalId: string; taskId: string; attempt: number; runId: string; asyncDir: string; workspacePath: string; leaseId: string; sessionId: string; baseHead: string; headAtDispatch: string; executionRevision: number; contractHash: string; agent: "executor" };
type ExecutorWorkspaceReceipt = { schemaVersion: "managed-workspace.v1"; workspaceId: string; leaseId: string; owner: { kind: "goal-task"; rootSessionId: string; goalId: string; taskId: string; attempt: number; executionRevision: number }; originRoot: string; requestedCwd: string; originRef: string; baseCommit: string; path: string; dispatchCwd: string; branchRef: string; state: string; run: unknown; disposition: unknown; cleanupDebt: unknown };
type ExecutorWorkspaceInspection = { headCommit: string };
type WorkspaceRelease = unknown;
type WorkspaceService = { issueDisposition: (input: unknown) => { actionToken: string }; dispose: (input: unknown) => { state: string; workspaceId: string; leaseId: string }; status: (input: unknown) => { receipt: { state: string; leaseId: string } } };
type HostFacade = { captureCurrentWorld?: (...args: unknown[]) => unknown; prepareManagedValidation?: (...args: unknown[]) => unknown; startManagedValidation?: (...args: unknown[]) => unknown; recoverManagedValidation?: (...args: unknown[]) => unknown; inspectManagedValidation?: (...args: unknown[]) => unknown; releaseManagedValidation?: (...args: unknown[]) => unknown; stopOwnedManagedValidation?: (...args: unknown[]) => unknown };
type ProductionRuntimeHostOptions = { adapters?: unknown; environments?: unknown; fixtures?: unknown; resources?: unknown; facade?: HostFacade; workspaceService?: WorkspaceService; loadExecutorWorkspaceLease?: (input: unknown) => ExecutorWorkspaceReceipt | undefined; inspectExecutorWorkspace?: (lease: ExecutorWorkspaceReceipt) => ExecutorWorkspaceInspection | undefined; releaseExecutorWorkspace?: (lease: ExecutorWorkspaceReceipt, input: unknown) => WorkspaceRelease | undefined; registries?: unknown; adapterRegistry?: unknown; environmentRegistry?: unknown; fixtureRegistry?: unknown; resourceRegistry?: unknown | (() => unknown); runInventory?: unknown | (() => unknown); stopRootBrokerGoalOwnedRun?: (pi: object, binding: OwnedStopBinding) => unknown };

function legacyWorkspaceManualRecovery() {
  throw Object.assign(new Error("legacy/manual recovery required: runtime workspace has no managed-workspace.v1 receipt"), { code: "LEGACY_WORKSPACE_MANUAL_RECOVERY" });
}

const sha = (value) => createHash("sha256").update(value).digest("hex");
const canonical = (value) => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
const exact = (value, keys) => value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const hash = (value) => sha(JSON.stringify(canonical(value)));
const fullSha = (value) => typeof value === "string" && /^[a-f0-9]{40}$/.test(value);
const hash64 = (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const attention = Object.freeze({ state: "attention", code: "OWNED_STOP_IDENTITY_UNKNOWN" });
const hostKeys = ["adapters", "environments", "fixtures", "resources"];
const safeRef = (value) => typeof value === "string" && !!value && !value.includes("\0") && !value.startsWith("/") && !value.split("/").some((part) => !part || part === "." || part === "..") && !/^[A-Za-z]:/.test(value);
const registryRow = (value) => exact(value, ["fingerprint", "available"]) && typeof value.fingerprint === "string" && !!value.fingerprint && typeof value.available === "boolean";
const resourceRow = (value) => exact(value, ["capacity", "holders"]) && Number.isSafeInteger(value.capacity) && value.capacity >= 0 && Array.isArray(value.holders) && value.holders.every((holder) => typeof holder === "string" && !!holder) && new Set(value.holders).size === value.holders.length;
const validationPlan = (plan) => exact(plan, ["schema", "limits", "actions"]) && plan.schema === "dispatch-ir.v1.validation-plan" && exact(plan.limits, ["timeoutMs", "maxOutputBytes", "terminationGraceMs", "maxConcurrentWorkspaces"]) && Number.isInteger(plan.limits.timeoutMs) && plan.limits.timeoutMs >= 50 && plan.limits.timeoutMs <= 1800000 && Number.isInteger(plan.limits.maxOutputBytes) && plan.limits.maxOutputBytes >= 1 && plan.limits.maxOutputBytes <= 1000000 && Number.isInteger(plan.limits.terminationGraceMs) && plan.limits.terminationGraceMs >= 50 && plan.limits.terminationGraceMs <= 5000 && Number.isInteger(plan.limits.maxConcurrentWorkspaces) && plan.limits.maxConcurrentWorkspaces >= 1 && plan.limits.maxConcurrentWorkspaces <= 4 && Array.isArray(plan.actions) && plan.actions.length >= 1 && plan.actions.length <= 16 && plan.actions.every((action) => exact(action, ["id", "kind", "executable", "args"]) && typeof action.id === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(action.id) && ["setup", "validation"].includes(action.kind) && typeof action.executable === "string" && isAbsolute(action.executable) && Array.isArray(action.args) && action.args.every((arg) => typeof arg === "string" && !arg.includes("\0") && Buffer.byteLength(arg) <= 8192)) && new Set(plan.actions.map((action) => action.id)).size === plan.actions.length && plan.actions.some((action) => action.kind === "validation");
export function normalizeProductionRuntimeHostOptions(value) {
  if (!exact(value, hostKeys) || !Array.isArray(value.adapters) || !value.adapters.every((adapter) => safeRef(adapter?.ref) && validationPlan(adapter?.validationPlan)) || !value.environments || typeof value.environments !== "object" || Array.isArray(value.environments) || !value.fixtures || typeof value.fixtures !== "object" || Array.isArray(value.fixtures) || !value.resources || typeof value.resources !== "object" || Array.isArray(value.resources) || Object.entries(value.environments).some(([ref, row]) => !safeRef(ref) || !registryRow(row)) || Object.entries(value.fixtures).some(([ref, row]) => !safeRef(ref) || !registryRow(row)) || Object.entries(value.resources).some(([key, row]) => !safeRef(key) || !resourceRow(row))) throw Error("Invalid production runtime Host settings");
  createObservationAdapterRegistry(value.adapters);
  return structuredClone(value);
}
function configuredRegistries(options) {
  if (!Object.hasOwn(options, "adapters")) return null;
  const config = normalizeProductionRuntimeHostOptions(Object.fromEntries(hostKeys.map((key) => [key, options[key]])));
  return { config, registries: Object.freeze({ adapters: Object.freeze(Object.fromEntries(config.adapters.map(({ ref, deterministic }) => [ref, Object.freeze({ deterministic })]))), environments: Object.freeze(structuredClone(config.environments)), fixtures: Object.freeze(structuredClone(config.fixtures)) }), adapterRegistry: createObservationAdapterRegistry(config.adapters), worldAdapterRegistry: Object.freeze(Object.fromEntries(config.adapters.map(({ ref, version }) => [ref, Object.freeze({ version })]))) };
}
function safeFile(file) { const stat = lstatSync(file); if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600) throw Error("artifact identity is invalid"); return stat; }
function sameNode(left, right) { return left.dev === right.dev && left.ino === right.ino; }
function readSafe(file) { const before = safeFile(file); const fd = openSync(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW); try { const held = fstatSync(fd); const bytes = readFileSync(fd); const after = safeFile(file); if (!sameNode(before, held) || !sameNode(held, after) || held.size !== after.size) throw Error("artifact identity changed during read"); return bytes; } finally { closeSync(fd); } }
function sync(file) { const fd = openSync(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW); try { fsyncSync(fd); } finally { closeSync(fd); } }
function validTerminal(value) { return exact(value, ["status", "code", "signal", "output", "outputBytes", "truncated", "terminal", "pid", "pidBirthIdentity", "processGroupTerminalProof", "workspaceClean"]) && ["passed", "failed", "timed_out"].includes(value.status) && (value.code === null || Number.isSafeInteger(value.code)) && (value.signal === null || typeof value.signal === "string") && typeof value.output === "string" && Number.isSafeInteger(value.outputBytes) && value.outputBytes === Buffer.byteLength(value.output, "utf8") && typeof value.truncated === "boolean" && value.terminal === true && Number.isSafeInteger(value.pid) && value.pid > 0 && hash64(value.pidBirthIdentity) && hash64(value.processGroupTerminalProof) && value.workspaceClean === true; }
function artifact(input) {
  if (!exact(input, ["stateRoot", "goalId", "runId", "managedTerminal"]) || !isAbsolute(input.stateRoot) || !input.goalId || !input.runId || !validTerminal(input.managedTerminal)) throw Error("Invalid artifact request");
  const root = resolve(input.stateRoot); if (!existsSync(root)) throw Error("artifact state root is unavailable"); const rootStat = lstatSync(root); if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || (rootStat.mode & 0o777) !== 0o700) throw Error("artifact state root is invalid");
  const dir = join(root, "artifacts"); try { mkdirSync(dir, { mode: 0o700 }); } catch (error) { if (error?.code !== "EEXIST") throw error; } const dirStat = lstatSync(dir); if (!dirStat.isDirectory() || dirStat.isSymbolicLink() || (dirStat.mode & 0o777) !== 0o700) throw Error("artifact directory is invalid");
  const bytes = Buffer.from(input.managedTerminal.output, "utf8"), id = sha(bytes), target = join(dir, id); if (existsSync(target)) { if (!readSafe(target).equals(bytes)) throw Error("artifact collision"); return { id, path: target }; }
  const temporary = join(dir, `.${id}.${process.pid}.${Date.now()}`); let fd;
  try { fd = openSync(temporary, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600); writeFileSync(fd, bytes); fsyncSync(fd); closeSync(fd); fd = undefined; safeFile(temporary); try { linkSync(temporary, target); sync(dir); unlinkSync(temporary); } catch (error) { if (error?.code !== "EEXIST") throw error; if (!readSafe(target).equals(bytes)) throw Error("artifact collision"); } safeFile(target); }
  catch (error) { if (fd !== undefined) closeSync(fd); try { unlinkSync(temporary); } catch {} throw error; }
  try { unlinkSync(temporary); } catch {} return { id, path: target };
}
const ownedStopKeys = ["goalId", "taskId", "attempt", "runId", "asyncDir", "workspacePath", "leaseId", "sessionId", "baseHead", "headAtDispatch", "executionRevision", "contractHash", "agent"];
function ownedStopAuthority(binding) { return exact(binding, ownedStopKeys) && typeof binding.goalId === "string" && !!binding.goalId && typeof binding.taskId === "string" && !!binding.taskId && Number.isSafeInteger(binding.attempt) && binding.attempt > 0 && typeof binding.runId === "string" && !!binding.runId && isAbsolute(binding.asyncDir) && isAbsolute(binding.workspacePath) && hash64(binding.leaseId) && typeof binding.sessionId === "string" && !!binding.sessionId && fullSha(binding.baseHead) && fullSha(binding.headAtDispatch) && Number.isSafeInteger(binding.executionRevision) && binding.executionRevision > 0 && hash64(binding.contractHash) && binding.agent === "executor"; }
function workspaceRequest(request) { return exact(request, ["stateRoot", "goalId", "taskId", "attempt", "runId", "leaseId", "workspacePath", "headAtDispatch", "baseHead", "executionRevision", "contractHash", "sessionId"]) && isAbsolute(request.stateRoot) && isAbsolute(request.workspacePath) && typeof request.goalId === "string" && !!request.goalId && typeof request.taskId === "string" && !!request.taskId && typeof request.runId === "string" && !!request.runId && typeof request.sessionId === "string" && !!request.sessionId && Number.isInteger(request.attempt) && request.attempt > 0 && Number.isInteger(request.executionRevision) && request.executionRevision > 0 && fullSha(request.headAtDispatch) && fullSha(request.baseHead) && hash64(request.leaseId) && hash64(request.contractHash); }
const publicReceiptKeys = ["schemaVersion", "workspaceId", "leaseId", "owner", "originRoot", "requestedCwd", "originRef", "baseCommit", "path", "dispatchCwd", "branchRef", "state", "run", "disposition", "cleanupDebt"];
function publicReceipt(value) {
  if (!exact(value, publicReceiptKeys)) return undefined;
  try { return publicManagedWorkspaceReceipt(value); } catch { return undefined; }
}
function leaseIdentity(receipt, request) {
  return receipt.owner.kind === "goal-task" && receipt.owner.goalId === request.goalId && receipt.owner.taskId === request.taskId && receipt.owner.attempt === request.attempt && receipt.owner.executionRevision === request.executionRevision && receipt.leaseId === request.leaseId;
}
function validPreservationReceipt(value, lease, inspection) {
  const receipt = publicReceipt(value);
  return !!receipt && receipt.state === "preserved" && receipt.workspaceId === lease.workspaceId && receipt.leaseId === lease.leaseId && hash(receipt.owner) === hash(lease.owner) && receipt.originRoot === lease.originRoot && receipt.requestedCwd === lease.requestedCwd && receipt.originRef === lease.originRef && receipt.baseCommit === lease.baseCommit && receipt.path === lease.path && receipt.dispatchCwd === lease.dispatchCwd && receipt.branchRef === lease.branchRef && fullSha(inspection.headCommit);
}
function preserveWorkspace(request, services) {
  if (typeof request?.workspaceId === "string") {
    const service = services.workspaceService;
    if (!service) throw Error("Managed workspace service is unavailable");
    const issued = service.issueDisposition({ workspaceId: request.workspaceId, terminalProof: { state: "pending" } });
    const receipt = service.dispose({ workspaceId: request.workspaceId, terminalProof: { state: "pending" }, disposition: "preserve", reason: "Goal quarantine after owned executor stop", actionToken: issued.actionToken });
    if (receipt.state !== "preserved" || receipt.workspaceId !== request.workspaceId || receipt.leaseId !== request.leaseId) throw Error("Managed workspace preservation receipt mismatch");
    return { taskId: request.taskId, attempt: request.attempt, proofHash: hash(receipt), state: "quarantined", disposition: "preserved" };
  }
  if (!workspaceRequest(request)) throw Error("Invalid workspace quarantine request");
  const loaded = services.loadExecutorWorkspaceLease({ goalId: request.goalId, taskId: request.taskId, attempt: request.attempt, stateRoot: request.stateRoot });
  const lease = publicReceipt(loaded);
  if (!lease || lease.path !== request.workspacePath || lease.baseCommit !== request.headAtDispatch || !leaseIdentity(lease, request)) throw Error("Executor workspace lease identity mismatch");
  const inspection = services.inspectExecutorWorkspace(lease);
  if (!inspection || !fullSha(inspection.headCommit)) throw Error("Executor workspace inspection invalid");
  // preserveManagedWorktree is durable and idempotent.  Recalling it after a
  // restart re-reads its manifest rather than trusting Host process memory.
  const released = services.releaseExecutorWorkspace(lease, { disposition: "preserved", expectedExecutorHead: inspection.headCommit });
  if (!validPreservationReceipt(released, lease, inspection)) throw Error("Executor workspace preservation receipt is invalid");
  return { taskId: request.taskId, attempt: request.attempt, proofHash: hash({ request, receipt: released }), state: "quarantined", disposition: "preserved" };
}
function resourceRequest(request) { return exact(request, ["stateRoot", "goalId", "ownerKind", "ownerId", "taskId", "attempt", "leaseId", "executionRevision", "contractHash", "sessionId"]) && isAbsolute(request.stateRoot) && typeof request.goalId === "string" && !!request.goalId && request.ownerKind === "executor" && typeof request.ownerId === "string" && !!request.ownerId && typeof request.taskId === "string" && !!request.taskId && typeof request.sessionId === "string" && !!request.sessionId && Number.isInteger(request.attempt) && request.attempt > 0 && Number.isInteger(request.executionRevision) && request.executionRevision > 0 && hash64(request.leaseId) && hash64(request.contractHash); }
function preserveResource(request, services) {
  if (typeof request?.workspaceId === "string") {
    const service = services.workspaceService;
    if (!service) throw Error("Managed workspace service is unavailable");
    const snapshot = service.status({ workspaceId: request.workspaceId });
    if (snapshot.receipt.state !== "preserved" || snapshot.receipt.leaseId !== request.leaseId) throw Error("Managed workspace resource receipt mismatch");
    return { ownerId: request.ownerId, proofHash: hash(snapshot.receipt), state: "quarantined", debt: true };
  }
  if (!resourceRequest(request)) throw Error("Invalid resource quarantine request");
  const loaded = services.loadExecutorWorkspaceLease({ goalId: request.goalId, taskId: request.taskId, attempt: request.attempt, stateRoot: request.stateRoot });
  const lease = publicReceipt(loaded);
  if (!lease || !leaseIdentity(lease, request)) throw Error("Executor workspace lease identity mismatch");
  const inspection = services.inspectExecutorWorkspace(lease);
  if (!inspection || !fullSha(inspection.headCommit)) throw Error("Executor workspace inspection invalid");
  const released = lease.state === "preserved" ? lease : services.releaseExecutorWorkspace(lease, { disposition: "preserved", expectedExecutorHead: inspection.headCommit });
  if (!validPreservationReceipt(released, lease, inspection)) throw Error("Executor workspace preservation receipt is invalid");
  return { ownerId: request.ownerId, proofHash: hash({ request, receipt: released }), state: "quarantined", debt: true };
}
/** Composes Host capabilities without transferring adapter authority. */
export function createProductionGoalRuntimeHost(pi: object, options: ProductionRuntimeHostOptions = {}) {
  const facade = options.facade || { prepareManagedValidation, startManagedValidation, recoverManagedValidation, inspectManagedValidation, releaseManagedValidation, stopOwnedManagedValidation };
  const services = { workspaceService: options.workspaceService || findManagedWorkspaceService(pi), loadExecutorWorkspaceLease: options.loadExecutorWorkspaceLease || legacyWorkspaceManualRecovery, inspectExecutorWorkspace: options.inspectExecutorWorkspace || legacyWorkspaceManualRecovery, releaseExecutorWorkspace: options.releaseExecutorWorkspace || legacyWorkspaceManualRecovery };
  const stopRootBroker: (pi: object, binding: OwnedStopBinding) => unknown = options.stopRootBrokerGoalOwnedRun || stopRootBrokerGoalOwnedRun;
  const configured = configuredRegistries(options);
  const registries = configured?.registries || options.registries || Object.freeze({}); const adapterRegistry = configured?.adapterRegistry || options.adapterRegistry || Object.freeze({});
  const environmentRegistry = configured?.config.environments || options.environmentRegistry || Object.freeze({}); const fixtureRegistry = configured?.config.fixtures || options.fixtureRegistry || Object.freeze({});
  const configuredResources = configured?.config.resources;
  const host = {
    registries, adapterRegistry,
    captureCurrentWorld: (input) => {
      if (!exact(input, ["cwd"]) || typeof input.cwd !== "string" || !input.cwd || !isAbsolute(input.cwd)) throw Error("Invalid CurrentWorld request");
      return (facade.captureCurrentWorld || captureCurrentWorld)({ repoRoot: input.cwd, adapterRegistry: configured?.worldAdapterRegistry || adapterRegistry, environmentRegistry: structuredClone(environmentRegistry), fixtureRegistry: structuredClone(fixtureRegistry), resourceRegistry: structuredClone(typeof options.resourceRegistry === "function" ? options.resourceRegistry() : (configuredResources || options.resourceRegistry || Object.freeze({}))), runInventory: typeof options.runInventory === "function" ? options.runInventory() : (options.runInventory || []) });
    },
    artifactRefForRun: async (input) => artifact(input),
    prepareManagedValidation: facade.prepareManagedValidation, startManagedValidation: facade.startManagedValidation, recoverManagedValidation: facade.recoverManagedValidation, inspectManagedValidation: facade.inspectManagedValidation, releaseManagedValidation: facade.releaseManagedValidation,
    // This is an internal Store-derived authority boundary.  In particular, do
    // not downgrade it to a runId/dir/session convenience call on reload.
    stopOwnedRun: async (binding) => { if (!ownedStopAuthority(binding)) throw Error("Invalid Root Broker binding"); return stopRootBroker(pi, binding); },
    quarantineWorkspace: async (request) => preserveWorkspace(request, services),
    quarantineResource: async (request) => preserveResource(request, services),
    stopManagedValidation: async (request) => { try { if (typeof facade.stopOwnedManagedValidation !== "function") return attention; return await facade.stopOwnedManagedValidation(request); } catch { return attention; } },
  };
  return Object.freeze(host);
}
