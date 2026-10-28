import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";

export type PlanRunRef = {
  runId: string;
  workspaceId: string;
  rootSessionId: string;
};

export type PlanRunFacts = {
  run: PlanRunRef;
  terminal: "pending" | "succeeded" | "failed" | "unknown";
  terminalProofRef: string | null;
  integration: "pending" | "completed" | "blocked" | "not-applicable";
  integrationReceiptRef: string | null;
  workspaceState: string;
  recovery: "none" | "typed-resume" | "manual-integration" | "unknown";
  wakeup: "subscribed" | "unavailable";
  blocker: string | null;
};

export interface PlanExecutionService {
  start(input: {
    dispatchKey: string;
    request: { agent: string; task: string; writePaths: string[];
      acceptance: { criteria: string[] }; worktree: true; cwd: string };
    ctx: ExtensionToolContext;
    onAllocated: (workspaceId: string) => Promise<void>;
    onBound: (ref: PlanRunRef) => Promise<void>;
  }): Promise<PlanRunRef>;
  resume(input: {
    previous: PlanRunRef; dispatchKey: string; message: string;
    ctx: ExtensionToolContext;
    onBound: (ref: PlanRunRef) => Promise<void>;
  }): Promise<PlanRunRef>;
  inspect(ref: PlanRunRef): Promise<PlanRunFacts>;
  subscribe(listener: (runId: string) => void): () => void;
}

// Pi 可为不同扩展创建独立 API/Jiti 实例；服务与就绪订阅均按 root 共享。
type Registry = Map<string, PlanExecutionService>;
type RegistryListeners = Map<string, Set<() => void>>;
const registryKey = Symbol.for("pi.plan-execution-services.v1");
const registryListenersKey = Symbol.for("pi.plan-execution-service-listeners.v1");
function registry(): Registry {
  const descriptor = Object.getOwnPropertyDescriptor(process, registryKey);
  if (descriptor) {
    if (!(descriptor.value instanceof Map)) {
      throw new Error("PLAN_EXECUTION_REGISTRY_INVALID");
    }
    return descriptor.value;
  }
  const value: Registry = new Map();
  Object.defineProperty(process, registryKey, { value, enumerable: false, configurable: false, writable: false });
  return value;
}
function registryListeners(): RegistryListeners {
  const descriptor = Object.getOwnPropertyDescriptor(process, registryListenersKey);
  if (descriptor) {
    if (!(descriptor.value instanceof Map)) throw new Error("PLAN_EXECUTION_LISTENER_REGISTRY_INVALID");
    return descriptor.value;
  }
  const value: RegistryListeners = new Map();
  Object.defineProperty(process, registryListenersKey, { value, enumerable: false, configurable: false, writable: false });
  return value;
}

export function getPlanExecutionService(pi: object, rootSessionId: string): PlanExecutionService | undefined {
  // pi 是扩展自身的 API facade，跨扩展按显式 root 查找；动作另验同一 live manager。
  void pi;
  return registry().get(rootSessionId);
}

export function subscribePlanExecutionService(pi: object, rootSessionId: string, listener: () => void): () => void {
  void pi;
  if (typeof rootSessionId !== "string" || rootSessionId.length === 0) throw new TypeError("PLAN_EXECUTION_ROOT_SESSION_REQUIRED");
  if (typeof listener !== "function") throw new TypeError("PLAN_EXECUTION_LISTENER_REQUIRED");
  const listeners = registryListeners();
  const set = listeners.get(rootSessionId) ?? new Set<() => void>();
  set.add(listener);
  listeners.set(rootSessionId, set);
  return () => {
    set.delete(listener);
    if (set.size === 0 && listeners.get(rootSessionId) === set) listeners.delete(rootSessionId);
  };
}

/** 仅供 package 主 Host 接线；业务消费者只取服务，不获得底层 authority。 */
export function bindPlanExecutionService(pi: object, rootSessionId: string, service: PlanExecutionService): () => void {
  void pi;
  const services = registry();
  services.set(rootSessionId, service);
  for (const listener of registryListeners().get(rootSessionId) ?? []) {
    try { listener(); } catch { /* 可选恢复通知失败不改变服务绑定事实。 */ }
  }
  return () => {
    // reload 的旧实例只能撤销自己。
    if (services.get(rootSessionId) === service) services.delete(rootSessionId);
  };
}
