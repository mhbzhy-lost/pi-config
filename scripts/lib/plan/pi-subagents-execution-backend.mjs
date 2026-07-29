import { createHash } from "node:crypto";

import {
  ExecutionProtocolError,
  executionSpawnRpcParams,
  normalizeExecutionSpawn,
  normalizeExecutionTarget,
} from "./execution-backend.mjs";
import { readRuntimeArtifacts } from "./runtime-artifacts.mjs";

const STARTED_EVENT = "subagent:async-started";
const COMPLETED_EVENT = "subagent:async-complete";
const TERMINAL_STATES = new Set(["complete", "failed", "paused", "stopped"]);

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => { resolve = resolvePromise; reject = rejectPromise; });
  return { promise, resolve, reject };
}

function supersedeRequest(input) {
  const request = normalizeExecutionSpawn({ ...input, agent: "executor", task: "Supersede dispatch", cwd: "/unused", output: "/unused", timeoutMs: 1 });
  return { dispatchId: request.dispatchId, attemptId: request.attemptId };
}

function nonempty(value) {
  return typeof value === "string" && value.length > 0;
}

function replyBinding(reply) {
  const details = reply?.details ?? reply;
  const runId = details?.runId ?? details?.asyncId;
  const asyncDir = details?.asyncDir;
  if (!nonempty(runId) || !nonempty(asyncDir)) {
    throw new ExecutionProtocolError("EXECUTION_SPAWN_REPLY_INVALID", "Spawn reply does not contain runId and asyncDir");
  }
  return { runId, asyncDir };
}

export function createPiSubagentsExecutionBackend({
  rpc,
  events,
  readArtifacts = readRuntimeArtifacts,
  emitFact = () => {},
  now = () => new Date().toISOString(),
  bindings = [],
  supersedeTimeoutMs = 30_000,
  supersedePollIntervalMs = 100,
} = {}) {
  if (!rpc || !events?.on) throw new ExecutionProtocolError("EXECUTION_BACKEND_INVALID", "rpc and events are required");
  if (!Number.isSafeInteger(supersedeTimeoutMs) || supersedeTimeoutMs < 1 || !Number.isSafeInteger(supersedePollIntervalMs) || supersedePollIntervalMs < 1) {
    throw new ExecutionProtocolError("EXECUTION_BACKEND_INVALID", "Supersede timing options must be positive safe integers");
  }
  const pending = new Map();
  const byRunId = new Map();
  let sessionId = null;
  let rpcSessionId = null;
  let disposed = false;

  function createEntry(request, binding = null) {
    return { request, binding, bindingWait: deferred(), cancelling: false, stopPromise: null, supersedePromise: null };
  }

  function bind(entry, binding) {
    entry.binding = binding;
    byRunId.set(binding.runId, binding);
    entry.bindingWait.resolve(binding);
    if (entry.cancelling) void stopBound(entry);
  }

  async function stopBound(entry) {
    if (!entry.binding) return null;
    entry.stopPromise ??= Promise.resolve().then(() => rpc.stop({ runId: entry.binding.runId, dir: entry.binding.asyncDir }));
    await entry.stopPromise;
    return entry.binding;
  }

  async function terminalProof(entry) {
    const binding = await stopBound(entry);
    const deadline = Date.now() + supersedeTimeoutMs;
    while (!disposed && Date.now() <= deadline) {
      try {
        const artifacts = await readArtifacts({ artifactDir: binding.asyncDir, binding: { runId: binding.runId, sessionId: binding.sessionId, cwd: binding.cwd, output: binding.output } });
        if (artifacts?.status?.kind === "stable" && TERMINAL_STATES.has(artifacts.status.value?.state)) {
          return Object.freeze({ kind: "terminal", dispatchId: entry.request.dispatchId, runId: binding.runId, asyncDir: binding.asyncDir, artifactSha256: createHash("sha256").update(stableJson(artifacts.status.value)).digest("hex") });
        }
      } catch (error) {
        if (error?.code === "RUNTIME_ARTIFACT_BINDING_MISMATCH" || error?.code === "RUNTIME_ARTIFACT_OUTPUT_MISMATCH") throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, supersedePollIntervalMs));
    }
    throw new ExecutionProtocolError(disposed ? "EXECUTION_BACKEND_DISPOSED" : "EXECUTION_DISPATCH_UNCERTAIN", disposed ? "Execution backend is disposed" : "Terminal execution artifact was not observed", entry.request.dispatchId);
  }

  function beginSupersede(entry) {
    entry.cancelling = true;
    entry.supersedePromise ??= (async () => {
      const binding = entry.binding ?? await Promise.race([entry.bindingWait.promise, new Promise((_, reject) => setTimeout(() => reject(new ExecutionProtocolError("EXECUTION_DISPATCH_UNCERTAIN", "Dispatch binding was not observed", entry.request.dispatchId)), supersedeTimeoutMs))]);
      if (!binding) throw new ExecutionProtocolError("EXECUTION_DISPATCH_UNCERTAIN", "Dispatch binding was not observed", entry.request.dispatchId);
      return terminalProof(entry);
    })();
    return entry.supersedePromise;
  }

  function recoveredEntry(binding, requireActiveSession = false) {
    if (!binding?.dispatchId || !binding?.attemptId || !binding?.runId || !binding?.asyncDir
      || !binding?.cwd || !binding?.output || !binding?.sessionId || !binding?.sessionFile) {
      throw new ExecutionProtocolError("EXECUTION_BINDING_INVALID", "Recovered execution binding is incomplete");
    }
    if (requireActiveSession && (binding.sessionId !== sessionId || binding.sessionFile !== sessionId)) {
      throw new ExecutionProtocolError("EXECUTION_CAPABILITY_MISMATCH", "Recovered binding session does not match active RPC session");
    }
    if (binding.sessionId !== binding.sessionFile) {
      throw new ExecutionProtocolError("EXECUTION_BINDING_INVALID", "Recovered execution binding session identity is inconsistent");
    }
    const request = normalizeExecutionSpawn({
      ...binding,
      agent: "executor",
      task: binding.task ?? "Recovered approved task",
      output: binding.output ?? `${binding.asyncDir}/recovered-output.json`,
      timeoutMs: binding.timeoutMs ?? 1,
    });
    return { request, binding: Object.freeze({ ...binding }) };
  }

  function publish(fact) {
    emitFact(Object.freeze(fact));
  }

  function violation(code, message, event) {
    const fact = {
      type: "execution.protocol-violation",
      code,
      message,
      runId: event?.runId ?? event?.id ?? null,
      asyncDir: event?.asyncDir ?? null,
      cwd: event?.cwd ?? null,
      observedAt: now(),
    };
    publish(fact);
    return fact;
  }

  function candidatesFor(event, completed) {
    const runId = event?.runId ?? event?.id;
    return [...pending.values()].filter((entry) => {
      if (entry.request.cwd !== event?.cwd) return false;
      if (!completed) return true;
      return entry.binding?.runId === runId;
    });
  }

  function lifecycle(event, completed) {
    if (!event || typeof event !== "object") {
      violation("LIFECYCLE_EVENT_INVALID", "Lifecycle event must be an object", event);
      return;
    }
    if (!sessionId || event.sessionId !== sessionId) {
      violation("LIFECYCLE_SESSION_MISMATCH", "Lifecycle event belongs to another Plan Session", event);
      return;
    }
    const candidates = candidatesFor(event, completed);
    if (candidates.length === 0) {
      violation("LIFECYCLE_BINDING_NOT_FOUND", "Lifecycle event has no authorized cwd binding", event);
      return;
    }
    if (candidates.length > 1) {
      violation("LIFECYCLE_BINDING_AMBIGUOUS", "Lifecycle event matches more than one authorized cwd", event);
      return;
    }
    const entry = candidates[0];
    const runId = event.runId ?? event.id;
    if (!nonempty(runId) || !nonempty(event.asyncDir) || !nonempty(event.cwd)) {
      violation("LIFECYCLE_EVENT_INVALID", "Lifecycle event identity is incomplete", event);
      return;
    }
    if (entry.binding && (entry.binding.runId !== runId || entry.binding.asyncDir !== event.asyncDir)) {
      violation("LIFECYCLE_BINDING_MISMATCH", "Lifecycle event disagrees with the bound run", event);
      return;
    }
    const binding = entry.binding ?? Object.freeze({
      dispatchId: entry.request.dispatchId,
      attemptId: entry.request.attemptId,
      runId,
      asyncDir: event.asyncDir,
      cwd: entry.request.cwd,
      output: entry.request.output,
      sessionId,
      sessionFile: sessionId,
    });
    bind(entry, binding);
    publish({
      type: completed ? "execution.completed" : "execution.started",
      dispatchId: entry.request.dispatchId,
      attemptId: entry.request.attemptId,
      runId,
      asyncDir: event.asyncDir,
      cwd: event.cwd,
      state: completed ? (nonempty(event.state) ? event.state : "complete") : "running",
      observedAt: now(),
    });

  }

  const unsubscribes = [
    events.on(STARTED_EVENT, (event) => lifecycle(event, false)),
    events.on(COMPLETED_EVENT, (event) => lifecycle(event, true)),
  ].filter((unsubscribe) => typeof unsubscribe === "function");

  for (const binding of bindings) {
    const recovered = recoveredEntry(binding);
    const entry = createEntry(recovered.request, recovered.binding);
    entry.bindingWait.resolve(entry.binding);
    pending.set(recovered.request.dispatchId, entry);
    byRunId.set(recovered.binding.runId, entry.binding);
    sessionId ??= recovered.binding.sessionId;
  }

  function ensureReady() {
    if (disposed) throw new ExecutionProtocolError("EXECUTION_BACKEND_DISPOSED", "Execution backend is disposed");
    if (!sessionId) throw new ExecutionProtocolError("EXECUTION_CAPABILITIES_UNVERIFIED", "Execution capabilities are not verified");
  }

  function boundTarget(input) {
    ensureReady();
    const target = normalizeExecutionTarget(input);
    const binding = byRunId.get(target.runId);
    if (!binding || binding.asyncDir !== target.asyncDir || binding.sessionId !== sessionId) {
      throw new ExecutionProtocolError("EXECUTION_TARGET_NOT_BOUND", "Execution target is not bound to this Plan Session", target.runId);
    }
    return { target, binding };
  }

  return Object.freeze({
    async ping() {
      if (disposed) throw new ExecutionProtocolError("EXECUTION_BACKEND_DISPOSED", "Execution backend is disposed");
      return rpc.ping();
    },
    async assertCapabilities({ rpcVersion, methods }) {
      if (disposed) throw new ExecutionProtocolError("EXECUTION_BACKEND_DISPOSED", "Execution backend is disposed");
      const result = await rpc.ping();
      const available = new Set(Array.isArray(result?.methods) ? result.methods : []);
      const missing = methods.filter((method) => !available.has(method));
      const negotiatedRpcSessionId = result?.session?.sessionId;
      const negotiatedSessionId = result?.session?.sessionFile;
      if (result?.version !== rpcVersion || missing.length > 0
        || !nonempty(negotiatedRpcSessionId) || !nonempty(negotiatedSessionId)) {
        throw new ExecutionProtocolError("EXECUTION_CAPABILITY_MISMATCH", "pi-subagents RPC capability or session identity mismatch", {
          expectedVersion: rpcVersion,
          actualVersion: result?.version,
          missing,
        });
      }
      if (sessionId && sessionId !== negotiatedSessionId) {
        throw new ExecutionProtocolError("EXECUTION_CAPABILITY_MISMATCH", "Recovered binding session does not match active RPC session");
      }
      sessionId = negotiatedSessionId;
      rpcSessionId = negotiatedRpcSessionId;
      return Object.freeze({
        rpcVersion: result.version,
        methods: Object.freeze([...methods]),
        sessionId,
        rpcSessionId,
        cwd: result.session?.cwd ?? null,
        sessionFile: negotiatedSessionId,
      });
    },
    async spawn(input) {
      ensureReady();
      const request = normalizeExecutionSpawn(input);
      if (pending.has(request.dispatchId)) {
        throw new ExecutionProtocolError("EXECUTION_DISPATCH_DUPLICATE", `Dispatch already exists: ${request.dispatchId}`);
      }
      const entry = createEntry(request);
      pending.set(request.dispatchId, entry);
      try {
        const reply = await rpc.spawn(executionSpawnRpcParams(request), { requestId: request.dispatchId });
        const observed = replyBinding(reply);
        if (entry.binding && (entry.binding.runId !== observed.runId || entry.binding.asyncDir !== observed.asyncDir)) {
          violation("SPAWN_REPLY_BINDING_MISMATCH", "Spawn reply disagrees with lifecycle start", {
            runId: observed.runId,
            asyncDir: observed.asyncDir,
            cwd: request.cwd,
          });
          throw new ExecutionProtocolError("SPAWN_REPLY_BINDING_MISMATCH", "Spawn reply disagrees with lifecycle start");
        }
        if (!entry.binding) {
          bind(entry, Object.freeze({
            dispatchId: request.dispatchId,
            attemptId: request.attemptId,
            runId: observed.runId,
            asyncDir: observed.asyncDir,
            cwd: request.cwd,
            output: request.output,
            sessionId,
            sessionFile: sessionId,
          }));
        }
        return entry.binding;
      } catch (error) {
        if (!entry.binding && !entry.cancelling) pending.delete(request.dispatchId);
        throw error;
      }
    },
    async recoverBinding(binding) {
      ensureReady();
      const recovered = recoveredEntry(binding, true);
      const existingDispatch = pending.get(recovered.request.dispatchId);
      const existingRun = byRunId.get(recovered.binding.runId);
      if (existingDispatch || existingRun) {
        if (existingDispatch?.binding && existingDispatch.binding.runId === recovered.binding.runId
          && existingRun === existingDispatch.binding
          && stableJson(existingDispatch.binding) === stableJson(recovered.binding)) return existingDispatch.binding;
        throw new ExecutionProtocolError("EXECUTION_BINDING_CONFLICT", "Recovered binding conflicts with an existing dispatch or run", recovered.request.dispatchId);
      }
      const entry = createEntry(recovered.request, recovered.binding);
      entry.bindingWait.resolve(entry.binding);
      pending.set(recovered.request.dispatchId, entry);
      byRunId.set(recovered.binding.runId, entry.binding);
      return entry.binding;
    },
    async supersede(input) {
      ensureReady();
      const request = supersedeRequest(input);
      const entry = pending.get(request.dispatchId);
      if (!entry) throw new ExecutionProtocolError("EXECUTION_DISPATCH_NOT_FOUND", "Dispatch is not known", request.dispatchId);
      if (entry.request.attemptId !== request.attemptId) {
        throw new ExecutionProtocolError("EXECUTION_DISPATCH_MISMATCH", "Dispatch does not belong to the supplied attempt", request.dispatchId);
      }
      return beginSupersede(entry);
    },
    async status(input) {
      const { target, binding } = boundTarget(input);
      await rpc.status({ runId: target.runId, dir: target.asyncDir });
      return readArtifacts({
        artifactDir: target.asyncDir,
        binding: {
          runId: binding.runId,
          sessionId: binding.sessionId,
          cwd: binding.cwd,
          output: binding.output,
        },
      });
    },
    async interrupt(input) {
      const { target } = boundTarget(input);
      return rpc.interrupt({ runId: target.runId, dir: target.asyncDir });
    },
    async stop(input) {
      const { target } = boundTarget(input);
      return rpc.stop({ runId: target.runId, dir: target.asyncDir });
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const unsubscribe of unsubscribes) unsubscribe();
      for (const entry of pending.values()) entry.bindingWait.reject(new ExecutionProtocolError("EXECUTION_BACKEND_DISPOSED", "Execution backend is disposed"));
      pending.clear();
      byRunId.clear();
      rpc.dispose?.();
    },
  });
}
