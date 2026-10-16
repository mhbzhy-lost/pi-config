// 仅验证自造 fixture 合同；不启动 Host。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { scenarios, visualArgs, visualEnv } from './helpers/background-activity-visual.mjs';
test('真实视觉固定八场景，默认验收不执行 Host', () => {
  assert.deepEqual(scenarios, ['base', 'long', 'widths', 'heights', 'draft', 'themes', 'lifecycle', 'rpc']);
});
test('真实视觉入口只加载本地三显示扩展与 deterministic provider', () => {
  const args = visualArgs('/fixture');
  for (const flag of ['--offline', '--no-mcp', '--no-extensions', '--no-tools', '--no-skills', '--no-context-files']) assert.ok(args.includes(flag));
  assert.equal(args.filter((flag) => flag === '-e').length, 4);
  assert.ok(visualArgs('/fixture', true).includes('rpc'));
});
test('环境白名单不继承凭据或代理，SDK绑定物理入口', () => {
  const env = visualEnv('/fixture');
  assert.ok(env.PI_HOST_ROOT.endsWith('/node_modules/@earendil-works/pi-coding-agent'));
  for (const key of Object.keys(env)) assert.doesNotMatch(key, /TOKEN|KEY|SECRET|PROXY|ZDOTDIR|XDG|PI_SESSION_ID/);
});
test('source fixture走公开协议，不手工伪造production event或消息', () => {
  const source = readFileSync(new URL('./fixtures/background-activity-visual.ts', import.meta.url), 'utf8');
  assert.match(source, /pi-subagents-enhanced\/tui\/background-activity/);
  assert.match(source, /ActivitySource\[\]/);
  assert.doesNotMatch(source, /triggerTurn|process\.kill|setFooter\(|setInterval\(/);
});
