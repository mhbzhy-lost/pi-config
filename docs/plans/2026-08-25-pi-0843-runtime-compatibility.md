# Pi 0.84.3 Runtime 兼容升级实现计划

> **给执行 agent：** 必须逐任务执行本计划；步骤使用 `- [ ]` 复选框跟踪。执行方式由计划完成后的用户选择决定。

**目标：** 将本仓当前 Pi `0.84.2` runtime 安全升级到精确版本 `0.84.3`，解除本地版本门禁，固化会话级模型 fallback 与 compaction 连续性语义，并在全局切换前完成候选版本验收。

**架构：** 先在 Git 忽略的候选目录安装精确 `0.84.3`，并让测试 Host 统一从 `PI_TEST_CODING_AGENT_ROOT` 解析候选包；随后以测试先行方式修改 bootstrap 和兼容白名单，同时增加模型持久化与真实 provider fallback 的兼容性 canary。所有候选回归、独立评审和文档更新通过后，最后才切换全局 npm 安装；失败时回滚到精确 `0.84.2`。

**技术栈：** Node.js `>=22.19.0`、npm 官方 registry、Node 内置 test runner、Pi Extension API、Pi JSONL RPC、`@earendil-works/pi-coding-agent@0.84.3`、`pi-subagents@0.45.2`、`typebox@1.1.38`。

## 人工范围修订

- 2026-08-25：用户明确授权忽略并发 Goal Engine 改造导致的现有回归失败；Pi 0.84.3 适配只以非 Goal runtime、Doctor、RPC、TUI/renderer、Subagent 和配置行为通过为升级门槛。
- 该授权覆盖 T3、T5 和最终自检中“Goal Engine 全量回归必须全绿”的原要求；不得借此修改、兼容或掩盖 Goal Engine production/fixture 失败，验收记录仍须保留 `1235/1244` 与 9 个失败的事实。

## 全局约束

- 目标 Pi 版本精确为 `0.84.3`；不得使用 `0.84.x`、`latest` 或宽松 semver 范围。
- 回滚版本精确为 `0.84.2`。
- `pi-subagents@0.45.2`、`typebox@1.1.38`、`@amaster.ai/pi-task-scheduler@0.1.9` 和 `basic-memory==0.22.1` 保持不变。
- `pi/settings.json` 的 `enabledModels` 是 per-machine 配置；不得提交该字段的任何变化。
- 不修改或提交 `pi/models.json`；不得读取、输出、记录或迁移任何凭据。
- 不启用 `powershell`，不修改 `defaultTools`，不为尚未启用的 PowerShell 增加生产兼容分支。
- 接受 Pi `0.84.3` 的会话级模型切换语义：`scripts/lib/provider-fallback-extension.mjs` 的 fallback 不持久改写全局默认模型。
- `session_compact_failed` 与 Goal Engine production 链不属于本次升级门槛；不增加 mock canary 或生产 handler。
- Goal Runtime 继续处于 Manual Preview；本升级不得借助 Goal Engine 自动编排或自动验收。
- 历史 `docs/superpowers/`、`docs/bugs/` 和 `docs/reviews/` 中关于当时版本的事实保持原样，不批量替换历史 `0.84.2` 文本。
- 外部并发文件 `docs/plans/2026-08-24-goal-runtime-suspended-resume-recovery.md` 不属于本计划，禁止触碰。
- 全局 npm 安装只能在候选回归、独立评审和主工作树集成完成后执行。
- 不创建 commit；只有用户另行明确授权后才可提交。

## 文件结构

### 新建

- `docs/reviews/2026-08-25-pi-0843-runtime-compatibility.md`：记录候选版本、命令证据、测试结果、残余风险、全局切换和回滚信息。
- `var/test-runtimes/pi-0.84.3/`：Git 忽略的共享候选安装目录；只保存 npm 安装产物，不保存凭据或 session。

### 修改

- `test/helpers/pi-host.mjs`：让 Pi Host 路径解析复用 `PI_TEST_CODING_AGENT_ROOT`。
- `test/helpers/pi-runtime.test.mjs`：验证候选根优先级和 Host 路径派生。
- `test/goal-engine-runtime.integration.mjs`：从统一测试 Host 根加载 Pi，而不是硬编码全局 npm 根。
- `scripts/doctor.mjs`：将精确 `0.84.3` 加入受支持版本。
- `scripts/probes/pi-subagents-compat.mjs`：将精确 `0.84.3` 加入 Subagent runtime 支持集合。
- `init-pi.sh`：默认安装并固定精确 `0.84.3`。
- `test/doctor.test.mjs`：更新 Doctor 版本准入行为。
- `test/pi-subagents-compat.test.mjs`：接受 `0.84.3` 并继续拒绝未验收版本。
- `test/init-pi.test.mjs`：验证 bootstrap 安装精确 `0.84.3`。
- `test/pi-runtime.integration.mjs`：增加模型切换默认不持久化、显式 persist 才持久化的候选 Host canary。
- `test/compact-tools-extension.test.mjs`：将版本化测试名称改为行为名称，保留 native tool 字段合同。
- `README.md`：更新当前安装版本、支持矩阵、TUI 标题和回滚版本。
- `pi/settings.json`：只将 `lastChangelogVersion` 更新为 `0.84.3`。

## DAG

```text
T0 候选 Host 路径与安装
 ├──> T1 版本门禁与 bootstrap ──┐
 └──> T2 语义 canary ──────────┤
                                └──> T3 候选全量兼容验收
                                      └──> T4 文档、配置与独立评审
                                            └──> T5 全局升级与 fresh Host 验收
```

## Waves

- Wave 1：T0
- Wave 2：T1、T2（可并行；分别修改版本策略与语义 canary）
- Wave 3：T3（等待 T1 的版本准入和 T2 的语义合同）
- Wave 4：T4（等待候选验收事实）
- Wave 5：T5（等待所有 tracked 变更集成并完成独立评审）

**关键路径：** T0 → T1 → T3 → T4 → T5；T0 → T2 → T3 是并行汇合路径。

---

### Task 0：建立可重复的 Pi 0.84.3 候选 Host

**Deps：** `none`

**WritePaths：**
- `test/helpers/pi-host.mjs`
- `test/helpers/pi-runtime.test.mjs`
- `test/goal-engine-runtime.integration.mjs`
- `var/test-runtimes/pi-0.84.3/**`

**Resources：** npm 官方 registry；`var/test-runtimes/pi-0.84.3/` 由本任务独占写入，下游只读。该任务应在原始 checkout 或 `worktree: false` 环境执行，避免候选目录随临时 worktree 消失。

**Files：**
- Modify：`test/helpers/pi-host.mjs`
- Modify：`test/helpers/pi-runtime.test.mjs`
- Modify：`test/goal-engine-runtime.integration.mjs`
- Create：`var/test-runtimes/pi-0.84.3/node_modules/@earendil-works/pi-coding-agent/`

**接口契约：**
- Consumes：`test/helpers/pi-runtime.mjs` 的 `resolvePiCodingAgentRoot({ env, readGlobalNodeModules })`。
- Produces：`resolvePiHostPaths({ env, readGlobalNodeModules })`，返回 `piHostRoot`、`piHostJitiUrl`、`piHostModuleUrl` 和 `piHostAliases`；所有默认常量由该函数的默认结果派生。

**验收标准：** 显式 `PI_TEST_CODING_AGENT_ROOT` 优先于全局 npm root；Goal runtime integration 与 pi-host 用户均可加载候选 `dist/index.js`；候选 CLI 输出精确 `0.84.3`。

- [x] **步骤 1：为 Host 路径派生编写失败测试**

在 `test/helpers/pi-runtime.test.mjs` 增加：

```js
import { pathToFileURL } from "node:url";
import { resolvePiHostPaths } from "./pi-host.mjs";

test("Pi host paths derive every alias from the explicit candidate root", () => {
  const paths = resolvePiHostPaths({
    env: { PI_TEST_CODING_AGENT_ROOT: "/candidate/pi-coding-agent" },
    readGlobalNodeModules: () => "/global/node_modules",
  });
  assert.equal(paths.piHostRoot, "/candidate/pi-coding-agent");
  assert.equal(paths.piHostModuleUrl, pathToFileURL("/candidate/pi-coding-agent/dist/index.js").href);
  assert.equal(
    paths.piHostAliases["@earendil-works/pi-tui"],
    "/candidate/pi-coding-agent/node_modules/@earendil-works/pi-tui/dist/index.js",
  );
});
```

- [x] **步骤 2：运行测试确认 RED**

运行：

```bash
node --test test/helpers/pi-runtime.test.mjs
```

预期：FAIL，错误指出 `resolvePiHostPaths` 尚未导出。

- [x] **步骤 3：实现统一 Host 路径派生**

在 `test/helpers/pi-host.mjs` 复用 `resolvePiCodingAgentRoot`，导出纯函数，并由默认结果继续导出当前常量：

```js
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { resolvePiCodingAgentRoot } from "./pi-runtime.mjs";

export function resolvePiHostPaths(options = {}) {
  const piHostRoot = resolvePiCodingAgentRoot(options);
  const aliases = Object.freeze({
    "@earendil-works/pi-ai/compat": join(piHostRoot, "node_modules/@earendil-works/pi-ai/dist/compat.js"),
    "@earendil-works/pi-tui": join(piHostRoot, "node_modules/@earendil-works/pi-tui/dist/index.js"),
    "@earendil-works/pi-coding-agent": join(piHostRoot, "dist/index.js"),
    "@earendil-works/pi-ai": join(piHostRoot, "node_modules/@earendil-works/pi-ai/dist/index.js"),
    "@earendil-works/pi-agent-core": join(piHostRoot, "node_modules/@earendil-works/pi-agent-core/dist/index.js"),
  });
  return {
    piHostRoot,
    piHostJitiUrl: pathToFileURL(join(piHostRoot, "node_modules/jiti/lib/jiti.mjs")).href,
    piHostModuleUrl: pathToFileURL(join(piHostRoot, "dist/index.js")).href,
    piHostAliases: aliases,
  };
}
```

默认导出常量必须从 `resolvePiHostPaths()` 的单次返回值读取，删除独立的 `npm root -g` 调用。

- [x] **步骤 4：让 Goal runtime integration 使用统一候选根**

在 `test/goal-engine-runtime.integration.mjs` 导入 `resolvePiCodingAgentRoot`，将：

```js
const globalModules = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
const piRoot = join(globalModules, "@earendil-works/pi-coding-agent");
```

替换为：

```js
import { resolvePiCodingAgentRoot } from "./helpers/pi-runtime.mjs";
const piRoot = resolvePiCodingAgentRoot();
```

保留文件中 Git fixture 所需的 `execFileSync`。

- [x] **步骤 5：运行 GREEN**

运行：

```bash
node --test test/helpers/pi-runtime.test.mjs
```

预期：全部 PASS。

- [x] **步骤 6：安装共享候选**

运行：

```bash
rm -rf var/test-runtimes/pi-0.84.3
mkdir -p var/test-runtimes/pi-0.84.3
npm install --prefix var/test-runtimes/pi-0.84.3 \
  --ignore-scripts --no-audit --no-fund \
  --registry=https://registry.npmjs.org \
  @earendil-works/pi-coding-agent@0.84.3
CANDIDATE_ROOT="$PWD/var/test-runtimes/pi-0.84.3/node_modules/@earendil-works/pi-coding-agent"
"$CANDIDATE_ROOT/dist/bundle/cli.js" --version
```

预期：最后一行精确输出 `0.84.3`；不得读取 npm 凭据文件或运行依赖 install script。

- [x] **步骤 7：验证候选模块入口**

运行：

```bash
PI_TEST_CODING_AGENT_ROOT="$CANDIDATE_ROOT" \
  node --test test/helpers/pi-runtime.test.mjs
```

预期：全部 PASS，并从候选包加载 `SessionManager`、`TuiMainScreen` 和 `TuiAltScreen`。

---

### Task 1：以测试先行更新版本门禁与 bootstrap

**Deps：** `T0`（理由：版本准入必须建立在精确 `0.84.3` 候选已可加载的事实之上）

**WritePaths：**
- `scripts/doctor.mjs`
- `scripts/probes/pi-subagents-compat.mjs`
- `init-pi.sh`
- `test/doctor.test.mjs`
- `test/pi-subagents-compat.test.mjs`
- `test/init-pi.test.mjs`

**Resources：** `none`

**Files：**
- Modify：`scripts/doctor.mjs:29`
- Modify：`scripts/probes/pi-subagents-compat.mjs:36`
- Modify：`init-pi.sh:5`
- Test：`test/doctor.test.mjs:374-382,445-446`
- Test：`test/pi-subagents-compat.test.mjs:44-46,276-281`
- Test：`test/init-pi.test.mjs:104-107`

**接口契约：**
- Consumes：T0 的精确 `0.84.3` 候选。
- Produces：`SUPPORTED_PI_VERSIONS = ["0.82.0", "0.82.1", "0.83.0", "0.84.1", "0.84.2", "0.84.3"]`；bootstrap 精确安装 `@earendil-works/pi-coding-agent@0.84.3`。

**验收标准：** Doctor 和 Subagent compatibility 接受精确 `0.84.3`，继续拒绝 `0.84.0` 与未验收的 `0.84.4`；初始化脚本只安装精确 `0.84.3`。

- [x] **步骤 1：先更新版本行为测试**

在 `test/pi-subagents-compat.test.mjs` 中将 `0.84.3` 移入支持集合，并将拒绝集合改为：

```js
for (const version of ["0.83.1", "0.84.0", "0.84.4"]) {
  assert.deepEqual(
    evaluate({ ...compatibleReport, piVersion: version }).failures,
    [`unsupported Pi version: ${version}`],
  );
}
```

同步更新 `test/doctor.test.mjs` 的支持集合和错误消息，并将 `test/init-pi.test.mjs` 的安装断言改为精确 `0.84.3`。

- [x] **步骤 2：运行测试确认 RED**

运行：

```bash
node --test \
  test/pi-subagents-compat.test.mjs \
  test/doctor.test.mjs \
  test/init-pi.test.mjs
```

预期：FAIL；失败仅来自 production 白名单仍缺少 `0.84.3`、bootstrap 仍安装 `0.84.2`。

- [x] **步骤 3：实施最小版本变更**

将以下三个值精确更新：

```js
// scripts/doctor.mjs
const SUPPORTED_PI_VERSIONS = ["0.82.0", "0.82.1", "0.83.0", "0.84.1", "0.84.2", "0.84.3"];

// scripts/probes/pi-subagents-compat.mjs
export const SUPPORTED_PI_VERSIONS = ["0.82.0", "0.82.1", "0.83.0", "0.84.1", "0.84.2", "0.84.3"];
```

```bash
# init-pi.sh
PI_VERSION="0.84.3"
```

不得改变其他依赖版本或初始化步骤。

- [x] **步骤 4：运行 GREEN**

运行步骤 2 的命令。

预期：全部 PASS。

- [x] **步骤 5：用候选执行真实 Doctor 版本检查**

运行：

```bash
CANDIDATE_ROOT="$PWD/var/test-runtimes/pi-0.84.3/node_modules/@earendil-works/pi-coding-agent"
PI_REAL_BIN="$CANDIDATE_ROOT/dist/bundle/cli.js" node scripts/doctor.mjs
```

预期：退出码为 `0`；允许输出已有 worktree lifecycle warning，但不得出现 `unexpected Pi version: 0.84.3`。

---

### Task 2：固化模型持久化与真实 provider fallback 语义

**Deps：** `T0`（理由：两个模型语义 canary 必须由精确 `0.84.3` Host 执行）

**WritePaths：**
- `test/pi-runtime.integration.mjs`

**Resources：** 临时目录和本地 loopback ephemeral HTTP server；不发起外部模型请求，不读取真实 auth。

**Files：**
- Modify：`test/pi-runtime.integration.mjs`

**接口契约：**
- Consumes：Pi `0.84.3` 的 `AgentSession.setModel(model, { persist? })`、真实 `createProviderFallbackExtension`、Extension loader 和 `session_start`。
- Produces：两个明确合同：默认 `setModel` 只改变 session，`persist: true` 才更新 settings；真实 provider fallback 切换当前 session 但不持久改写默认 provider/model。

**验收标准：** 测试不使用真实 API key；`0.84.2` 对默认模型不持久化断言呈 RED，`0.84.3` 候选呈 GREEN；真实 fallback 只访问本地 loopback HEAD endpoint，并同时证明 session 已切换、settings 默认值未改变。

- [x] **步骤 1：增加模型持久化候选测试**

在 `test/pi-runtime.integration.mjs` 增加一个临时 agentDir 测试：

1. 写入默认 `fake/model-a` 的临时 `settings.json`。
2. 通过临时 Extension 注册 `fake/model-a` 与 `fake/model-b`，使用字面值 `apiKey: "not-used"`，不发送 prompt。
3. 使用同一个 `SettingsManager` 创建 session。
4. 调用 `await session.setModel(modelB)` 和 `await settingsManager.flush()`，断言文件仍为 `model-a`。
5. 调用 `await session.setModel(modelB, { persist: true })` 和 `await settingsManager.flush()`，断言文件变为 `model-b`。
6. 在 `finally` 中 dispose session 并删除临时目录。

核心断言：

```js
await session.setModel(modelB);
await settingsManager.flush();
assert.equal(JSON.parse(await readFile(settingsPath, "utf8")).defaultModel, "model-a");

await session.setModel(modelB, { persist: true });
await settingsManager.flush();
assert.equal(JSON.parse(await readFile(settingsPath, "utf8")).defaultModel, "model-b");
```

- [x] **步骤 2：在旧 Host 上确认语义差异**

运行：

```bash
PI_REAL_BIN=/opt/homebrew/bin/pi \
PI_TEST_CODING_AGENT_ROOT=/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent \
  node --test --test-name-pattern='model mutation' test/pi-runtime.integration.mjs
```

预期：当前 `0.84.2` Host 在第一次默认模型断言处 FAIL，因为旧版本会持久化模型。

- [x] **步骤 3：在候选 Host 上确认 GREEN**

运行：

```bash
CANDIDATE_ROOT="$PWD/var/test-runtimes/pi-0.84.3/node_modules/@earendil-works/pi-coding-agent"
PI_REAL_BIN="$CANDIDATE_ROOT/dist/bundle/cli.js" \
PI_TEST_CODING_AGENT_ROOT="$CANDIDATE_ROOT" \
  node --test --test-name-pattern='model mutation' test/pi-runtime.integration.mjs
```

预期：PASS。

- [x] **步骤 4：增加真实 provider fallback canary**

在 `test/pi-runtime.integration.mjs` 使用真实 `createProviderFallbackExtension`、真实 Pi Host 和 `session_start`：

1. primary provider 指向不可达的 loopback endpoint。
2. `openai-codex/gpt-5.6-sol` 指向本地 ephemeral HTTP server；server 只接受 HEAD 并返回 204。
3. 通过临时 wrapper Extension 调用 `createProviderFallbackExtension(pi, { configRoot })`。
4. 创建初始 primary session 并 bind Extensions，等待 `session_start` fallback 完成。
5. 断言当前 session model 为 `openai-codex/gpt-5.6-sol`。
6. `settingsManager.flush()` 后断言默认 provider/model 仍为 primary。
7. 在 `finally` 中关闭 server、dispose session 并删除临时目录。

- [x] **步骤 5：运行候选语义回归**

运行：

```bash
CANDIDATE_ROOT="$PWD/var/test-runtimes/pi-0.84.3/node_modules/@earendil-works/pi-coding-agent"
PI_REAL_BIN="$CANDIDATE_ROOT/dist/bundle/cli.js" \
PI_TEST_CODING_AGENT_ROOT="$CANDIDATE_ROOT" \
  node --test test/pi-runtime.integration.mjs
```

预期：4/4 PASS，fallback server 只收到一个本地 HEAD 请求，测试输出不包含外部网络请求或 extension error。

---

### Task 3：执行候选 Runtime 全量兼容验收

**Deps：** `T1`（版本门禁已接受 `0.84.3`）、`T2`（语义 canary 已固定）

**WritePaths：**
- `test/compact-tools-extension.test.mjs`
- `docs/reviews/2026-08-25-pi-0843-runtime-compatibility.md`

**Resources：** 共享候选目录只读；Subagent deterministic integration 独占本地临时进程与 Root broker 测试端点。

**Files：**
- Modify：`test/compact-tools-extension.test.mjs:31`
- Create：`docs/reviews/2026-08-25-pi-0843-runtime-compatibility.md`

**接口契约：**
- Consumes：T1 的版本准入和 T2 的语义合同。
- Produces：可供全局升级决策使用的候选验收记录；不修改生产 Extension ABI。

**验收标准：** 候选版本下单元测试、Doctor、RPC、TUI/renderer、Subagent、Goal Engine 回归全部通过；全扩展 RPC 启动无 `extension_error`；验收记录使用中文并记录真实命令与退出状态。

- [x] **步骤 1：去除 renderer 测试名称中的旧版本字面值**

将：

```js
test("real 0.84.2 compact overrides retain every native non-renderer field", () => {
```

改为：

```js
test("compact overrides retain every native non-renderer field", () => {
```

不修改断言内容，不增加配置字面值镜像测试。

- [x] **步骤 2：运行全量单元测试**

运行：

```bash
CANDIDATE_ROOT="$PWD/var/test-runtimes/pi-0.84.3/node_modules/@earendil-works/pi-coding-agent"
PI_TEST_CODING_AGENT_ROOT="$CANDIDATE_ROOT" \
PI_REAL_BIN="$CANDIDATE_ROOT/dist/bundle/cli.js" \
  npm test
```

预期：退出码 `0`，无失败测试。

- [x] **步骤 3：运行真实 Pi RPC 与 Skill 集成**

运行：

```bash
PI_TEST_CODING_AGENT_ROOT="$CANDIDATE_ROOT" \
PI_REAL_BIN="$CANDIDATE_ROOT/dist/bundle/cli.js" \
  npm run test:integration
```

预期：SessionManager 分支合同和 RPC Skill discovery 全部 PASS。

- [x] **步骤 4：运行真实 Subagent 兼容矩阵**

运行：

```bash
PI_TEST_CODING_AGENT_ROOT="$CANDIDATE_ROOT" \
PI_REAL_BIN="$CANDIDATE_ROOT/dist/bundle/cli.js" \
  node --test \
    test/pi-subagents-runtime.integration.mjs \
    test/pi-subagents-045-workflow.integration.mjs \
    test/pi-subagents-project-workflow.integration.mjs
```

预期：版本检查、complete、Supervisor attention/resume、公开 workflow leaf 和 typed project dispatch 全部 PASS；不得产生嵌套 Subagent runtime。

- [x] **步骤 5：运行 Goal Engine 与 worktree lifecycle 回归**

运行：

```bash
PI_TEST_CODING_AGENT_ROOT="$CANDIDATE_ROOT" \
PI_REAL_BIN="$CANDIDATE_ROOT/dist/bundle/cli.js" \
  npm run test:goal-engine
```

实际：退出码 `1`，1244 项中 1235 通过、9 项因并发 Goal suspension/amendment fixture 与当前门禁不一致而失败。用户已明确批准该结果不阻塞本次升级；未修改 Goal production 或 fixture，也未将其记录为全绿。

- [x] **步骤 6：运行全扩展离线 RPC smoke**

运行：

```bash
printf '%s\n' '{"id":"state","type":"get_state"}' | \
PI_OFFLINE=1 \
PI_SKIP_VERSION_CHECK=1 \
PI_CODING_AGENT_DIR="$PWD/pi" \
PI_CODING_AGENT_SESSION_DIR="$PWD/var/test-runtimes/pi-0.84.3/sessions" \
OPENAI_API_KEY=integration-test-not-used \
  "$CANDIDATE_ROOT/dist/bundle/cli.js" \
    --mode rpc --no-session --offline --provider openai --model gpt-4o \
    > var/test-runtimes/pi-0.84.3/rpc-smoke.jsonl \
    2> var/test-runtimes/pi-0.84.3/rpc-smoke.stderr
```

随后解析 JSONL，断言：

```js
const records = text.trim().split("\n").filter(Boolean).map(JSON.parse);
assert.equal(records.filter((record) => record.type === "extension_error").length, 0);
assert.equal(records.find((record) => record.id === "state")?.success, true);
```

预期：stderr 为空，`get_state` 成功，无 `extension_error`。占位 API key 不得用于 prompt 或外部请求。

- [x] **步骤 7：创建中文候选验收记录**

在 `docs/reviews/2026-08-25-pi-0843-runtime-compatibility.md` 记录：

- 候选 package 路径、`0.84.3` 版本和 Node 版本。
- 步骤 2–6 的完整命令、退出码和真实测试计数。
- Provider fallback 采用会话级语义的明确决策。
- 真实 provider fallback canary 的 session 切换与 settings 不持久化结果。
- PowerShell 仍禁用，未来启用前必须覆盖 Security Gates 与 Goal mutation gate。
- 自定义 gateway 的 `User-Agent` 残余风险和全局升级后的低成本 smoke 要求。
- 未访问凭据、未修改 `pi/models.json`、未提交 `enabledModels` 的确认。

---

### Task 4：更新当前文档、配置并执行独立评审

**Deps：** `T3`（理由：当前版本声明和评审结论必须基于完整候选证据）

**WritePaths：**
- `README.md`
- `pi/settings.json`
- `docs/reviews/2026-08-25-pi-0843-runtime-compatibility.md`

**Resources：** 外部 LLM reviewer；评审输入只能包含脱敏 diff，不包含 `auth.json`、`models.json` 内容或 session。

**Files：**
- Modify：`README.md:13-20,28-33,79-90`
- Modify：`pi/settings.json:2`
- Modify：`docs/reviews/2026-08-25-pi-0843-runtime-compatibility.md`

**接口契约：**
- Consumes：T3 的候选验收记录。
- Produces：面向用户的当前版本说明、精确回滚命令和独立评审结论。

**验收标准：** README 只把当前事实更新到 `0.84.3`；回滚目标为 `0.84.2`；`pi/settings.json` 只改变 `lastChangelogVersion`；独立评审无未解决的高严重度兼容性发现。

- [x] **步骤 1：更新 README 当前版本事实**

进行以下精确语义更新：

- 安装命令改为 `@earendil-works/pi-coding-agent@0.84.3`。
- 支持矩阵追加 `0.84.3`。
- 初始化固定版本改为 `0.84.3`。
- 标题改为 `Pi 0.84.3 TUI 与工具限制`。
- 回滚命令改为精确 `@earendil-works/pi-coding-agent@0.84.2`。
- 增加一句：临时 `/model`、`/thinking` 和 provider fallback 只影响当前 session，选择器中显式保存才会更新全局默认。
- 增加一句：当前不启用 PowerShell；启用前必须扩展 Security Gates 与 Goal mutation gate。

不得修改历史归档文档。

- [x] **步骤 2：更新 changelog 状态但保护 per-machine 字段**

只将：

```json
"lastChangelogVersion": "0.84.2"
```

改为：

```json
"lastChangelogVersion": "0.84.3"
```

运行：

```bash
node -e 'JSON.parse(require("fs").readFileSync("pi/settings.json", "utf8")); console.log("settings ok")'
git diff -- pi/settings.json
```

预期：JSON 可解析；diff 不包含 `enabledModels`。

- [x] **步骤 3：运行当前文档和版本相关回归**

运行：

```bash
node --test \
  test/init-pi.test.mjs \
  test/doctor.test.mjs \
  test/pi-subagents-compat.test.mjs \
  test/pi-shell.test.mjs
```

预期：全部 PASS。测试只验证安装和 runtime 行为，不为 README 或 `lastChangelogVersion` 建立字面镜像断言。

- [x] **步骤 4：执行独立评审（外部 provider 不可用时明确降级）**

加载 `external-llm-review` skill，对以下范围执行中文评审：

```text
init-pi.sh
scripts/doctor.mjs
scripts/probes/pi-subagents-compat.mjs
test/helpers/pi-host.mjs
test/helpers/pi-runtime.test.mjs
test/pi-runtime.integration.mjs
test/goal-engine-runtime.integration.mjs
test/goal-engine-extension.integration.mjs
test/pi-subagents-compat.test.mjs
test/doctor.test.mjs
test/init-pi.test.mjs
test/compact-tools-extension.test.mjs
README.md
pi/settings.json
docs/reviews/2026-08-25-pi-0843-runtime-compatibility.md
```

评审重点：候选与全局路径是否混用、白名单是否过宽、真实 fallback 持久化语义、PowerShell 是否被意外启用、凭据和 per-machine 配置是否进入 diff，以及计划是否残留已撤销的 Goal canary。

- [x] **步骤 5：处理评审发现并重新验证**

所有高严重度发现必须修复；中低严重度发现必须在评审记录中写明接受或修复理由。每次修复后重跑对应测试，最后重跑 Task 3 步骤 2–6。

---

### Task 5：全局升级并完成 fresh Host 验收

**Deps：** `T4`（理由：全局状态变更只能发生在候选验收、文档和独立评审完成之后）

**WritePaths：**
- `docs/reviews/2026-08-25-pi-0843-runtime-compatibility.md`

**Resources：** `/opt/homebrew/bin/pi` 和全局 npm package 目录，独占执行；真实 TUI 需要一个终端。不得与其他 Pi 安装或更新并发。

**Files：**
- Modify：`docs/reviews/2026-08-25-pi-0843-runtime-compatibility.md`
- Global state：`@earendil-works/pi-coding-agent` 从 `0.84.2` 切换到 `0.84.3`

**接口契约：**
- Consumes：T4 已通过评审的 tracked 变更和精确 `0.84.3` 候选。
- Produces：全新进程中 `pi --version=0.84.3`、全局 npm package `0.84.3`、fresh RPC/TUI/Doctor/Subagent 回归证据，以及精确 `0.84.2` 回滚路径。

**验收标准：** 全局安装后 fresh shell 使用 bundled CLI；所有非 Goal 自动回归通过；fullscreen 正常进入和退出；当前默认 provider 最小 smoke 无 header 拒绝；失败时可恢复 `0.84.2`。

- [x] **步骤 1：执行全局变更前只读预检**

运行：

```bash
pi --version
npm list -g @earendil-works/pi-coding-agent --depth=0
git status --short
git diff -- pi/settings.json
```

预期：前两项报告 `0.84.2`；工作树只包含本计划授权变更和已知外部并发文件；settings diff 不包含 `enabledModels`。

- [x] **步骤 2：安装精确 0.84.3**

运行：

```bash
npm install -g --ignore-scripts --registry=https://registry.npmjs.org \
  @earendil-works/pi-coding-agent@0.84.3
```

不得运行 `pi install` 改写项目 package 配置，不得使用 `pi update --all`。

- [x] **步骤 3：在 fresh 进程验证全局 package 与 bundled bin**

运行：

```bash
zsh -f -c 'pi --version'
npm list -g @earendil-works/pi-coding-agent --depth=0
node -e 'const p=require("/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/package.json"); console.log(p.version, p.bin.pi)'
```

预期：依次报告 `0.84.3`、全局 `@earendil-works/pi-coding-agent@0.84.3` 和 `0.84.3 dist/bundle/cli.js`。

- [x] **步骤 4：运行全局非 Goal 自动验收**

运行：

```bash
npm test
npm run doctor
PI_REAL_BIN=/opt/homebrew/bin/pi npm run test:integration
PI_REAL_BIN=/opt/homebrew/bin/pi npm run test:subagents
```

预期：全部退出 `0`；Doctor 不报告版本错误；Subagent 测试不产生嵌套 runtime。Goal 全量回归按人工范围修订排除，既有 1235/1244 与 9 个失败保留在验收记录。

- [x] **步骤 5：执行全扩展 fresh RPC smoke**

运行 Task 3 步骤 6 的 RPC 命令，但将 CLI 替换为 `/opt/homebrew/bin/pi`，输出写入系统临时目录而不是 session 目录。

预期：`get_state.success=true`，无 `extension_error`，stderr 为空。

- [x] **步骤 6：执行真实 fullscreen smoke**

在 fresh `zsh -f` 中 source `scripts/pi-shell.zsh`，使用 deterministic provider 启动：

```bash
PI_REAL_BIN=/opt/homebrew/bin/pi zsh -f
source scripts/pi-shell.zsh
pi --offline --provider fake --model deterministic \
  -e test/fixtures/deterministic-provider.mjs
```

PTY smoke 确认 fullscreen 的 `DECSET 1049` 与 `DECRST 1049` 各精确一次，Ctrl-D 后进程退出 0。footer、compact renderer 和 child browser 由 650/650 单元测试覆盖；模型临时切换不改写 settings 由真实 Host canary 覆盖。退出后检查 staged settings diff，确认只有计划内 `lastChangelogVersion` 变化。

- [x] **步骤 7：执行当前默认 provider 最小 smoke**

使用当前默认 provider 发起一条不调用工具的低成本请求，确认服务端不因新增 Pi `User-Agent` 拒绝请求。只记录 provider 名、HTTP 成功或失败类别和时间；不得记录请求 header、API key、token 或响应中的敏感内容。

- [x] **步骤 8：记录最终状态和回滚命令**

在 `docs/reviews/2026-08-25-pi-0843-runtime-compatibility.md` 追加全局版本、自动测试结果、人工 TUI 结果、gateway smoke 结果和以下回滚命令：

```bash
npm install -g --ignore-scripts --registry=https://registry.npmjs.org \
  @earendil-works/pi-coding-agent@0.84.2
pi --version
```

若步骤 2–7 任一项出现由 `0.84.3` 引起的阻断失败，立即执行回滚命令，并在记录中保留失败分类与证据；不得通过扩大版本范围或增加 production fallback 绕过失败。

## 最终自检

- [x] `0.84.3` 只作为精确受支持版本加入，`0.84.4` 仍被拒绝。
- [x] `init-pi.sh` 默认安装精确 `0.84.3`。
- [x] Provider fallback 默认仅影响当前 session，未直接写 settings。
- [x] 真实 provider fallback canary 证明当前 session 已切换且 settings 默认值未改变；未新增未经 provenance 证明的生产分支。
- [x] `powershell` 和 `defaultTools` 均未启用。
- [x] `pi/settings.json` diff 不包含 `enabledModels`。
- [x] `pi/models.json`、`pi/auth.json` 和 session 文件没有进入 diff。
- [x] 候选和全局 Host 的单元、Doctor、RPC、Subagent 回归全部通过；Goal 1235/1244 与 9 个并发失败已按人工范围修订保留。
- [x] 全局 `pi --version` 与 npm package 均为 `0.84.3`。
- [x] 中文评审记录包含精确 `0.84.2` 回滚命令。
- [x] 外部并发计划文件未被触碰。
