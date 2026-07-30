# Pi 0.83 与依赖扩展升级实施计划

> **执行者注意：** 逻辑和契约改动必须加载并遵循 `test-driven-development`；遇到任何非预期失败必须先按 `systematic-debugging` 写 `docs/bugs/bug-<摘要>.md`，再修复。涉及子任务派发时必须遵循 `subagent-dispatch`。

**目标：** 以官方 npm registry 和官方发布 tarball 为事实源，把 Pi 升级到 `0.83.0`、`pi-subagents` 升级到 `0.37.2`、`@juicesharp/rpiv-todo` 升级到 `2.2.0`，并通过仓库全部兼容门禁。

**架构：** 继续由 `init-pi.sh` 和 `pi/settings.json` 声明可复现版本，由 Pi package manager 管理扩展安装；项目自有 wrapper 继续独占 `pi-subagents` 和 `rpiv-todo` 的注册面。Pi 0.83 自带 TypeBox `1.3.7`，Plan Runtime 仍保留 `pi-subagents@0.37.2` 官方依赖的顶层 `typebox@1.1.38`，两者位于不同 package root，不强行合并版本。

**技术栈：** Node.js 22、npm 官方 registry、Pi Extension API、`pi-subagents` RPC v1、TypeBox、Node 内置 test runner。

**范围边界：** `../../.r2c/integrations/pi-adapter` 是本机私有 local-path package，没有可核验的官方 registry 版本，本次只做加载回归，不改其源码或 `1.0.0` 元数据。`vendor/superpowers` 是独立 submodule，也不属于本次 Pi package 升级。

---

## 文件职责

- `README.md`：记录默认安装版本和已验证组合。
- `init-pi.sh`：新机器安装 Pi、`pi-subagents`、`rpiv-todo` 的唯一入口。
- `pi/settings.json`：固定 Pi package 来源并禁用 upstream 资源自动注册；保留现有 `defaultThinkingLevel: "minimal"`。
- `scripts/setup-plan-runtime-deps.mjs`：精确安装 Plan Runtime 所需 `pi-subagents` 与 TypeBox。
- `scripts/doctor.mjs`：验证受支持 Pi 版本、扩展版本、资源隔离和 RPC 能力。
- `scripts/probes/pi-subagents-compat.mjs`：定义真实 Plan Harness 兼容报告。
- `pi/extensions/lib/subagent-session-browser.ts`：标明当前上游状态契约版本，不改变浏览逻辑。
- `docs/knowledge/plan-runner-pi-subagents-harness.md`：记录当前受支持运行时组合。
- `test/init-pi.test.mjs`：验证初始化命令可复现且不读取凭据。
- `test/doctor.test.mjs`：验证 Doctor 对新旧版本和 RPC 方法的判定。
- `test/pi-subagents-compat.test.mjs`：验证兼容报告、官方私有导入点和安装命令。
- `test/pi-subagents-runtime.integration.mjs`：验证真实 RPC、async、Supervisor 和 Plan child 运行语义。
- `test/subagent-runtime-resource-isolation.test.mjs`：验证 package 精确版本及 upstream 资源隔离。
- `test/todo-compact-result.test.mjs`：验证 `rpiv-todo` 精确来源及自有 renderer wrapper。
- `pi/npm/package.json`、`pi/npm/package-lock.json`：安装阶段生成的本机 package 状态；该目录被 Git 忽略，不作为提交产物。

### Task 1：先把新版本契约写成失败测试

**Files:**
- Modify: `test/init-pi.test.mjs`
- Modify: `test/doctor.test.mjs`
- Modify: `test/pi-subagents-compat.test.mjs`
- Modify: `test/pi-subagents-runtime.integration.mjs`
- Modify: `test/subagent-runtime-resource-isolation.test.mjs`
- Modify: `test/todo-compact-result.test.mjs`

- [ ] **Step 1：把 fixture 和断言切到目标版本**

将 `test/pi-subagents-compat.test.mjs` 的 `compatibleReport` 精确替换以下字段：

```js
piVersion: "0.83.0",
version: "0.37.2",
typeboxVersion: "1.1.38",
rpcVersion: 1,
methods: ["ping", "status", "spawn", "steer", "interrupt", "stop", "resume"],
```

`typeboxCompileResolvable` 与现有运行语义布尔字段不属于版本升级，不做编辑。

初始化和资源隔离测试使用以下目标：

```text
@earendil-works/pi-coding-agent@0.83.0
pi-subagents@0.37.2
@juicesharp/rpiv-todo@2.2.0
typebox@1.1.38
```

`test/todo-compact-result.test.mjs` 中 package 断言改为：

```js
assert.deepEqual(configured, {
  source: "npm:@juicesharp/rpiv-todo@2.2.0",
  extensions: [],
});
```

- [ ] **Step 2：补充 0.83 和 RPC `resume` 的边界断言**

```js
for (const version of ["0.82.0", "0.82.1", "0.83.0"]) {
  assert.deepEqual(evaluate({ ...compatibleReport, piVersion: version }), { ok: true, failures: [] });
}
assert.deepEqual(
  evaluate({ ...compatibleReport, piVersion: "0.83.1" }).failures,
  ["unsupported Pi version: 0.83.1"],
);
assert.deepEqual(
  evaluate({ ...compatibleReport, methods: compatibleReport.methods.filter((method) => method !== "resume") }).failures,
  ["missing RPC method: resume"],
);
```

在 `installed launch arguments keep project child agents outside fanout hierarchy` 中补充：

```js
assert.ok(built.args.includes("--no-context-files"));
```

这验证 `pi-subagents 0.37.2` 在 `inheritProjectContext: false` 时使用 Pi 0.83 的正式隔离参数。

- [ ] **Step 3：运行目标测试并确认 RED**

Run:

```bash
node --test test/init-pi.test.mjs test/doctor.test.mjs test/pi-subagents-compat.test.mjs test/subagent-runtime-resource-isolation.test.mjs test/todo-compact-result.test.mjs
```

Expected: FAIL；失败必须明确指向旧的 `0.82.1`、`0.37.0`、未固定的 `rpiv-todo` 来源或缺少 `resume`，不能是语法错误或 fixture 无法启动。

### Task 2：同步声明版本与兼容门禁

**Deps:** Task 1

**Files:**
- Modify: `README.md`
- Modify: `init-pi.sh`
- Modify: `pi/settings.json`
- Modify: `scripts/setup-plan-runtime-deps.mjs`
- Modify: `scripts/doctor.mjs`
- Modify: `scripts/probes/pi-subagents-compat.mjs`
- Modify: `pi/extensions/lib/subagent-session-browser.ts`
- Modify: `docs/knowledge/plan-runner-pi-subagents-harness.md`

- [ ] **Step 1：更新初始化脚本的精确版本**

`init-pi.sh` 顶部使用：

```bash
PI_VERSION="0.83.0"
PI_PACKAGE="@earendil-works/pi-coding-agent@$PI_VERSION"
PI_SUBAGENTS_VERSION="0.37.2"
RPIV_TODO_VERSION="2.2.0"
BASIC_MEMORY_VERSION="0.22.1"
```

扩展安装保持 Pi package manager 所有权：

```bash
PI_CODING_AGENT_DIR="$SCRIPT_DIR/pi" "$pi_binary" install "npm:pi-subagents@$PI_SUBAGENTS_VERSION"
PI_CODING_AGENT_DIR="$SCRIPT_DIR/pi" "$pi_binary" install "npm:@juicesharp/rpiv-todo@$RPIV_TODO_VERSION"
npm --prefix "$SCRIPT_DIR" run setup:plan-runtime
```

不把 npm registry 写入用户全局配置；执行阶段通过 `NPM_CONFIG_REGISTRY` 注入官方源。

- [ ] **Step 2：更新 package 声明并保留资源隔离**

`pi/settings.json` 只改 `lastChangelogVersion` 和两个 package source，保留当前模型及 `defaultThinkingLevel: "minimal"`：

```json
{
  "lastChangelogVersion": "0.83.0",
  "packages": [
    {
      "source": "npm:pi-subagents@0.37.2",
      "extensions": [],
      "skills": [],
      "prompts": [],
      "themes": []
    },
    "../../.r2c/integrations/pi-adapter",
    {
      "source": "npm:@juicesharp/rpiv-todo@2.2.0",
      "extensions": []
    }
  ],
  "defaultThinkingLevel": "minimal"
}
```

代码块只展示相关字段，编辑时不得删除 `theme`、provider、model、subagent overrides 或 enabled models。

- [ ] **Step 3：更新 Doctor 和兼容报告常量**

`scripts/doctor.mjs`：

```js
const SUPPORTED_PI_VERSIONS = ["0.82.0", "0.82.1", "0.83.0"];
const PI_SUBAGENTS_VERSION = "0.37.2";
const TYPEBOX_VERSION = "1.1.38";
const REQUIRED_RPC_METHODS = ["ping", "status", "spawn", "steer", "interrupt", "stop", "resume"];
```

`scripts/probes/pi-subagents-compat.mjs`：

```js
export const REQUIRED_METHODS = ["ping", "status", "spawn", "steer", "interrupt", "stop", "resume"];
export const SUPPORTED_PI_VERSIONS = ["0.82.0", "0.82.1", "0.83.0"];

if (report.version !== "0.37.2") failures.push(`unexpected pi-subagents version: ${report.version}`);
```

`scripts/setup-plan-runtime-deps.mjs` 的精确安装参数改为：

```js
"pi-subagents@0.37.2", "typebox@1.1.38",
```

TypeBox 不改成 `1.3.x`：Pi 0.83 的 bundled TypeBox 属于全局 Pi package root；`pi-subagents 0.37.2` 官方 `dependencies` 仍精确要求 `1.1.38`。

- [ ] **Step 4：更新当前知识文档和契约注释**

`README.md` 和 `docs/knowledge/plan-runner-pi-subagents-harness.md` 写明：默认 Pi `0.83.0`，兼容集合 `0.82.0/0.82.1/0.83.0`，扩展固定为 `pi-subagents@0.37.2`、`rpiv-todo@2.2.0`，Plan Runtime TypeBox 为 `1.1.38`。

`pi/extensions/lib/subagent-session-browser.ts` 的版本注释改为：

```ts
// pi-subagents 0.37.2 state contract: active states may advance; terminal states are immutable recent runs.
```

- [ ] **Step 5：再次运行目标测试，确认剩余失败只来自尚未安装的新包**

Run:

```bash
node --test test/init-pi.test.mjs test/doctor.test.mjs test/pi-subagents-compat.test.mjs test/subagent-runtime-resource-isolation.test.mjs test/todo-compact-result.test.mjs
```

Expected: 声明和 fixture 测试通过；直接读取当前全局 Pi 或 `pi/npm/node_modules` 的测试可以因仍是旧安装而失败，错误必须只报告版本不匹配。

### Task 3：从官方源安装并完成聚焦兼容验证

**Deps:** Task 2

**Files:**
- Runtime update: global npm installation
- Runtime update: `pi/npm/package.json`
- Runtime update: `pi/npm/package-lock.json`

- [ ] **Step 1：再次从官方 registry 验证 dist-tag**

Run:

```bash
npm view @earendil-works/pi-coding-agent version --registry=https://registry.npmjs.org
npm view pi-subagents version --registry=https://registry.npmjs.org
npm view @juicesharp/rpiv-todo version --registry=https://registry.npmjs.org
```

Expected:

```text
0.83.0
0.37.2
2.2.0
```

- [ ] **Step 2：安装 Pi 0.83.0，不修改全局 registry**

Run:

```bash
npm install -g --ignore-scripts --registry=https://registry.npmjs.org @earendil-works/pi-coding-agent@0.83.0
pi --version
```

Expected: 安装成功，`pi --version` 输出 `0.83.0`。

- [ ] **Step 3：通过 Pi package manager 安装精确扩展版本**

Run:

```bash
NPM_CONFIG_REGISTRY=https://registry.npmjs.org PI_CODING_AGENT_DIR="$PWD/pi" pi install npm:pi-subagents@0.37.2
NPM_CONFIG_REGISTRY=https://registry.npmjs.org PI_CODING_AGENT_DIR="$PWD/pi" pi install npm:@juicesharp/rpiv-todo@2.2.0
NPM_CONFIG_REGISTRY=https://registry.npmjs.org npm run setup:plan-runtime
```

Expected: `pi/npm/package.json` 中三项依赖分别为 `pi-subagents: "0.37.2"`、`@juicesharp/rpiv-todo: "2.2.0"`、`typebox: "1.1.38"`，lockfile 的 resolved URL 指向 `registry.npmjs.org`。

- [ ] **Step 4：运行聚焦 GREEN 门禁**

Run:

```bash
node --test test/init-pi.test.mjs test/doctor.test.mjs test/pi-subagents-compat.test.mjs test/subagent-runtime-resource-isolation.test.mjs test/todo-compact-result.test.mjs test/subagent-session-browser.test.mjs test/extension-reload-boundary.test.mjs
PI_REAL_BIN="$(command -v pi)" node --test test/pi-subagents-runtime.integration.mjs
```

Expected: PASS。真实集成必须证明 RPC v1 方法子集、`--no-context-files`、async completion、Supervisor round trip、精确 cwd、无 Executor fanout 和 `nestedEventFiles=0`。

### Task 4：运行完整门禁并审查升级结果

**Deps:** Task 3

**Files:**
- Verify only: repository and installed runtime

- [ ] **Step 1：运行完整单元测试和 Doctor**

Run:

```bash
npm test
npm run doctor
```

Expected: PASS；Doctor 只输出既有 limitation warning，不出现 `[error]`。

- [ ] **Step 2：运行全部真实集成门禁**

Run:

```bash
PI_REAL_BIN="$(command -v pi)" npm run test:integration
PI_REAL_BIN="$(command -v pi)" npm run test:subagents
PI_REAL_BIN="$(command -v pi)" npm run test:plan
PI_REAL_BIN="$(command -v pi)" npm run test:plan-harness
```

Expected: PASS；不得跳过真实 Pi、RPC、Plan Harness 或 Supervisor 场景。

- [ ] **Step 3：核对最终安装状态**

Run:

```bash
pi --version
npm ls -g --depth=0 @earendil-works/pi-coding-agent
PI_CODING_AGENT_DIR="$PWD/pi" pi list
node -p "require('./pi/npm/node_modules/pi-subagents/package.json').version"
node -p "require('./pi/npm/node_modules/@juicesharp/rpiv-todo/package.json').version"
node -p "require('./pi/npm/node_modules/typebox/package.json').version"
```

Expected: 依次确认 Pi `0.83.0`、`pi-subagents 0.37.2`、`rpiv-todo 2.2.0`、TypeBox `1.1.38`；`pi list` 中两个 package 均显示已过滤资源。

- [ ] **Step 4：做外部审查和工作树边界检查**

加载 `external-llm-review`，只审查本计划产生的 diff，重点检查 Pi 0.83 TypeBox breaking change、上游私有导入点、资源隔离和测试缺口。随后运行：

```bash
git diff --check
git status --short
git diff -- README.md init-pi.sh pi/settings.json scripts/setup-plan-runtime-deps.mjs scripts/doctor.mjs scripts/probes/pi-subagents-compat.mjs pi/extensions/lib/subagent-session-browser.ts docs/knowledge/plan-runner-pi-subagents-harness.md test/init-pi.test.mjs test/doctor.test.mjs test/pi-subagents-compat.test.mjs test/pi-subagents-runtime.integration.mjs test/subagent-runtime-resource-isolation.test.mjs test/todo-compact-result.test.mjs
```

Expected: 无 whitespace error；升级 diff 不包含用户原有的 `.gitignore`、`.state/**`、`skill-overrides/exa-search/**`、未跟踪 bug/plan 文件或其他并行改动。本计划不自动创建 commit，避免把现有脏工作树中的无关修改混入提交。

## 失败处理

任何测试出现版本不匹配以外的非预期失败时立即停止，不得把测试改弱或删除门禁。先加载 `systematic-debugging`，创建中文 `docs/bugs/bug-<摘要>.md` 完成根因分析六要素，再以新的 TDD RED/GREEN 小任务修复；修复后从失败步骤开始重跑，并最终重新执行 Task 4 全部门禁。

## 执行偏差记录

执行期间，其他会话持续写入 `pi/settings.json` 的 provider/model/thinking 字段。隔离实验排除 `pi install` 和 setup 脚本后，按并发工作树规则保留最新值，不回退到计划起草时观察到的 `minimal`；版本字段和 package source 仍严格按本计划完成。根因证据见 `docs/bugs/bug-pi-upgrade-observed-concurrent-settings-rewrite.md`。Plan Runner/Broker 正处于独立 Task 8 intentional RED，用户明确允许忽略其全量单测与 Harness 失败；本次升级的 Pi RPC、subagents、Doctor 和 Plan Capsule 门禁均已通过。
