import path from 'node:path';

/** 只生成候选白名单环境，不继承真实HOME、认证或模型配置。 */
export function candidateEnvironment({ candidateRoot, hostRoot, nodeBin }) {
  for (const value of [candidateRoot, hostRoot, nodeBin]) {
    if (typeof value !== 'string' || !path.isAbsolute(value)) throw new TypeError('候选路径必须为绝对路径');
  }
  return {
    PATH: `${path.dirname(nodeBin)}:/usr/bin:/bin`, TMPDIR: '/tmp',
    HOME: path.join(candidateRoot, 'home'),
    XDG_CONFIG_HOME: path.join(candidateRoot, 'home/config'),
    XDG_STATE_HOME: path.join(candidateRoot, 'home/state'),
    PI_CODING_AGENT_DIR: path.join(candidateRoot, 'agent'),
    PI_PACKAGE_DIR: hostRoot,
    PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1', PI_TELEMETRY: '0',
    PI_REAL_BIN: path.join(hostRoot, 'dist/cli.js'),
    PI_TEST_CODING_AGENT_ROOT: hostRoot,
    PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT: hostRoot,
    T8_PI_REAL_BIN: path.join(hostRoot, 'dist/cli.js'),
  };
}
