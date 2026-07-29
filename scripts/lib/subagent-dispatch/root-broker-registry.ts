import type { RootBrokerServer } from "./root-broker-server.ts";

const brokers = new WeakMap<object, RootBrokerServer>();

export function bindRootBroker(pi: object, broker: RootBrokerServer): void {
  if (brokers.has(pi)) throw new Error("Root subagent broker is already bound");
  brokers.set(pi, broker);
}

export function requireRootBroker(pi: object): RootBrokerServer {
  const broker = brokers.get(pi);
  if (!broker) throw new Error("Root subagent broker is unavailable");
  return broker;
}

export function unbindRootBroker(pi: object, broker?: RootBrokerServer): void {
  if (!broker || brokers.get(pi) === broker) brokers.delete(pi);
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
