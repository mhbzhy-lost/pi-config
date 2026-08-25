import type { RootBrokerServer } from "./root-broker-server.ts";

const ROOT_BROKER_REGISTRY_KEY = Symbol.for("pi.root-subagent-broker-registry.v2");
const GOAL_EXECUTOR_COORDINATOR_KEY = Symbol.for("pi.goal-executor-coordinator-registry.v2");

type GoalExecutorCoordinator = {
  prepareSpawn: (request: any) => Promise<any> | any;
  bindSpawn: (ticket: any, binding: { runId: string; asyncDir: string }) => Promise<any> | any;
};

function processWeakRegistry<T>(key: symbol, label: string): WeakMap<object, T> {
  const descriptor = Object.getOwnPropertyDescriptor(process, key);
  if (!descriptor) {
    const registry = new WeakMap<object, T>();
    Object.defineProperty(process, key, {
      value: registry,
      enumerable: false,
      configurable: false,
      writable: false,
    });
    return registry;
  }
  if (!(descriptor.value instanceof WeakMap)) throw new Error(`${label} registry slot is invalid`);
  return descriptor.value as WeakMap<object, T>;
}

type RootBrokerRegistry = {
  exact: WeakMap<object, RootBrokerServer>;
  byRootSessionId: Map<string, RootBrokerServer>;
};

function rootBrokerRegistry(): RootBrokerRegistry {
  const descriptor = Object.getOwnPropertyDescriptor(process, ROOT_BROKER_REGISTRY_KEY);
  if (!descriptor) {
    const registry: RootBrokerRegistry = { exact: new WeakMap<object, RootBrokerServer>(), byRootSessionId: new Map<string, RootBrokerServer>() };
    Object.defineProperty(process, ROOT_BROKER_REGISTRY_KEY, {
      value: registry,
      enumerable: false,
      configurable: false,
      writable: false,
    });
    return registry;
  }
  const registry = descriptor.value;
  if (!registry || typeof registry !== "object" || !(registry.exact instanceof WeakMap) || !(registry.byRootSessionId instanceof Map)) {
    throw new Error("Root subagent broker registry slot is invalid");
  }
  return registry as RootBrokerRegistry;
}

function rootSessionIdentity(rootSessionId: unknown): string {
  if (typeof rootSessionId !== "string" || rootSessionId.trim().length === 0) {
    throw new Error("Root subagent broker root session identity is invalid");
  }
  return rootSessionId;
}

function registryKey(pi: object): object {
  if (!("events" in pi)) return pi;
  const events = (pi as { events: unknown }).events;
  if (events === null || (typeof events !== "object" && typeof events !== "function")) {
    throw new Error("Root subagent broker events identity is invalid");
  }
  return events;
}

const brokers = rootBrokerRegistry();
type GoalExecutorCoordinatorRegistry = {
  exact: WeakMap<object, GoalExecutorCoordinator>;
  byRootSessionId: Map<string, GoalExecutorCoordinator>;
};

function goalExecutorCoordinatorRegistry(): GoalExecutorCoordinatorRegistry {
  const descriptor = Object.getOwnPropertyDescriptor(process, GOAL_EXECUTOR_COORDINATOR_KEY);
  if (!descriptor) {
    const registry: GoalExecutorCoordinatorRegistry = { exact: new WeakMap<object, GoalExecutorCoordinator>(), byRootSessionId: new Map<string, GoalExecutorCoordinator>() };
    Object.defineProperty(process, GOAL_EXECUTOR_COORDINATOR_KEY, { value: registry, enumerable: false, configurable: false, writable: false });
    return registry;
  }
  const registry = descriptor.value;
  if (!registry || typeof registry !== "object" || !(registry.exact instanceof WeakMap) || !(registry.byRootSessionId instanceof Map)) {
    throw new Error("Goal executor coordinator registry slot is invalid");
  }
  return registry as GoalExecutorCoordinatorRegistry;
}

const goalCoordinators = goalExecutorCoordinatorRegistry();

function assertGoalExecutorCoordinator(coordinator: GoalExecutorCoordinator): void {
  if (!coordinator || typeof coordinator.prepareSpawn !== "function" || typeof coordinator.bindSpawn !== "function") {
    throw new TypeError("Goal executor coordinator is invalid");
  }
}

export function bindGoalExecutorCoordinator(pi: object, coordinator: GoalExecutorCoordinator): void {
  assertGoalExecutorCoordinator(coordinator);
  goalCoordinators.exact.set(registryKey(pi), coordinator);
}

export function bindGoalExecutorCoordinatorSession(pi: object, rootSessionId: string, coordinator: GoalExecutorCoordinator): void {
  assertGoalExecutorCoordinator(coordinator);
  const identity = rootSessionIdentity(rootSessionId);
  goalCoordinators.exact.set(registryKey(pi), coordinator);
  // A reload replaces the ExtensionAPI facade for the same live root session.
  // Shutdown compare-and-delete prevents the old generation from removing this alias.
  goalCoordinators.byRootSessionId.set(identity, coordinator);
}

export function findGoalExecutorCoordinator(pi: object, rootSessionId?: string): GoalExecutorCoordinator | undefined {
  const exact = goalCoordinators.exact.get(registryKey(pi));
  if (exact) return exact;
  return rootSessionId === undefined ? undefined : goalCoordinators.byRootSessionId.get(rootSessionIdentity(rootSessionId));
}

export function unbindGoalExecutorCoordinatorSession(pi: object, rootSessionId: string, coordinator?: GoalExecutorCoordinator): void {
  const identity = rootSessionIdentity(rootSessionId);
  const current = goalCoordinators.byRootSessionId.get(identity);
  if (!current || (coordinator && current !== coordinator)) return;
  goalCoordinators.byRootSessionId.delete(identity);
  const key = registryKey(pi);
  if (goalCoordinators.exact.get(key) === current) goalCoordinators.exact.delete(key);
}

export function bindRootBroker(pi: object, broker: RootBrokerServer): void {
  const key = registryKey(pi);
  const rootSessionId = rootSessionIdentity(broker?.rootSessionId);
  if (brokers.exact.has(key) || brokers.byRootSessionId.has(rootSessionId)) throw new Error("Root subagent broker is already bound");
  brokers.exact.set(key, broker);
  brokers.byRootSessionId.set(rootSessionId, broker);
}

export function requireRootBroker(pi: object, rootSessionId?: string): RootBrokerServer {
  const exact = brokers.exact.get(registryKey(pi));
  if (rootSessionId === undefined) {
    if (!exact) throw new Error("Root subagent broker is unavailable");
    return exact;
  }
  const identity = rootSessionIdentity(rootSessionId);
  if (exact) {
    if (exact.rootSessionId !== identity) throw new Error("Root subagent broker is unavailable");
    return exact;
  }
  const broker = brokers.byRootSessionId.get(identity);
  if (!broker) throw new Error("Root subagent broker is unavailable");
  return broker;
}

export async function stopRootBrokerGoalOwnedRun(pi: object, binding: { goalId: string; taskId: string; attempt: number; runId: string; asyncDir: string; workspacePath: string; leaseId: string; sessionId: string; baseHead: string; headAtDispatch: string; executionRevision: number; contractHash: string; agent: "executor" }, rootSessionId?: string) {
  return requireRootBroker(pi, rootSessionId).stopGoalOwnedRun(binding);
}

// This is intentionally an internal coordinator facade, not a dispatch tool.
export function persistGoalExecutorBindingAuthority(pi: object, authority: any, rootSessionId?: string): void {
  requireRootBroker(pi, rootSessionId).persistGoalBindingAuthority(authority);
}

export function inspectRootBrokerExecutorProof(pi: object, runId: string, rootSessionId?: string) {
  return requireRootBroker(pi, rootSessionId).inspectExecutorProof(runId);
}

export function registerRootBrokerFacadeRun(pi: object, run: { runId: string; asyncDir: string; sessionId: string; pid: number; agent: string; kind: string }, rootSessionId?: string): void {
  requireRootBroker(pi, rootSessionId).registerFacadeRun(run);
}

export function inspectRootBrokerFacadeTerminalProof(pi: object, runId: string, rootSessionId?: string) {
  return requireRootBroker(pi, rootSessionId).inspectFacadeTerminalProof(runId);
}

export function unbindRootBroker(pi: object, broker?: RootBrokerServer): void {
  const key = registryKey(pi);
  const exact = brokers.exact.get(key);
  if (broker && exact !== broker) return;
  brokers.exact.delete(key);
  if (exact && brokers.byRootSessionId.get(exact.rootSessionId) === exact) brokers.byRootSessionId.delete(exact.rootSessionId);
}

export async function closeAndUnbindRootBroker(pi: object, broker = requireRootBroker(pi)): Promise<void> {
  await broker.closeRootSession();
  unbindRootBroker(pi, broker);
}

export async function startAndBindRootBroker(pi: object, broker: RootBrokerServer): Promise<void> {
  try {
    bindRootBroker(pi, broker);
    await broker.start();
  } catch (error) {
    unbindRootBroker(pi, broker);
    await broker.closeRootSession().catch(() => undefined);
    throw error;
  }
}
