# Pi Runtime Session Source Adapter 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 `@ali/ai-coding-trace` 无需猜测 Pi session 目录或 subagent 框架，即可无感发现主 Pi、独立 subagent 与嵌套 subagent 的真实 session JSONL，并复用现有 `PiSessionCapture` 完成统一采集。

**Architecture:** 主 npm 包内嵌一个零依赖 Pi package，安装/激活时原子释放到稳定的 `~/.r2c/integrations/pi-adapter` 并通过 Pi 官方 package 机制注册。每个实际运行的 Pi 进程在 `session_start` 后通过 `SessionManager` 获取已解析的真实 session 文件，原子写入本地 source descriptor；daemon 合并默认目录发现与 descriptor 精确文件发现，现有 cursor、token、tool、adoption、session record 和 OTel 链路保持不变。

**Tech Stack:** TypeScript/ESM、Pi Extension API、Node.js `fs/path/crypto/child_process`、现有 `PiSessionCapture`、SQLite transcript cursor、Rollup、自定义 verify 测试。

---

## 1. 核心问题

当前 `PiSessionCapture.discoverTranscriptFiles()` 固定扫描：

```text
~/.pi/agent/sessions/<encoded-cwd>/*.jsonl
```

但 Pi 正式支持以下 session 目录优先级：

```text
--session-dir
> PI_CODING_AGENT_SESSION_DIR
> settings.json.sessionDir
> 默认目录
```

独立 subagent 框架还可以在启动 child 时动态传入新的 `--session-dir`。daemon 由系统服务管理器启动，不继承任意 Pi 进程最终解析后的配置，因此无法仅靠 daemon 环境准确重建 session 路径。

## 2. 真实约束

1. 不要求用户填写 session root，不扫描整个 HOME。
2. 不预设用户采用 `pi-subagents`、内联 Task 或其他 subagent 框架。
3. adapter 只负责 source discovery，不重新实现 token、tool call、diff 或网络上报。
4. Pi extension 被显式禁用时无法自注册；默认目录扫描继续作为降级路径。
5. adapter 必须使用稳定路径，不能让 Pi settings 引用会被自动更新清理的版本目录。
6. 自动更新先安装、校验、再激活；adapter 更新必须幂等，并与旧 daemon 保持 protocol v1 兼容。
7. source descriptor 只包含本地定位元数据，不包含对话内容、tool 参数或凭据。
8. discovery 必须有文件数、文件大小、mtime、真实文件类型和用户所有权边界，不能引入 OOM 或任意文件读取。

## 3. 非目标

1. 不新增后端字段或数据库 schema。
2. 不建立主 agent 与 child agent 的父子关系；每个 JSONL 继续作为独立 `pi-cli` session。
3. 不采集非 Pi 子进程。
4. 不绕过用户的 `--no-extensions`、package filter 或 extension 禁用决定。
5. 不修改 Pi 本体或任意第三方 subagent 框架。
6. 不删除现有默认目录轮询和手动 backfill 能力。
7. contributor 不执行任何发布动作：禁止 `npm publish`、registry dist-tag、release/tag、正式版本号提交、Space Next 发布和正式环境部署；发布只能由 repo admin 完成。

## 4. 文件结构

新增文件按职责拆分：

```text
src/assets/pi-adapter/
├── package.json                         # 嵌入式 Pi package manifest
└── extensions/
    └── ai-coding-trace.js               # session_start source descriptor writer

src/core/history/pi/
└── pi-session-source-registry.ts        # daemon 侧 descriptor 校验、发现和清理

src/scripts/
└── install-pi-adapter.ts                # 原子释放、Pi package 注册和卸载

src/tests/
├── pi-adapter-extension-verify.ts       # extension 生命周期与原子 descriptor
├── pi-adapter-installer-verify.ts       # 安装、升级、agentDir、卸载
└── pi-session-source-registry-verify.ts # registry 安全边界与 Pi capture 集成
```

修改文件：

```text
src/core/history/PiSessionCapture.ts
src/utils/runtime-package.ts
src/scripts/collector-postinstall.ts
src/scripts/uninstall-code-collect-service.ts
src/build-tools/runtime-package-manifest.ts
src/tests/collector-postinstall-verify.ts
src/tests/runtime-package-manifest-verify.ts
src/tests/pi-session-capture-verify.ts
package.json
docs/summaries/pi-session-tracing.md
docs/investigations/pi-subagent-sidechain.md
```

## 5. Source Descriptor 契约

protocol v1 固定为：

```json
{
  "protocolVersion": 1,
  "clientType": "pi-cli",
  "sessionId": "019f...",
  "sessionFile": "/absolute/path/session.jsonl",
  "sessionDir": "/absolute/path",
  "cwd": "/absolute/workspace",
  "pid": 12345,
  "observedAt": "2026-07-22T12:00:00.000Z"
}
```

descriptor 文件路径：

```text
~/.r2c/logs/pi/session-sources/<sha256(real-session-path)>.json
```

本地协议规则：

- `protocolVersion` 必须等于 `1`。
- `clientType` 必须等于 `pi-cli`。
- `sessionFile` 必须是绝对路径、普通文件、`.jsonl`，且首条有效记录是 Pi `type=session` header。
- descriptor 最大 64KB；单次 discovery 最多处理 2000 个 descriptor。
- 非当前用户拥有的 descriptor/session 在 POSIX 平台跳过。
- descriptor 不直接删除仍存在的历史 session；目标不存在且 descriptor 超过 7 天才清理。
- descriptor 重复注册按真实 `sessionFile` 去重。

---

### Task 1: 实现嵌入式 Pi adapter package

**Files:**
- Create: `src/assets/pi-adapter/package.json`
- Create: `src/assets/pi-adapter/extensions/ai-coding-trace.js`
- Create: `src/tests/pi-adapter-extension-verify.ts`
- Modify: `package.json`

- [ ] **Step 1: 写 adapter RED 测试**

测试构造假的 Pi extension API，捕获 `session_start` handler，并把 `AI_CODING_TRACE_USER_HOME` 指向临时 HOME：

```ts
const handlers = new Map<string, Function>();
const fakePi = {
  on(name: string, handler: Function) {
    handlers.set(name, handler);
  },
};

await adapter(fakePi as never);
const sessionStart = handlers.get('session_start');
assert.equal(typeof sessionStart, 'function');

await sessionStart?.(
  { type: 'session_start', reason: 'startup' },
  {
    sessionManager: {
      getSessionId: () => 'pi-child-session-1',
      getSessionFile: () => sessionFile,
      getSessionDir: () => path.dirname(sessionFile),
      getCwd: () => projectDir,
    },
  },
);

const descriptor = JSON.parse(await fs.readFile(expectedDescriptorPath, 'utf8'));
assert.equal(descriptor.protocolVersion, 1);
assert.equal(descriptor.clientType, 'pi-cli');
assert.equal(descriptor.sessionFile, sessionFile);
assert.equal(descriptor.sessionId, 'pi-child-session-1');
```

同时断言：

- `getSessionFile()` 返回 `undefined` 时不写文件。
- 两次 `session_start` 只更新同一个 hash 文件。
- descriptor 临时文件不残留。
- descriptor 不包含消息、tool 参数或环境变量快照。

- [ ] **Step 2: 运行测试确认 RED**

Run:

```bash
npm run build:rollup && node dist/tests/pi-adapter-extension-verify.js
```

Expected: FAIL，原因是 `src/assets/pi-adapter` 与 adapter export 尚不存在。

- [ ] **Step 3: 创建 Pi package manifest**

```json
{
  "name": "@ali/ai-coding-trace-pi-adapter",
  "private": true,
  "version": "1.0.0",
  "type": "module",
  "pi": {
    "extensions": [
      "./extensions/ai-coding-trace.js"
    ]
  }
}
```

- [ ] **Step 4: 实现最小 adapter**

extension 使用 Node 内置模块，注册 `session_start`，通过临时文件加 rename 原子写 descriptor：

```js
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const PROTOCOL_VERSION = 1;

function resolveR2CRoot() {
  const configured = process.env.R2C_CACHE_DIR?.trim();
  if (configured) return path.resolve(configured);
  const userHome = process.env.AI_CODING_TRACE_USER_HOME?.trim() || os.homedir();
  return path.join(userHome, '.r2c');
}

function descriptorPathFor(sessionFile) {
  const id = crypto.createHash('sha256').update(path.resolve(sessionFile)).digest('hex');
  return path.join(resolveR2CRoot(), 'logs', 'pi', 'session-sources', `${id}.json`);
}

async function writeDescriptor(ctx) {
  const sessionFile = ctx.sessionManager.getSessionFile();
  if (!sessionFile) return;
  const resolvedFile = path.resolve(sessionFile);
  const target = descriptorPathFor(resolvedFile);
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
  const payload = {
    protocolVersion: PROTOCOL_VERSION,
    clientType: 'pi-cli',
    sessionId: ctx.sessionManager.getSessionId(),
    sessionFile: resolvedFile,
    sessionDir: path.resolve(ctx.sessionManager.getSessionDir()),
    cwd: path.resolve(ctx.sessionManager.getCwd()),
    pid: process.pid,
    observedAt: new Date().toISOString(),
  };
  await fs.mkdir(path.dirname(target), { recursive: true });
  try {
    await fs.writeFile(temp, `${JSON.stringify(payload)}\n`, { encoding: 'utf8', mode: 0o600 });
    await fs.rename(temp, target);
  } finally {
    await fs.rm(temp, { force: true }).catch(() => undefined);
  }
}

export default function aiCodingTracePiAdapter(pi) {
  pi.on('session_start', async (_event, ctx) => {
    await writeDescriptor(ctx).catch(() => undefined);
  });
}
```

- [ ] **Step 5: 运行 adapter 测试确认 GREEN**

Run:

```bash
npm run build:rollup && node dist/tests/pi-adapter-extension-verify.js
```

Expected: PASS，输出 `[pi-adapter-extension-verify] ok`。

- [ ] **Step 6: 提交 adapter package**

```bash
git add src/assets/pi-adapter src/tests/pi-adapter-extension-verify.ts package.json
git commit -m "feat(pi): 增加运行时会话源适配器"
```

---

### Task 2: 实现 daemon 侧 Pi session source registry

**Files:**
- Create: `src/core/history/pi/pi-session-source-registry.ts`
- Create: `src/tests/pi-session-source-registry-verify.ts`
- Modify: `package.json`

- [ ] **Step 1: 写 registry RED 测试**

测试在临时 `.r2c/logs/pi/session-sources` 下构造 descriptor 与 session 文件：

```ts
const validSession = path.join(tempRoot, 'custom', 'run-0', 'session.jsonl');
await fs.mkdir(path.dirname(validSession), { recursive: true });
await fs.writeFile(validSession, `${JSON.stringify({
  type: 'session',
  version: 3,
  id: 'child-session-1',
  timestamp: new Date().toISOString(),
  cwd: projectDir,
})}\n`, 'utf8');

await writeDescriptor({
  protocolVersion: 1,
  clientType: 'pi-cli',
  sessionId: 'child-session-1',
  sessionFile: validSession,
  sessionDir: path.dirname(validSession),
  cwd: projectDir,
  pid: 123,
  observedAt: new Date().toISOString(),
});

const result = await discoverRegisteredPiSessionFiles({ r2cRoot: tempR2C });
assert.deepEqual(result.files, [path.resolve(validSession)]);
```

分别验证以下 descriptor 被跳过：

- 非法 JSON。
- 大于 64KB。
- `protocolVersion !== 1`。
- `clientType !== 'pi-cli'`。
- 相对 `sessionFile`。
- 非 `.jsonl`。
- session 文件不是普通文件。
- 首条记录不是 Pi session header。
- descriptor 超过 2000 时有界截断。
- 多个 descriptor 指向同一真实文件时去重。
- 目标缺失且 descriptor 过期 7 天时清理。

- [ ] **Step 2: 运行测试确认 RED**

Run:

```bash
npm run build:rollup && node dist/tests/pi-session-source-registry-verify.js
```

Expected: FAIL，原因是 registry 模块尚不存在。

- [ ] **Step 3: 实现 registry 数据边界**

模块导出固定接口：

```ts
export interface RegisteredPiSessionDiscovery {
  files: string[];
  invalidCount: number;
  removedCount: number;
}

export interface PiSessionSourceRegistryOptions {
  r2cRoot?: string;
  nowMs?: number;
  maxDescriptors?: number;
}

export async function discoverRegisteredPiSessionFiles(
  options: PiSessionSourceRegistryOptions = {},
): Promise<RegisteredPiSessionDiscovery>;
```

实现要求：

```ts
const MAX_DESCRIPTOR_BYTES = 64 * 1024;
const MAX_DESCRIPTORS = 2000;
const STALE_MISSING_TARGET_MS = 7 * 24 * 60 * 60 * 1000;
```

按 descriptor mtime 从新到旧排序，在读取内容前先做 `lstat` 和 size 过滤；POSIX 下使用 `process.getuid()` 对 descriptor 与 session 文件执行 owner 校验。registry 只返回已通过静态边界的真实 session 路径，Pi header 最终仍由 `PiSessionCapture.readSessionBootstrap()` 二次校验。

- [ ] **Step 4: 运行 registry 测试确认 GREEN**

Run:

```bash
npm run build:rollup && node dist/tests/pi-session-source-registry-verify.js
```

Expected: PASS，输出 `[pi-session-source-registry-verify] ok`。

- [ ] **Step 5: 提交 registry**

```bash
git add src/core/history/pi/pi-session-source-registry.ts src/tests/pi-session-source-registry-verify.ts package.json
git commit -m "feat(pi): 增加会话源注册表发现"
```

---

### Task 3: 将注册文件接入 PiSessionCapture

**Deps:** Task 2

**Files:**
- Modify: `src/core/history/PiSessionCapture.ts:460`
- Modify: `src/tests/pi-session-capture-verify.ts`

- [ ] **Step 1: 写自定义路径与嵌套 child RED 测试**

在现有 verify 中增加一个不位于 `~/.pi/agent/sessions` 的主 session、child 和 nested child：

```text
<temp>/custom-sessions/main.jsonl
<temp>/custom-sessions/main/run-a/run-0/session.jsonl
<temp>/custom-sessions/main/run-a/run-0/session/run-b/run-0/session.jsonl
```

为三个文件分别写 descriptor，运行一次 `capture.runTranscriptCycle()`，断言：

```ts
assert.equal(stats.sessionsScanned, 3);
assert.equal(cursorPaths.has(path.resolve(mainFile)), true);
assert.equal(cursorPaths.has(path.resolve(childFile)), true);
assert.equal(cursorPaths.has(path.resolve(nestedChildFile)), true);
assert.equal(modelUsageSessionIds.has('main-session'), true);
assert.equal(modelUsageSessionIds.has('child-session'), true);
assert.equal(modelUsageSessionIds.has('nested-child-session'), true);
```

再让默认目录扫描与 descriptor 同时指向同一文件，断言只消费一次。

- [ ] **Step 2: 运行测试确认 RED**

Run:

```bash
npm run build:rollup && node dist/tests/pi-session-capture-verify.js
```

Expected: FAIL，`sessionsScanned` 只包含默认目录文件，不包含三个注册文件。

- [ ] **Step 3: 最小修改 discovery 聚合**

在 `discoverTranscriptFiles()` 中保留现有默认扫描，增加 registry 文件并按绝对路径去重：

```ts
const registered = await discoverRegisteredPiSessionFiles();
const transcriptPaths = new Map<string, {
  transcriptPath: string;
  mtimeMs: number;
  size: number;
  inode?: number;
}>();

for (const candidate of defaultStatFiltered) {
  transcriptPaths.set(path.resolve(candidate.transcriptPath), candidate);
}

for (const registeredPath of registered.files) {
  const stat = await fsPromises.stat(registeredPath).catch(() => null);
  if (!stat?.isFile() || stat.mtimeMs < mtimeThresholdMs) continue;
  transcriptPaths.set(path.resolve(registeredPath), {
    transcriptPath: path.resolve(registeredPath),
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    inode: stat.ino,
  });
}

const statFiltered = [...transcriptPaths.values()]
  .sort((a, b) => b.mtimeMs - a.mtimeMs)
  .slice(0, MAX_TRANSCRIPT_DISCOVERY_FILES);
```

要求：

- `readSessionBootstrap()` 仍是进入 candidates 的最终条件。
- registered 文件复用现有 mtime、lookback、pending、cursor 和 read budget。
- registry 失败只写 bounded debug 日志，不中断默认路径采集。
- 不对注册文件父目录做递归扫描。

- [ ] **Step 4: 运行 Pi capture 回归**

Run:

```bash
npm run build:rollup && node dist/tests/pi-session-capture-verify.js
node dist/tests/pi-session-capture-smoke-verify.js
```

Expected: 两个命令 PASS；自定义主、child、nested child 均产生独立 `pi-cli` cursor/model usage。

- [ ] **Step 5: 提交 capture 接入**

```bash
git add src/core/history/PiSessionCapture.ts src/tests/pi-session-capture-verify.ts
git commit -m "feat(pi): 接入运行时注册会话源"
```

---

### Task 4: 实现 adapter 原子释放与 Pi package 注册

**Deps:** Task 1

**Files:**
- Create: `src/scripts/install-pi-adapter.ts`
- Create: `src/tests/pi-adapter-installer-verify.ts`
- Modify: `package.json`

- [ ] **Step 1: 写安装器 RED 测试**

通过依赖注入 fake `spawnPi`，验证：

```ts
const result = await installPiAdapter({
  packageRoot,
  r2cRoot,
  env: { PI_CODING_AGENT_DIR: customAgentDir },
  spawnPi: (args, env) => {
    calls.push({ args, env });
    return { status: 0 };
  },
});

assert.equal(result.materialized, true);
assert.deepEqual(calls[0]?.args, ['install', adapterTarget]);
assert.equal(calls[0]?.env.PI_CODING_AGENT_DIR, customAgentDir);
assert.equal(await readPackageName(adapterTarget), '@ali/ai-coding-trace-pi-adapter');
```

覆盖：

- 首次安装。
- 相同内容重复安装。
- 新版本内容原子替换。
- 复制失败时恢复旧 adapter。
- 当前环境 `PI_CODING_AGENT_DIR` 加入 installation state。
- 历史 state 中多个 agentDir 逐个幂等注册。
- 默认 `~/.pi/agent` 不存在时不主动创建。
- `pi` 不可执行时 materialize 成功、registration 返回 skipped。
- `removePiAdapter()` 对已记录 agentDir 执行 `pi remove <path>`，成功后删除 managed 目录与 state。

- [ ] **Step 2: 运行测试确认 RED**

Run:

```bash
npm run build:rollup && node dist/tests/pi-adapter-installer-verify.js
```

Expected: FAIL，安装器模块尚不存在。

- [ ] **Step 3: 实现稳定目录与 installation state**

固定路径：

```ts
const PI_ADAPTER_SOURCE_RELATIVE_PATH = path.join('assets', 'pi-adapter');
const PI_ADAPTER_TARGET_RELATIVE_PATH = path.join('integrations', 'pi-adapter');
const PI_ADAPTER_STATE_RELATIVE_PATH = path.join('integrations', 'pi-adapter-installation.json');
```

安装算法复用 `installTroubleshootSkill` 的 temp/backup/rename 事务：

```text
source -> .pi-adapter.tmp-<pid>-<time>
existing target -> .pi-adapter.bak-<pid>-<time>
temp -> target
成功后删除 backup
失败时 backup -> target
```

state 只保存：

```ts
interface PiAdapterInstallationState {
  protocolVersion: 1;
  adapterPath: string;
  agentDirs: string[];
  installedVersion: string;
  updatedAt: string;
}
```

agentDir 来源只包括：

1. 当前安装进程的非空 `PI_CODING_AGENT_DIR`。
2. 已存在 installation state 中的 agentDirs。
3. 已存在的默认 `~/.pi/agent`。

不遍历 HOME 搜索未知 Pi 配置目录。

- [ ] **Step 4: 使用 Pi 官方 package CLI 注册**

对每个 agentDir 调用：

```text
pi install <absolute-adapter-target>
```

并显式传递：

```ts
{
  ...env,
  PI_CODING_AGENT_DIR: agentDir,
}
```

安装器不得直接编辑用户 `settings.json`。单个 agentDir 失败不回滚已成功 agentDir，也不让 collector 安装失败；结果中返回 `registeredAgentDirs` 与 `failedAgentDirs` 供日志记录。

- [ ] **Step 5: 运行安装器测试确认 GREEN**

Run:

```bash
npm run build:rollup && node dist/tests/pi-adapter-installer-verify.js
```

Expected: PASS，输出 `[pi-adapter-installer-verify] ok`。

- [ ] **Step 6: 提交安装器**

```bash
git add src/scripts/install-pi-adapter.ts src/tests/pi-adapter-installer-verify.ts package.json
git commit -m "feat(pi): 增加适配器托管安装"
```

---

### Task 5: 接入 postinstall、版本激活和自愈

**Deps:** Task 4

**Files:**
- Modify: `src/scripts/collector-postinstall.ts`
- Modify: `src/utils/runtime-package.ts:912`
- Modify: `src/build-tools/runtime-package-manifest.ts`
- Modify: `src/tests/collector-postinstall-verify.ts`
- Modify: `src/tests/runtime-package-manifest-verify.ts`

- [ ] **Step 1: 写生命周期 RED 测试**

在 `collector-postinstall-verify.ts` 注入 `installPiAdapter` spy，断言普通安装调用、stop/uninstall 祖先进程场景不调用：

```ts
assert.equal(piAdapterInstallCalled, true, '普通安装应释放并注册 Pi adapter');
```

在 runtime package 测试中断言：

```ts
assert.equal(
  RUNTIME_PACKAGE_FILES.includes('assets'),
  true,
  '运行时包必须携带嵌入式 Pi adapter',
);
```

增加 activation 测试，断言 collector target 通过验证并激活时执行 `scripts/install-pi-adapter.js`；脚本失败为 warning，不阻断 runtime manifest 切换。

- [ ] **Step 2: 运行测试确认 RED**

Run:

```bash
npm run build:rollup
node dist/tests/collector-postinstall-verify.js
node dist/tests/runtime-package-manifest-verify.js
node dist/tests/runtime-package-verify.js
```

Expected: 至少一个 FAIL，原因是 Pi adapter 尚未进入 postinstall/activation。

- [ ] **Step 3: 接入首次安装**

扩展 `CollectorPostinstallDeps`：

```ts
installPiAdapter?: () => Promise<PiAdapterInstallResult>;
```

在 troubleshoot skill 后调用幂等安装：

```ts
await runPiAdapterInstallPostinstall(deps);
```

日志必须区分：

```text
materialized=true|false
registered=<count>
failed=<count>
reason=<optional>
```

不得记录完整环境变量或 session 路径。

- [ ] **Step 4: 接入自动更新激活**

在 `runtime-package.ts` 增加：

```ts
const PI_ADAPTER_INSTALL_SCRIPT = path.join('scripts', 'install-pi-adapter.js');
```

并在 `runCollectorActivationMigrations()` 中以 optional 脚本执行：

```ts
runCollectorActivationScript(packageRoot, PI_ADAPTER_INSTALL_SCRIPT, { required: false });
```

这样每次 `npm install --prefix ~/.r2c/versions/...` 后，只有通过校验并进入 activation 的版本才刷新稳定 adapter；postinstall 负责捕获首次安装时可见的 `PI_CODING_AGENT_DIR`，activation 负责升级和修复。

- [ ] **Step 5: 运行生命周期测试确认 GREEN**

Run:

```bash
npm run build:rollup
node dist/tests/collector-postinstall-verify.js
node dist/tests/runtime-package-manifest-verify.js
node dist/tests/runtime-package-verify.js
```

Expected: 三个命令 PASS。

- [ ] **Step 6: 提交安装生命周期**

```bash
git add src/scripts/collector-postinstall.ts src/utils/runtime-package.ts src/build-tools/runtime-package-manifest.ts src/tests/collector-postinstall-verify.ts src/tests/runtime-package-manifest-verify.ts
git commit -m "feat(pi): 接入适配器安装生命周期"
```

---

### Task 6: 接入卸载与残留清理

**Deps:** Task 4

**Files:**
- Modify: `src/scripts/uninstall-code-collect-service.ts`
- Modify: `src/tests/stop-service-verify.ts`

- [ ] **Step 1: 写卸载 RED 测试**

注入 `removePiAdapterImpl` spy，断言：

```ts
assert.equal(removePiAdapterCalled, true);
assert.equal(cleanupVersionInstallsCalledAfterAdapter, true);
```

覆盖单个 agentDir `pi remove` 失败时：

- 记录 warning。
- 保留 installation state 与 adapter 目录，避免 settings 悬空。
- 继续卸载 daemon 和其他 hooks。

全部 agentDir 成功时：

- 删除 adapter stable directory。
- 删除 installation state。
- 删除空的 `logs/pi/session-sources` descriptor 目录。

- [ ] **Step 2: 运行测试确认 RED**

Run:

```bash
npm run build:rollup && node dist/tests/stop-service-verify.js
```

Expected: FAIL，卸载流程尚未调用 `removePiAdapter()`。

- [ ] **Step 3: 接入 best-effort 卸载**

在 `cleanupCliHooksAndPlugins` 后、`cleanupVersionInstalls` 前执行：

```ts
await removePiAdapterImpl().catch((error) => {
  emit('warning', `[CodexCollector] Pi adapter 清理失败，保留托管文件供重试: ${formatError(error).message}`);
});
```

不直接删除未知路径，不修改不在 installation state 中的 agentDir。

- [ ] **Step 4: 运行卸载测试确认 GREEN**

Run:

```bash
npm run build:rollup && node dist/tests/stop-service-verify.js
```

Expected: PASS。

- [ ] **Step 5: 提交卸载支持**

```bash
git add src/scripts/uninstall-code-collect-service.ts src/tests/stop-service-verify.ts
git commit -m "feat(pi): 增加适配器卸载清理"
```

---

### Task 7: 完成文档、全量回归与真实链路验收

**Deps:** Task 1, Task 2, Task 3, Task 4, Task 5, Task 6

**Files:**
- Modify: `docs/summaries/pi-session-tracing.md`
- Modify: `docs/investigations/pi-subagent-sidechain.md`
- Modify: `package.json`
- Test: `src/tests/pi-adapter-extension-verify.ts`
- Test: `src/tests/pi-adapter-installer-verify.ts`
- Test: `src/tests/pi-session-source-registry-verify.ts`
- Test: `src/tests/pi-session-capture-verify.ts`

- [ ] **Step 1: 更新 Pi tracing 文档**

在 summary 中把“无 subagent/sidechain”拆成两个明确口径：

```text
1. 独立 Pi 子进程：通过 runtime source adapter 作为独立 pi-cli session 完整采集。
2. 内联 subagents:record：仍不投影为后端 sidechain，不新增父子关系字段。
```

在历史 investigation 顶部补充后续说明，明确原结论针对内联 Task 模型，不适用于创建完整 Pi JSONL 的第三方 subagent 框架。

- [ ] **Step 2: 添加聚合测试命令**

在 `package.json` 增加：

```json
{
  "scripts": {
    "test:pi-session-adapter": "npm run build:rollup && node dist/tests/pi-adapter-extension-verify.js && node dist/tests/pi-adapter-installer-verify.js && node dist/tests/pi-session-source-registry-verify.js && node dist/tests/pi-session-capture-verify.js && node dist/tests/pi-session-capture-smoke-verify.js"
  }
}
```

- [ ] **Step 3: 运行聚合测试**

Run:

```bash
npm run test:pi-session-adapter
```

Expected: adapter、installer、registry、capture、smoke 五组测试全部 PASS，无未处理 Promise rejection。

- [ ] **Step 4: 运行相关安装与 runtime 回归**

Run:

```bash
npm run build:rollup
node dist/tests/collector-postinstall-verify.js
node dist/tests/runtime-package-manifest-verify.js
node dist/tests/runtime-package-verify.js
node dist/tests/stop-service-verify.js
node dist/tests/tool-control-verify.js
node dist/tests/backfill-service-verify.js
```

Expected: 全部 PASS。

- [ ] **Step 5: 在隔离 HOME 验证 Pi 官方 package 注册**

使用临时目录，避免修改真实用户配置：

```bash
TEMP_HOME="$(mktemp -d)"
PI_CODING_AGENT_DIR="$TEMP_HOME/pi-agent" \
R2C_CACHE_DIR="$TEMP_HOME/.r2c" \
node dist/scripts/install-pi-adapter.js
PI_CODING_AGENT_DIR="$TEMP_HOME/pi-agent" pi list
```

Expected: `pi list` 显示本地 package `@ali/ai-coding-trace-pi-adapter`，source 指向 `$TEMP_HOME/.r2c/integrations/pi-adapter`。

- [ ] **Step 6: 用本地 tarball 完整安装到真实采集环境**

正式部署入口仅用于说明，contributor 不执行：

```text
npx -y --registry=https://registry.anpm.alibaba-inc.com @ali/ai-coding-trace --workId=426648
```

本地验证必须从当前源码构建 tarball，并给生成目录注入唯一的临时预发布版本，避免复用本机同版本正式包。只修改 `dist/package.json`，不得修改或提交源码 `package.json`、`package-lock.json` 的发布版本：

```bash
npm run build
LOCAL_VERSION="$(node -e 'const [a,b,c]=require("./package.json").version.split("-")[0].split(".").map(Number); process.stdout.write(`${a}.${b}.${c + 1}-pi-adapter.${Date.now()}`)')"
node -e 'const fs=require("fs"); const file="dist/package.json"; const pkg=JSON.parse(fs.readFileSync(file,"utf8")); pkg.version=process.argv[1]; fs.writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`);' "$LOCAL_VERSION"
LOCAL_TGZ_NAME="$(cd dist && npm pack --silent)"
LOCAL_TGZ="$(pwd)/dist/$LOCAL_TGZ_NAME"
npx -y --registry=https://registry.anpm.alibaba-inc.com --package="$LOCAL_TGZ" ai-coding-trace --workId=426648
jq -e --arg version "$LOCAL_VERSION" '.collector.version == $version and .collector.packageRoot != null' ~/.r2c/runtime/ai-coding-trace/active.json
```

Expected:

- `npx` 安装源是本地 tarball，registry 只用于解析 tarball 依赖。
- postinstall、runtime activation、LaunchAgent 重启和 adapter 安装链路均实际执行。
- `active.json` 的 collector version 严格等于 `$LOCAL_VERSION`，排除复用旧正式包。
- 全程不执行 `npm publish`、dist-tag、release/tag、正式版本号提交或 Space Next 发布。

- [ ] **Step 7: 用真实 Pi 主/子/嵌套进程验收 source discovery**

记录验收开始时间，在当前真实 Pi agentDir 中启动主 Pi，分别执行一个 child 与 nested child。验收先检查本地证据：

```text
1. logs/pi/session-sources 下出现三个不同 hash descriptor。
2. 三个 descriptor 的 sessionFile 均存在且首行为 type=session。
3. session-capture.db 的 session_transcript_cursor 出现三个 source='pi-transcript' 路径。
4. session_model_usage 中三个 session_id 均为 client_type='pi-cli'。
5. child 执行 write/edit 时产生对应 adoption 本地记录。
6. 记录三个 session_id、descriptor observedAt、collector 本地版本和验收结束时间。
```

若模型 provider 不可用，保留主 session + child session source 注册验证，并使用合成 JSONL 完成 ingestion 反证；不得把 provider 失败误判为 adapter 失败。

- [ ] **Step 8: 由用户确认数据面板闭环**

把以下非敏感验收信息交给用户查询数据面板：

```text
workId=426648
clientType=pi-cli
collectorVersion=<LOCAL_VERSION>
sessionIds=<main, child, nested-child>
observedWindow=<start, end>
```

Expected: 用户确认数据面板在对应时间窗内出现主、子、嵌套三个 session 的 token/model/tool/adoption 数据。用户确认前，只能声明“本地采集与上报链路已验证”，不能声明“数据面板已验证”。

- [ ] **Step 9: 自审安全、性能与发布边界**

逐项确认：

```text
- adapter 不发送对话内容、tool 参数或凭据。
- descriptor mode 为 0600。
- daemon 不扫描 descriptor 指向目录，只读取精确文件。
- descriptor 与 transcript 都有 owner/type/size/header 校验。
- discovery 总数受 2000 上限约束。
- 默认目录采集与 manual backfill 未改变。
- extension 禁用时行为降级而非阻断 Pi。
- 安装/升级失败不阻断 collector 主服务。
- adapter 与 daemon protocolVersion=1 向下兼容。
- 本地验证只使用本地 tarball 和临时 dist 版本。
- 未执行 npm publish、dist-tag、release/tag、正式版本号提交、Space Next 发布或正式部署。
```

- [ ] **Step 10: 提交文档与验收入口**

```bash
git add docs/summaries/pi-session-tracing.md docs/investigations/pi-subagent-sidechain.md package.json src/tests
git commit -m "docs(pi): 补充运行时会话源采集说明"
```

---

## 6. 最小可行闭环

```text
@ali/ai-coding-trace 安装/激活
  -> 嵌入式 Pi package 原子释放到稳定 .r2c 路径
  -> pi install 注册到当前及历史已知 agentDir
  -> 任意启用 adapter 的 Pi 进程 session_start
  -> 写入精确 session source descriptor
  -> PiSessionCapture 合并默认发现与 descriptor
  -> 复用现有 cursor/token/tool/adoption/session/OTel 链路
```

成功标准：

1. 自定义主 session 路径无需用户配置即可进入 `pi-cli` 本地 DB。
2. 不解析 `pi-subagents` 目录协议，也能采集独立 child 与 nested child JSONL。
3. 自动更新后 Pi settings 本地 package 路径不变，adapter 内容更新。
4. collector 回滚时 protocol v1 adapter 仍兼容。
5. 卸载后不留下由采集器管理的 Pi package 引用。

## 7. 风险与缓解

| 风险 | 缓解 |
| --- | --- |
| 安装器看不到未来新增的 `PI_CODING_AGENT_DIR` | 仅承诺安装时当前环境与历史已知 agentDir；Pi 核心暂无跨 agentDir 全局扩展契约 |
| child 显式禁用 extensions | 默认目录扫描降级；不绕过用户禁用决定 |
| descriptor 指向任意文件 | 绝对路径、扩展名、普通文件、owner、大小和 Pi header 多重校验 |
| descriptor 数量长期增长 | 2000 上限、mtime 排序、缺失目标 7 天清理 |
| postinstall 已执行但新版本未激活 | adapter protocol v1 向下兼容；activation 再次幂等刷新 |
| Pi 启动与 adapter 更新并发 | stable target 使用 temp/backup/rename 原子目录替换 |
| Pi package 注册失败 | 记录 agentDir 供后续 activation 重试，不阻断 collector 安装 |
| 默认发现与 descriptor 重复 | 按绝对 transcript path 去重后再做 bootstrap 与 cursor |

## 8. 计划自审

- 规格覆盖：包含嵌入式包、稳定释放、无感注册、主/子/嵌套 source discovery、统一采集、升级、回滚、卸载和安全边界。
- 非目标明确：不增加后端 schema，不强行构造父子关系，不绕过 extension 禁用。
- 类型一致：adapter 与 registry 统一使用 `protocolVersion: 1`、`clientType: 'pi-cli'` 和绝对 `sessionFile`。
- 测试闭环：每项逻辑变更均先 RED 后 GREEN，并包含隔离 HOME 与真实 Pi 链路验收。
- 路径符合仓库惯例：方案文档位于 `docs/2026-07-22/`，不新增仓库未采用的顶层 plans 目录。
