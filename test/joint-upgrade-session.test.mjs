import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { loadPiTestRuntime } from "./helpers/pi-runtime.mjs";
import { classifyPiLaunch, resolveLaunchTarget, resolveRecentSession } from "../src/session-owner/contract.ts";

const { codingAgent: sdk, root: hostRoot } = await loadPiTestRuntime(import.meta.url);
const { parseArgs } = await import(pathToFileURL(join(hostRoot, "dist/cli/args.js")));

test("官方合法 value flags 保留实际 continue token，不用非法枚举伪 RED", () => {
  for (const [flag, value, field, expected] of [
    ["--use-theme", "dark", "useTheme", "dark"],
    ["--tui-mode", "regular", "tuiMode", "regular"],
    ["--tui-mode", "fullscreen", "tuiMode", "fullscreen"],
    ["-t", "read,bash", "tools", ["read", "bash"]],
    ["-xt", "write,edit", "excludeTools", ["write", "edit"]],
    ["-n", "-c", "name", "-c"],
  ]) {
    const parsed = parseArgs([flag, value, "-c"]);
    assert.deepEqual(parsed.diagnostics, [], flag);
    assert.deepEqual(parsed[field], expected, flag);
    assert.equal(parsed.continue, true, flag);
    assert.deepEqual(classifyPiLaunch([flag, value]), { kind: "new", continueArgIndex: null }, flag);
    assert.deepEqual(classifyPiLaunch([flag, value, "-c"]), { kind: "continue", continueArgIndex: 2 }, flag);
  }
});

test("public SessionManager 首 user 落盘使 wrapper 能发现同一身份；context_edit 与 fork 不改 raw user", async () => {
  const temp = await mkdtemp(join(tmpdir(), "joint-102-session-"));
  try {
    const cwd = await realpath(temp);
    const sessions = join(cwd, "sessions");
    const manager = sdk.SessionManager.create(cwd, sessions);
    const id = manager.getSessionId();
    const file = manager.getSessionFile();
    manager.appendModelChange("synthetic", "synthetic");
    manager.appendThinkingLevelChange("off");
    manager.appendSessionInfo("setup-only");
    assert.equal(existsSync(file), false);
    assert.deepEqual(await resolveRecentSession({ argv: ["--session-dir", sessions], cwd }), { kind: "absent" });
    const user = manager.appendMessage({ role: "user", content: "original", timestamp: Date.now() });
    assert.equal(existsSync(file), true);
    const persisted = (await readFile(file, "utf8")).trim().split("\n").map(JSON.parse);
    assert.equal(persisted[0].id, id);
    assert.equal(persisted[0].cwd, cwd);
    assert.ok(persisted.some((entry) => entry.id === user && entry.message.content === "original"));
    const recent = await resolveRecentSession({ argv: ["--session-dir", sessions], cwd });
    assert.equal(recent.session.id, id);
    assert.equal(recent.session.path, file);
    const target = await resolveLaunchTarget({ argv: ["--session-id", id, "--session-dir", sessions], cwd, intent: classifyPiLaunch(["--session-id", id]), sessionManager: sdk.SessionManager });
    assert.equal(target.reservation.sessionId, id);
    assert.equal(target.reservation.sessionFile, file);
    const edit = manager.appendContextEdit(user, { content: "replacement" });
    assert.equal(manager.getEntry(user).message.content, "original");
    assert.equal(manager.buildSessionContext().messages.find((m) => m.role === "user").content, "replacement");
    manager.branch(user);
    assert.equal(manager.buildSessionContext().messages.find((m) => m.role === "user").content, "original");
    manager.branch(edit);
    const opened = sdk.SessionManager.open(file);
    assert.equal(opened.getSessionId(), id);
    assert.equal(opened.buildSessionContext().messages.find((m) => m.role === "user").content, "replacement");
    const fork = sdk.SessionManager.forkFrom(file, cwd, join(cwd, "forks"));
    assert.notEqual(fork.getSessionId(), id);
    assert.equal(fork.getHeader().parentSession, file);
    assert.equal(fork.buildSessionContext().messages.find((m) => m.role === "user").content, "replacement");
  } finally { await rm(temp, { recursive: true, force: true }); }
});
