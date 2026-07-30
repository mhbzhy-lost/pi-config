import type { RootBrokerServer } from "./root-broker-server.ts";

const ROOT_BROKER_REGISTRY_KEY = Symbol.for("pi.root-subagent-broker-registry.v1");

function rootBrokerRegistry(): WeakMap<object, RootBrokerServer> {
  const descriptor = Object.getOwnPropertyDescriptor(process, ROOT_BROKER_REGISTRY_KEY);
  if (!descriptor) {
    const registry = new WeakMap<object, RootBrokerServer>();
    Object.defineProperty(process, ROOT_BROKER_REGISTRY_KEY, {
      value: registry,
      enumerable: false,
      configurable: false,
      writable: false,
    });
    return registry;
  }
  if (!(descriptor.value instanceof WeakMap)) {
    throw new Error("Root subagent broker registry slot is invalid");
  }
  return descriptor.value as WeakMap<object, RootBrokerServer>;
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

export function unbindRootBroker(pi: object, broker?: RootBrokerServer): void {
  const key = registryKey(pi);
  if (!broker || brokers.get(key) === broker) brokers.delete(key);
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
