import { link, mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

const PLAN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SCHEMA_VERSION = "pi-plan-control.v1";
const ATTENTION_SCHEMA_VERSION = "pi-plan-attention-command.v1";

function validIdentity(value) {
  return typeof value === "string" && PLAN_ID.test(value) && !value.includes("..");
}

function controlPaths(stateRoot, planId) {
  if (!validIdentity(planId)) throw new Error("Invalid planId");
  const runsRoot = path.resolve(stateRoot, "var", "plan-runs");
  const directory = path.resolve(runsRoot, planId, "control");
  const relative = path.relative(runsRoot, directory);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Plan control path escapes plan-runs");
  return {
    directory,
    request: path.join(directory, "cancel-request.json"),
    ack: path.join(directory, "cancel-ack.json"),
    attention: path.join(directory, "attention"),
  };
}

async function writeAtomic(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}-${process.pid}-${crypto.randomUUID()}.tmp`);
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, file);
}

function parseRequest(value) {
  if (!value || value.schemaVersion !== SCHEMA_VERSION || value.type !== "cancel" || !validIdentity(value.requestId) || !validIdentity(value.planId) || !validIdentity(value.runId) || typeof value.occurredAt !== "string" || !value.occurredAt) {
    throw new Error("Invalid cancel request");
  }
  return value;
}

function matchingCancelledAck(value, request) {
  return value && value.schemaVersion === SCHEMA_VERSION && value.type === "cancel" && value.requestId === request.requestId && value.planId === request.planId && value.runId === request.runId && value.lifecycle === "cancelled" && value.result === "accepted" && typeof value.occurredAt === "string" && value.occurredAt;
}

function parseAttentionReply(value) {
  const input = value?.schemaVersion === ATTENTION_SCHEMA_VERSION ? value : { ...value, schemaVersion: ATTENTION_SCHEMA_VERSION };
  for (const field of ["planId", "requestId", "taskId", "attemptId", "runId"]) {
    if (!validIdentity(input?.[field])) throw new Error(`Invalid attention reply ${field}`);
  }
  if (!Number.isInteger(input.expectedProjectionVersion) || input.expectedProjectionVersion < 1) {
    throw new Error("Invalid attention reply projection version");
  }
  if (typeof input.message !== "string" || !input.message.trim() || Buffer.byteLength(input.message, "utf8") > 64 * 1024) {
    throw new Error("Invalid attention reply message");
  }
  if (typeof input.occurredAt !== "string" || !input.occurredAt) throw new Error("Invalid attention reply occurredAt");
  return input;
}

function publicAttentionReply(value) {
  const { schemaVersion: _schemaVersion, ...reply } = value;
  return reply;
}

function attentionPath(paths, requestId, suffix) {
  if (!validIdentity(requestId)) throw new Error("Invalid attention reply requestId");
  return path.join(paths.attention, `${requestId}.${suffix}.json`);
}

function matchingAttentionReply(existing, expected) {
  return ["planId", "requestId", "taskId", "attemptId", "runId", "expectedProjectionVersion", "message"].every((field) => existing[field] === expected[field]);
}

async function publishAttentionReply(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}-${process.pid}-${crypto.randomUUID()}.tmp`);
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  try {
    await link(temporary, file);
    return value;
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    let existing;
    try {
      existing = parseAttentionReply(JSON.parse(await readFile(file, "utf8")));
    } catch {
      throw new Error("A different durable Plan Attention reply is already queued");
    }
    if (!matchingAttentionReply(existing, value)) throw new Error("A different durable Plan Attention reply is already queued");
    return existing;
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function createPlanControl({ stateRoot, id = () => crypto.randomUUID(), now = () => new Date().toISOString(), intervalMs = 50, timeoutMs = 5_000 } = {}) {
  if (typeof stateRoot !== "string" || !stateRoot) throw new Error("stateRoot is required");

  return {
    paths(planId) {
      return controlPaths(stateRoot, planId);
    },
    async requestCancel({ planId, runId }) {
      if (!validIdentity(planId)) throw new Error("Invalid planId");
      if (!validIdentity(runId)) throw new Error("Invalid runId");
      const request = parseRequest({ schemaVersion: SCHEMA_VERSION, requestId: id(), planId, runId, type: "cancel", occurredAt: now() });
      const paths = controlPaths(stateRoot, planId);
      await writeAtomic(paths.request, request);
      const deadline = Date.now() + timeoutMs;
      while (Date.now() <= deadline) {
        try {
          const ack = JSON.parse(await readFile(paths.ack, "utf8"));
          if (matchingCancelledAck(ack, request)) return ack;
        } catch (error) {
          if (error?.code !== "ENOENT" && error instanceof SyntaxError) throw new Error("Invalid cancel acknowledgement");
          if (error?.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
        }
        await delay(intervalMs);
      }
      throw new Error("Plan cancellation acknowledgement timed out");
    },
    async readRequest(planId) {
      const paths = controlPaths(stateRoot, planId);
      try {
        return parseRequest(JSON.parse(await readFile(paths.request, "utf8")));
      } catch (error) {
        if (error?.code === "ENOENT") return null;
        throw error;
      }
    },
    async writeAck(ack) {
      const request = parseRequest(ack);
      if (!["cancelled", "rejected"].includes(ack.lifecycle) || typeof ack.result !== "string" || !ack.result) throw new Error("Invalid cancel acknowledgement");
      await writeAtomic(controlPaths(stateRoot, request.planId).ack, ack);
      return ack;
    },
    async writeAttentionReply(command) {
      const parsed = parseAttentionReply(command);
      const paths = controlPaths(stateRoot, parsed.planId);
      return publicAttentionReply(await publishAttentionReply(attentionPath(paths, parsed.requestId, "reply"), parsed));
    },
    async readAttentionReplies(planId) {
      const paths = controlPaths(stateRoot, planId);
      let files;
      try {
        files = await readdir(paths.attention);
      } catch (error) {
        if (error?.code === "ENOENT") return [];
        throw error;
      }
      const replies = [];
      for (const file of files.filter((name) => name.endsWith(".reply.json")).sort()) {
        const requestId = file.slice(0, -".reply.json".length);
        try {
          await readFile(attentionPath(paths, requestId, "ack"), "utf8");
          continue;
        } catch (error) {
          if (error?.code !== "ENOENT") throw error;
        }
        const parsed = parseAttentionReply(JSON.parse(await readFile(path.join(paths.attention, file), "utf8")));
        if (parsed.planId !== planId || parsed.requestId !== requestId) throw new Error("Invalid attention reply command identity");
        replies.push(publicAttentionReply(parsed));
      }
      return replies;
    },
    async writeAttentionAck(ack) {
      const parsed = parseAttentionReply(ack);
      if (ack.result !== "delivered" || typeof ack.deliveredAt !== "string" || !ack.deliveredAt) {
        throw new Error("Invalid attention reply acknowledgement");
      }
      const value = { ...parsed, result: ack.result, deliveredAt: ack.deliveredAt };
      const paths = controlPaths(stateRoot, parsed.planId);
      await writeAtomic(attentionPath(paths, parsed.requestId, "ack"), value);
      return publicAttentionReply(value);
    },
  };
}
