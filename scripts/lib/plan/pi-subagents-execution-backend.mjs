import {
  ExecutionProtocolError,
  executionSpawnRpcParams,
  normalizeExecutionSpawn,
  normalizeExecutionTarget,
} from "./execution-backend.mjs";
import { readRuntimeArtifacts } from "./runtime-artifacts.mjs";

const STARTED_EVENT = "subagent:async-started";
const COMPLETED_EVENT = "subagent:async-complete";

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
} = {}) {
  if (!rpc || !events?.on) throw new ExecutionProtocolError("EXECUTION_BACKEND_INVALID", "rpc and events are required");
  const pending = new Map();
  const byRunId = new Map();
  let sessionId = null;
  let rpcSessionId = null;
  let disposed = false;

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
    });
    entry.binding = binding;
    byRunId.set(runId, binding);
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
    if (completed) pending.delete(entry.request.dispatchId);
  }

  const unsubscribes = [
    events.on(STARTED_EVENT, (event) => lifecycle(event, false)),
    events.on(COMPLETED_EVENT, (event) => lifecycle(event, true)),
  ].filter((unsubscribe) => typeof unsubscribe === "function");

  for (const binding of bindings) {
    if (!binding?.dispatchId || !binding?.attemptId || !binding?.runId || !binding?.asyncDir
      || !binding?.cwd || !binding?.output || !binding?.sessionId) {
      throw new ExecutionProtocolError("EXECUTION_BINDING_INVALID", "Recovered execution binding is incomplete");
    }
    const request = normalizeExecutionSpawn({
      ...binding,
      agent: "executor",
      task: binding.task ?? "Recovered approved task",
      output: binding.output ?? `${binding.asyncDir}/recovered-output.json`,
      timeoutMs: binding.timeoutMs ?? 1,
    });
    const entry = { request, binding: Object.freeze({ ...binding }) };
    pending.set(request.dispatchId, entry);
    byRunId.set(binding.runId, entry.binding);
    sessionId ??= binding.sessionId;
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
      const entry = { request, binding: null };
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
          entry.binding = Object.freeze({
            dispatchId: request.dispatchId,
            attemptId: request.attemptId,
            runId: observed.runId,
            asyncDir: observed.asyncDir,
            cwd: request.cwd,
            output: request.output,
            sessionId,
          });
          byRunId.set(observed.runId, entry.binding);
        }
        return entry.binding;
      } catch (error) {
        if (!entry.binding) pending.delete(request.dispatchId);
        throw error;
      }
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
      pending.clear();
      byRunId.clear();
      rpc.dispose?.();
    },
  });
}
