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

export function unbindRootBroker(pi: object): void {
  brokers.delete(pi);
}
