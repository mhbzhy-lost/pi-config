import type { RootBrokerServer } from "./root-broker-server.ts";

const ROOT_BROKER_REGISTRY_KEY = Symbol.for("pi.root-subagent-broker-registry.v1");
const GOAL_EXECUTOR_COORDINATOR_KEY = Symbol.for("pi.goal-executor-coordinator-registry.v1");

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

function rootBrokerRegistry(): WeakMap<object, RootBrokerServer> {
  return processWeakRegistry<RootBrokerServer>(ROOT_BROKER_REGISTRY_KEY, "Root subagent broker");
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
const goalCoordinators = processWeakRegistry<GoalExecutorCoordinator>(GOAL_EXECUTOR_COORDINATOR_KEY, "Goal executor coordinator");

export function bindGoalExecutorCoordinator(pi: object, coordinator: GoalExecutorCoordinator): void {
  if (!coordinator || typeof coordinator.prepareSpawn !== "function" || typeof coordinator.bindSpawn !== "function") {
    throw new TypeError("Goal executor coordinator is invalid");
  }
  goalCoordinators.set(registryKey(pi), coordinator);
}

export function findGoalExecutorCoordinator(pi: object): GoalExecutorCoordinator | undefined {
  return goalCoordinators.get(registryKey(pi));
}

export function bindRootBroker(pi: object, broker: RootBrokerServer): void {
  const key = registryKey(pi);
  if (brokers.has(key)) throw new Error("Root subagent broker is already bound");
  brokers.set(key, broker);
}

export function requireRootBroker(pi: object): RootBrokerServer {
  const broker = brokers.get(registryKey(pi));
  if (!broker) throw new Error("Root subagent broker is unavailable");
  return broker;
}

export function inspectRootBrokerExecutorProof(pi: object, runId: string) {
  return requireRootBroker(pi).inspectExecutorProof(runId);
}

export function unbindRootBroker(pi: object, broker?: RootBrokerServer): void {
  const key = registryKey(pi);
  if (!broker || brokers.get(key) === broker) brokers.delete(key);
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
