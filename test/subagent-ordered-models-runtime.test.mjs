import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { piHostAliases, piHostJitiUrl } from "./helpers/pi-host.mjs";

const { createJiti } = await import(piHostJitiUrl);
const jiti = createJiti(import.meta.url, { moduleCache: false, alias: piHostAliases });
const { discoverAgents } = await jiti.import("../pi/npm/node_modules/pi-subagents/src/agents/agents.ts");
const { resolveSubagentLaunchContract } = await jiti.import("../pi/npm/node_modules/pi-subagents/src/api/preflight.ts");

async function fixture(frontmatter) {
  const root = await mkdtemp(join(tmpdir(), "ordered-models-"));
  const agentsDir = join(root, ".pi", "agents");
  await mkdir(agentsDir, { recursive: true });
  await writeFile(join(agentsDir, "ordered.md"), `---\nname: ordered\ndescription: fixture\n${frontmatter}---\n\nFixture agent.\n`);
  return root;
}

test("models defines the exact primary and fallback order and ignores legacy fields", async (t) => {
  const root = await fixture([
    "model: legacy/primary\n",
    "fallbackModels: legacy/one, legacy/two\n",
    "models:\n",
    "  - provider/terra\n",
    "  - provider/luna\n",
    "  - other/fallback\n",
  ].join(""));
  t.after(() => rm(root, { recursive: true, force: true }));

  const agent = discoverAgents(root, "project").agents.find((candidate) => candidate.name === "ordered");
  assert.ok(agent);
  assert.equal(agent.model, "provider/terra");
  assert.deepEqual(agent.fallbackModels, ["provider/terra", "provider/luna", "other/fallback"]);
  assert.equal(agent.extraFields?.models, undefined);
});

test("models rejects empty, duplicate, and malformed candidates", async (t) => {
  const inputs = [
    "models:\n",
    "models:\n  - provider/a\n  - provider/a\n",
    "models:\n  - provider/a\n  - invalid-candidate\n",
  ];

  for (const [index, frontmatter] of inputs.entries()) {
    const root = await fixture(frontmatter);
    t.after(() => rm(root, { recursive: true, force: true }));
    const discovered = discoverAgents(root, "project");
    assert.equal(discovered.agents.some((candidate) => candidate.name === "ordered"), false, `case ${index} must omit invalid agent`);
    assert.ok(
      discovered.agentDiagnostics.some((diagnostic) => diagnostic.name === "ordered" && /models.*(?:non-empty|duplicate|candidate)/i.test(diagnostic.error)),
      `case ${index} must record a model validation diagnostic: ${JSON.stringify(discovered.agentDiagnostics)}`,
    );
  }
});

test("preflight exposes models in declared execution order", async (t) => {
  const declared = ["provider/primary", "provider/fallback", "other/last"];
  const root = await fixture(`models:\n${declared.map((model) => `  - ${model}`).join("\n")}\n`);
  t.after(() => rm(root, { recursive: true, force: true }));

  const result = await resolveSubagentLaunchContract({
    agent: "ordered",
    agentScope: "project",
    cwd: root,
    task: "probe",
    runId: "ordered-models-probe",
    availableModels: declared.map((fullId) => {
      const [provider, ...id] = fullId.split("/");
      return { provider, id: id.join("/"), fullId };
    }),
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.contract.modelCandidates, declared);
  assert.equal(result.contract.model, declared[0]);
});

test("an explicit tier primary tries every declared model in that tier before the remaining order", async (t) => {
  const declared = [
    "pool/gpt-5.6-terra",
    "direct/gpt-5.6-terra",
    "pool/gpt-5.6-luna",
    "direct/gpt-5.6-luna",
    "other/fallback",
  ];
  const root = await fixture(`models:\n${declared.map((model) => `  - ${model}`).join("\n")}\n`);
  t.after(() => rm(root, { recursive: true, force: true }));

  const result = await resolveSubagentLaunchContract({
    agent: "ordered",
    agentScope: "project",
    cwd: root,
    task: "probe",
    model: "pool/gpt-5.6-luna",
    runId: "ordered-models-tier-probe",
    availableModels: declared.map((fullId) => {
      const [provider, ...id] = fullId.split("/");
      return { provider, id: id.join("/"), fullId };
    }),
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.contract.modelCandidates, [
    "pool/gpt-5.6-luna",
    "direct/gpt-5.6-luna",
    "pool/gpt-5.6-terra",
    "direct/gpt-5.6-terra",
    "other/fallback",
  ]);
});

test("a tier primary absent from models falls back to the unchanged declared order", async (t) => {
  const declared = ["provider/alpha", "provider/beta", "other/fallback"];
  const root = await fixture(`models:\n${declared.map((model) => `  - ${model}`).join("\n")}\n`);
  t.after(() => rm(root, { recursive: true, force: true }));
  const available = ["pool/gpt-5.6-terra", ...declared];

  const result = await resolveSubagentLaunchContract({
    agent: "ordered",
    agentScope: "project",
    cwd: root,
    task: "probe",
    model: "pool/gpt-5.6-terra",
    runId: "ordered-models-no-tier-match",
    availableModels: available.map((fullId) => {
      const [provider, ...id] = fullId.split("/");
      return { provider, id: id.join("/"), fullId };
    }),
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.contract.modelCandidates, ["pool/gpt-5.6-terra", ...declared]);
});
