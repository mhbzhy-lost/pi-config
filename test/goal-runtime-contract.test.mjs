import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodePlanContract, hashPlanContract, readPlanContract, PlanContractError } from '../src/goal-runtime/contract.ts';
import { admitRepositoryCandidates, resolveTaskRepository, resolveParticipatingRepositories, bindingSemanticInput } from '../src/goal-runtime/repository-resolution.ts';
import { decodePlanBinding, decodeGoalStateSnapshot } from '../src/goal-runtime/session-state.ts';
import { captureSubject, captureBindingSubject, compareSubjects } from '../src/goal-runtime/verification.ts';

function contract() {
  return { schema: 'goal-runtime.plan.v1', objective: '验证隔离计划', constraints: ['只读检查'],
    resources: [{ id: 'slot', capacity: 1 }],
    checks: [{ id: 'C', statement: '退出成功', command: { executable: 'true', args: [], timeoutSeconds: 5 }, repairTaskIds: ['A'] }],
    tasks: [{ id: 'A', agent: 'delegate', task: '输入为临时仓库；仅修改声明路径，异常时停止。', deps: [], writePaths: ['src/**'], resources: ['slot'], acceptance: { criteria: ['满足检查'] }, checkIds: ['C'] }], terminalCheckIds: ['C'] };
}
const block = value => `<!-- goal-runtime-contract:start -->\n\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\`\n<!-- goal-runtime-contract:end -->`;
function rejects(code, mutate, pattern) {
  const value = contract(); mutate(value);
  assert.throws(() => decodePlanContract(value), error => {
    assert.ok(error instanceof PlanContractError); assert.equal(error.code, code);
    assert.ok(error.keypath); if (pattern) assert.match(error.message, pattern); return true;
  });
}
async function files(work) {
  const dir = await mkdtemp(join(tmpdir(), 'goal-contract-'));
  try { await work(join(dir, 'plan.md')); } finally { await rm(dir, { recursive: true, force: true }); }
}

test('契约正向解码、独立副本与递归冻结', () => {
  const input = contract(); const decoded = decodePlanContract(input);
  assert.deepEqual(decoded, input); assert.notEqual(decoded, input);
  function frozen(value) { if (value && typeof value === 'object') { assert.ok(Object.isFrozen(value)); Object.values(value).forEach(frozen); } }
  frozen(decoded); assert.throws(() => decoded.tasks[0].deps.push('B'), TypeError);
  input.tasks[0].task = '外部修改'; assert.notEqual(decoded.tasks[0].task, input.tasks[0].task);
});
test('语义 hash 对 checkbox、JSON 空白和递归键序稳定，合同变化失效', async () => files(async file => {
  const value = contract(); const expected = hashPlanContract(value);
  assert.equal(expected, '16f06191226dad2d4ef9ed1f467a80bb4180661b906ff7be13c97fc0eccc690a');
  await writeFile(file, '- [ ] 执行\n' + block(value)); assert.equal((await readPlanContract(file)).contractHash, expected);
  const reverse = value => Array.isArray(value) ? value.map(reverse) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).reverse().map(([k, v]) => [k, reverse(v)])) : value;
  await writeFile(file, '- [x] 执行\n\n' + block(reverse(value)).replaceAll('\n', '\r\n'));
  assert.equal((await readPlanContract(file)).contractHash, expected);
  value.constraints.push('新增约束'); assert.notEqual(hashPlanContract(value), expected);
}));
test('结构与身份拒绝码：INVALID_CONTRACT INVALID_VALUE UNKNOWN_FIELD UNKNOWN_SCHEMA DUPLICATE_ID', () => {
  rejects('INVALID_CONTRACT', c => { delete c.objective; });
  rejects('INVALID_VALUE', c => { c.tasks[0].id = 'bad id'; });
  rejects('UNKNOWN_FIELD', c => { c.passed = true; });
  rejects('UNKNOWN_FIELD', c => { c.tasks[0].repoId = 'repoA'; });
  rejects('UNKNOWN_SCHEMA', c => { c.schema = 'goal-runtime.plan.v2'; });
  rejects('DUPLICATE_ID', c => c.tasks.push(structuredClone(c.tasks[0])));
});
test('引用闭合与重复拒绝码：DUPLICATE_REFERENCE UNKNOWN_TASK_REF UNKNOWN_CHECK_REF UNKNOWN_RESOURCE_REF', () => {
  rejects('DUPLICATE_REFERENCE', c => { c.terminalCheckIds = ['C', 'C']; });
  rejects('UNKNOWN_TASK_REF', c => { c.tasks[0].deps = ['missing']; });
  rejects('UNKNOWN_TASK_REF', c => { c.checks[0].repairTaskIds = ['missing']; });
  rejects('UNKNOWN_CHECK_REF', c => { c.terminalCheckIds = ['missing']; });
  rejects('UNKNOWN_CHECK_REF', c => { c.tasks[0].checkIds = ['missing']; });
  rejects('UNKNOWN_RESOURCE_REF', c => { c.tasks[0].resources = ['missing']; });
});
test('修复可达、死检查与终态拒绝码：MISSING_REPAIR_OWNER EMPTY_REPAIR_OWNERS EMPTY_TERMINAL_CHECKS ORPHAN_CHECK', () => {
  rejects('MISSING_REPAIR_OWNER', c => {
    c.tasks.push({ ...structuredClone(c.tasks[0]), id: 'B', deps: ['A'], checkIds: [] }); c.checks[0].repairTaskIds = ['B'];
  });
  rejects('EMPTY_REPAIR_OWNERS', c => { c.checks[0].repairTaskIds = []; });
  rejects('EMPTY_TERMINAL_CHECKS', c => { c.terminalCheckIds = []; });
  rejects('ORPHAN_CHECK', c => c.checks.push({ ...structuredClone(c.checks[0]), id: 'unused' }));
});
test('DAG 拒绝自依赖并返回完整环路径', () => {
  rejects('SELF_DEPENDENCY', c => { c.tasks[0].deps = ['A']; });
  rejects('DEPENDENCY_CYCLE', c => {
    c.tasks.push({ ...structuredClone(c.tasks[0]), id: 'B', deps: ['A'], checkIds: [] }); c.tasks[0].deps = ['B'];
  }, /A → B → A/);
});
test('路径文法、重复、容量、timeout、控制字符与 32KiB 上界', () => {
  rejects('DUPLICATE_PATH', c => { c.tasks[0].writePaths = ['src/**', 'src/**']; });
  for (const path of ['/tmp/a', '../a', 'a/../b', 'a\\b', 'a/*', '/**', 'a//b', 'a/', './a']) rejects('INVALID_PATH', c => { c.tasks[0].writePaths = [path]; });
  for (const capacity of [-1, 0.5, 1000001]) rejects('INVALID_CAPACITY', c => { c.resources[0].capacity = capacity; });
  for (const timeout of [0, 1.5, 86401]) rejects('INVALID_COMMAND', c => { c.checks[0].command.timeoutSeconds = timeout; });
  rejects('INVALID_VALUE', c => { c.checks[0].command.args = ['a\u0000b']; });
  rejects('INVALID_CONTRACT', c => { c.tasks[0].task = 'a'.repeat(32769); });
  const edge = contract(); edge.tasks[0].task = 'a'.repeat(32768); edge.resources[0].capacity = 0; assert.ok(decodePlanContract(edge));
});
test('区块拒绝码：缺失、重复、夹带、逆序与非法 JSON', async () => files(async file => {
  const valid = block(contract());
  const cases = [
    ['MISSING_CONTRACT_BLOCK', '# 无契约'],
    ['DUPLICATE_CONTRACT_BLOCK', valid + '\n' + valid],
    ['INVALID_CONTRACT_BLOCK', valid.replace('```json', '夹带正文\n```json')],
    ['INVALID_CONTRACT_BLOCK', '<!-- goal-runtime-contract:end -->\n<!-- goal-runtime-contract:start -->'],
    ['INVALID_CONTRACT_BLOCK', valid.replace('\n```\n', '\n```\n```json\n{}\n```\n')],
    ['INVALID_JSON', valid.replace('"schema":', 'bad:')],
  ];
  for (const [code, content] of cases) { await writeFile(file, content); await assert.rejects(readPlanContract(file), { code }); }
}));
test('文件拒绝码：PLAN_TOO_LARGE UNREADABLE_PLAN；空路径明确拒绝', async () => files(async file => {
  await assert.rejects(readPlanContract(file), { code: 'UNREADABLE_PLAN' });
  await assert.rejects(readPlanContract(''), { code: 'INVALID_VALUE' });
  await writeFile(file, 'a'.repeat(4 * 1024 * 1024 + 1)); await assert.rejects(readPlanContract(file), { code: 'PLAN_TOO_LARGE' });
}));

const candidate = (repoId, n) => ({ repoId, root: `/super/${repoId}`, realRoot: `/super/${repoId}`,
  gitRoot: `/super/${repoId}`, gitDir: `/super/${repoId}/.git`, commonDir: `/super/${repoId}/.git`,
  originRoot: `/super/${repoId}`, migrationDebt: false, repositoryId: n.toString(16).padStart(64, '0'), storageRepositoryId: (n + 100).toString(16).padStart(64, '0') });
const legacyBinding = () => ({ planPath: '/super/plan.md', contractHash: hashPlanContract(contract()), repositoryRoot: '/super', sessionId: 'session', sessionFile: '/session.jsonl' });

test('T3 单仓库 v1 三字段与空仓库、文件内容 fingerprint 固定值不变', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'goal-subject-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  execFileSync('git', ['init', '-b', 'main'], { cwd: dir, stdio: 'ignore' });
  const repositoryRoot = await realpath(dir);
  assert.deepEqual(await captureSubject(dir), { repositoryRoot, head: '', contentHash: 'eb60ef56388baa627ef4b3c7c2b85845a62d7acd7a1b4187140117e8d9cec86e' });
  await writeFile(join(dir, 'a.txt'), 'v1\n');
  const subject = { repositoryRoot, head: '', contentHash: 'c9ae5f015f011141a587d2d1dbe05c952bb06d4dec2e5a5eccf29498d9b8bfac' };
  assert.deepEqual(await captureSubject(dir), subject);
  assert.deepEqual(await captureBindingSubject({ ...legacyBinding(), repositoryRoot }), subject);
  assert.deepEqual(compareSubjects(subject, structuredClone(subject)), { equal: true, driftedRepoIds: [] });
  assert.equal(compareSubjects(subject, { ...subject, head: 'changed' }).equal, false);
});

test('T0 23 个普通根只保留参与集合，一次投影不改合同或 hash；无关兄弟不影响等价输入', () => {
  const candidates = Array.from({ length: 23 }, (_, i) => candidate(`repo${i}`, i + 1));
  const repositories = admitRepositoryCandidates('/super', candidates);
  const c = contract(); c.tasks[0].writePaths = ['repo0/repo0/src/**', 'repo0/README.md'];
  c.tasks.push({ ...structuredClone(c.tasks[0]), id: 'B', writePaths: ['repo1/src/**'] });
  c.checks[0].repairTaskIds.push('B');
  const frozen = decodePlanContract(c); const before = hashPlanContract(frozen);
  const projected = resolveTaskRepository(frozen.tasks[0], repositories);
  assert.deepEqual(projected, { repoId: 'repo0', root: '/super/repo0', originalWritePaths: c.tasks[0].writePaths, writePaths: ['repo0/src/**', 'README.md'] });
  projected.originalWritePaths.push('外部修改'); assert.equal(frozen.tasks[0].writePaths.length, 2);
  assert.equal(hashPlanContract(frozen), before);
  const participating = resolveParticipatingRepositories(frozen, repositories);
  assert.deepEqual(participating.map(r => r.repoId), ['repo0', 'repo1']);
  const binding = { ...legacyBinding(), repositories: participating };
  const added = admitRepositoryCandidates('/super', [...candidates, candidate('unrelated', 24)]);
  assert.deepEqual(bindingSemanticInput(binding), bindingSemanticInput({ ...binding, repositories: resolveParticipatingRepositories(frozen, added).reverse() }));
  assert.deepEqual(Object.keys(participating[0]).sort(), ['repoId', 'repositoryId', 'root', 'storageRepositoryId']);
});

test('T0 唯一前缀文法稳定拒绝无前缀、跨仓库和剥除后非法路径', () => {
  const repositories = admitRepositoryCandidates('/super', [candidate('A', 1), candidate('B', 2)]);
  const cases = [
    [['file.txt'], 'GOAL_REPOSITORY_PREFIX_REQUIRED'], [[], 'GOAL_REPOSITORY_PREFIX_REQUIRED'],
    [['missing/src/**'], 'GOAL_REPOSITORY_NOT_FOUND'], [['A/src/**', 'B/a'], 'GOAL_REPOSITORY_CROSS_TASK'],
    ...['/A/a', 'A/../a', '../A/a', 'A//a', 'A/', 'A/**', 'A/./x', 'A/a/*', 'A/a\\b', 'C:/a', 'A/C:/a', 'A/a\u0000b'].map(path => [[path], 'GOAL_REPOSITORY_PATH_INVALID']),
  ];
  for (const [writePaths, code] of cases) assert.throws(() => resolveTaskRepository({ id: 'T', writePaths }, repositories), { code });
});

test('T0 准入拒绝 linked worktree、外部 realpath、路径别名、嵌套根和重复 common-dir 身份', () => {
  for (const patch of [{ realRoot: '/outside/A' }, { realRoot: '/super/B' }, { gitRoot: '/super' }, { originRoot: '/outside/A' }, { gitDir: '/elsewhere/git' }, { commonDir: '/shared/git' }, { repoId: '../A' }]) {
    assert.throws(() => admitRepositoryCandidates('/super', [{ ...candidate('A', 1), ...patch }]), { code: 'GOAL_REPOSITORY_TOPOLOGY_INVALID' });
  }
  assert.throws(() => admitRepositoryCandidates('/super', [{ ...candidate('A', 1), migrationDebt: true }]), { code: 'GOAL_REPOSITORY_LINKED_WORKTREE' });
  for (const patch of [{ repositoryId: candidate('A', 1).repositoryId }, { storageRepositoryId: candidate('A', 1).storageRepositoryId }]) {
    assert.throws(() => admitRepositoryCandidates('/super', [candidate('A', 1), { ...candidate('B', 2), ...patch }]), { code: 'GOAL_REPOSITORY_DUPLICATE' });
  }
});

test('T0 binding 精确解码：旧形状原样保留，多仓库拒绝库存、任务映射、坏身份和额外字段', () => {
  const legacy = legacyBinding(); assert.deepEqual(decodePlanBinding(legacy), legacy);
  assert.deepEqual(bindingSemanticInput(legacy), legacy); assert.equal(Object.hasOwn(decodePlanBinding(legacy), 'repositories'), false);
  const repositories = admitRepositoryCandidates('/super', [candidate('A', 1), candidate('B', 2)]);
  const binding = { ...legacy, repositories };
  assert.deepEqual(decodePlanBinding(binding), binding);
  for (const bad of [{ ...legacy, repositories: undefined }, { ...binding, taskRepositories: {} }, { ...binding, inventory: [] },
    { ...binding, repositories: [] }, { ...binding, repositories: [...repositories, repositories[0]] },
    { ...binding, repositories: [{ ...repositories[0], extra: true }] }, { ...binding, repositories: [{ ...repositories[0], root: '/outside/A' }] },
    { ...binding, repositories: [{ ...repositories[0], repositoryId: 'not-a-hash' }] }]) {
    assert.throws(() => decodePlanBinding(bad), { code: 'SESSION_STATE_CORRUPT' });
  }
  const c = contract(); c.tasks[0].writePaths = ['A/src/**'];
  const state = { planId: 'plan', revision: 0, binding: { ...binding, contractHash: hashPlanContract(c), repositories: [repositories[0]] },
    contract: c, status: 'active', tasks: {}, receipts: [], checkpoint: { decisions: [], sourceRefs: [], nextAction: '等待接线' },
    pauseReason: null, lastProgressHash: '', noProgressTurns: 0 };
  assert.deepEqual(decodeGoalStateSnapshot(state).binding, state.binding);
  assert.throws(() => decodeGoalStateSnapshot({ ...state, binding: { ...state.binding, repositories } }), { code: 'SESSION_STATE_CORRUPT' });
});
