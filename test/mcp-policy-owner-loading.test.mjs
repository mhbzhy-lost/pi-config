import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { sdk } from './helpers/joint-upgrade-session.mjs';

const sharedTemplatePath = join(import.meta.dirname, '..', 'pi', 'settings.template.json');

function ownerSummary(loader) {
  const result = loader.getExtensions();
  const extensions = result.extensions ?? [];
  return {
    errors: result.errors ?? [],
    warnings: result.warnings ?? [],
    codemodeOwners: extensions.filter(extension => extension.tools?.has?.('codemode')).length,
    mcpOwners: extensions.filter(extension => extension.commands?.has?.('mcp')).length,
  };
}

async function makeLoader(root, template) {
  const agentDir = join(root, 'agent');
  const cwd = join(root, 'cwd');
  await mkdir(join(agentDir, 'extensions'), { recursive: true });
  await mkdir(cwd, { recursive: true });
  const policyEntry = join(agentDir, 'extensions', 'mcp-policy.ts');
  const implementation = pathToFileURL(new URL('../src/mcp-policy/index.ts', import.meta.url).pathname).href;
  await writeFile(policyEntry, `export { registerConfiguredToolRuntime as default } from ${JSON.stringify(implementation)};\n`);
  const resources = template.resources ?? template;
  const settingsManager = sdk.SettingsManager.inMemory({
    extensions: resources.extensions,
    defaultTools: resources.defaultTools,
    enableInstallTelemetry: false,
    defaultProjectTrust: 'always',
  });
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const loader = new sdk.DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    noSkills: true,
    noThemes: true,
    noContextFiles: true,
    noPromptTemplates: true,
    extensionFactories: [
      { name: 'codemode', builtin: true, replaceable: true, factory: sdk.createCodemodeExtension({ models: false }) },
      { name: 'mcp', builtin: true, replaceable: true, factory: sdk.createMcpExtension() },
    ],
  });
  return { loader, agentDir, cwd, restoreEnv() {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  } };
}

test('F0 template copy produces replacement warnings before owner exclusions', async t => {
  // 独立字面量旧选择：不能从当前模板自动推导预期，否则删掉排除项时测试仍会通过。
  const baseline = { extensions: ['-builtin:tool-search', '-builtin:llama.cpp'], defaultTools: ['+codemode', '-tool_search'] };
  const root = await mkdtemp(join(tmpdir(), 'trial-owner-red-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fixture = await makeLoader(root, baseline);
  t.after(() => fixture.restoreEnv());
  await fixture.loader.reload();
  const summary = ownerSummary(fixture.loader);
  assert.equal(summary.errors.length, 0);
  assert.ok(summary.warnings.length > 0, JSON.stringify(summary));
  assert.equal(summary.codemodeOwners, 1);
  assert.equal(summary.mcpOwners, 1);
});

test('template owner exclusions make fresh and synthetic resume loads warning-free with one owner', async t => {
  const root = await mkdtemp(join(tmpdir(), 'trial-owner-loading-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const currentTemplate = JSON.parse(await readFile(sharedTemplatePath, 'utf8'));
  const template = { resources: { extensions: currentTemplate.extensions, defaultTools: currentTemplate.defaultTools } };
  const first = await makeLoader(root, template);
  t.after(() => first.restoreEnv());
  await first.loader.reload();
  assert.deepEqual(ownerSummary(first.loader), { errors: [], warnings: [], codemodeOwners: 1, mcpOwners: 1 });
  const freshSession = await sdk.createAgentSession({ cwd: first.cwd, agentDir: first.agentDir, resourceLoader: first.loader, sessionManager: sdk.SessionManager.inMemory(first.cwd) });
  await freshSession.session.bindExtensions({ mode: 'print', onError: error => { throw error.error; } });
  assert.equal(freshSession.session.getAllTools().some(tool => tool.name === 'codemode'), true);
  assert.equal(freshSession.session.getAllTools().some(tool => tool.name.startsWith('mcp__')), false);
  const codemode = freshSession.session.getAllTools().find(tool => tool.name === 'codemode');
  assert.ok(codemode, '真实 codemode owner must be available');
  freshSession.session.dispose();
  const second = await makeLoader(root, template);
  t.after(() => second.restoreEnv());
  await second.loader.reload();
  assert.deepEqual(ownerSummary(second.loader), { errors: [], warnings: [], codemodeOwners: 1, mcpOwners: 1 });
});

test('persistent SessionManager create/open resumes synthetic session without duplicate owner diagnostics', async t => {
  const root = await mkdtemp(join(tmpdir(), 'trial-owner-resume-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const currentTemplate = JSON.parse(await readFile(sharedTemplatePath, 'utf8'));
  const template = { resources: { extensions: currentTemplate.extensions, defaultTools: currentTemplate.defaultTools } };
  const first = await makeLoader(root, template);
  t.after(() => first.restoreEnv());
  await first.loader.reload();
  assert.deepEqual(ownerSummary(first.loader), { errors: [], warnings: [], codemodeOwners: 1, mcpOwners: 1 });
  const sessions = join(first.agentDir, 'sessions');
  const created = sdk.SessionManager.create(first.cwd, sessions);
  const initial = await sdk.createAgentSession({ cwd: first.cwd, agentDir: first.agentDir, resourceLoader: first.loader, sessionManager: created });
  created.appendMessage({ role: 'user', content: [{ type: 'text', text: 'synthetic resume marker' }], timestamp: Date.now() });
  created.appendCustomMessageEntry('fixture-resume', 'synthetic resume marker', false);
  const sessionFile = created.getSessionFile();
  assert.ok(sessionFile);
  initial.session.dispose();
  const resumedManager = sdk.SessionManager.open(sessionFile, sessions, first.cwd);
  const second = await makeLoader(root, template);
  t.after(() => second.restoreEnv());
  await second.loader.reload();
  const resumed = await sdk.createAgentSession({ cwd: first.cwd, agentDir: first.agentDir, resourceLoader: second.loader, sessionManager: resumedManager });
  assert.deepEqual(ownerSummary(second.loader), { errors: [], warnings: [], codemodeOwners: 1, mcpOwners: 1 });
  assert.equal(resumedManager.getBranch().some(entry => entry.type === 'custom_message' && entry.customType === 'fixture-resume'), true);
  resumed.session.dispose();
});
