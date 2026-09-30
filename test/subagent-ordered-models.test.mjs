import assert from "node:assert/strict";
import test from "node:test";
import { piHostAliases, piHostJitiUrl } from "./helpers/pi-host.mjs";

const { createJiti } = await import(piHostJitiUrl);
const jiti = createJiti(import.meta.url, { moduleCache: false, alias: piHostAliases });
const { resolveModelCandidates } = await jiti.import("../packages/pi-subagents-enhanced/src/subagent-dispatch/model-selection.ts");

test("resolveModelCandidates preserves the declared candidate order", () => {
  assert.deepEqual(resolveModelCandidates({
    agentName: "ordered",
    models: ["pool/primary", "direct/backup", "other/last"],
    availableModels: [
      { provider: "other", id: "last" },
      { provider: "pool", id: "primary" },
      { provider: "direct", id: "backup" },
    ],
  }), ["pool/primary", "direct/backup", "other/last"]);
});

test("resolveModelCandidates rejects an empty declaration", () => {
  assert.throws(
    () => resolveModelCandidates({ agentName: "empty", models: [], availableModels: [] }),
    /candidate chain.*empty|declared candidates.*empty/i,
  );
});

test("resolveModelCandidates reports the complete unavailable declaration", () => {
  assert.throws(
    () => resolveModelCandidates({
      agentName: "unavailable",
      models: ["pool/primary", "direct/backup"],
      availableModels: [{ provider: "other", id: "available" }],
    }),
    (error) => {
      assert.match(error.message, /pool\/primary/);
      assert.match(error.message, /direct\/backup/);
      return true;
    },
  );
});

test("coding child extension declarations are registered through the public required-child API", async () => {
  const source = await import("node:fs/promises").then((fs) => fs.readFile(
    new URL("../packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts", import.meta.url),
    "utf8",
  ));
  assert.match(source, /from ["']pi-subagents\/required-child-extensions["']/);
  assert.match(source, /registerRequiredChildExtensions\(/);
});
