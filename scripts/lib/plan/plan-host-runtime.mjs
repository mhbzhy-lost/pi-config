import { createHash } from "node:crypto";
import { execFile as execFileCallback, spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { chmod, mkdir, open, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

const HANDLE_FIELDS = [
  "schemaVersion", "planId", "revision", "manifestSha256", "sourceBytesSha256", "planHash", "planIrHash", "hostRunId", "processIdentity", "pid", "runDir",
  "sessionFile", "statusPath", "worktree", "startedAt",
];
const INPUT_FIELDS = new Set([
  "planId", "revision", "manifestSha256", "sourceBytesSha256", "planHash", "planIrHash", "baseCommit", "originRoot", "stateRoot", "cwd", "extension", "runDir", "statusPath",
]);
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function assertHandle(handle) {
  if (handle?.schemaVersion !== "pi-plan-handle.v3") {
    throw new Error("Legacy Plan handle requires explicit migration to pi-plan-handle.v3");
  }
  for (const field of HANDLE_FIELDS) {
    if (field === "pid" || field === "revision") {
      if (!Number.isInteger(handle[field]) || handle[field] < 1) throw new Error(`Invalid v3 Plan Host ${field}`);
    } else if ((field === "manifestSha256" || field === "sourceBytesSha256" || field === "planHash" || field === "planIrHash") && (typeof handle[field] !== "string" || !/^[a-f0-9]{64}$/.test(handle[field]))) {
      throw new Error(`Invalid v3 Plan Host ${field}`);
    } else if (typeof handle[field] !== "string" || !handle[field]) {
      throw new Error(`Invalid v3 Plan Host ${field}`);
    }
  }
  return handle;
}

function assertSpawnInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid Plan Runner input");
  const unsupported = Object.keys(input).filter((field) => !INPUT_FIELDS.has(field));
  if (unsupported.length > 0) throw new Error(`Unsupported Plan Runner input field: ${unsupported.join(", ")}`);
  for (const field of INPUT_FIELDS) {
    if (field === "revision") {
      if (!Number.isSafeInteger(input[field]) || input[field] < 1) throw new Error(`Invalid Plan Runner input ${field}`);
    } else if (typeof input[field] !== "string" || !input[field]) throw new Error(`Invalid Plan Runner input ${field}`);
  }
  if (!ID.test(input.planId) || input.planId.includes("..")) throw new Error("Invalid Plan Runner input planId");
  if (!Number.isSafeInteger(input.revision) || input.revision < 1 || !/^[a-f0-9]{64}$/.test(input.manifestSha256) || !/^[a-f0-9]{64}$/.test(input.sourceBytesSha256) || !/^[a-f0-9]{64}$/.test(input.planHash) || !/^[a-f0-9]{64}$/.test(input.planIrHash)) {
    throw new Error("Invalid Plan Runner revision identity");
  }
  return input;
}

function bootstrap(input, promptMarker = "") {
  return `You are the dedicated Standalone Plan Runner. ${promptMarker}\nYour first action must be plan_open with this exact bootstrap JSON:\n${JSON.stringify({
    planId: input.planId,
    revision: input.revision,
    manifestSha256: input.manifestSha256,
    planIrHash: input.planIrHash,
    baseCommit: input.baseCommit,
    worktree: input.cwd,
    allowPlanCommits: true,
  })}\nDo not merge or push.`;
}

function waitForSessionStart(child, { cwd, stdoutPath, sessionFile, timeoutMs, pollIntervalMs = 20 }) {
  let buffer = "";
  let offset = 0;
  let settled = false;
  let pollTimer;
  let timeoutTimer;
  const expectedCwd = realpathSync(cwd);
  let resolveReady;
  let rejectReady;
  const ready = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const cleanup = () => {
    if (pollTimer) clearTimeout(pollTimer);
    if (timeoutTimer) clearTimeout(timeoutTimer);
    child.off("error", onError);
    child.off("exit", onExit);
  };
  const settle = (error, value) => {
    if (settled) return;
    settled = true;
    cleanup();
    if (error) rejectReady(error);
    else resolveReady(value);
  };
  const validateSessionEvent = (event) => {
    let eventCwd;
    try {
      eventCwd = typeof event?.cwd === "string" ? realpathSync(event.cwd) : undefined;
    } catch {
      eventCwd = undefined;
    }
    if (event?.type !== "session" || event.version !== 3 || typeof event.id !== "string" || !event.id
      || eventCwd !== expectedCwd) {
      settle(new Error("Standalone Plan Runner emitted an invalid session start event"));
      return false;
    }
    settle(undefined, { sessionId: event.id, sessionFile });
    return true;
  };
  const parseAvailableLines = (content) => {
    if (content.length < offset) {
      settle(new Error("Standalone Plan Runner stdout was truncated before session start"));
      return;
    }
    buffer += content.slice(offset);
    offset = content.length;
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        settle(new Error("Standalone Plan Runner emitted invalid JSON before session start"));
        return;
      }
      if (event?.type !== "session") continue;
      validateSessionEvent(event);
      return;
    }
  };
  const parseSessionFile = (content) => {
    const newline = content.indexOf("\n");
    if (newline < 0) return;
    const line = content.slice(0, newline).trim();
    if (!line) {
      settle(new Error("Standalone Plan Runner session file starts with an empty event"));
      return;
    }
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      settle(new Error("Standalone Plan Runner session file starts with invalid JSON"));
      return;
    }
    validateSessionEvent(event);
  };
  const poll = async () => {
    if (settled) return;
    try {
      parseAvailableLines(await readFile(stdoutPath, "utf8"));
    } catch (error) {
      if (error?.code !== "ENOENT") {
        settle(error);
        return;
      }
    }
    if (settled) return;
    try {
      parseSessionFile(await readFile(sessionFile, "utf8"));
    } catch (error) {
      if (error?.code !== "ENOENT") {
        settle(error);
        return;
      }
    }
    if (!settled) pollTimer = setTimeout(() => void poll(), pollIntervalMs);
  };
  const onError = (error) => settle(error);
  const onExit = (exitCode, signal) => settle(new Error(
    `Standalone Plan Runner exited before session start (exitCode=${exitCode}, signal=${signal})`,
  ));
  child.once("error", onError);
  child.once("exit", onExit);
  timeoutTimer = setTimeout(
    () => settle(new Error("Standalone Plan Runner session start event was not emitted")),
    timeoutMs,
  );
  void poll();
  void ready.catch(() => {});
  return ready;
}

export async function spawnStandaloneHost({
  task,
  cwd,
  extensions,
  noExtensions,
  noSkills,
  sessionDir,
  runDir,
  model,
  command = "pi",
  environment = process.env,
  hostRunId,
  startupTimeoutMs = 5_000,
}) {
  if (typeof hostRunId !== "string" || !hostRunId) throw new Error("Plan Host run identity is required");
  await mkdir(runDir, { recursive: true, mode: 0o700 });
  await mkdir(sessionDir, { recursive: true, mode: 0o700 });
  await Promise.all([chmod(runDir, 0o700), chmod(sessionDir, 0o700)]);
  const stdoutPath = path.join(runDir, "stdout.jsonl");
  const stderrPath = path.join(runDir, "stderr.log");
  const statusPath = path.join(runDir, "status.json");
  const sessionFile = path.join(
    sessionDir,
    `${createHash("sha256").update(hostRunId).digest("hex")}.jsonl`,
  );
  await Promise.all([
    writeFile(stdoutPath, "", { flag: "a", mode: 0o600 }),
    writeFile(stderrPath, "", { flag: "a", mode: 0o600 }),
  ]);
  await Promise.all([chmod(stdoutPath, 0o600), chmod(stderrPath, 0o600)]);
  const args = ["--mode", "rpc", "--session", sessionFile, "--session-dir", sessionDir];
  if (model) args.push("--model", model);
  if (noExtensions) args.push("--no-extensions");
  if (noSkills) args.push("--no-skills");
  for (const extension of extensions) args.push("--extension", extension);

  const bootstrapCommand = JSON.stringify({
    id: `${hostRunId}.bootstrap`,
    type: "prompt",
    message: task,
  });
  const keeperScript = [
    'bootstrap="$PI_PLAN_BOOTSTRAP_COMMAND"',
    "unset PI_PLAN_BOOTSTRAP_COMMAND",
    "{ printf '%s\\n' \"$bootstrap\"; exec sleep 2147483647; } | exec \"$@\"",
  ].join("\n");
  const childEnv = { ...environment, PI_PLAN_HOST_RUN_ID: hostRunId, PI_PLAN_BOOTSTRAP_COMMAND: bootstrapCommand };
  delete childEnv.PI_SUBAGENT_PARENT_SESSION;
  const [stdoutFile, stderrFile] = await Promise.all([open(stdoutPath, "a"), open(stderrPath, "a")]);
  let child;
  let ready;
  try {
    child = spawn("/bin/sh", ["-c", keeperScript, "pi-plan-host-keeper", command, ...args], {
      cwd,
      detached: true,
      stdio: ["ignore", stdoutFile.fd, stderrFile.fd],
      env: childEnv,
      windowsHide: true,
    });
    ready = waitForSessionStart(child, {
      cwd,
      stdoutPath,
      sessionFile,
      timeoutMs: startupTimeoutMs,
    });
  } finally {
    await Promise.all([stdoutFile.close(), stderrFile.close()]);
  }
  child.unref();
  const startedAt = new Date().toISOString();
  await writeFile(statusPath, JSON.stringify({ state: "running", pid: child.pid, startedAt }), { mode: 0o600 });
  const finish = async (state, detail = {}) => {
    await writeFile(
      statusPath,
      JSON.stringify({ state, pid: child.pid, startedAt, endedAt: new Date().toISOString(), ...detail }),
      { mode: 0o600 },
    ).catch(() => {});
  };
  child.on("exit", (exitCode, signal) => void finish(exitCode === 0 ? "complete" : "failed", { exitCode, signal }));
  child.on("error", (error) => void finish("failed", { reason: "spawn_error", message: error.message }));
  return { pid: child.pid, sessionFile, ready };
}

function hostPidExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function processTargetExists(target) {
  try {
    process.kill(target, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function signalProcessTarget(target, value) {
  process.kill(target, value);
}

async function defaultCaptureHostIdentity(pid) {
  if (!hostPidExists(pid)) throw new Error("Plan Host process is not running");
  const { stdout } = await execFile("ps", ["-ww", "-p", String(pid), "-o", "lstart=", "-o", "command="], {
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  });
  const identity = stdout.trim();
  if (!identity) throw new Error("Plan Host process identity is unavailable");
  return createHash("sha256").update(identity).digest("hex");
}

async function defaultVerifyHostIdentity(handle) {
  try {
    return await defaultCaptureHostIdentity(handle.pid) === handle.processIdentity;
  } catch {
    return false;
  }
}

export async function stopStandaloneHost(pid, {
  graceMs = 5_000,
  handle,
  verifyHostIdentity,
  isProcessAlive = processTargetExists,
  signal = signalProcessTarget,
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
} = {}) {
  if (!Number.isInteger(pid) || pid < 1) throw new Error("Invalid Plan Host pid");
  const target = -pid;
  if (!isProcessAlive(target)) return;
  if (handle && !(await verifyHostIdentity?.(handle))) throw new Error("Plan Host process identity fencing failed");
  try { signal(target, "SIGTERM"); } catch (error) { if (error?.code !== "ESRCH") throw error; return; }
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(target)) return;
    if (handle && !(await verifyHostIdentity?.(handle))) return;
    await sleep(50);
  }
  if (handle && !(await verifyHostIdentity?.(handle))) return;
  try { signal(target, "SIGKILL"); } catch (error) { if (error?.code !== "ESRCH") throw error; }
}

async function interruptStandaloneHost(pid, {
  handle,
  verifyHostIdentity,
  isProcessAlive = processTargetExists,
  signal = signalProcessTarget,
} = {}) {
  if (!Number.isInteger(pid) || pid < 1) throw new Error("Invalid Plan Host pid");
  const target = -pid;
  if (!isProcessAlive(target)) return;
  if (handle && !(await verifyHostIdentity?.(handle))) throw new Error("Plan Host process identity fencing failed");
  try { signal(target, "SIGINT"); } catch (error) { if (error?.code !== "ESRCH") throw error; }
}

async function defaultReadHostStatus(runDir) {
  return JSON.parse(await readFile(path.join(runDir, "status.json"), "utf8"));
}

async function waitForSessionFile(sessionDir, { timeoutMs = 5_000, intervalMs = 25 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    try {
      const files = (await readdir(sessionDir)).filter((file) => file.endsWith(".jsonl")).sort();
      if (files.length === 1) return path.join(sessionDir, files[0]);
      if (files.length > 1) throw new Error("Standalone Plan Runner created multiple session files");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error("Standalone Plan Runner session file was not created");
}

export function createPlanHostRuntime({
  spawnHost = spawnStandaloneHost,
  readHostStatus = defaultReadHostStatus,
  interruptHost = interruptStandaloneHost,
  stopHost = stopStandaloneHost,
  captureHostIdentity = defaultCaptureHostIdentity,
  verifyHostIdentity = defaultVerifyHostIdentity,
  emitAttention = () => {},
  id = () => crypto.randomUUID(),
  now = () => new Date().toISOString(),
  env = process.env,
  promptMarker = "",
  model,
  extraExtensions = [],
  noExtensions = false,
} = {}) {
  const forwardedAttention = new Set();

  async function planStatus(handle) {
    try {
      return JSON.parse(await readFile(handle.statusPath, "utf8"));
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
  }

  async function forwardAttention(handle, plan) {
    for (const task of plan?.tasks ?? []) {
      for (const attempt of task.attempts ?? []) {
        const attention = attempt.attention;
        if (!attention || attention.status !== "pending" || !attention.evidence) continue;
        const key = `${handle.planId}:${attention.requestId}:${attention.projectionVersion}`;
        if (forwardedAttention.has(key)) continue;
        const expectedBodyPath = path.posix.join("attention", `${attention.requestId}.md`);
        if (attention.evidence.bodyPath !== expectedBodyPath) throw new Error("Plan Attention body path is invalid");
        const planRunRoot = path.dirname(handle.statusPath);
        const bodyFile = path.resolve(planRunRoot, ...expectedBodyPath.split("/"));
        const relativeBody = path.relative(planRunRoot, bodyFile);
        if (!relativeBody || relativeBody.startsWith("..") || path.isAbsolute(relativeBody)) {
          throw new Error("Plan Attention body path escapes the Plan run");
        }
        await emitAttention({
          customType: "pi-plan-attention-v1",
          content: [
            `Plan ${handle.planId} requires user input for Attention ${attention.requestId}.`,
            `Read the private Attention body with the read tool at ${bodyFile}, summarize it to the user, and wait for an explicit decision.`,
            `After the user decides, call plan_attention_reply with planId=${handle.planId}, requestId=${attention.requestId}, and expectedProjectionVersion=${attention.projectionVersion}.`,
            "Do not infer or submit a decision on the user's behalf.",
          ].join("\n"),
          details: {
            planId: handle.planId,
            requestId: attention.requestId,
            expectedProjectionVersion: attention.projectionVersion,
            bodyPath: attention.evidence.bodyPath,
            bodySha256: attention.evidence.bodySha256,
          },
        });
        forwardedAttention.add(key);
      }
    }
  }

  async function status(handle) {
    assertHandle(handle);
    const [host, plan] = await Promise.all([readHostStatus(handle.runDir), planStatus(handle)]);
    await forwardAttention(handle, plan);
    return { host, plan };
  }

  return Object.freeze({
    async spawnPlanRunner(rawInput) {
      if (env.PI_SUBAGENT_CHILD || env.PI_SUBAGENT_FANOUT_CHILD) {
        throw new Error("Standalone Plan Runner Host refuses child or fanout-child mode");
      }
      const input = assertSpawnInput(rawInput);
      const sessionDir = path.join(input.runDir, "sessions");
      const hostRunId = id();
      const spawnOptions = {
        task: bootstrap(input, promptMarker),
        cwd: input.cwd,
        extensions: [...extraExtensions, input.extension],
        noExtensions,
        noSkills: false,
        sessionDir,
        runDir: input.runDir,
        hostRunId,
        environment: {
          ...env,
          PI_PLAN_ORIGIN_ROOT: input.originRoot,
          PI_PLAN_STATE_ROOT: input.stateRoot,
        },
      };
      if (model) spawnOptions.model = model;
      const result = await spawnHost(spawnOptions);
      if (!Number.isInteger(result?.pid) || result.pid < 1) throw new Error("Standalone Plan Runner process handle is incomplete");
      let processIdentity;
      try {
        processIdentity = result.processIdentity ?? await captureHostIdentity(result.pid);
      } catch (error) {
        try {
          await stopHost(result.pid);
        } catch (stopError) {
          throw new AggregateError([error, stopError], "Plan Host identity capture failed and spawned Host cleanup failed", { cause: error });
        }
        throw error;
      }
      let startup;
      if (result.ready !== undefined) {
        try {
          startup = await result.ready;
        } catch (error) {
          await stopHost(result.pid).catch(() => {});
          throw error;
        }
      }
      let sessionFile = result.sessionFile ?? startup?.sessionFile;
      if (!sessionFile) {
        try {
          sessionFile = await waitForSessionFile(sessionDir);
        } catch (error) {
          await stopHost(result.pid).catch(() => {});
          throw error;
        }
      }
      const handle = {
        schemaVersion: "pi-plan-handle.v3",
        planId: input.planId,
        revision: input.revision,
        manifestSha256: input.manifestSha256,
        sourceBytesSha256: input.sourceBytesSha256,
        planHash: input.planHash,
        planIrHash: input.planIrHash,
        hostRunId,
        processIdentity,
        pid: result.pid,
        runDir: input.runDir,
        sessionFile,
        statusPath: input.statusPath,
        worktree: input.cwd,
        startedAt: now(),
      };
      return Object.freeze(assertHandle(handle));
    },
    status,
    async interrupt(handle) {
      assertHandle(handle);
      if (!(await verifyHostIdentity(handle))) throw new Error("Plan Host process identity fencing failed");
      await interruptHost(handle.pid, { handle, verifyHostIdentity });
      return { interrupted: true, hostRunId: handle.hostRunId };
    },
    async stop(handle) {
      assertHandle(handle);
      if (!(await verifyHostIdentity(handle))) throw new Error("Plan Host process identity fencing failed");
      await stopHost(handle.pid, { handle, verifyHostIdentity });
      return { stopped: true, hostRunId: handle.hostRunId };
    },
    async reconcile(handle) {
      const observed = await status(handle);
      const planTerminal = ["validated", "blocked", "cancelled", "interrupted"].includes(observed.plan?.lifecycle);
      const hostRunning = observed.host?.state === "running";
      const attached = hostRunning && await verifyHostIdentity(handle);
      if (hostRunning && !planTerminal && !attached) throw new Error("Plan Host process identity fencing failed");
      return { attached, ...observed };
    },
  });
}
