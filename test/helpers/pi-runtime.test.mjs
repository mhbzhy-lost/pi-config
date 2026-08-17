import assert from "node:assert/strict";
import test from "node:test";
import {
  loadPiTestRuntime,
  resolvePiCodingAgentRoot,
} from "./pi-runtime.mjs";

test("explicit candidate Pi package root wins without a Homebrew assumption", () => {
  assert.equal(resolvePiCodingAgentRoot({
    env: { PI_TEST_CODING_AGENT_ROOT: " /candidate/pi-coding-agent " },
    readGlobalNodeModules: () => "/global/node_modules",
  }), "/candidate/pi-coding-agent");
});

test("global fallback joins the package under npm root", () => {
  assert.equal(resolvePiCodingAgentRoot({
    env: {},
    readGlobalNodeModules: () => "/global/node_modules",
  }), "/global/node_modules/@earendil-works/pi-coding-agent");
});

test("actual runtime loader exposes Pi and TUI constructors", async () => {
  const runtime = await loadPiTestRuntime(import.meta.url);
  assert.equal(typeof runtime.codingAgent.SessionManager, "function");
  assert.equal(typeof runtime.piTui.TuiMainScreen, "function");
  assert.equal(typeof runtime.piTui.TuiAltScreen, "function");
});
