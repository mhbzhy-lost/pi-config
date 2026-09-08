import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const api = await import("../src/session-owner/contract.ts").catch(() => ({}));

test("exports the session owner contract", () => {
  assert.equal(typeof api.classifyPiLaunch, "function");
  assert.equal(typeof api.canonicalizeCwd, "function");
  assert.equal(typeof api.normalizeSessionPath, "function");
  assert.equal(typeof api.resolveRecentSession, "function");
});

test("classifies Pi 0.84.4 guarded separated startup forms", () => {
  assert.deepEqual(api.classifyPiLaunch([]), { kind: "new", continueArgIndex: null });
  assert.deepEqual(api.classifyPiLaunch(["-c"]), { kind: "continue", continueArgIndex: 0 });
  assert.deepEqual(api.classifyPiLaunch(["--continue"]), { kind: "continue", continueArgIndex: 0 });
  assert.deepEqual(api.classifyPiLaunch(["-r"]), { kind: "resume", continueArgIndex: null });
  assert.deepEqual(api.classifyPiLaunch(["--resume"]), { kind: "resume", continueArgIndex: null });
  assert.deepEqual(api.classifyPiLaunch(["--session", "/repo/s.jsonl"]), { kind: "session", value: "/repo/s.jsonl", continueArgIndex: null });
  assert.deepEqual(api.classifyPiLaunch(["--session-id", "exact-id"]), { kind: "session-id", value: "exact-id", continueArgIndex: null });
  assert.deepEqual(api.classifyPiLaunch(["--fork", "source-id"]), { kind: "fork", value: "source-id", continueArgIndex: null });
  assert.deepEqual(api.classifyPiLaunch(["--no-session"]), { kind: "ephemeral", continueArgIndex: null });
  assert.deepEqual(api.classifyPiLaunch(["-p", "prompt"]), { kind: "non-interactive", continueArgIndex: null });
  assert.deepEqual(api.classifyPiLaunch(["--mode", "json"]), { kind: "non-interactive", continueArgIndex: null });
  assert.deepEqual(api.classifyPiLaunch(["--mode", "rpc"]), { kind: "non-interactive", continueArgIndex: null });
});

test("does not interpret unknown equals syntax or prompt arguments after --", () => {
  assert.deepEqual(api.classifyPiLaunch(["--mode=rpc"]), { kind: "new", continueArgIndex: null });
  assert.deepEqual(api.classifyPiLaunch(["--session=/repo/s.jsonl"]), { kind: "new", continueArgIndex: null });
  assert.deepEqual(api.classifyPiLaunch(["--session-dir=/sessions"]), { kind: "new", continueArgIndex: null });
  assert.deepEqual(api.classifyPiLaunch(["--", "-c", "--session", "/repo/s.jsonl"]), { kind: "new", continueArgIndex: null });
});

test("consumes official Pi option values and retains the exact continue token index", () => {
  assert.deepEqual(api.classifyPiLaunch(["--system-prompt", "-c", "-c"]), { kind: "continue", continueArgIndex: 2 });
  assert.deepEqual(api.classifyPiLaunch(["--session-dir", "-c", "-c"]), { kind: "continue", continueArgIndex: 2 });
  assert.deepEqual(api.classifyPiLaunch(["-c", "--system-prompt", "value"]), { kind: "continue", continueArgIndex: 0 });
  assert.deepEqual(api.classifyPiLaunch(["--mode", "rpc", "--mode", "interactive"]), { kind: "new", continueArgIndex: null });
  assert.deepEqual(api.classifyPiLaunch(["--mode", "interactive", "--mode", "json"]), { kind: "non-interactive", continueArgIndex: null });
});

test("bypasses legal non-interactive reuse while retaining resume for picker blocking", () => {
  assert.deepEqual(api.classifyPiLaunch(["--mode", "rpc", "--session", "/repo/s.jsonl"]), { kind: "non-interactive", continueArgIndex: null });
  assert.deepEqual(api.classifyPiLaunch(["-p", "prompt", "--session-id", "existing"]), { kind: "non-interactive", continueArgIndex: null });
  assert.deepEqual(api.classifyPiLaunch(["--session", "/repo/s.jsonl"], { stdinTty: false, stdoutTty: false }), { kind: "non-interactive", continueArgIndex: null });
  assert.deepEqual(api.classifyPiLaunch(["-r"], { stdinTty: false, stdoutTty: false }), { kind: "resume", continueArgIndex: null });
  assert.deepEqual(api.classifyPiLaunch(["--mode", "rpc", "-r"]), { kind: "resume", continueArgIndex: null });
});

test("uses wrapper TTY facts rather than helper stdio", () => {
  assert.deepEqual(api.classifyPiLaunch([], { stdinTty: false, stdoutTty: true }), { kind: "non-interactive", continueArgIndex: null });
  assert.deepEqual(api.classifyPiLaunch([], { stdinTty: true, stdoutTty: false }), { kind: "non-interactive", continueArgIndex: null });
  assert.deepEqual(api.classifyPiLaunch([], { stdinTty: true, stdoutTty: true }), { kind: "new", continueArgIndex: null });
});

test("rejects missing values and conflicting guarded startup forms", () => {
  assert.throws(() => api.classifyPiLaunch(["--session"]), { name: "LaunchIntentError", code: "missing-value" });
  assert.throws(() => api.classifyPiLaunch(["-c", "--resume"]), { name: "LaunchIntentError", code: "conflicting-intents" });
  assert.throws(() => api.classifyPiLaunch(["--session", "a", "--fork", "b"]), { name: "LaunchIntentError", code: "conflicting-intents" });
});

test("canonicalizes cwd and existing session path aliases to filesystem identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "session-owner-contract-"));
  try {
    const cwd = join(root, "cwd");
    const alias = join(root, "cwd-alias");
    const session = join(cwd, "session.jsonl");
    await mkdir(cwd);
    await writeFile(session, "");
    await symlink(cwd, alias);

    assert.equal(api.canonicalizeCwd(alias), await realpath(cwd));
    assert.equal(api.normalizeSessionPath("session.jsonl", alias), await realpath(session));
    assert.throws(() => api.canonicalizeCwd(join(root, "missing")), { name: "LaunchIntentError", code: "unverifiable-cwd" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resolves recent JSONL sessions by filesystem mtime, stable ties, and CLI session-dir precedence", async () => {
  const root = await mkdtemp(join(tmpdir(), "session-owner-public-list-"));
  try {
    const sessions = join(root, "sessions");
    await mkdir(sessions);
    const canonicalRoot = await realpath(root);
    const first = join(sessions, "a-first.jsonl");
    const second = join(sessions, "z-second.jsonl");
    await writeFile(first, `${JSON.stringify({ type: "session", id: "first", cwd: canonicalRoot })}\n`);
    await writeFile(second, `${JSON.stringify({ type: "session", id: "second", cwd: canonicalRoot })}\n`);
    await utimes(first, 10, 10);
    await utimes(second, 20, 20);
    assert.deepEqual(await api.resolveRecentSession({ argv: ["-c", "--session-dir", sessions], cwd: root, env: { PI_CODING_AGENT_SESSION_DIR: join(root, "ignored") } }), {
      kind: "found", session: { id: "second", cwd: canonicalRoot, path: await realpath(second) },
    });
    await utimes(first, 30, 30);
    await utimes(second, 30, 30);
    assert.deepEqual(await api.resolveRecentSession({ argv: ["-c", "--session-dir", sessions], cwd: root }), {
      kind: "found", session: { id: "first", cwd: canonicalRoot, path: await realpath(first) },
    });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("recent resolver bounds large session reads and never invokes injected Pi discovery", async () => {
  const root = await mkdtemp(join(tmpdir(), "session-owner-recent-budget-"));
  try {
    const sessions = join(root, "sessions");
    const cwd = await realpath(root);
    const bodyMarker = "BODY_MUST_NOT_BE_READ";
    await mkdir(sessions);
    for (let index = 0; index < 100; index += 1) {
      const path = join(sessions, `${String(index).padStart(3, "0")}.jsonl`);
      const header = JSON.stringify({ type: "session", id: `session-${index}`, cwd: index === 0 ? cwd : join(root, "other") });
      await writeFile(path, `${header}\n${bodyMarker.repeat(20_000)}\n`);
      await utimes(path, index + 1, index + 1);
    }
    const actualHeaderBytes = Array.from({ length: 100 }, (_, index) => api.readSessionHeaderBytes(join(sessions, `${String(index).padStart(3, "0")}.jsonl`)));
    assert.equal(actualHeaderBytes.reduce((total, bytes) => total + bytes.length, 0) <= 100 * api.MAX_SESSION_HEADER_BYTES, true);
    assert.equal(actualHeaderBytes.some((bytes) => bytes.includes(Buffer.from(bodyMarker))), false);
    let listCalls = 0;
    let bytesRead = 0;
    const resolved = await api.resolveRecentSession({
      argv: ["-c", "--session-dir", sessions], cwd,
      sessionManager: { async list() { listCalls += 1; return []; } },
      readHeaderBytes(path, maximum) {
        const index = Number(/(\d+)\.jsonl$/.exec(path)?.[1]);
        const bounded = Buffer.from(`${JSON.stringify({ type: "session", id: `session-${index}`, cwd: index === 0 ? cwd : join(root, "other") })}\n`);
        bytesRead += bounded.length;
        assert.equal(bounded.includes(Buffer.from(bodyMarker)), false);
        return bounded;
      },
    });
    assert.equal(listCalls, 0);
    assert.equal(bytesRead <= 100 * api.MAX_SESSION_HEADER_BYTES, true);
    assert.deepEqual(resolved, { kind: "found", session: { id: "session-0", cwd, path: await realpath(join(sessions, "000.jsonl")) } });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("recent resolution skips invalid and foreign headers but fails closed on discovery errors", async () => {
  const root = await mkdtemp(join(tmpdir(), "session-owner-session-dir-"));
  try {
    const cwd = await realpath(root);
    const sessions = join(root, "sessions");
    await mkdir(sessions);
    await writeFile(join(sessions, "invalid.jsonl"), "not json\n");
    await writeFile(join(sessions, "foreign.jsonl"), `${JSON.stringify({ type: "session", id: "foreign", cwd: join(root, "other") })}\n`);
    assert.deepEqual(await api.resolveRecentSession({ argv: ["-c", "--session-dir", sessions], cwd }), { kind: "absent" });
    const file = join(root, "not-a-directory");
    await writeFile(file, "x");
    assert.deepEqual(await api.resolveRecentSession({ argv: ["-c", "--session-dir", file], cwd }), { kind: "unavailable" });
    assert.deepEqual(await api.resolveRecentSession({ argv: ["-c", "--session-dir", join(root, "missing")], cwd }), { kind: "absent" });
    assert.deepEqual(await api.resolveRecentSession({ argv: ["--continue", "--session-dir"], cwd }), { kind: "unavailable" });
    assert.deepEqual(await api.resolveRecentSession({ argv: ["-c", "--session-dir", sessions], cwd, readHeaderBytes() { throw new Error("read failed"); } }), { kind: "unavailable" });
    assert.deepEqual(await api.resolveRecentSession({ argv: ["-c", "--session-dir", sessions], cwd, statMtime() { throw new Error("stat race"); } }), { kind: "unavailable" });
    await writeFile(join(sessions, "too-large.jsonl"), "x".repeat(api.MAX_SESSION_HEADER_BYTES));
    assert.deepEqual(await api.resolveRecentSession({ argv: ["-c", "--session-dir", sessions], cwd }), { kind: "unavailable" });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("resolves path, exact ID, and unique prefix targets while failing closed on ambiguous prefixes", async () => {
  const cwd = process.cwd();
  const sessions = [
    { id: "exact-id", cwd, path: "/sessions/exact.jsonl" },
    { id: "prefix-one", cwd, path: "/sessions/one.jsonl" },
    { id: "prefix-two", cwd, path: "/sessions/two.jsonl" },
  ];
  const sessionManager = { async list() { return sessions; }, async listAll() { return sessions; } };
  const pathTarget = await api.resolveLaunchTarget({ argv: ["--session", "/sessions/direct.jsonl"], cwd, intent: api.classifyPiLaunch(["--session", "/sessions/direct.jsonl"]), sessionManager });
  assert.deepEqual(pathTarget, { kind: "resolved", reservation: { kind: "session", cwd: api.canonicalizeCwd(cwd), sessionFile: "/sessions/direct.jsonl", sessionId: null } });
  const publicId = await api.resolveLaunchTarget({ argv: ["--session", "exact-id"], cwd, intent: api.classifyPiLaunch(["--session", "exact-id"]), sessionManager });
  assert.deepEqual(publicId, { kind: "resolved", reservation: { kind: "session", cwd: api.canonicalizeCwd(cwd), sessionFile: "/sessions/exact.jsonl", sessionId: "exact-id" } });
  const existingId = await api.resolveLaunchTarget({ argv: ["--session-id", "exact-id"], cwd, intent: api.classifyPiLaunch(["--session-id", "exact-id"]), sessionManager });
  assert.equal(existingId.reservation.sessionFile, "/sessions/exact.jsonl");
  const newId = await api.resolveLaunchTarget({ argv: ["--session-id", "new-id"], cwd, intent: api.classifyPiLaunch(["--session-id", "new-id"]), sessionManager });
  assert.deepEqual(newId, { kind: "resolved", reservation: { kind: "session-id", cwd: api.canonicalizeCwd(cwd), sessionId: "new-id" } });
  const ambiguous = await api.resolveLaunchTarget({ argv: ["--fork", "prefix"], cwd, intent: api.classifyPiLaunch(["--fork", "prefix"]), sessionManager });
  assert.deepEqual(ambiguous, { kind: "unavailable" });
});

test("reads an existing path header before reserving it and rejects invalid identities", async () => {
  const root = await mkdtemp(join(tmpdir(), "session-owner-header-"));
  try {
    const cwd = await realpath(root);
    const session = join(root, "existing.jsonl");
    const canonicalSession = await realpath(root).then((directory) => join(directory, "existing.jsonl"));
    await writeFile(session, `${JSON.stringify({ type: "session", id: "header-id", cwd })}\n${JSON.stringify({ type: "message" })}\n`);
    const target = await api.resolveLaunchTarget({ argv: ["--session", session], cwd, intent: api.classifyPiLaunch(["--session", session]), sessionManager: { async list() { return []; } } });
    assert.deepEqual(target, { kind: "resolved", reservation: { kind: "session", cwd, sessionFile: canonicalSession, sessionId: "header-id" } });
    const fork = await api.resolveLaunchTarget({ argv: ["--fork", session], cwd, intent: api.classifyPiLaunch(["--fork", session]), sessionManager: { async list() { return []; } } });
    assert.deepEqual(fork, { kind: "resolved", reservation: { kind: "fork-source", cwd, source: { cwd, sessionFile: canonicalSession, sessionId: "header-id" } } });
    await writeFile(session, `${JSON.stringify({ type: "message", id: "wrong", cwd })}\n`);
    assert.deepEqual(await api.resolveLaunchTarget({ argv: ["--session", session], cwd, intent: api.classifyPiLaunch(["--session", session]), sessionManager: { async list() { return []; } } }), { kind: "unavailable" });
    await writeFile(session, `${JSON.stringify({ type: "session", id: "header-id", cwd: "/other" })}\n`);
    assert.deepEqual(await api.resolveLaunchTarget({ argv: ["--session", session], cwd, intent: api.classifyPiLaunch(["--session", session]), sessionManager: { async list() { return []; } } }), { kind: "unavailable" });
  } finally { await rm(root, { recursive: true, force: true }); }
});
