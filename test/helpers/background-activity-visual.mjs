// 真实 TUI tests-only 的固定入口和白名单环境，不读取用户配置。
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
export const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const hostRoot = join(repo, 'node_modules/@earendil-works/pi-coding-agent');
export const scenarios = ['base', 'long', 'widths', 'heights', 'draft', 'themes', 'lifecycle', 'rpc'];
export function visualArgs(root, rpc = false) {
  return [...(rpc ? ['--mode', 'rpc'] : ['--tui-mode', 'fullscreen']), '--offline', '--no-mcp', '--no-extensions', '--no-tools', '--no-skills', '--no-prompt-templates', '--no-themes', '--no-context-files', '--use-theme', 'dark', '--session-dir', join(root, 'sessions'), '-e', join(repo, 'test/fixtures/deterministic-provider.mjs'), '--provider', 'fake', '--model', 'fake/deterministic', '-e', join(repo, 'packages/pi-subagents-enhanced/extensions/custom-footer.ts'), '-e', join(repo, 'pi/extensions/background-activity.ts'), '-e', join(repo, 'test/fixtures/background-activity-visual.ts')];
}
export function visualEnv(root) {
  return { PATH: process.env.PATH || '/usr/bin:/bin', HOME: join(root, 'home'), TMPDIR: join(root, 'tmp'), PI_CODING_AGENT_DIR: join(root, 'agent'), PI_CODING_AGENT_SESSION_DIR: join(root, 'sessions'), PI_SESSION_OWNER_REGISTRY: join(root, 'registry'), PI_CODING_WORKSPACE_DIR: join(root, 'workspaces'), PI_CODING_GOAL_DIR: join(root, 'goals'), TERM: 'xterm-256color', PI_HOST_NODE: process.execPath, PI_HOST_ROOT: hostRoot, PI_PACKAGE_DIR: hostRoot, PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1', PI_TELEMETRY: '0', PI_TEST_BG_ROOT: root, PI_TUI_WRITE_LOG: join(root, 'ansi.log') };
}
