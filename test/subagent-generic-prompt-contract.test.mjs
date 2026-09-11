import assert from "node:assert/strict";
import test from "node:test";

const contract = {
  task: "Assess the proposed boundary.",
  context: ["The caller has no authority to choose runtime capabilities."],
  constraints: ["Do not claim Host-owned authority."],
  deliverable: "A concise review finding.",
  done: ["Every finding identifies its evidence."],
};

async function loadCodec() {
  try {
    return await import("../packages/pi-subagents-enhanced/src/contracts/generic-prompt.ts");
  } catch (error) {
    if (error?.code === "ERR_MODULE_NOT_FOUND") return null;
    throw error;
  }
}

test("compiles every prompt-bearing generic input into an independently hashed prompt", async () => {
  const codec = await loadCodec();
  assert.ok(codec?.compileGenericPrompt, "generic five-part prompt codec must exist");

  const baseline = codec.compileGenericPrompt(contract);
  assert.match(baseline.hash, /^[a-f0-9]{64}$/);
  for (const [field, replacement] of Object.entries({
    task: "Assess a different boundary.",
    context: ["The Host owns runtime capability grants."],
    constraints: ["Do not accept caller supplied return routes."],
    deliverable: "A structured review finding.",
    done: ["Every conclusion is traceable to evidence."],
  })) {
    assert.notEqual(codec.compileGenericPrompt({ ...contract, [field]: replacement }).hash, baseline.hash, `${field} must affect the compiled prompt identity`);
  }
});

test("renders the five prompt sections in canonical order", async () => {
  const codec = await loadCodec();
  assert.ok(codec?.renderGenericPrompt, "generic five-part prompt renderer must exist");

  const prompt = codec.renderGenericPrompt(codec.compileGenericPrompt(contract));
  assert.deepEqual(prompt.split("\n").filter((line) => line.startsWith("## ")), [
    "## Task",
    "## Context",
    "## Constraints",
    "## Deliverable",
    "## Done",
  ]);
  assert.match(prompt, /Assess the proposed boundary/);
  assert.match(prompt, /Every finding identifies its evidence/);
});
