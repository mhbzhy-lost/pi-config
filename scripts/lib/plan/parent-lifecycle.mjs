import { mkdir, readFile as readFileFromDisk, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const PLAN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const LEASE_SCHEMA = "pi-plan-parent-lease.v1";

function validPlanId(value) {
  return typeof value === "string" && PLAN_ID.test(value) && !value.includes("..");
}

function leasePath(stateRoot, planId) {
  if (typeof stateRoot !== "string" || !stateRoot) throw new Error("stateRoot is required");
  if (!validPlanId(planId)) throw new Error("Invalid planId");
  const runsRoot = path.resolve(stateRoot, "var", "plan-runs");
  const directory = path.resolve(runsRoot, planId, "control");
  const relative = path.relative(runsRoot, directory);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Parent lease path escapes plan-runs");
  return path.join(directory, "parent-lease.json");
}

async function writeAtomic(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}-${process.pid}-${crypto.randomUUID()}.tmp`);
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, file);
}

export function createParentLease({
  stateRoot,
  planId,
  token,
  parentPid,
  now = () => Date.now(),
  intervalMs = 1_000,
  writeLease = writeAtomic,
  setInterval: schedule = setInterval,
  clearInterval: cancel = clearInterval,
} = {}) {
  const file = leasePath(stateRoot, planId);
  if (typeof token !== "string" || !token) throw new Error("token is required");
  if (!Number.isInteger(parentPid) || parentPid <= 0) throw new Error("parentPid is required");
  if (typeof now !== "function") throw new Error("now is required");
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) throw new Error("intervalMs must be positive");
  let timer = null;
  let heartbeat = Promise.resolve();
  let heartbeatError;
  let stopped = false;

  const beat = () => {
    const write = () => writeLease(file, {
      schemaVersion: LEASE_SCHEMA,
      planId,
      token,
      parentPid,
      updatedAt: now(),
    });
    heartbeat = heartbeat.then(write, write);
    heartbeatError = undefined;
    heartbeat.catch((error) => { heartbeatError = error; });
    return heartbeat;
  };

  return {
    path: file,
    beat,
    start() {
      if (timer || stopped) return;
      timer = schedule(() => { if (!stopped) beat(); }, intervalMs);
      timer.unref();
    },
    async stop() {
      stopped = true;
      if (timer) {
        cancel(timer);
        timer = null;
      }
      await heartbeat;
      if (heartbeatError) throw heartbeatError;
    },
    remove() {
      return rm(file, { force: true });
    },
  };
}

function validLease(value, planId, token) {
  return value && value.schemaVersion === LEASE_SCHEMA && value.planId === planId && value.token === token &&
    Number.isFinite(value.updatedAt);
}

async function defaultExpired({ leasePath, planId, token }) {
  await writeAtomic(path.join(path.dirname(leasePath), "parent-lost.json"), {
    schemaVersion: "pi-plan-parent-lost.v1",
    planId,
    token,
    occurredAt: new Date().toISOString(),
  });
  process.kill(process.pid, "SIGTERM");
}

export function startParentLeaseWatchdog({
  leasePath,
  planId,
  token,
  timeoutMs,
  startupGraceMs = timeoutMs,
  checkIntervalMs = 1_000,
  onExpired = defaultExpired,
  readFile = readFileFromDisk,
  now = () => Date.now(),
  setInterval: schedule = setInterval,
  clearInterval: cancel = clearInterval,
} = {}) {
  if (typeof leasePath !== "string" || !leasePath) throw new Error("leasePath is required");
  if (!validPlanId(planId)) throw new Error("Invalid planId");
  if (typeof token !== "string" || !token) throw new Error("token is required");
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("timeoutMs must be positive");
  if (!Number.isFinite(startupGraceMs) || startupGraceMs < 0) throw new Error("startupGraceMs must be non-negative");
  if (!Number.isFinite(checkIntervalMs) || checkIntervalMs <= 0) throw new Error("checkIntervalMs must be positive");
  const startedAt = now();
  let stopped = false;
  let expired = false;
  let checking = false;
  let timer;

  const check = async () => {
    if (stopped || expired || checking) return;
    checking = true;
    try {
      let value;
      try {
        value = JSON.parse(await readFile(leasePath, "utf8"));
      } catch (error) {
        if (error?.code === "ENOENT" && now() - startedAt < startupGraceMs) return;
        expired = true;
        await onExpired({ leasePath, planId, token });
        return;
      }
      if (!validLease(value, planId, token) || now() - value.updatedAt > timeoutMs) {
        expired = true;
        await onExpired({ leasePath, planId, token });
      }
    } finally {
      checking = false;
    }
  };

  timer = schedule(() => { void check(); }, checkIntervalMs);
  timer.unref?.();
  return {
    stop() {
      if (stopped) return;
      stopped = true;
      cancel(timer);
    },
  };
}
