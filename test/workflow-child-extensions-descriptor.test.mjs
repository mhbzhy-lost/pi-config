import assert from "node:assert/strict";
import test from "node:test";
import { realpath } from "node:fs/promises";
const { registerRequiredChildExtensions } = await import("../packages/pi-subagents-enhanced/node_modules/pi-subagents/src/api/required-child-extensions.js");

test("public required-child-extensions registration preserves an immutable launch snapshot", async () => {
  const extensionPath = await realpath(new URL("../packages/pi-subagents-enhanced/child-extensions/root-session-owner.ts", import.meta.url));
  const stableSessionId = `descriptor-test-${Date.now()}`;
  const stable = registerRequiredChildExtensions({
    sessionId: stableSessionId,
    extensions: [{ id: "root-session-owner", path: extensionPath }],
  });
  try {
    assert.equal(typeof stable.dispose, "function");
  } finally {
    stable.dispose();
  }
 });

test("public required-child-extensions registration rejects duplicate IDs", async () => {
  const extensionPath = await realpath(new URL("../packages/pi-subagents-enhanced/child-extensions/root-session-owner.ts", import.meta.url));
  assert.throws(() => registerRequiredChildExtensions({
    sessionId: "descriptor-test-duplicate",
    extensions: [
      { id: "root-session-owner", path: extensionPath },
      { id: "root-session-owner", path: extensionPath },
    ],
  }), /duplicated/i);
});
