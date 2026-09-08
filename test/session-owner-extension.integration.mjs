import assert from "node:assert/strict";
import { chmod, lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const api = await import("../src/session-owner/index.ts").catch(() => ({}));
const registry = await import("../src/session-owner/registry.ts");
const { createAgentSession, DefaultResourceLoader, SessionManager } = await import(join((await import("node:child_process")).spawnSync("npm", ["root", "-g"], { encoding: "utf8" }).stdout.trim(), "@earendil-works", "pi-coding-agent", "dist", "index.js"));

function runner() {
  const handlers = new Map();
  return {
    handlers,
    on(type, handler) { handlers.set(type, [...(handlers.get(type) ?? []), handler]); },
  };
}

function context({ cwd = process.cwd(), id = "current", file = "/sessions/current.jsonl", notices = [] } = {}) {
  return {
    cwd,
    hasUI: true,
    ui: { notify(message) { notices.push(message); } },
    sessionManager: {
      getCwd() { return cwd; },
      getSessionId() { return id; },
      getSessionFile() { return file; },
    },
  };
}

async function temporaryRegistry() {
  return mkdtemp(join(tmpdir(), "session-owner-extension-"));
}

async function reserve(root, ownerId, reservation, pid = process.pid) {
  return registry.prepareLaunch({
    store: { root, guardTimeoutMs: 150 }, pid, ownerId,
    startedAt: "2026-09-08T00:00:00.000Z", reservation,
  });
}

test("loads an installable lifecycle extension candidate", () => {
  assert.equal(typeof api.installSessionOwnerExtension, "function");
});

test("child markers and hosts without wrapper ownership install no hooks", () => {
  const pi = runner();
  api.installSessionOwnerExtension(pi, { env: { PI_SUBAGENT_CHILD: "1" } });
  assert.equal(pi.handlers.size, 0);
  api.installSessionOwnerExtension(pi, { env: {} });
  assert.equal(pi.handlers.size, 0);
});

test("startup commits only its own pending record and replacement shutdowns remain fail closed", async () => {
  const root = await temporaryRegistry();
  const ownerId = "owner-extension-0123456789abcdef";
  const store = { root, guardTimeoutMs: 150 };
  try {
    await reserve(root, ownerId, { kind: "new" });
    const pi = runner();
    api.installSessionOwnerExtension(pi, { env: { PI_SESSION_OWNER_ID: ownerId, PI_SESSION_OWNER_REGISTRY: root }, store });
    const ctx = context();
    await pi.handlers.get("session_start")[0]({ reason: "startup" }, ctx);
    assert.deepEqual(await registry.listLiveRecords(store), [
      { protocol: "pi-session-owner.v1", ownerId, pid: process.pid, cwd: process.cwd(), sessionId: "current", sessionFile: "/sessions/current.jsonl", state: "active", pendingSessionFile: null, forkSource: null, startedAt: "2026-09-08T00:00:00.000Z" },
    ]);
    await pi.handlers.get("session_shutdown")[0]({ reason: "reload" }, ctx);
    assert.equal((await registry.listLiveRecords(store))[0].state, "active");
    await pi.handlers.get("session_shutdown")[0]({ reason: "resume" }, ctx);
    assert.equal((await registry.listLiveRecords(store))[0].state, "transitioning");
    await pi.handlers.get("session_start")[0]({ reason: "resume" }, context({ id: "replacement", file: "/sessions/replacement.jsonl" }));
    assert.equal((await registry.listLiveRecords(store))[0].state, "active");
    await pi.handlers.get("session_shutdown")[0]({ reason: "quit" }, ctx);
    assert.deepEqual(await registry.listLiveRecords(store), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("before hooks do not mutate ownership and cancel active targets or registry failures", async () => {
  const root = await temporaryRegistry();
  const ownerId = "owner-extension-0123456789abcdef";
  const otherId = "owner-other-extension-0123456789";
  const store = { root, guardTimeoutMs: 150 };
  try {
    await reserve(root, ownerId, { kind: "new" });
    await reserve(root, otherId, { kind: "session", cwd: process.cwd(), sessionFile: "/sessions/occupied.jsonl", sessionId: "occupied" });
    const pi = runner();
    api.installSessionOwnerExtension(pi, { env: { PI_SESSION_OWNER_ID: ownerId, PI_SESSION_OWNER_REGISTRY: root }, store });
    const ctx = context();
    await pi.handlers.get("session_start")[0]({ reason: "startup" }, ctx);
    assert.deepEqual(await pi.handlers.get("session_before_switch")[0]({ reason: "resume", targetSessionFile: "/sessions/occupied.jsonl" }, ctx), { cancel: true });
    assert.equal((await registry.listLiveRecords(store)).find((record) => record.ownerId === ownerId).state, "active");
    assert.deepEqual(await pi.handlers.get("session_before_fork")[0]({ entryId: "entry", position: "at" }, ctx), undefined);
    const broken = runner();
    api.installSessionOwnerExtension(broken, {
      env: { PI_SESSION_OWNER_ID: ownerId, PI_SESSION_OWNER_REGISTRY: root }, store,
      async listLiveRecords() { throw new Error("registry unavailable"); },
    });
    assert.deepEqual(await broken.handlers.get("session_before_switch")[0]({ reason: "resume", targetSessionFile: "/sessions/free.jsonl" }, ctx), { cancel: true });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("startup refuses a pending session identity mismatch without replacing the reservation", async () => {
  const root = await temporaryRegistry();
  const ownerId = "owner-extension-0123456789abcdef";
  const store = { root, guardTimeoutMs: 150 };
  try {
    await reserve(root, ownerId, { kind: "session", cwd: process.cwd(), sessionFile: "/sessions/pinned.jsonl", sessionId: "pinned" });
    const pi = runner();
    api.installSessionOwnerExtension(pi, { env: { PI_SESSION_OWNER_ID: ownerId, PI_SESSION_OWNER_REGISTRY: root }, store });
    let shutdowns = 0;
    const ctx = { ...context({ id: "other", file: "/sessions/other.jsonl" }), async shutdown() { shutdowns += 1; } };
    assert.deepEqual(await pi.handlers.get("session_start")[0]({ reason: "startup" }, ctx), { cancel: true });
    assert.equal(shutdowns, 1);
    assert.equal((await registry.listLiveRecords(store))[0].pendingSessionFile, "/sessions/pinned.jsonl");
    assert.equal((await registry.listLiveRecords(store))[0].state, "pending");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("fork-source reservation accepts Pi's new destination but not its source", async () => {
  const root = await temporaryRegistry();
  const ownerId = "owner-fork-source-0123456789abcdef";
  const store = { root, guardTimeoutMs: 150 };
  try {
    await reserve(root, ownerId, {
      kind: "fork-source",
      cwd: process.cwd(),
      source: { cwd: process.cwd(), sessionFile: "/sessions/source.jsonl", sessionId: "source" },
    });
    const pi = runner();
    api.installSessionOwnerExtension(pi, { env: { PI_SESSION_OWNER_ID: ownerId, PI_SESSION_OWNER_REGISTRY: root }, store });
    let shutdowns = 0;
    const destination = { ...context({ id: "destination", file: "/sessions/destination.jsonl" }), async shutdown() { shutdowns += 1; } };
    assert.equal(await pi.handlers.get("session_start")[0]({ reason: "startup" }, destination), undefined);
    assert.equal(shutdowns, 0);
    assert.deepEqual(await registry.listLiveRecords(store), [
      {
        protocol: "pi-session-owner.v1", ownerId, pid: process.pid, cwd: process.cwd(),
        sessionId: "destination", sessionFile: "/sessions/destination.jsonl", state: "active",
        pendingSessionFile: null, forkSource: null, startedAt: "2026-09-08T00:00:00.000Z",
      },
    ]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("real Pi ExtensionRunner commits startup and preserves ownership through reload", async () => {
  const root = await temporaryRegistry();
  const agentDir = await mkdtemp(join(tmpdir(), "session-owner-extension-agent-"));
  const ownerId = "owner-runtime-extension-0123456789";
  const store = { root, guardTimeoutMs: 150 };
  let result;
  try {
    await reserve(root, ownerId, { kind: "new" });
    const loader = new DefaultResourceLoader({
      cwd: process.cwd(), agentDir,
      extensionFactories: [(pi) => api.installSessionOwnerExtension(pi, {
        env: { PI_SESSION_OWNER_ID: ownerId, PI_SESSION_OWNER_REGISTRY: root }, store,
      })],
    });
    await loader.reload();
    result = await createAgentSession({ cwd: process.cwd(), agentDir, resourceLoader: loader, sessionManager: SessionManager.inMemory(process.cwd()) });
    await result.session.bindExtensions({ mode: "rpc", shutdownHandler() {}, onError(error) { throw error.error; } });
    assert.equal((await registry.listLiveRecords(store))[0].state, "active");
    await result.session.reload();
    assert.equal((await registry.listLiveRecords(store))[0].state, "active");
  } finally {
    if (result) {
      await result.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      result.session.dispose();
    }
    await rm(root, { recursive: true, force: true });
    await rm(agentDir, { recursive: true, force: true });
    await assert.rejects(lstat(join(process.cwd(), "auth.json")), { code: "ENOENT" });
    await assert.rejects(lstat(join(process.cwd(), "models-store.json")), { code: "ENOENT" });
  }
});

test("RED: real Pi ExtensionRunner reload normalizes a legacy v1 active record without shutdown", async () => {
  const root = await temporaryRegistry();
  const agentDir = await mkdtemp(join(tmpdir(), "session-owner-reload-agent-"));
  const ownerId = "owner-legacy-reload-0123456789";
  const store = { root, guardTimeoutMs: 150 };
  let result;
  try {
    await reserve(root, ownerId, { kind: "new" });
    const loader = new DefaultResourceLoader({
      cwd: process.cwd(), agentDir,
      extensionFactories: [(pi) => api.installSessionOwnerExtension(pi, {
        env: { PI_SESSION_OWNER_ID: ownerId, PI_SESSION_OWNER_REGISTRY: root }, store,
      })],
    });
    await loader.reload();
    result = await createAgentSession({ cwd: process.cwd(), agentDir, resourceLoader: loader, sessionManager: SessionManager.inMemory(process.cwd()) });
    let shutdowns = 0;
    await result.session.bindExtensions({ mode: "rpc", shutdownHandler() { shutdowns += 1; }, onError(error) { throw error.error; } });
    const recordPath = join(root, `${ownerId}.json`);
    const legacy = JSON.parse(await readFile(recordPath, "utf8"));
    delete legacy.forkSource;
    await writeFile(recordPath, `${JSON.stringify(legacy)}\n`, { mode: 0o600 });
    await chmod(recordPath, 0o600);

    await result.session.reload();

    const [record] = await registry.listLiveRecords(store);
    assert.equal(record.state, "active");
    assert.equal(record.forkSource, null);
    assert.equal(shutdowns, 0);
  } finally {
    result?.session.dispose();
    await rm(root, { recursive: true, force: true });
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("real Pi ExtensionRunner reload fails closed for malformed nonempty legacy forkSource", async () => {
  const root = await temporaryRegistry();
  const agentDir = await mkdtemp(join(tmpdir(), "session-owner-malformed-reload-agent-"));
  const ownerId = "owner-malformed-reload-012345";
  const store = { root, guardTimeoutMs: 150 };
  let result;
  try {
    await reserve(root, ownerId, { kind: "new" });
    const loader = new DefaultResourceLoader({
      cwd: process.cwd(), agentDir,
      extensionFactories: [(pi) => api.installSessionOwnerExtension(pi, {
        env: { PI_SESSION_OWNER_ID: ownerId, PI_SESSION_OWNER_REGISTRY: root }, store,
      })],
    });
    await loader.reload();
    result = await createAgentSession({ cwd: process.cwd(), agentDir, resourceLoader: loader, sessionManager: SessionManager.inMemory(process.cwd()) });
    let shutdowns = 0;
    await result.session.bindExtensions({ mode: "rpc", shutdownHandler() { shutdowns += 1; }, onError(error) { throw error.error; } });
    const recordPath = join(root, `${ownerId}.json`);
    const malformed = JSON.parse(await readFile(recordPath, "utf8"));
    malformed.forkSource = { sessionFile: "/sessions/source.jsonl" };
    await writeFile(recordPath, `${JSON.stringify(malformed)}\n`, { mode: 0o600 });
    await chmod(recordPath, 0o600);

    await result.session.reload();

    assert.equal(shutdowns, 1);
  } finally {
    result?.session.dispose();
    await rm(root, { recursive: true, force: true });
    await rm(agentDir, { recursive: true, force: true });
  }
});
