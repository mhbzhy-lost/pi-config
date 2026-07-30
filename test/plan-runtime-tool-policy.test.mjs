import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { ensurePlanRuntimeTools } from "../scripts/lib/plan/plan-runtime-tools.mjs";

const root = path.resolve(import.meta.dirname, "..");

function runtime({ registered, active, ignoreActivation = false }) {
  let current = [...active];
  return {
    pi: {
      getAllTools() {
        return registered.map((name) => ({ name }));
      },
      getActiveTools() {
        return [...current];
      },
      setActiveTools(names) {
        if (!ignoreActivation) current = [...names];
      },
    },
    activeTools() {
      return [...current];
    },
  };
}

test("activates registered native Plan Runner runtime tools for a standalone session", () => {
  const subject = runtime({
    registered: ["read", "subagent_wait", "subagent_supervisor"],
    active: ["read", "subagent_wait"],
  });

  const activated = ensurePlanRuntimeTools(subject.pi, [
    "subagent_wait",
    "subagent_supervisor",
  ]);

  assert.deepEqual(activated, ["subagent_wait", "subagent_supervisor"]);
  assert.deepEqual(subject.activeTools(), [
    "read",
    "subagent_wait",
    "subagent_supervisor",
  ]);
});

test("rejects a missing native runtime tool instead of inventing an active name", () => {
  const subject = runtime({
    registered: ["read", "subagent_wait"],
    active: ["read", "subagent_wait"],
  });

  assert.throws(
    () => ensurePlanRuntimeTools(subject.pi, ["subagent_wait", "subagent_supervisor"]),
    /not registered: subagent_supervisor/,
  );
  assert.deepEqual(subject.activeTools(), ["read", "subagent_wait"]);
});

test("fails closed when the runtime refuses to activate a registered tool", () => {
  const subject = runtime({
    registered: ["read", "subagent_wait", "subagent_supervisor"],
    active: ["read", "subagent_wait"],
    ignoreActivation: true,
  });

  assert.throws(
    () => ensurePlanRuntimeTools(subject.pi, ["subagent_wait", "subagent_supervisor"]),
    /could not be activated: subagent_supervisor/,
  );
});

test("runtime tool failures identify the Plan Session without Standalone Runner terminology", async () => {
  const source = await readFile(path.join(root, "scripts/lib/plan/plan-runtime-tools.mjs"), "utf8");
  assert.match(source, /Plan Session/);
  assert.doesNotMatch(source, /Standalone Plan Runner/);
});
