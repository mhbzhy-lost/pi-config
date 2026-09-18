import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import test from "node:test";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  loadPiTestRuntime,
  resolvePiCodingAgentRoot,
} from "./pi-runtime.mjs";
import { resolvePiHostPaths } from "./pi-host.mjs";

const explicitCandidateRoot = resolve(import.meta.dirname, "..", "..", "node_modules", "@earendil-works", "pi-coding-agent");
const explicitCandidateRealRoot = realpathSync(explicitCandidateRoot);

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
    env: { PI_TEST_CODING_AGENT_ROOT: ` ${explicitCandidateRoot} ` },
    readGlobalNodeModules: () => "/global/node_modules",
  });
  assert.equal(paths.piHostRoot, explicitCandidateRoot);
  assert.ok(paths.piHostAliases["@earendil-works/pi-coding-agent"].startsWith(explicitCandidateRealRoot));
  assert.ok(paths.piHostAliases["@earendil-works/pi-tui"].startsWith(explicitCandidateRealRoot));
  assert.ok(paths.piHostAliases["@earendil-works/pi-ai/compat"].startsWith(explicitCandidateRealRoot));
  assert.equal(paths.piHostModuleUrl, pathToFileURL(paths.piHostAliases["@earendil-works/pi-coding-agent"]).href);
  assert.equal(paths.piHostJitiUrl, pathToFileURL(`${explicitCandidateRoot}/node_modules/jiti/lib/jiti.mjs`).href);
});

test("runtime loader exposes the resolved public package entries of one candidate instance", async () => {
  const runtime = await loadPiTestRuntime(import.meta.url, {
    env: { PI_TEST_CODING_AGENT_ROOT: explicitCandidateRoot },
  });
  const hostPaths = resolvePiHostPaths({ env: { PI_TEST_CODING_AGENT_ROOT: explicitCandidateRoot } });
  assert.equal(runtime.root, explicitCandidateRoot);
  assert.equal(runtime.paths.codingAgent, hostPaths.piHostModuleUrl);
  assert.equal(runtime.paths.piTui, hostPaths.piHostAliases["@earendil-works/pi-tui"]);
  assert.equal(runtime.paths.piAi, hostPaths.piHostAliases["@earendil-works/pi-ai"]);
  assert.equal(runtime.paths.piAiCompat, hostPaths.piHostAliases["@earendil-works/pi-ai/compat"]);
  assert.equal(runtime.paths.piAgentCore, hostPaths.piHostAliases["@earendil-works/pi-agent-core"]);
  assert.equal(runtime.paths.jiti, hostPaths.piHostJitiUrl);
  for (const path of [runtime.paths.piTui, runtime.paths.piAi, runtime.paths.piAiCompat, runtime.paths.piAgentCore]) {
    assert.ok(path.startsWith(explicitCandidateRealRoot), `${path} must resolve inside the candidate root`);
  }
});

test("actual runtime loader exposes Pi and TUI constructors", async () => {
  const runtime = await loadPiTestRuntime(import.meta.url);
  assert.equal(typeof runtime.codingAgent.SessionManager, "function");
  assert.equal(typeof runtime.piTui.TuiMainScreen, "function");
  assert.equal(typeof runtime.piTui.TuiAltScreen, "function");
});
