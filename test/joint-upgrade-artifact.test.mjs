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

/**
 * 仓库唯一允许的本地 `file:` 依赖：只认这一条名字与这一个声明，不构造通用包发现器。
 * 豁免必须同时满足：相应 lockRoot 的真实 package.json 精确声明、lock 内成对 link/包目录项。
 */
const ALLOWED_LOCAL_PACKAGE = { name: 'pi-subagents-enhanced', spec: 'file:./packages/pi-subagents-enhanced' };

function normalizeLocalTarget(spec) {
  return path.posix.normalize(spec.slice('file:'.length).trim().replace(/^\.\//, '').replace(/\/+$/, ''));
}

/**
 * 从 lockRoot 的真实 package.json 核对唯一豁免项（而非从 lock 自身自授权）；
 * 声明缺失、改成 registry 版本或指向其它路径时返回空豁免集，此时任何 link/目录项都按污染处理。
 */
function localFilePackages(lockRoot) {
  const manifest = JSON.parse(readFileSync(path.join(lockRoot, 'package.json'), 'utf8'));
  const declared = { ...manifest.dependencies, ...manifest.devDependencies, ...manifest.optionalDependencies };
  const links = new Map();
  const dirs = new Map();
  const spec = declared[ALLOWED_LOCAL_PACKAGE.name];
  const expectedTarget = normalizeLocalTarget(ALLOWED_LOCAL_PACKAGE.spec);
  if (typeof spec === 'string' && spec.startsWith('file:') && normalizeLocalTarget(spec) === expectedTarget) {
    links.set('node_modules/' + ALLOWED_LOCAL_PACKAGE.name, { name: ALLOWED_LOCAL_PACKAGE.name, target: expectedTarget });
    dirs.set(expectedTarget, { name: ALLOWED_LOCAL_PACKAGE.name });
  }
  return { links, dirs };
}
test('目标四核心包与实际CLI一致，旧shrinkwrap未复用', () => {
  for (const name of ['pi-agent-core', 'pi-ai', 'pi-coding-agent', 'pi-tui']) {
    const file = path.resolve(host, "..", name, "package.json");
    assert.equal(JSON.parse(readFileSync(file)).version, '1.4.0');
  }
  assert.equal(existsSync(path.join(host, 'npm-shrinkwrap.json')), false);
  const result = spawnSync(process.execPath, [path.join(host, 'dist/bundle/cli.js'), '--version'], {
    env: candidateEnvironment({ candidateRoot: root, hostRoot: host, nodeBin: process.execPath }), encoding: 'utf8', timeout: 15000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), '1.4.0');
});
test('Host TypeBox三个公开入口完整，上游安装为0.80.0', () => {
  for (const specifier of ['typebox', 'typebox/compile', 'typebox/value']) assert.ok(require.resolve(specifier));
  const upstream = JSON.parse(readFileSync(path.resolve(import.meta.dirname, '../packages/pi-subagents-enhanced/node_modules/pi-subagents/package.json')));
  assert.equal(upstream.version, '0.80.0');
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
  assert.equal(run.stdout.trim(), '1.4.0');
});
test('所有候选lock可移植，不含tmp路径或file-link污染', () => {
  const scopes = manifest
    ? ['repo', 'repo/packages/pi-subagents-enhanced', 'host', 'scheduler'].map(scope => [scope, path.join(root, scope)])
    : [['repo', repoRoot], ['repo/packages/pi-subagents-enhanced', path.join(repoRoot, 'packages/pi-subagents-enhanced')]];
  for (const [scope, lockRoot] of scopes) {
    const lock = JSON.parse(readFileSync(path.join(lockRoot, 'package-lock.json')));
    assert.ok(!String(lock.version ?? '').startsWith('file:'), scope + ': root version');
    const { links, dirs } = localFilePackages(lockRoot);
    for (const [key, entry] of Object.entries(lock.packages)) {
      const link = links.get(key);
      if (link) {
        // 声明的本地包：必须是 link，且 resolved 恰为声明的包目录
        assert.equal(entry.link, true, scope + ': ' + key + ' 声明的本地包必须为link');
        assert.equal(entry.resolved, link.target, scope + ': ' + key + ' 链接目标');
        continue;
      }
      const dir = dirs.get(key);
      if (dir) {
        // 对应包目录项：必须是真实目录项，带自身版本，不得伪装registry包
        assert.notEqual(entry.link, true, scope + ': ' + key);
        assert.match(String(entry.version ?? ''), /^\d+\.\d+\.\d+/, scope + ': ' + key + ' version');
        assert.equal(entry.resolved, undefined, scope + ': ' + key + ' resolved');
        assert.equal(entry.integrity, undefined, scope + ': ' + key + ' integrity');
        continue;
      }
      assert.ok(key === '' || key.startsWith('node_modules/') || [...dirs.keys()].some(target => key.startsWith(target + '/node_modules/')), scope + ': ' + key);
      assert.notEqual(entry.link, true, scope + ': ' + key);
    }
    // 声明与实际必须闭合：link条目与包目录项成对存在，且磁盘manifest名字一致
    for (const [key, { name, target }] of links) {
      assert.ok(lock.packages[key], scope + ': 缺少本地link条目 ' + key);
      assert.ok(lock.packages[target], scope + ': 缺少本地包目录项 ' + target);
      assert.equal(JSON.parse(readFileSync(path.join(lockRoot, target, 'package.json'), 'utf8')).name, name, scope + ': ' + target + ' manifest name');
    }
  }
});

test('目标锁的每个registry解析保留resolved/integrity，bundled子项不伪造独立SRI',()=>{
 const scopes = manifest
   ? ['repo', 'repo/packages/pi-subagents-enhanced', 'host', 'scheduler'].map(scope => [scope, path.join(root, scope)])
   : [['repo', repoRoot], ['repo/packages/pi-subagents-enhanced', path.join(repoRoot, 'packages/pi-subagents-enhanced')]];
 for(const [scope, lockRoot] of scopes){
  const lock=JSON.parse(readFileSync(path.join(lockRoot,'package-lock.json')));
  const {links,dirs}=localFilePackages(lockRoot);
  for(const [key,value] of Object.entries(lock.packages)){
   if(!key)continue;
   const link=links.get(key);
   if(link){
    // 唯一豁免：声明的本地file包只允许目录型resolved，且不得伪造registry SRI
    assert.equal(value.resolved,link.target,scope+': '+key+' resolved');
    assert.equal(value.integrity,undefined,scope+': '+key+' integrity');
    continue;
   }
   if(dirs.has(key)){
    assert.match(String(value.version??''),/^\d+\.\d+\.\d+/,scope+': '+key+' version');
    assert.equal(value.resolved,undefined,scope+': '+key+' resolved');
    assert.equal(value.integrity,undefined,scope+': '+key+' integrity');
    continue;
   }
   assert.notEqual(value.link,true,scope+': '+key+' 未声明的link');
   if(value.inBundle)continue;
   assert.match(value.resolved??'',/^https:\/\/registry\.npmjs\.org\//,scope+': '+key+' resolved');
   assert.match(value.integrity??'',/^sha(?:256|512)-[A-Za-z0-9+/=]+$/,scope+': '+key+' integrity');
  }
 }
});
