import assert from "node:assert/strict";
import test from "node:test";
import { pathToFileURL } from "node:url";
import {
  loadPiTestRuntime,
  resolvePiCodingAgentRoot,
} from "./pi-runtime.mjs";
import { resolvePiHostPaths } from "./pi-host.mjs";

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

test("Pi host paths derive every alias from the explicit candidate root", () => {
  const paths = resolvePiHostPaths({
    env: { PI_TEST_CODING_AGENT_ROOT: "/candidate/pi-coding-agent" },
    readGlobalNodeModules: () => "/global/node_modules",
  });
  assert.equal(paths.piHostRoot, "/candidate/pi-coding-agent");
  assert.equal(paths.piHostModuleUrl, pathToFileURL("/candidate/pi-coding-agent/dist/index.js").href);
  assert.equal(
    paths.piHostAliases["@earendil-works/pi-tui"],
    "/candidate/pi-coding-agent/node_modules/@earendil-works/pi-tui/dist/index.js",
  );
});

test("actual runtime loader exposes Pi and TUI constructors", async () => {
  const runtime = await loadPiTestRuntime(import.meta.url);
  assert.equal(typeof runtime.codingAgent.SessionManager, "function");
  assert.equal(typeof runtime.piTui.TuiMainScreen, "function");
  assert.equal(typeof runtime.piTui.TuiAltScreen, "function");
});
