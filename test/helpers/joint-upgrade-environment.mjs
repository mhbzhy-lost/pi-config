import { mkdirSync } from 'node:fs';
import path from 'node:path';

/** 只生成候选白名单环境，不继承真实HOME、认证或模型配置。 */
export function candidateEnvironment({ candidateRoot, hostRoot, nodeBin }) {
  for (const value of [candidateRoot, hostRoot, nodeBin]) {
    if (typeof value !== 'string' || !path.isAbsolute(value)) throw new TypeError('候选路径必须为绝对路径');
  }
  // 候选状态目录归 fixture 自己所有：先落盘，避免子进程的 TMPDIR/session/workspace 根缺失。
  const state = {
    tmp: path.join(candidateRoot, 'state/tmp'),
    sessions: path.join(candidateRoot, 'state/sessions'),
    workspaces: path.join(candidateRoot, 'state/workspaces'),
    registry: path.join(candidateRoot, 'state/registry'),
    subagentsTmp: path.join(candidateRoot, 'state/tmp/subagents'),
    npmCache: path.join(candidateRoot, 'state/npm-cache'),
    gitConfig: path.join(candidateRoot, 'state/gitconfig'),
  };
  for (const dir of [state.tmp, state.sessions, state.workspaces, state.registry, state.subagentsTmp, state.npmCache]) {
    mkdirSync(dir, { recursive: true });
  }
  return {
    PATH: `${path.dirname(nodeBin)}:/usr/bin:/bin`, TMPDIR: state.tmp,
    HOME: path.join(candidateRoot, 'home'),
    XDG_CONFIG_HOME: path.join(candidateRoot, 'home/config'),
    XDG_STATE_HOME: path.join(candidateRoot, 'home/state'),
    PI_CODING_AGENT_DIR: path.join(candidateRoot, 'agent'),
    PI_HOST_NODE: nodeBin,
    PI_HOST_ROOT: hostRoot,
    PI_PACKAGE_DIR: hostRoot,
    PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1', PI_TELEMETRY: '0',
    PI_REAL_BIN: path.join(hostRoot, 'dist/cli.js'),
    PI_TEST_CODING_AGENT_ROOT: hostRoot,
    PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT: hostRoot,
    T8_PI_REAL_BIN: path.join(hostRoot, 'dist/cli.js'),
    PI_CODING_AGENT_SESSION_DIR: state.sessions,
    PI_CODING_WORKSPACE_DIR: state.workspaces,
    PI_SESSION_OWNER_REGISTRY: state.registry,
    PI_SUBAGENTS_TEMP_ROOT: state.subagentsTmp,
    PI_JOINT_CANDIDATE_ROOT: candidateRoot,
    NPM_CONFIG_REGISTRY: 'https://registry.npmjs.org/',
    npm_config_cache: state.npmCache,
    GIT_CONFIG_GLOBAL: state.gitConfig,
    GIT_CONFIG_NOSYSTEM: '1',
  };
}
