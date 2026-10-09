import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { candidateEnvironment } from './helpers/joint-upgrade-environment.mjs';
import { resolveJointUpgradeLayout } from './helpers/joint-upgrade-layout.mjs';

const { repoRoot, candidateRoot: root, hostRoot: host, manifest } = resolveJointUpgradeLayout();
const require = createRequire(path.join(host, 'package.json'));
test('目标四核心包与实际CLI一致，旧shrinkwrap未复用', () => {
  for (const name of ['pi-agent-core', 'pi-ai', 'pi-coding-agent', 'pi-tui']) {
    const file = path.resolve(host, "..", name, "package.json");
    assert.equal(JSON.parse(readFileSync(file)).version, '1.0.4');
  }
  assert.equal(existsSync(path.join(host, 'npm-shrinkwrap.json')), false);
  const result = spawnSync(process.execPath, [path.join(host, 'dist/bundle/cli.js'), '--version'], {
    env: candidateEnvironment({ candidateRoot: root, hostRoot: host, nodeBin: process.execPath }), encoding: 'utf8', timeout: 15000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), '1.0.4');
});
test('Host TypeBox三个公开入口完整，上游安装为0.75', () => {
  for (const specifier of ['typebox', 'typebox/compile', 'typebox/value']) assert.ok(require.resolve(specifier));
  const upstream = JSON.parse(readFileSync(path.resolve(import.meta.dirname, '../packages/pi-subagents-enhanced/node_modules/pi-subagents/package.json')));
  assert.equal(upstream.version, '0.75.0');
});
test('候选环境拒绝相对路径并不继承认证环境', () => {
  assert.throws(() => candidateEnvironment({ candidateRoot: 'relative', hostRoot: host, nodeBin: process.execPath }), TypeError);
  const env = candidateEnvironment({ candidateRoot: root, hostRoot: host, nodeBin: process.execPath });
  assert.equal(Object.hasOwn(env, 'OPENAI_API_KEY'), false);
});

test('候选明确绑定physical CLI而非bundle，同时不依赖ambient入口', () => {
  const env = candidateEnvironment({ candidateRoot: root, hostRoot: host, nodeBin: process.execPath });
  assert.equal(env.PI_REAL_BIN, path.join(host, 'dist/cli.js'));
  assert.equal(env.T8_PI_REAL_BIN, path.join(host, 'dist/cli.js'));
  const run = spawnSync(process.execPath, [env.PI_REAL_BIN, '--version'], { env, encoding: 'utf8', timeout: 15000 });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout.trim(), '1.0.4');
});
test('所有候选lock可移植，不含tmp路径或file-link污染', () => {
  const scopes = manifest
    ? ['repo', 'repo/packages/pi-subagents-enhanced', 'host', 'scheduler'].map(scope => [scope, path.join(root, scope)])
    : [['repo', repoRoot], ['repo/packages/pi-subagents-enhanced', path.join(repoRoot, 'packages/pi-subagents-enhanced')]];
  for (const [scope, lockRoot] of scopes) {
    const lock = JSON.parse(readFileSync(path.join(lockRoot, 'package-lock.json')));
    assert.ok(!String(lock.version ?? '').startsWith('file:'), scope + ': root version');
    for (const [key, entry] of Object.entries(lock.packages)) {
      assert.ok(key === '' || key.startsWith('node_modules/'), scope + ': ' + key);
      assert.notEqual(entry.link, true, scope + ': ' + key);
    }
  }
});

test('目标锁的每个registry解析保留resolved/integrity，bundled子项不伪造独立SRI',()=>{
 const scopes = manifest
   ? ['repo', 'repo/packages/pi-subagents-enhanced', 'host', 'scheduler'].map(scope => [scope, path.join(root, scope)])
   : [['repo', repoRoot], ['repo/packages/pi-subagents-enhanced', path.join(repoRoot, 'packages/pi-subagents-enhanced')]];
 for(const [scope, lockRoot] of scopes){
  const lock=JSON.parse(readFileSync(path.join(lockRoot,'package-lock.json')));
  for(const [key,value] of Object.entries(lock.packages)){
   if(!key||value.link||value.inBundle)continue;
   assert.match(value.resolved??'',/^https:\/\/(?:registry\.npmjs\.org|registry\.anpm\.alibaba-inc\.com)\//,scope+': '+key+' resolved');
   assert.match(value.integrity??'',/^sha(?:256|512)-[A-Za-z0-9+/=]+$/,scope+': '+key+' integrity');
  }
 }
});
