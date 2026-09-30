import { createRootBrokerClient } from "../src/subagent-dispatch/root-broker-client.ts";

const RETRY_DEADLINE_MS = 5_000;
const RETRY_DELAY_MS = 25;

type Options = {
  env?: NodeJS.ProcessEnv;
  createClient?: typeof createRootBrokerClient;
  clock?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  setInterval?: typeof setInterval;
  clearInterval?: typeof clearInterval;
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  pid?: number;
};

export default function rootSessionOwner(pi: any) {
  installRootSessionOwnerLifecycle(pi);
}

export function installRootSessionOwnerLifecycle(pi: any, options: Options = {}) {
  let owner: Awaited<ReturnType<typeof installRootSessionOwner>> | undefined;
  let started = false;
  let disposed = false;
  pi.on("session_start", async () => {
    if (started) throw new Error("Root session owner is already started");
    started = true;
    try {
      owner = await installRootSessionOwner(pi, options);
    } catch (error) {
      started = false;
      throw error;
    }
  });
  pi.on("session_shutdown", () => {
    if (disposed) return;
    disposed = true;
    owner?.dispose();
    owner = undefined;
  });
}

export async function installRootSessionOwner(pi: any, options: Options = {}) {
  const env = options.env ?? process.env;
  const enabled = env.PI_ROOT_SUBAGENT_BROKER_ENABLED === "1";
  const rootSessionId = env.PI_SUBAGENT_ORCHESTRATOR_SESSION_ID;
  const callerRunId = env.PI_SUBAGENT_RUN_ID;
  if (!enabled) return Object.freeze({ dispose() {} });
  // 宿主 broker marker 可经环境继承到 generic child；只有完整 child 身份才能绑定 Root ownership。
  if (!rootSessionId && !callerRunId) {
    try { console.error("[subagent-root-owner] root ownership disabled: child broker identity unavailable"); } catch { /* 诊断不影响 generic child */ }
    return Object.freeze({ dispose() {} });
  }
  if (!rootSessionId || !callerRunId) throw new Error("Root ownership requires PI_SUBAGENT_RUN_ID and PI_SUBAGENT_ORCHESTRATOR_SESSION_ID");
  const createClient = options.createClient ?? createRootBrokerClient;
  const client = createClient({ rootSessionId, callerRunId, requiredCapability: "root.subscribe" });
  const clock = options.clock ?? Date.now;
  const sleep = options.sleep ?? ((milliseconds) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const kill = options.kill ?? process.kill;
  const pid = options.pid ?? process.pid;
  const deadline = clock() + RETRY_DEADLINE_MS;
  let subscription: any;
  let terminating = false;
  let terminationReason: "authority_lease_expired" | "explicit_stop" | "subscription_eof" | undefined;
  let expiresAt: number | undefined;
  let ownerGeneration: number | undefined;
  const setExpiryInterval = options.setInterval ?? setInterval;
  const clearExpiryInterval = options.clearInterval ?? clearInterval;
  let expiryTimer: ReturnType<typeof setInterval> | undefined;

  const terminate = async (reason: "authority_lease_expired" | "explicit_stop" | "subscription_eof" = "authority_lease_expired") => {
    if (terminating) return;
    terminating = true;
    terminationReason = reason;
    kill(pid, "SIGTERM");
  };

  for (;;) {
    try {
      subscription = await client.subscribe((push: any) => {
        if (push.type === "root.closing") void terminate("explicit_stop");
        if (push.type === "lease.updated"
          && push.data?.runId === callerRunId
          && Number.isSafeInteger(push.data.ownerGeneration) && push.data.ownerGeneration > 0
          && (ownerGeneration === undefined || push.data.ownerGeneration >= ownerGeneration)
          && Number.isFinite(push.data.lastRenewedAt) && Number.isFinite(push.data.expiresAt)
          && push.data.lastRenewedAt <= clock()
          && push.data.expiresAt >= push.data.lastRenewedAt
          && (expiresAt === undefined || push.data.expiresAt >= expiresAt)) {
          ownerGeneration = push.data.ownerGeneration;
          expiresAt = push.data.expiresAt;
        }
        // Recovery notifications are intentionally consumed as durable
        // observations by the root owner; the broker has already persisted the
        // event and no model wake-up is needed here.
        if (push.type === "recovery.event") void Promise.resolve(pi.sendMessage?.({
          customType: "pi-root-recovery-event-v1",
          content: "Recovery event observed by root session.",
          details: push.data,
        })).catch(() => {});
      });
      break;
    } catch (error: any) {
      if (error?.code !== "GRANT_NOT_READY" || clock() >= deadline) {
        client.dispose();
        throw error;
      }
      await sleep(RETRY_DELAY_MS);
    }
  }
  expiryTimer = setExpiryInterval(() => { if (!terminating && expiresAt !== undefined && clock() >= expiresAt) void terminate("authority_lease_expired"); }, 5_000);
  subscription.closed.catch(() => { if (!terminating && (expiresAt === undefined || clock() >= expiresAt)) void terminate(expiresAt === undefined ? "subscription_eof" : "authority_lease_expired"); });
  return Object.freeze({
    client,
    subscription,
    get terminationReason() { return terminationReason; },
    get expiresAt() { return expiresAt; },
    dispose() {
      if (expiryTimer) clearExpiryInterval(expiryTimer);
      subscription.dispose();
      client.dispose();
      terminating = true;
    },
  });
}
