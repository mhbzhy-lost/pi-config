const MANAGED_WORKSPACE_SERVICE_REGISTRY_KEY = Symbol.for("pi.managed-workspace-service-registry.v1");

export type ManagedWorkspaceService = {
  reserve: (request: any) => any;
  ensureAllocated: (request: any) => any;
  bindRun: (binding: { workspaceId: string; run: { runId: string; asyncDir: string } }) => any;
  status: (request: { workspaceId: string; terminalProof?: any }) => any;
  issueDisposition: (request: { workspaceId: string; terminalProof?: any }) => any;
  dispose: (request: any) => any;
  release: (request: { workspaceId: string }) => any;
  reconcile: (request: { originRoot?: string }) => any;
};

type Registry = {
  exact: WeakMap<object, ManagedWorkspaceService>;
  byRootSessionId: Map<string, ManagedWorkspaceService>;
};

function registry(): Registry {
  const descriptor = Object.getOwnPropertyDescriptor(process, MANAGED_WORKSPACE_SERVICE_REGISTRY_KEY);
  if (!descriptor) {
    const value: Registry = { exact: new WeakMap(), byRootSessionId: new Map() };
    Object.defineProperty(process, MANAGED_WORKSPACE_SERVICE_REGISTRY_KEY, {
      value,
      enumerable: false,
      configurable: false,
      writable: false,
    });
    return value;
  }
  const value = descriptor.value;
  if (!value || typeof value !== "object" || !(value.exact instanceof WeakMap) || !(value.byRootSessionId instanceof Map)) {
    throw new Error("Managed workspace service registry slot is invalid");
  }
  return value as Registry;
}

function key(pi: object): object {
  if (!("events" in pi)) return pi;
  const events = (pi as { events: unknown }).events;
  if (events === null || (typeof events !== "object" && typeof events !== "function")) {
    throw new Error("Managed workspace service events identity is invalid");
  }
  return events;
}

function rootSessionId(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(value) || value.includes("..")) {
    throw new Error("Managed workspace service root session identity is invalid");
  }
  return value;
}

function assertService(value: ManagedWorkspaceService): void {
  const methods = ["reserve", "ensureAllocated", "bindRun", "status", "issueDisposition", "dispose", "release", "reconcile"] as const;
  if (!value || methods.some((method) => typeof value[method] !== "function")) {
    throw new TypeError("Managed workspace service is invalid");
  }
}

const services = registry();

export function bindManagedWorkspaceService(pi: object, service: ManagedWorkspaceService): void {
  assertService(service);
  services.exact.set(key(pi), service);
}

export function bindManagedWorkspaceServiceSession(pi: object, rootSessionIdentity: string, service: ManagedWorkspaceService): void {
  assertService(service);
  const identity = rootSessionId(rootSessionIdentity);
  services.exact.set(key(pi), service);
  services.byRootSessionId.set(identity, service);
}

export function findManagedWorkspaceService(pi: object, rootSessionIdentity?: string): ManagedWorkspaceService | undefined {
  const exact = services.exact.get(key(pi));
  if (exact) return exact;
  return rootSessionIdentity === undefined ? undefined : services.byRootSessionId.get(rootSessionId(rootSessionIdentity));
}

export function unbindManagedWorkspaceServiceSession(pi: object, rootSessionIdentity: string, service?: ManagedWorkspaceService): void {
  const identity = rootSessionId(rootSessionIdentity);
  const current = services.byRootSessionId.get(identity);
  if (!current || (service && current !== service)) return;
  services.byRootSessionId.delete(identity);
  const exactKey = key(pi);
  if (services.exact.get(exactKey) === current) services.exact.delete(exactKey);
}
