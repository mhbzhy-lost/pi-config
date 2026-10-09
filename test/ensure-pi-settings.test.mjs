import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

const R2C_ADAPTER_SOURCE = "../../.r2c/integrations/pi-adapter";

async function fixtureWithAdapter(existing) {
  const paths = await fixture(existing);
  const adapterDir = join(paths.root, "r2c-adapter");
  await mkdir(adapterDir);
  return { ...paths, adapterDir };
}

test("creates settings from the shared template when target is absent", async () => {
  const paths = await fixture();
  try {
    await ensureSettings({ target:paths.target, template:paths.templatePath });
    assert.deepEqual(JSON.parse(await readFile(paths.target, "utf8")), template);
  } finally { await rm(paths.root, { recursive: true, force: true }); }
});

test("merges shared fields while preserving local settings", async () => {
  const existing = {
    enabledModels: ["local/model"], defaultProvider: "local", theme: "local",
    packages: [{ source: "../../.r2c/integrations/pi-adapter" }, { source: "npm:@amaster.ai/pi-task-scheduler@0.1.9", extensions: ["local"] }],
    subagents: { agentOverrides: { delegate: { disabled: true, localOnly: true } }, localField: 7 },
  };
  const paths = await fixtureWithAdapter(existing);
  try {
    await ensureSettings({ target:paths.target, template:paths.templatePath, r2cAdapterDir:paths.adapterDir });
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
    await ensureSettings({ target:paths.target, template:paths.templatePath });
    const first = await readFile(paths.target, "utf8");
    await ensureSettings({ target:paths.target, template:paths.templatePath });
    assert.equal(await readFile(paths.target, "utf8"), first);
  } finally { await rm(paths.root, { recursive: true, force: true }); }
});

test('existing settings增量启用codemode并禁tool_search/llama，保留本机enabledModels',async()=>{
 const paths=await fixture({enabledModels:['local/model'],defaultTools:['read','bash'],extensions:['custom.ts']});
 try {await writeFile(paths.templatePath,JSON.stringify({...template,defaultTools:['+codemode','-tool_search'],extensions:['-builtin:tool-search','-builtin:llama.cpp']}));await ensureSettings({target:paths.target,template:paths.templatePath});const value=JSON.parse(await readFile(paths.target,'utf8'));assert.deepEqual(value.defaultTools,['read','bash','+codemode','-tool_search']);assert.deepEqual(value.extensions,['custom.ts','-builtin:tool-search','-builtin:llama.cpp']);assert.deepEqual(value.enabledModels,['local/model']);}
 finally{await rm(paths.root,{recursive:true,force:true});}
});

test('ensure和check在相反精确resource selector存在时拒绝且不写入', async () => {
  for (const field of ['extensions', 'defaultTools']) for (const selector of ['builtin:mcp', 'builtin:code-mode', 'builtin:tool-search']) {
    const paths = await fixture({ enabledModels: ['local/model'], [field]: [`+${selector}`] });
    try {
      await writeFile(paths.templatePath, JSON.stringify({ ...template, [field]: [`-${selector}`] }));
      const before = await readFile(paths.target, 'utf8');
      for (const check of [false, true]) {
        await assert.rejects(
          ensureSettings({ target: paths.target, template: paths.templatePath, check }),
          error => error.code === 'SETTINGS_RESOURCE_OVERRIDE_CONFLICT' && error.field === field && error.selector === selector,
        );
        assert.equal(await readFile(paths.target, 'utf8'), before);
      }
    } finally { await rm(paths.root, { recursive: true, force: true }); }
  }
});

test('已有双方精确token和template自身相反token在写入前拒绝', async () => {
  for (const field of ['extensions', 'defaultTools']) {
    const both = await fixture({ enabledModels: ['local/model'], [field]: ['+builtin:tool-search', '-builtin:tool-search'] });
    try {
      await writeFile(both.templatePath, JSON.stringify({ ...template, [field]: ['-builtin:tool-search'] }));
      const before = await readFile(both.target, 'utf8');
      await assert.rejects(ensureSettings({ target: both.target, template: both.templatePath, check: true }), error =>
        error.code === 'SETTINGS_RESOURCE_OVERRIDE_CONFLICT' && error.field === field && error.selector === 'builtin:tool-search');
      assert.equal(await readFile(both.target, 'utf8'), before);
    } finally { await rm(both.root, { recursive: true, force: true }); }
  }
  for (const field of ['extensions', 'defaultTools']) {
    const paths = await fixture({ enabledModels: ['local/model'] });
    try {
      await writeFile(paths.templatePath, JSON.stringify({ ...template, [field]: ['+builtin:mcp', '-builtin:mcp'] }));
      const before = await readFile(paths.target, 'utf8').catch(() => null);
      await assert.rejects(ensureSettings({ target: paths.target, template: paths.templatePath }), error =>
        error.code === 'SETTINGS_RESOURCE_OVERRIDE_CONFLICT' && error.field === field && error.selector === 'builtin:mcp');
      assert.equal(await readFile(paths.target, 'utf8').catch(() => null), before);
    } finally { await rm(paths.root, { recursive: true, force: true }); }
  }
});

test("r2c adapter 已安装时按模板挂载 package 且 check 通过、幂等", async () => {
  const paths = await fixtureWithAdapter();
  try {
    const withAdapter = { ...template, packages: [...template.packages, R2C_ADAPTER_SOURCE] };
    await writeFile(paths.templatePath, JSON.stringify(withAdapter));
    await ensureSettings({ target: paths.target, template: paths.templatePath, r2cAdapterDir: paths.adapterDir });
    const mounted = JSON.parse(await readFile(paths.target, "utf8"));
    assert.equal(mounted.packages.at(-1), R2C_ADAPTER_SOURCE);
    await ensureSettings({ target: paths.target, template: paths.templatePath, r2cAdapterDir: paths.adapterDir, check: true });
    const first = await readFile(paths.target, "utf8");
    await ensureSettings({ target: paths.target, template: paths.templatePath, r2cAdapterDir: paths.adapterDir });
    assert.equal(await readFile(paths.target, "utf8"), first);
  } finally { await rm(paths.root, { recursive: true, force: true }); }
});

test("r2c adapter 缺失时过滤模板条目并自愈悬空注册，check 不要求该字段", async () => {
  const absentDir = "absent-r2c-adapter";
  const withAdapter = { ...template, packages: [...template.packages, R2C_ADAPTER_SOURCE] };
  const paths = await fixture();
  try {
    await writeFile(paths.templatePath, JSON.stringify(withAdapter));
    await ensureSettings({ target: paths.target, template: paths.templatePath, r2cAdapterDir: join(paths.root, absentDir) });
    assert.deepEqual(JSON.parse(await readFile(paths.target, "utf8")).packages, template.packages);
    await ensureSettings({ target: paths.target, template: paths.templatePath, r2cAdapterDir: join(paths.root, absentDir), check: true });

    await writeFile(paths.target, JSON.stringify({ packages: [R2C_ADAPTER_SOURCE] }));
    await assert.rejects(
      ensureSettings({ target: paths.target, template: paths.templatePath, r2cAdapterDir: join(paths.root, absentDir), check: true }),
      /stale r2c adapter package/,
    );
    await ensureSettings({ target: paths.target, template: paths.templatePath, r2cAdapterDir: join(paths.root, absentDir) });
    assert.deepEqual(JSON.parse(await readFile(paths.target, "utf8")).packages, template.packages);
  } finally { await rm(paths.root, { recursive: true, force: true }); }
});
