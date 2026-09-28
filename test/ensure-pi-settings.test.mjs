import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ensureSettings } from "../scripts/ensure-pi-settings.ts";

const template = {
  packages: [
    { source: "../packages/pi-subagents-enhanced" },
    { source: "npm:@amaster.ai/pi-task-scheduler@0.1.9", extensions: [], skills: [], prompts: [], themes: [] },
  ],
  subagents: { disableBuiltins: true, agentOverrides: { delegate: { disabled: false } } },
};

async function fixture(existing) {
  const root = await mkdtemp(join(tmpdir(), "ensure-pi-settings-"));
  const target = join(root, "settings.json");
  const templatePath = join(root, "settings.template.json");
  await writeFile(templatePath, JSON.stringify(template));
  if (existing !== undefined) await writeFile(target, JSON.stringify(existing));
  return { root, target, templatePath };
}

test("creates settings from the shared template when target is absent", async () => {
  const paths = await fixture();
  try {
    await ensureSettings(paths);
    assert.deepEqual(JSON.parse(await readFile(paths.target, "utf8")), template);
  } finally { await rm(paths.root, { recursive: true, force: true }); }
});

test("merges shared fields while preserving local settings", async () => {
  const existing = {
    enabledModels: ["local/model"], defaultProvider: "local", theme: "local",
    packages: [{ source: "../../.r2c/integrations/pi-adapter" }, { source: "npm:@amaster.ai/pi-task-scheduler@0.1.9", extensions: ["local"] }],
    subagents: { agentOverrides: { delegate: { disabled: true, localOnly: true } }, localField: 7 },
  };
  const paths = await fixture(existing);
  try {
    await ensureSettings(paths);
    const result = JSON.parse(await readFile(paths.target, "utf8"));
    assert.deepEqual(result.packages, [existing.packages[0], existing.packages[1], template.packages[0]]);
    assert.deepEqual(result.subagents, { agentOverrides: { delegate: { disabled: false, localOnly: true } }, localField: 7, disableBuiltins: true });
    assert.deepEqual(result.enabledModels, existing.enabledModels);
    assert.equal(result.defaultProvider, "local");
    assert.equal(result.theme, "local");
  } finally { await rm(paths.root, { recursive: true, force: true }); }
});

test("replaying ensure is idempotent", async () => {
  const paths = await fixture({ packages: [], subagents: {} });
  try {
    await ensureSettings(paths);
    const first = await readFile(paths.target, "utf8");
    await ensureSettings(paths);
    assert.equal(await readFile(paths.target, "utf8"), first);
  } finally { await rm(paths.root, { recursive: true, force: true }); }
});
