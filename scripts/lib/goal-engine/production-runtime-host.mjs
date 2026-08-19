import { createHash } from "node:crypto";
import { closeSync, constants as fsConstants, existsSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync, chmodSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { captureCurrentWorld } from "./current-world.mjs";
import { prepareManagedValidation, startManagedValidation, recoverManagedValidation, inspectManagedValidation, releaseManagedValidation, stopOwnedManagedValidation } from "./managed-validation.mjs";
import { loadExecutorWorkspaceLease, inspectExecutorWorkspace, releaseExecutorWorkspace } from "./workspace.mjs";
import { stopRootBrokerGoalOwnedRun } from "../subagent-dispatch/root-broker-registry.ts";

const sha = (value) => createHash("sha256").update(value).digest("hex");
const canonical = (value) => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
const exact = (value, keys) => value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const hash = (value) => sha(JSON.stringify(canonical(value)));
const fullSha = (value) => typeof value === "string" && /^[a-f0-9]{40}$/.test(value);
const hash64 = (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const attention = Object.freeze({ state: "attention", code: "OWNED_STOP_IDENTITY_UNKNOWN" });
function safeFile(file) { const stat = lstatSync(file); if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600) throw Error("artifact identity is invalid"); return stat; }
function artifact(input) {
  if (!exact(input, ["stateRoot", "goalId", "runId", "managedTerminal"]) || !isAbsolute(input.stateRoot) || !input.managedTerminal || !exact(input.managedTerminal, ["status", "code", "signal", "output"]) || typeof input.managedTerminal.output !== "string") throw Error("Invalid artifact request");
  const root = resolve(input.stateRoot), dir = join(root, "artifacts"); mkdirSync(root, { recursive: true, mode: 0o700 }); chmodSync(root, 0o700); mkdirSync(dir, { recursive: true, mode: 0o700 }); chmodSync(dir, 0o700); const dirStat = lstatSync(dir); if (!dirStat.isDirectory() || dirStat.isSymbolicLink() || (dirStat.mode & 0o777) !== 0o700) throw Error("artifact directory is invalid");
  const bytes = Buffer.from(input.managedTerminal.output, "utf8"), id = sha(bytes), target = join(dir, id); if (existsSync(target)) { safeFile(target); if (!readFileSync(target).equals(bytes)) throw Error("artifact collision"); return { id, path: target }; }
  const temporary = join(dir, `.${id}.${process.pid}.${Date.now()}`); let fd;
  try { fd = openSync(temporary, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600); writeFileSync(fd, bytes); closeSync(fd); fd = undefined; chmodSync(temporary, 0o600); safeFile(temporary); renameSync(temporary, target); safeFile(target); }
  catch (error) { if (fd !== undefined) closeSync(fd); try { unlinkSync(temporary); } catch {} throw error; }
  return { id, path: target };
}
function workspaceRequest(request) { return exact(request, ["stateRoot", "goalId", "taskId", "attempt", "runId", "leaseId", "workspacePath", "headAtDispatch", "baseHead", "executionRevision", "contractHash", "sessionId"]) && isAbsolute(request.stateRoot) && isAbsolute(request.workspacePath) && Number.isInteger(request.attempt) && request.attempt > 0 && fullSha(request.baseHead) && hash64(request.leaseId) && hash64(request.contractHash); }
function preserveWorkspace(request, services) { if (!workspaceRequest(request)) throw Error("Invalid workspace quarantine request"); const lease = services.loadExecutorWorkspaceLease({ goalId: request.goalId, taskId: request.taskId, attempt: request.attempt, stateRoot: request.stateRoot }); if (!lease || lease.goalId !== request.goalId || lease.taskId !== request.taskId || lease.attempt !== request.attempt || lease.stateRoot !== request.stateRoot || lease.path !== request.workspacePath || lease.baseCommit !== request.baseHead || sha(lease.ownerToken) !== request.leaseId) throw Error("Executor workspace lease identity mismatch"); const inspection = services.inspectExecutorWorkspace(lease); if (!inspection || inspection.path !== lease.path || !fullSha(inspection.headCommit)) throw Error("Executor workspace inspection invalid"); const released = services.releaseExecutorWorkspace(lease, { disposition: "preserved", expectedExecutorHead: inspection.headCommit }); if (!released?.preserved || released.disposition !== "preserved") throw Error("Executor workspace preservation failed"); return { taskId: request.taskId, attempt: request.attempt, proofHash: hash({ request, lease, inspection, disposition: "preserved" }), state: "quarantined", disposition: "preserved" }; }
export function createProductionGoalRuntimeHost(pi, options = {}) {
  const facade = options.facade || { prepareManagedValidation, startManagedValidation, recoverManagedValidation, inspectManagedValidation, releaseManagedValidation, stopOwnedManagedValidation };
  const services = { loadExecutorWorkspaceLease: options.loadExecutorWorkspaceLease || loadExecutorWorkspaceLease, inspectExecutorWorkspace: options.inspectExecutorWorkspace || inspectExecutorWorkspace, releaseExecutorWorkspace: options.releaseExecutorWorkspace || releaseExecutorWorkspace };
  const registries = options.registries || Object.freeze({}); const adapterRegistry = options.adapterRegistry || Object.freeze({});
  const host = {
    registries, adapterRegistry,
    captureCurrentWorld: async (repoRoot) => (options.facade?.captureCurrentWorld || captureCurrentWorld)({ repoRoot, adapterRegistry, environmentRegistry: options.environmentRegistry || Object.freeze({}), fixtureRegistry: options.fixtureRegistry || Object.freeze({}), resourceRegistry: typeof options.resourceRegistry === "function" ? options.resourceRegistry() : (options.resourceRegistry || Object.freeze({})), runInventory: typeof options.runInventory === "function" ? options.runInventory() : (options.runInventory || []) }),
    artifactRefForRun: async (input) => artifact(input),
    prepareManagedValidation: facade.prepareManagedValidation, startManagedValidation: facade.startManagedValidation, recoverManagedValidation: facade.recoverManagedValidation, inspectManagedValidation: facade.inspectManagedValidation, releaseManagedValidation: facade.releaseManagedValidation,
    stopOwnedRun: async (binding) => { if (!exact(binding, ["runId", "asyncDir", "sessionId"]) || !binding.runId || !binding.sessionId || !isAbsolute(binding.asyncDir)) throw Error("Invalid Root Broker binding"); return (options.stopRootBrokerGoalOwnedRun || stopRootBrokerGoalOwnedRun)(pi, binding); },
    quarantineWorkspace: async (request) => preserveWorkspace(request, services),
    quarantineResource: async (request) => { if (!exact(request, ["stateRoot", "goalId", "ownerKind", "ownerId", "taskId", "attempt", "leaseId", "executionRevision", "contractHash", "sessionId"]) || request.ownerKind !== "executor") throw Error("Invalid resource quarantine request"); const lease = services.loadExecutorWorkspaceLease({ goalId: request.goalId, taskId: request.taskId, attempt: request.attempt, stateRoot: request.stateRoot }); if (!lease || lease.goalId !== request.goalId || lease.taskId !== request.taskId || lease.attempt !== request.attempt || lease.stateRoot !== request.stateRoot || sha(lease.ownerToken) !== request.leaseId) throw Error("Executor workspace lease identity mismatch"); const inspection = services.inspectExecutorWorkspace(lease); if (!inspection || inspection.path !== lease.path || !fullSha(inspection.headCommit)) throw Error("Executor workspace inspection invalid"); const released = services.releaseExecutorWorkspace(lease, { disposition: "preserved", expectedExecutorHead: inspection.headCommit }); if (!released?.preserved || released.disposition !== "preserved") throw Error("Executor workspace preservation failed"); return { ownerId: request.ownerId, proofHash: hash({ request, lease, inspection, disposition: "preserved" }), state: "quarantined", debt: true }; },
    stopManagedValidation: async (request) => { try { if (typeof facade.stopOwnedManagedValidation !== "function") return attention; return await facade.stopOwnedManagedValidation(request); } catch { return attention; } },
  };
  return Object.freeze(host);
}
