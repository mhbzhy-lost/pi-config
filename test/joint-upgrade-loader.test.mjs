import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { candidateEnvironment } from './helpers/joint-upgrade-environment.mjs';
import { resolveJointUpgradeLayout } from './helpers/joint-upgrade-layout.mjs';

const { repoRoot: repo, candidateRoot: c, hostRoot: h } = resolveJointUpgradeLayout();
const upstream = path.join(repo, 'packages/pi-subagents-enhanced/node_modules/pi-subagents');
if (process.argv[2] === '--probe') {
  const sdk = await import(pathToFileURL(path.join(h, 'dist/index.js')).href);
  const loaded = await sdk.discoverAndLoadExtensions([path.join(repo, 'test/fixtures/joint-upgrade/loader-entry.ts')], repo, path.join(c, 'agent'));
  assert.deepEqual(loaded.errors, [], '加载缺包不是身份RED');
  const extension = loaded.extensions.find(e => e.commands.has('joint-identity'));
  assert.ok(extension);
  const ids = extension.commands.get('joint-identity').handler();
  const renderer = extension.messageRenderers.get('subagent_watchdog_warning');
  assert.equal(typeof renderer, 'function');
  const details = { severity: 'concern', importance: 'high', category: 'test-gap', source: 'main', state: 'displayed', summary: '联合目标同实例检查', evidence: 'public compat实际consumer', recommendedAction: 'probe' };
  const component = renderer({ customType: 'subagent_watchdog_warning', content: details.summary, display: true, details }, { expanded: true }, { fg: (_, s) => s, bold: s => s });
  // 0.79.2 的 watchdog 渲染器返回 SubagentMessageBlock extends Host Box（不再是直接 Container）。
  const hostTui = await import(pathToFileURL(path.join(h, '..', 'pi-tui', 'dist', 'index.js')).href);
  console.log(JSON.stringify({ core: '1.3.0', upstream: '0.79.2', node: process.versions.node, containerEqualsHost: ids.host.Container === hostTui.Container, watchdogBoxSubclass: component instanceof hostTui.Box && component.constructor !== hostTui.Box, nativeSessionEqualsHost: ids.native.SessionManager === ids.host.SessionManager }));
  loaded.runtime.invalidate();
  assert.equal(ids.host.Container, hostTui.Container, 'Host Container仍须与Host pi-tui模块同源');
  assert.equal(component instanceof hostTui.Box, true, '实际watchdog必须是physical Host Box子类');
  assert.notEqual(component.constructor, hostTui.Box, '实际watchdog必须是upstream子类，不得退化为裸Host Box');
} else {
  const { default: test } = await import('node:test');
  test('联合目标实际compat native watchdog同realm身份', () => {
    const env = candidateEnvironment({ candidateRoot: c, hostRoot: h, nodeBin: process.execPath });
    env.JOINT_NATIVE_ENTRY = path.join(repo, 'test/fixtures/joint-upgrade/loader-native.mjs');
    env.JOINT_COMPAT_ENTRY = path.join(repo, 'packages/pi-subagents-enhanced/src/compat/pi-subagents-0.75.ts');
    const run = spawnSync(process.execPath, [import.meta.filename, '--probe'], { env, cwd: repo, encoding: 'utf8', timeout: 45000 });
    assert.equal(run.status, 0, run.stdout + run.stderr);
  });
  test('0.75 optional node alias解除首门但不是同实例证明', async () => {
    const { resolveHostPeerAliases } = await import(pathToFileURL(path.join(upstream, 'src/runs/background/runner-aliases.js')).href);
    const result = resolveHostPeerAliases(h);
    assert.deepEqual(result.missing, []);
    assert.equal(Object.hasOwn(result.aliases, '@earendil-works/pi-agent-core/node'), false);
  });
}
