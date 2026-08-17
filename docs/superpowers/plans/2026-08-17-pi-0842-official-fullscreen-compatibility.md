# Pi 0.84.2 官方 TUI 收敛与兼容升级实施计划

> **供执行型 Agent 使用：** 每个产生逻辑变更的任务必须先加载并遵循 `test-driven-development`；编码任务通过 `subagent-dispatch` 派发。步骤使用复选框记录进度。

**目标：** 将本仓从 Pi `0.84.1` 兼容升级到精确版本 `0.84.2`，删除 Zsh 自行管理的备用屏幕，优先采用 Pi 官方 fullscreen、focused overlay、组件输入和原生工具合同；升级验收完成后，再把 Subagent 启动显示收敛为单行摘要。

**架构：** Shell 只负责选择配置根和转发参数，fullscreen 生命周期交给 Pi 的 `tuiMode`、`fullscreenExitOutput` 和 `TuiAltScreen`。Subagent 浏览器改为官方 focused overlay，输入由 overlay 组件自身持有；现有 child transcript、roster、可信路径和 native renderer 保留。Compact tool 继续作为必要的显示薄层，但完整继承官方工具定义；最终显示任务只改 TUI renderer state，不改原始 tool result、RPC、session 或 run identity。

**技术栈：** Zsh、Node.js 22.19+、Node 内置 test runner、`@earendil-works/pi-coding-agent@0.84.2`、`@earendil-works/pi-tui@0.84.2`、Pi Extension API、`pi-subagents@0.45.2`、`typebox@1.1.38`。

## 全局约束

- 目标 Pi 版本精确为 `0.84.2`；不得用 `0.84.x`、`latest` 或其他宽松范围代替。
- `pi-subagents` 保持精确 `0.45.2`，顶层 `typebox` 保持精确 `1.1.38`。
- 官方 fullscreen 是唯一备用屏幕拥有者；仓库脚本和 Extension 不得发送 `DECSET/DECRST 1049`，不得自行嵌套备用屏幕。
- 默认交互模式使用 `tuiMode: "fullscreen"`；退出使用 `fullscreenExitOutput: "resume-hint"`，保留 `pi-inline`/`pi-full` 作为官方 `--tui-mode` 的轻量别名。
- Subagent 浏览器必须使用 focused/capturing overlay 和组件 `handleInput()`；禁止在 browser active 时由全局 `onTerminalInput` 吞掉未知输入。
- `Ctrl+Shift+F` 保持 Pi 官方语义：搜索 primary parent transcript；本计划不新增 child transcript 搜索。
- Child roster、可信路径检查、SessionManager 原生渲染、Fleet fallback、三行 footer、`Alt+O` 入口、左右切 child、`x` 展开和应用内位置指示必须保留。
- Compact tool 仅保留官方尚未提供的紧凑显示；执行、参数 schema、prompt、sampling 和未来附加元数据必须来自官方 `create*Tool()` 定义。
- 本计划不启用 `defaultTools`。Pi 官方规定 extension tools 始终启用，而 compact override 与 built-in 同名；需要严格工具集合时使用官方 `--tools`/`--exclude-tools`/`--no-tools`。
- 生产或 Skill 逻辑修改前必须先建立 `docs/bugs/bug-pi-0842-official-surface-compatibility-gaps.md`，并观察对应测试 RED。
- 不读取、复制或输出 `pi/auth.json`、npm 凭据、provider 密钥或其他认证材料。
- 不修改 Goal Engine 业务合同、`.state/**`、Goal 数据或受管 worktree；禁止 raw `git worktree add/remove/prune/move/repair/lock/unlock`。
- T0 可在 gitignored `var/test-runtimes/pi-0.84.2/` 安装共享只读候选 artifact；它不得暂存、不得包含认证信息，T1/T2/T3 只读取该 artifact。
- 全局安装只在隔离候选验证、完整回归和人工 fullscreen 验收后执行；任一新增回归都回滚到 `0.84.1`。
- 历史 bug/计划中的旧版本和当时事实保留；只增加“已由 0.84.2 官方能力取代”的状态说明，不重写历史证据。
- Subagent 启动显示优化必须晚于 T5 的全局 `0.84.2` 升级验收；原始 spawn content/details、runId、RPC reply、session JSONL 和 completion lifecycle 不得改变。

---

## 决策记录

- **[备用屏幕拥有者]**：终端全屏由 Pi 官方 TUI 单独管理。
- **推荐**：删除 Zsh `1049h/1049l` 包装，因为官方 fullscreen 已负责滚动、恢复和退出输出。
- **不选原因**：终端备用屏幕不是可嵌套栈，双重拥有会产生恢复错屏。
- **选错代价**：退出、崩溃或 reload 时暴露，修复代价中。

- **[Subagent 浏览器输入]**：采用 focused overlay 和组件输入，而非全局抢占。
- **推荐**：官方 overlay handle 持焦，browser component 处理导航，因为 0.84.2 会为 focused overlay 让出 viewport 输入。
- **不选原因**：继续使用 `nonCapturing` 会绕过官方修复，并让 search 输入被全局 listener 吞掉。
- **选错代价**：fullscreen 搜索、分页和滚轮时暴露，修复代价中。

- **[Compact tool 去留]**：保留紧凑显示，但收窄为官方工具合同上的显示适配器。
- **推荐**：展开官方 tool definition 后只覆盖动态 cwd 执行和 renderer，因为官方没有单独装饰 built-in renderer 的 Extension API。
- **不选原因**：完全删除会丢失已确认的单行摘要与 Skill 展示；手工复制字段会继续漏掉新宿主能力。
- **选错代价**：模型工具参数、实验性严格采样或显示一致性变化时暴露，修复代价中。

- **[搜索范围]**：保留官方 primary transcript 搜索，不新增 child 搜索。
- **推荐**：先恢复官方搜索可输入和焦点恢复，因为 child search 是新增产品能力，不是升级兼容条件。
- **不选原因**：在本次升级中再维护独立搜索会复制匹配、高亮和快捷键逻辑。
- **选错代价**：用户要求搜索 child 历史时暴露，后续独立实现代价中。

---

## 文件职责

- `docs/bugs/bug-pi-0842-official-surface-compatibility-gaps.md`：记录外层备用屏幕、focused overlay、主题缓存和工具合同四类兼容缺口、复现与修复边界。
- `test/helpers/pi-runtime.mjs`：按 `PI_TEST_CODING_AGENT_ROOT` 或动态 npm global root 加载候选 Pi/Jiti/TUI，消除 Homebrew `0.84.1` 绝对路径。
- `test/helpers/pi-runtime.test.mjs`：锁定显式候选 root、全局 fallback 和 alias 合同。
- `scripts/pi-shell.zsh`：只设置仓库配置目录并转发；`pi-inline`/`pi-full` 只映射官方 TUI mode。
- `pi/settings.json`：声明官方默认 fullscreen 与退出输出；不放入 `defaultTools`。
- `test/pi-shell.test.mjs`：证明 shell 不输出备用屏幕控制码，并验证两个官方 mode 别名。
- `pi/extensions/custom-footer.ts`：维护 roster/footer/overlay 生命周期，使用官方 shortcut、focused overlay 和组件输入。
- `pi/extensions/lib/subagent-session-viewport.ts`：保留 child line model、位置与应用内滚动；作为 focused component 接收按键和 SGR wheel，区分轻量 refresh 与宿主 invalidate。
- `test/custom-footer-fullscreen.integration.test.mjs`：在真实 `TuiAltScreen` 输入链验证 search、焦点恢复、分页和滚轮。
- `test/custom-footer-input.integration.test.mjs`、`test/custom-footer-subagents.test.mjs`、`test/subagent-session-viewport.test.mjs`：锁定 regular/fullscreen 共有行为、生命周期、主题失效和现有 child UX。
- `pi/extensions/compact-tools.ts`：完整继承官方 tool definition，只覆盖显示和动态 cwd 执行。
- `test/compact-tools-extension.test.mjs`：在 `PI_EXPERIMENTAL=1` 下验证官方元数据、schema 和 strict sampling 未丢失。
- `scripts/probes/pi-subagents-compat.mjs`、`scripts/doctor.mjs`：在兼容修复全部通过后允许精确 `0.84.2`。
- `init-pi.sh`、`README.md`：固定默认安装版本并记录官方 fullscreen、compact/defaultTools 限制和回滚方式。
- `test/pi-subagents-compat.test.mjs`、`test/doctor.test.mjs`、`test/init-pi.test.mjs`：锁定版本准入和可复现安装。
- 其余硬编码 Pi 路径的测试：统一使用 `test/helpers/pi-runtime.mjs`，确保同一套测试可运行于 `0.84.1` 和候选 `0.84.2`。
- `docs/bugs/bug-subagent-spawn-result-is-verbose.md`：记录 spawn 成功结果在 TUI 重复展示工具名、runId 和固定调度提示的问题。
- `scripts/lib/subagent-dispatch/compact-rendering.ts`：从结构化 `result.details.agent/title` 生成启动状态摘要，不解析或改写原始协议数据。
- `scripts/lib/subagent-dispatch/extension.ts`、`pi/extensions/subagent-runtime.ts`：把 spawn call/result renderer state 接到项目自有 `subagent` tool；status/control 维持原显示合同。
- `test/subagent-compact-rendering.test.mjs`、`test/subagent-runtime-membrane.test.mjs`：锁定单行启动摘要、原始 result 不变和非 spawn 行为。

## DAG

```dot
digraph pi_0842_official_tui {
  rankdir=LR;
  T0 [label="T0 缺陷合同与候选宿主夹具"];
  T1 [label="T1 Shell 收敛到官方 fullscreen"];
  T2 [label="T2 Focused child overlay 与输入"];
  T3 [label="T3 官方工具合同薄适配"];
  T4 [label="T4 0.84.2 准入与隔离候选回归"];
  T5 [label="T5 全量验收、审查与全局升级"];
  T6 [label="T6 Subagent 启动显示单行化"];

  T0 -> T1 [label="bug 文档先于 shell 逻辑；官方模式合同"];
  T0 -> T2 [label="候选 TUI loader 与已记录复现"];
  T0 -> T3 [label="候选 tool loader 与已记录复现"];
  T1 -> T4 [label="无外层 1049 的 shell 行为"];
  T2 -> T4 [label="focused overlay/search/input 证据"];
  T3 -> T4 [label="完整官方 tool metadata 证据"];
  T4 -> T5 [label="0.84.2 准入、候选全量输出"];
  T5 -> T6 [label="全局 0.84.2 与真实 TUI 基线"];
}
```

### 依赖边理由

- `T0 → T1/T2/T3`：只依赖 T0 产出的中文 bug 合同；T2/T3 额外消费 `loadPiTestRuntime()` 候选宿主夹具。没有 bug 文档时下游不得修改生产逻辑。
- `T1/T2/T3 → T4`：T4 才扩大版本准入；必须先获得 shell 单 owner、focused overlay 和 tool metadata 三份独立通过证据，避免门禁提前放行不完整实现。
- `T4 → T5`：全局安装只消费隔离候选的版本、Doctor、全量测试、RPC 和 subagent 证据。
- `T5 → T6`：显示优化必须基于已经验收的 0.84.2 tool renderer 行为；它只消费真实 TUI 基线，不得与宿主升级同时调试。

### 并行调度组

- **Wave 0**：T0，先建立缺陷合同和共享候选宿主夹具。
- **Wave 1（可并行）**：T1、T2、T3。三者写入路径不重叠，分别处理 shell、child overlay、tool adapter。
- **Wave 2**：T4；它只在三个前驱各自完成后扩大准入并运行隔离候选回归。
- **Wave 3**：T5；执行全量验收、审查、全局安装与回滚检查。
- **Wave 4**：T6；升级完成后单独优化 Subagent 启动显示并复跑 Subagent/TUI 回归。
- Wave 不是派发屏障；T1/T2/T3 任一任务在 T0 完成后即可独立派发。

---

### Task 0：建立兼容缺陷合同与候选 Pi 测试夹具

**Deps:** none

**写入路径：**
- `docs/bugs/bug-pi-0842-official-surface-compatibility-gaps.md`
- `test/helpers/pi-runtime.mjs`
- `test/helpers/pi-runtime.test.mjs`
- `var/test-runtimes/pi-0.84.2/**`（gitignored 共享候选 artifact，不提交）

**资源约束：** npm 官方 registry；该任务独占写入 `var/test-runtimes/pi-0.84.2/`，下游只读。

**接口：**
- 消费：`PI_TEST_CODING_AGENT_ROOT`、`npm root -g`、Pi package 内的 `dist/index.js`、嵌套 `jiti` 与 `pi-tui`。
- 产出：
  - `resolvePiCodingAgentRoot(options?): string`
  - `loadPiTestRuntime(importMetaUrl, options?): Promise<{ root, paths, jiti, codingAgent, piTui }>`
  - 一份先于生产逻辑存在的中文 bug 文档。

**验收：**
- Bug 文档包含一句话描述、四组稳定复现和官方优先修复方案。
- 显式候选 root 永远优先；未指定时动态解析 npm global root，不出现 `/opt/homebrew` 常量。
- Loader 能同时加载当前 `0.84.1` 和传入的隔离 `0.84.2`，alias 包含 coding-agent、pi-tui、pi-ai、pi-ai/compat、pi-agent-core。

- [ ] **Step 1：先创建中文 bug 文档**

创建 `docs/bugs/bug-pi-0842-official-surface-compatibility-gaps.md`，正文至少包含：

```markdown
# Bug：Pi 0.84.2 官方能力与本仓旧兼容层发生重叠

## 一句话描述
本仓 Zsh 备用屏幕、non-capturing child overlay 和手工复制的 tool definition 绕过或覆盖了 Pi 0.84.2 已提供的官方行为。

## 复现流程
1. 在外层发送 DECSET 1049 后再以 `--tui-mode fullscreen` 启动 Pi，观察双重备用屏幕所有权。
2. fullscreen child browser 激活时按 Ctrl+Shift+F 并输入字符，搜索框打开但 query 为空。
3. 设置 PI_EXPERIMENTAL=1，比较原生 read 与 compact override 的 constrainedSampling。
4. 切换主题并重绘已缓存 child transcript，观察旧 ANSI 颜色未失效。

## 修复方案
删除外层 1049；使用官方 fullscreen 设置、focused overlay、组件 handleInput 和 overlay handle；compact tool 展开官方定义后只覆盖显示与动态 cwd；宿主 invalidate 必须清除 child ANSI cache。
```

这一步完成并可供人审后，才允许执行本计划任何生产逻辑修改。

- [ ] **Step 2：写候选 root 和 loader 的失败测试（RED）**

在 `test/helpers/pi-runtime.test.mjs` 写入：

```js
import assert from "node:assert/strict";
import test from "node:test";
import {
  loadPiTestRuntime,
  resolvePiCodingAgentRoot,
} from "./pi-runtime.mjs";

test("explicit candidate Pi package root wins without a Homebrew assumption", () => {
  assert.equal(resolvePiCodingAgentRoot({
    env: { PI_TEST_CODING_AGENT_ROOT: " /candidate/pi-coding-agent " },
    readGlobalNodeModules: () => "/global/node_modules",
  }), "/candidate/pi-coding-agent");
});

test("global fallback joins the package under npm root", () => {
  assert.equal(resolvePiCodingAgentRoot({
    env: {},
    readGlobalNodeModules: () => "/global/node_modules",
  }), "/global/node_modules/@earendil-works/pi-coding-agent");
});

test("actual runtime loader exposes Pi and TUI constructors", async () => {
  const runtime = await loadPiTestRuntime(import.meta.url);
  assert.equal(typeof runtime.codingAgent.SessionManager, "function");
  assert.equal(typeof runtime.piTui.TuiMainScreen, "function");
  assert.equal(typeof runtime.piTui.TuiAltScreen, "function");
});
```

- [ ] **Step 3：运行测试确认 RED**

运行：

```bash
node --test test/helpers/pi-runtime.test.mjs
```

预期：因 `test/helpers/pi-runtime.mjs` 尚不存在而失败；不得接受 npm、认证或网络失败作为 RED。

- [ ] **Step 4：实现最小候选 loader（GREEN）**

创建 `test/helpers/pi-runtime.mjs`：

```js
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const defaultGlobalRoot = () => execFileSync("npm", ["root", "-g"], {
  encoding: "utf8",
}).trim();

export function resolvePiCodingAgentRoot({
  env = process.env,
  readGlobalNodeModules = defaultGlobalRoot,
} = {}) {
  const explicit = env.PI_TEST_CODING_AGENT_ROOT?.trim();
  if (explicit) return explicit;
  return join(readGlobalNodeModules(), "@earendil-works", "pi-coding-agent");
}

export async function loadPiTestRuntime(importMetaUrl, options = {}) {
  const root = resolvePiCodingAgentRoot(options);
  const paths = {
    codingAgent: join(root, "dist", "index.js"),
    piTui: join(root, "node_modules", "@earendil-works", "pi-tui", "dist", "index.js"),
    piAi: join(root, "node_modules", "@earendil-works", "pi-ai", "dist", "index.js"),
    piAiCompat: join(root, "node_modules", "@earendil-works", "pi-ai", "dist", "compat.js"),
    piAgentCore: join(root, "node_modules", "@earendil-works", "pi-agent-core", "dist", "index.js"),
    jiti: join(root, "node_modules", "jiti", "lib", "jiti.mjs"),
  };
  const { createJiti } = await import(pathToFileURL(paths.jiti).href);
  const jiti = createJiti(importMetaUrl, {
    moduleCache: false,
    alias: {
      "@earendil-works/pi-coding-agent": paths.codingAgent,
      "@earendil-works/pi-tui": paths.piTui,
      "@earendil-works/pi-ai": paths.piAi,
      "@earendil-works/pi-ai/compat": paths.piAiCompat,
      "@earendil-works/pi-agent-core": paths.piAgentCore,
    },
  });
  return {
    root,
    paths,
    jiti,
    codingAgent: await import(pathToFileURL(paths.codingAgent).href),
    piTui: await jiti.import("@earendil-works/pi-tui"),
  };
}
```

若隔离包的公开 `pi-ai/compat` 实际路径由 package exports 指向不同文件，只允许依据 `package.json.exports` 修正 `paths.piAiCompat`；不得回退到全局 0.84.1。

- [ ] **Step 5：运行 GREEN 并安装共享 0.84.2 候选**

先验证动态全局 fallback：

```bash
node --test test/helpers/pi-runtime.test.mjs
```

再在 gitignored 固定位置安装供并行下游只读使用的候选：

```bash
mkdir -p var/test-runtimes/pi-0.84.2
npm install --prefix var/test-runtimes/pi-0.84.2 \
  --ignore-scripts --no-audit --no-fund \
  --registry=https://registry.npmjs.org \
  @earendil-works/pi-coding-agent@0.84.2
CANDIDATE_ROOT="$PWD/var/test-runtimes/pi-0.84.2/node_modules/@earendil-works/pi-coding-agent"
PI_TEST_CODING_AGENT_ROOT="$CANDIDATE_ROOT" \
  node --test test/helpers/pi-runtime.test.mjs
node "$CANDIDATE_ROOT/dist/cli.js" --version
```

预期测试通过且最后输出 `0.84.2`。运行：

```bash
grep -R "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent" \
  test/helpers/pi-runtime.mjs test/helpers/pi-runtime.test.mjs
git status --short -- var/test-runtimes
```

预期两条都无输出；candidate artifact 被 `.gitignore` 排除。

- [ ] **Step 6：提交接口任务**

加载 `git-commit-convention`，只暂存本 Task 三个路径，创建独立提交；不得包含审计 artifact、用户配置或 `.state/**`。

---

### Task 1：删除 Zsh 备用屏幕并映射官方 fullscreen

**Deps:** Task 0（依赖产物：bug 文档中的单一备用屏幕拥有者合同）

**写入路径：**
- `scripts/pi-shell.zsh`
- `test/pi-shell.test.mjs`
- `pi/settings.json`
- `docs/bugs/bug-bare-pi-does-not-enter-alternate-screen.md`

**接口：**
- 消费：`_pi_config_invoke "$@"` 和 Pi 官方 `--tui-mode regular|fullscreen`。
- 产出：
  - `pi()`：只转发，默认 mode 由 `pi/settings.json` 决定。
  - `pi-inline()`：调用官方 `--tui-mode regular`。
  - `pi-full()`：调用官方 `--tui-mode fullscreen`。
  - settings：`tuiMode="fullscreen"`、`fullscreenExitOutput="resume-hint"`。

**验收：**
- Shell 文件和三种调用的 stdout 都不含 `\x1b[?1049h`、`\x1b[?1049l`、清屏或相关 trap。
- `PI_ALT_SCREEN=always|auto|never` 不再改变行为。
- `pi-inline`/`pi-full` 只通过官方 CLI flag 选择 mode；bare `pi` 不硬编码 flag。

- [ ] **Step 1：写 shell 行为 RED 测试**

在 `test/pi-shell.test.mjs`：

1. 将原“bare pi uses the alternate screen”测试改为断言：

```js
assert.equal(result.stdout, "");
assert.equal(await readFile(output, "utf8"), "--no-skills\n");
```

2. 将 `pi-inline --version` 的参数预期改为：

```text
--no-skills
--tui-mode
regular
--version
```

3. 将 `pi-full --version` 的参数预期改为：

```text
--no-skills
--tui-mode
fullscreen
--version
```

4. 新增源码与 settings 断言：

```js
const shell = await readFile(join(repoRoot, "scripts", "pi-shell.zsh"), "utf8");
assert.doesNotMatch(shell, /1049|PI_ALT_SCREEN|_pi_config_alt_screen/);
const settings = JSON.parse(await readFile(join(repoRoot, "pi", "settings.json"), "utf8"));
assert.equal(settings.tuiMode, "fullscreen");
assert.equal(settings.fullscreenExitOutput, "resume-hint");
assert.equal(Object.hasOwn(settings, "defaultTools"), false);
```

- [ ] **Step 2：运行 shell 测试确认 RED**

运行：

```bash
node --test test/pi-shell.test.mjs
```

预期：旧实现仍输出 1049 序列、别名未传官方 flag、settings 缺字段而失败。

- [ ] **Step 3：用官方 mode 替换 shell 实现**

将 `scripts/pi-shell.zsh` 中 `_pi_config_alt_screen`、`PI_ALT_SCREEN` 分支和相关 trap 全部删除，保留：

```zsh
pi() {
  _pi_config_invoke "$@"
}

pi-inline() {
  _pi_config_invoke --tui-mode regular "$@"
}

pi-full() {
  _pi_config_invoke --tui-mode fullscreen "$@"
}
```

在 `pi/settings.json` 顶层加入：

```json
"tuiMode": "fullscreen",
"fullscreenExitOutput": "resume-hint"
```

不得修改 provider、model、packages、subagents、enabledModels 或 thinking 设置，不得加入 `defaultTools`。

- [ ] **Step 4：标记历史 workaround 已被官方能力替代**

在 `docs/bugs/bug-bare-pi-does-not-enter-alternate-screen.md` 标题后增加状态说明：

```markdown
> **状态：由 Pi 0.84.2 官方 `tuiMode=fullscreen` 取代。** Zsh 不再发送 DECSET/DECRST 1049；`pi-inline` 与 `pi-full` 仅保留为官方 mode 别名。
```

保留原始现象、根因和历史修复方向。

- [ ] **Step 5：运行 GREEN**

运行：

```bash
node --test test/pi-shell.test.mjs test/init-pi.test.mjs
zsh -n scripts/pi-shell.zsh
```

预期全部通过；再运行：

```bash
grep -nE "1049|PI_ALT_SCREEN|_pi_config_alt_screen" scripts/pi-shell.zsh
```

预期无输出。

- [ ] **Step 6：提交官方 fullscreen shell 迁移**

加载 `git-commit-convention`，只暂存本 Task 四个路径，创建独立提交。

---

### Task 2：将 child browser 迁移到 focused overlay 与组件输入

**Deps:** Task 0（依赖产物：`loadPiTestRuntime()`、共享 0.84.2 候选和 focused overlay bug 合同）

**写入路径：**
- `pi/extensions/custom-footer.ts`
- `pi/extensions/lib/subagent-session-viewport.ts`
- `test/custom-footer-fullscreen.integration.test.mjs`
- `test/custom-footer-input.integration.test.mjs`
- `test/custom-footer-subagents.test.mjs`
- `test/subagent-session-viewport.test.mjs`

**资源约束：** 只读使用 `var/test-runtimes/pi-0.84.2/`；不写候选 package。

**接口：**
- 消费：Pi `registerShortcut("alt+o")`、`ctx.ui.custom(..., { overlay:true, onHandle })`、`OverlayHandle.focus()`、组件 `handleInput(data)`。
- 产出：
  - `SubagentTranscriptViewport.handleInput(data): void`
  - `SubagentTranscriptViewport.refresh(): void`：只请求重绘，不清 renderer cache。
  - `SubagentTranscriptViewport.invalidate(): void`：宿主失效边界，调用 `onInvalidate` 后请求重绘。
  - `parseSgrWheelDirection(data): -1 | 1 | undefined`
  - browser-active 期间不注册全局 terminal input consumer。

**验收：**
- 官方 search 打开后可输入 query；关闭后 child overlay 重新持焦。
- PageUp/PageDown/Home/End、上下/`j`/`k`、左右 child、`x`、Alt+O、Escape 保持原行为。
- SGR wheel 在 focused child overlay 中滚动 child，不再滚动隐藏的 parent transcript。
- host theme invalidation 清理 native child ANSI cache；500ms poll 只 refresh，不破坏缓存性能。
- reload/no-UI/shutdown 释放 shortcut 所依赖的 live context、overlay、timer 和 event listener。

- [ ] **Step 1：把现有测试切到共享候选 runtime loader**

在以下测试中删除 `/opt/homebrew/...` 静态 import，改用：

```js
import { loadPiTestRuntime } from "./helpers/pi-runtime.mjs";
const { jiti, codingAgent, piTui } = await loadPiTestRuntime(import.meta.url);
```

文件：

```text
test/custom-footer-input.integration.test.mjs
test/custom-footer-subagents.test.mjs
test/subagent-session-viewport.test.mjs
```

`SessionManager`、`initTheme` 从 `codingAgent` 解构；Extension 源码继续由返回的 `jiti` 加载。

- [ ] **Step 2：写真实 fullscreen input RED**

创建 `test/custom-footer-fullscreen.integration.test.mjs`，使用真实 `piTui.TuiAltScreen` 与可控 fake `Terminal`，至少固定：

```js
assert.equal(typeof piTui.TuiAltScreen, "function");
// 注册一个 child，触发官方 Alt+O shortcut 后 overlay 必须 focused。
assert.equal(overlayHandle.isFocused(), true);
// 官方 Ctrl+Shift+F 打开 search；字符 q 必须进入 search input。
dispatchInput("\x1b[102;6u");
dispatchInput("q");
assert.match(tui.getFocusedComponent().render(40).join("\n"), /> q/);
// Escape 关闭 search 后 child overlay 恢复焦点。
dispatchInput("\x1b");
assert.equal(overlayHandle.isFocused(), true);
// PageUp 和 SGR wheel 必须改变 child position。
const before = viewport.position();
dispatchInput("\x1b[5~");
assert.notDeepEqual(viewport.position(), before);
```

测试还要证明 search 关闭后 browser 仍 active，且官方 search 的目标仍是 primary transcript；不得伪造 child search。

- [ ] **Step 3：写生命周期、wheel 与主题缓存 RED**

在 `test/subagent-session-viewport.test.mjs` 增加：

```js
assert.equal(parseSgrWheelDirection("\x1b[<64;10;5M"), -1);
assert.equal(parseSgrWheelDirection("\x1b[<65;10;5M"), 1);
assert.equal(parseSgrWheelDirection("x"), undefined);
```

验证 `refresh()` 只增加 render 请求；`invalidate()` 还必须调用一次 `onInvalidate`。

在 `test/custom-footer-subagents.test.mjs` 更新 runtime fixture：mock `pi.registerShortcut` 和 `ui.custom(..., { onHandle })`，断言：

```js
assert.equal(ctx.ui.onTerminalInputCalls, 0);
assert.equal(customCall.options.overlayOptions.nonCapturing, undefined);
assert.equal(customCall.handle.focusCalls, 1);
```

再以真实 `initTheme("dark")` 渲染 child、切换 `initTheme("light")`、调用 overlay component `invalidate()`，断言输出 ANSI 变化；仅调用 `refresh()` 时缓存命中次数不变。

- [ ] **Step 4：运行测试确认 RED**

运行：

```bash
PI_TEST_CODING_AGENT_ROOT="$PWD/var/test-runtimes/pi-0.84.2/node_modules/@earendil-works/pi-coding-agent" \
node --test --test-concurrency=1 \
  test/custom-footer-fullscreen.integration.test.mjs \
  test/custom-footer-input.integration.test.mjs \
  test/custom-footer-subagents.test.mjs \
  test/subagent-session-viewport.test.mjs
```

预期至少因 `nonCapturing:true`、全局 listener 吞 query、缺少 component `handleInput/refresh` 和未传播 invalidate 而失败。

- [ ] **Step 5：实现 focused overlay 和组件输入**

在 `pi/extensions/lib/subagent-session-viewport.ts`：

1. 给 options 增加：

```ts
onInput?: (data: string) => void;
onInvalidate?: () => void;
```

2. 增加：

```ts
handleInput(data: string): void {
  if (!this.disposed) this.options.onInput?.(data);
}

refresh(): void {
  if (!this.disposed) this.options.requestRender();
}

invalidate(): void {
  if (this.disposed) return;
  this.options.onInvalidate?.();
  this.options.requestRender();
}
```

3. 导出 `parseSgrWheelDirection(data)`；仅接受完整 SGR wheel press，去除 Shift/Alt/Ctrl modifier bits 后把 button `64` 映射为 `-1`、`65` 映射为 `1`，其他 mouse/key 返回 `undefined`。

在 `pi/extensions/custom-footer.ts`：

1. 由 `pi.registerShortcut(Key.alt("o"), { description, handler })` 提供 inactive→browser 入口。
2. browser active 时 Alt+O/Escape 和导航由 viewport component `handleInput` 调用 controller；未知按键不再由全局 listener consume。
3. 删除 `unsubscribeInput` 和 `ctx.ui.onTerminalInput(...)` 生命周期。
4. `ctx.ui.custom` 删除 `nonCapturing:true`，增加：

```ts
onHandle: (handle) => handle.focus(),
```

5. viewport options 使用：

```ts
onInput: (data) => controller.handleOverlayInput(data),
onInvalidate: invalidateNative,
```

6. Extension 内部 `refresh()` 改调 `viewport?.refresh()`；child 变化仍可显式调用 `invalidateNative()`。

保留 read-only editor 与 draft 保存/恢复，避免 footer dock 显示可编辑输入；overlay 才是 browser active 时的焦点拥有者。

- [ ] **Step 6：运行 GREEN 与性能回归**

运行 Step 4 命令，并追加：

```bash
PI_TEST_CODING_AGENT_ROOT="$PWD/var/test-runtimes/pi-0.84.2/node_modules/@earendil-works/pi-coding-agent" \
node --test --test-concurrency=1 \
  test/subagent-native-conversation.test.mjs \
  test/pi-subagents-browser-adapter.test.mjs
```

预期全部通过；`renders 100 unchanged native cache hits below 100ms` 仍通过，证明 poll refresh 未退化为每次清缓存。

- [ ] **Step 7：提交 focused overlay 迁移**

加载 `git-commit-convention`，只暂存本 Task 六个路径，创建独立提交。

---

### Task 3：把 compact tools 收窄为官方 tool definition 薄适配

**Deps:** Task 0（依赖产物：候选 Pi loader、共享 0.84.2 候选和 tool metadata bug 合同）

**写入路径：**
- `pi/extensions/compact-tools.ts`
- `test/compact-tools-extension.test.mjs`
- `test/compact-tools-renderer.test.mjs`

**资源约束：** 只读使用 `var/test-runtimes/pi-0.84.2/`；不写候选 package。

**接口：**
- 消费：`createReadTool/createBashTool/createEditTool/createWriteTool/createFindTool/createGrepTool/createLsTool` 返回的完整 `ToolDefinition`。
- 产出：同名 extension tool 完整保留官方字段；仅覆盖 `execute`、`renderShell`、`renderCall`、`renderResult`。

**验收：**
- `PI_EXPERIMENTAL=1` 时 read/bash/edit/write 的 `constrainedSampling` 与原生定义深相等。
- `promptGuidelines`、`promptSnippet`、`parameters`、`prepareArguments` 与官方定义保持相同引用或深相等。
- execute 按 `ctx.cwd` 获取官方工具，并传递完整五参数；renderer 仍保持单行摘要和 expanded 输出。
- `pi/settings.json` 不引入 `defaultTools`；README 明确严格集合使用官方 `--tools`。

- [ ] **Step 1：写真实 extension factory RED**

创建 `test/compact-tools-extension.test.mjs`，通过 `loadPiTestRuntime()` 加载 `compact-tools.ts`，收集 `registerTool` 参数：

```js
process.env.PI_EXPERIMENTAL = "1";
const registered = [];
compactTools({ registerTool: (tool) => registered.push(tool), on() {} });
for (const name of ["read", "bash", "edit", "write"]) {
  const native = factories[name](process.cwd());
  const actual = registered.find((tool) => tool.name === name);
  assert.deepEqual(actual.constrainedSampling, native.constrainedSampling);
  assert.deepEqual(actual.promptGuidelines, native.promptGuidelines);
  assert.equal(actual.parameters, native.parameters);
}
```

测试必须在 `after`/`finally` 恢复原 `PI_EXPERIMENTAL` 值，避免污染同进程其他测试。

增加动态 cwd spy：让两个 cwd 的官方 factory 返回不同 execute spy，调用注册后的 tool 后断言五个参数和 live `ctx` 全部透传到第二个 cwd 的官方 execute。

- [ ] **Step 2：运行测试确认 RED**

运行：

```bash
PI_TEST_CODING_AGENT_ROOT="$PWD/var/test-runtimes/pi-0.84.2/node_modules/@earendil-works/pi-coding-agent" \
  node --test test/compact-tools-extension.test.mjs test/compact-tools-renderer.test.mjs
```

预期真实 factory 测试因当前 override 丢失 `constrainedSampling` 和 `promptGuidelines` 而失败；纯 renderer 基线继续通过。

- [ ] **Step 3：用对象展开保留官方合同**

把 `pi.registerTool({...})` 改为：

```ts
pi.registerTool({
  ...native,
  name,
  renderShell: "self",
  async execute(toolCallId, params, signal, onUpdate, ctx) {
    return nativeTools(ctx.cwd)[name].execute(
      toolCallId,
      params,
      signal,
      onUpdate,
      ctx,
    );
  },
  renderCall: rendering.renderCall,
  renderResult: rendering.renderResult,
} as any);
```

不得再逐项复制 `label/description/promptSnippet/parameters/prepareArguments`；对象展开是未来宿主新增字段的兼容边界。

- [ ] **Step 4：运行 GREEN**

运行 Step 2 命令，预期全部通过。再运行：

```bash
PI_EXPERIMENTAL=1 PI_TEST_CODING_AGENT_ROOT="$PWD/var/test-runtimes/pi-0.84.2/node_modules/@earendil-works/pi-coding-agent" \
  node --test test/compact-tools-extension.test.mjs
```

预期 strict sampling、prompt 和 schema 断言通过。

- [ ] **Step 5：提交 tool contract 薄适配**

加载 `git-commit-convention`，只暂存本 Task 三个路径，创建独立提交。

---

### Task 4：扩大 0.84.2 准入并执行隔离候选全量回归

**Deps:** Task 1（无外层 1049）、Task 2（focused overlay）、Task 3（完整官方 tool metadata）

**写入路径：**
- `scripts/probes/pi-subagents-compat.mjs`
- `scripts/doctor.mjs`
- `init-pi.sh`
- `README.md`
- `test/pi-subagents-compat.test.mjs`
- `test/doctor.test.mjs`
- `test/init-pi.test.mjs`
- `test/pi-runtime.integration.mjs`
- `test/pi-subagents-project-workflow.integration.mjs`
- `test/pi-subagents-045-workflow.integration.mjs`
- `test/pi-subagents-browser-adapter.test.mjs`
- `test/subagent-session-browser.test.mjs`
- `test/deterministic-provider.test.mjs`
- `test/subagent-native-conversation.test.mjs`
- `test/extension-reload-boundary.test.mjs`
- `test/interactive-stderr-guard.test.mjs`

**接口：**
- 消费：Tasks 1–3 的已通过测试、`PI_TEST_CODING_AGENT_ROOT`、`PI_REAL_BIN`。
- 产出：
  - `SUPPORTED_PI_VERSIONS` 包含精确 `0.84.2`。
  - `init-pi.sh` 默认安装精确 `0.84.2`。
  - 所有宿主相关测试可绑定显式候选 package root，不依赖 Homebrew 路径。

**验收：**
- Doctor/compat 接受 `0.84.2`，仍拒绝 `0.84.3`。
- `grep` 不再在 active tests 中发现硬编码 coding-agent Homebrew root。
- 新鲜隔离 `0.84.2` 下 `npm test`、Doctor、RPC、subagent complete/Supervisor 全部通过。
- 当前全局 Pi 在 Task 5 前保持 `0.84.1`。

- [ ] **Step 1：更新剩余测试到共享 runtime loader**

将下列测试的 coding-agent/Jiti/TUI/AI 静态绝对路径替换为 `loadPiTestRuntime(import.meta.url)` 返回值：

```text
test/pi-subagents-browser-adapter.test.mjs
test/subagent-session-browser.test.mjs
test/deterministic-provider.test.mjs
test/subagent-native-conversation.test.mjs
test/extension-reload-boundary.test.mjs
test/interactive-stderr-guard.test.mjs
```

`test/pi-runtime.integration.mjs` 的 `piPackage` 和 `piTypes` 从 `resolvePiCodingAgentRoot()` 拼接；真实二进制仍只接受显式 `PI_REAL_BIN`。

- [ ] **Step 2：写版本策略 RED**

把测试预期更新为：

```js
const supported = ["0.82.0", "0.82.1", "0.83.0", "0.84.1", "0.84.2"];
assert.deepEqual(SUPPORTED_PI_VERSIONS, supported);
assert.deepEqual(
  evaluate({ ...compatibleReport, piVersion: "0.84.3" }).failures,
  ["unsupported Pi version: 0.84.3"],
);
```

`test/doctor.test.mjs` 接受 `0.84.2` 并精确拒绝 `0.84.3`。`test/init-pi.test.mjs` 期望：

```text
@earendil-works/pi-coding-agent@0.84.2
```

三个 integration 文件中的诊断改成“explicitly supported Pi host”，不得硬编码 `0.84.1 host`。

- [ ] **Step 3：运行策略测试确认 RED**

运行：

```bash
node --test \
  test/pi-subagents-compat.test.mjs \
  test/doctor.test.mjs \
  test/init-pi.test.mjs
```

预期旧 allowlist 和 `PI_VERSION="0.84.1"` 导致失败。

- [ ] **Step 4：更新准入、初始化与 README**

在 `scripts/probes/pi-subagents-compat.mjs` 和 `scripts/doctor.mjs` 把精确数组更新为：

```js
["0.82.0", "0.82.1", "0.83.0", "0.84.1", "0.84.2"]
```

在 `init-pi.sh` 更新：

```bash
PI_VERSION="0.84.2"
```

README 必须写明：

1. 默认 Pi 为 `0.84.2`，`pi-subagents@0.45.2`、`typebox@1.1.38` 不变。
2. fullscreen 由 Pi 官方拥有，shell 不再发送 1049。
3. `pi-inline`/`pi-full` 是官方 mode 别名。
4. child browser 使用 focused overlay；官方 `Ctrl+Shift+F` 搜索 parent primary transcript。
5. compact renderer 是薄适配；由于它注册同名 extension tools，不使用 `defaultTools`，严格集合改用官方 `--tools`。
6. 回滚到 `0.84.1` 的精确命令。

- [ ] **Step 5：安装全新隔离候选**

使用系统临时目录，不改全局安装：

```bash
CANDIDATE_PREFIX="$(mktemp -d "${TMPDIR:-/tmp}/pi-0842.XXXXXX")"
npm install --prefix "$CANDIDATE_PREFIX" --ignore-scripts --no-audit --no-fund \
  --registry=https://registry.npmjs.org \
  @earendil-works/pi-coding-agent@0.84.2
CANDIDATE_ROOT="$CANDIDATE_PREFIX/node_modules/@earendil-works/pi-coding-agent"
CANDIDATE_PI="$CANDIDATE_ROOT/dist/cli.js"
node "$CANDIDATE_PI" --version
```

预期精确输出 `0.84.2`。不得读取 npm credential 文件；registry 只在本命令参数中覆盖。

- [ ] **Step 6：运行候选全量与真实集成**

运行：

```bash
PI_TEST_CODING_AGENT_ROOT="$CANDIDATE_ROOT" npm test
PI_TEST_CODING_AGENT_ROOT="$CANDIDATE_ROOT" PI_REAL_BIN="$CANDIDATE_PI" npm run doctor
PI_TEST_CODING_AGENT_ROOT="$CANDIDATE_ROOT" PI_REAL_BIN="$CANDIDATE_PI" npm run test:integration
PI_TEST_CODING_AGENT_ROOT="$CANDIDATE_ROOT" PI_REAL_BIN="$CANDIDATE_PI" npm run test:subagents
PI_TEST_CODING_AGENT_ROOT="$CANDIDATE_ROOT" PI_REAL_BIN="$CANDIDATE_PI" \
  node --test test/pi-subagents-project-workflow.integration.mjs
```

预期全部通过，且真实 subagent 场景继续证明 workflow root/leaf 区分、Root Broker、completion、Supervisor 和无 fanout。

- [ ] **Step 7：执行静态候选绑定检查**

运行：

```bash
grep -R "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent" \
  test --include='*.mjs'
git diff --check
```

预期第一条无输出，第二条通过。使用 Node `fs.rm()` 仅删除本 Task 创建的 `CANDIDATE_PREFIX`；不得清理仓库或任何 worktree。

- [ ] **Step 8：提交准入与候选测试迁移**

加载 `git-commit-convention`，只暂存本 Task 列出的路径，创建独立提交；不得暂存 `pi/auth.json`、`pi/npm/**`、`.state/**` 或审计 artifact。

---

### Task 5：全量验收、外部审查与全局升级

**Deps:** Task 4（依赖产物：新鲜 0.84.2 候选的全量、Doctor、RPC、subagent 证据）

**写入路径：**
- `docs/bugs/bug-pi-0842-official-surface-compatibility-gaps.md`（只追加验证结果）
- `docs/superpowers/plans/2026-08-17-pi-0842-official-fullscreen-compatibility.md`（只勾选执行状态）
- 全局 npm 安装位置中的 `@earendil-works/pi-coding-agent`

**接口：**
- 消费：Tasks 1–4 的提交、候选测试输出、T0 的共享只读候选和真实终端人工检查。
- 产出：全局 `pi --version=0.84.2`、完整验收记录和精确回滚路径。

**验收：**
- 全局安装后重复候选全部测试，无新增失败。
- 真实 fullscreen 中 shell 恢复、child 浏览、官方 search、分页、滚轮、主题切换均通过。
- 外部审查没有未解决的 Critical/Important；同一 diff 最多两轮。
- staged diff 不含认证、Goal、`.state/**`、`pi/npm/**` 或其他用户数据。

- [ ] **Step 1：做真实 fullscreen 人工验收（共享候选二进制）**

先固定并检查 T0 的共享只读候选：

```bash
CANDIDATE_PI="$PWD/var/test-runtimes/pi-0.84.2/node_modules/@earendil-works/pi-coding-agent/dist/cli.js"
node "$CANDIDATE_PI" --version
```

预期输出 `0.84.2`。通过 `PI_REAL_BIN="$CANDIDATE_PI"` 使用 `scripts/pi-shell.zsh` 开启新鲜 TUI session，逐项确认：

1. bare `pi` 只进入一次官方 fullscreen；启动前 shell 内容不可见。
2. 退出后恢复 shell，并只打印 resume hint；没有完整 transcript 泄漏到主屏。
3. 启动 async child，按 `Alt+O` 进入 child；左右、上下、`j/k`、PageUp/PageDown、Home/End、滚轮和 `x` 正常，footer 位置同步。
4. child active 时按 `Ctrl+Shift+F`，搜索框可输入；`Escape` 关闭搜索后返回 child overlay。搜索结果属于 parent primary transcript，符合文档。
5. `/settings` 在 light/dark 间切换，已缓存 child transcript 颜色随 invalidate 更新。
6. `pi-inline` 使用 regular TUI；`pi-full` 使用官方 fullscreen；两者都没有 shell 1049 输出。

任何一项失败都停止全局升级，按 TDD 回到对应 Task 修复，不在验收步骤直接改代码。

- [ ] **Step 2：运行安全筛选后的外部审查 Round 1**

加载 `external-llm-review`。创建只包含 Tasks 0–4 已列源码、测试和文档的 sanitized review 输入，排除：

```text
pi/settings.json 中与 tuiMode/fullscreenExitOutput 无关的字段
pi/auth.json
pi/npm/**
.state/**
.pi-subagents/**
var/**
```

重点审查：shell 单 owner、overlay focus 恢复、unknown input、reload cleanup、theme cache、wheel parser、tool metadata 展开和候选路径解析。外部结论必须逐项与本地证据比对，不得直接采信严重度。

- [ ] **Step 3：如有真实阻断问题，最多修复并复审一次**

只有 Round 1 发现有证据的 Critical/Important 时，新增 RED、执行最小修复、重跑对应 Task 和全量候选回归，再执行 Round 2。Round 2 后不默认运行第三轮。

- [ ] **Step 4：全局安装精确 0.84.2**

记录升级前版本后执行：

```bash
pi --version
npm install -g --ignore-scripts --registry=https://registry.npmjs.org \
  @earendil-works/pi-coding-agent@0.84.2
pi --version
npm ls -g --depth=0 @earendil-works/pi-coding-agent
```

预期后两项都报告 `0.84.2`。不得运行会改写用户 package 配置的 `pi install`。

- [ ] **Step 5：在全局新宿主上重复最终回归**

运行：

```bash
npm test
PI_REAL_BIN="$(command -v pi)" npm run doctor
PI_REAL_BIN="$(command -v pi)" npm run test:integration
PI_REAL_BIN="$(command -v pi)" npm run test:subagents
node --test test/pi-shell.test.mjs test/custom-footer-fullscreen.integration.test.mjs
```

预期全部通过。随后重新开启 Pi session，重复 Step 1 的启动、child、search 和退出最小 smoke。

- [ ] **Step 6：失败时精确回滚**

只要全局新宿主出现候选阶段未出现的新失败，执行：

```bash
npm install -g --ignore-scripts --registry=https://registry.npmjs.org \
  @earendil-works/pi-coding-agent@0.84.1
pi --version
```

预期输出 `0.84.1`；停止交付并保留失败证据，不通过放宽测试或版本门禁宣称成功。

- [ ] **Step 7：记录验证并交付**

在 bug 文档追加：候选路径、全局版本、自动测试数量、真实 TUI 六项结果、外部审查结论和是否发生回滚。运行：

```bash
git status --short
git diff --check
git diff --cached --check
```

仅提交计划内精确文件。最终报告明确：哪些逻辑已删除并交给官方、哪些 custom logic 因官方不足继续保留、`defaultTools` 限制和回滚命令。

---

### Task 6：将 Subagent 启动显示收敛为单行摘要

**Deps:** Task 5（依赖产物：已全局安装并通过真实 TUI 验收的 Pi 0.84.2，以及升级前后的 Subagent tool renderer 基线）

**写入路径：**
- `docs/bugs/bug-subagent-spawn-result-is-verbose.md`
- `scripts/lib/subagent-dispatch/compact-rendering.ts`
- `scripts/lib/subagent-dispatch/extension.ts`
- `pi/extensions/subagent-runtime.ts`
- `test/subagent-compact-rendering.test.mjs`
- `test/subagent-runtime-membrane.test.mjs`

**接口：**
- 消费：spawn 成功 `result.details.agent/title/runId`、tool renderer 的 `context.args/state`、现有 `formatCompactSubagentToolResult()`。
- 产出：
  - `formatCompactSubagentSpawnSummary(result): string | undefined`
  - renderer state key `subagentSpawnSummary`
  - TUI 单行：`* subagent started <agent>: <title>`
- 保持：execute 返回的完整 content/details、`ASYNC_SPAWN_GUIDANCE`、runId、workspace 信息、RPC、session 和 completion notification 原样不变。

**验收：**
- coding 与 generic spawn 成功后，折叠显示精确为一行，不出现 runId 或固定调度提示。
- 原始 tool result 仍含完整 `Started ... (runId). Completion notifications ...` 和结构化 details，供模型、RPC、日志和诊断使用。
- spawn error 显示 `* subagent failed <agent>: <title>`；status/control action 保持既有摘要或原始文本。
- grouped completion、Footer、title registry、Root Broker 和 Goal binding 不受影响。

- [ ] **Step 1：先创建中文 bug 文档**

创建 `docs/bugs/bug-subagent-spawn-result-is-verbose.md`：

```markdown
# Bug：Subagent 启动结果在 TUI 重复显示调度细节

## 一句话描述
Subagent spawn 成功后，TUI 同时显示工具名、runId 和固定调度提示，常规阅读只需要 agent、title 与 started 状态。

## 复现流程
1. 派发任意 executor 或 generic subagent。
2. 观察工具结果显示 `Started <agent>: <title> (<runId>). Completion notifications ...`。
3. 确认 runId 与调度提示已存在于 details、tool result 和系统调度合同，不需要在默认 TUI 重复展开。

## 修复方案
只在项目自有 tool renderer 中用结构化 details 生成 `* subagent started <agent>: <title>`；原始 content/details、RPC、session 和生命周期消息保持不变。
```

- [ ] **Step 2：写纯格式化与数据不变 RED**

在 `test/subagent-compact-rendering.test.mjs` 增加：

```js
const result = {
  content: [{
    type: "text",
    text: "Started executor: 迁移 Shell 到官方 fullscreen (run-123). Completion notifications arrive automatically; do not sleep, poll status, or call supervisor pending. If no independent work remains, end the turn.",
  }],
  details: {
    runId: "run-123",
    asyncDir: "/tmp/run-123",
    agent: "executor",
    title: "迁移 Shell 到官方 fullscreen",
  },
};
const before = structuredClone(result);
assert.equal(
  formatCompactSubagentSpawnSummary(result),
  "* subagent started executor: 迁移 Shell 到官方 fullscreen",
);
assert.deepEqual(result, before);
```

再覆盖 generic reviewer、缺少合法 agent/title 返回 `undefined`、`isError:true` 返回 failed 摘要；title 中的换行和控制字符必须在生产 identity 校验边界已被拒绝，formatter 不从 content 正则猜 identity。

- [ ] **Step 3：写 tool renderer state RED**

在 `test/subagent-runtime-membrane.test.mjs` 固定两层行为：

1. execute 返回值仍精确等于当前完整文本：

```js
assert.equal(
  result.content[0].text,
  "Started executor: Install the typed subagent runtime (leaf-run-1). Completion notifications arrive automatically; do not sleep, poll status, or call supervisor pending. If no independent work remains, end the turn.",
);
```

2. renderer 调用 `renderResult(result, { expanded:false }, theme, context)` 后把 `context.state.subagentSpawnSummary` 写为：

```text
* subagent started executor: Install the typed subagent runtime
```

`renderCall(args, theme, context)` 随后只返回这一行；`renderResult` 自身返回空 `Text`，避免旧的工具标题行与结果行重复。expanded 模式也保持单行，完整诊断从 tool details/raw result 读取。

- [ ] **Step 4：运行测试确认 RED**

运行：

```bash
node --test \
  test/subagent-compact-rendering.test.mjs \
  test/subagent-runtime-membrane.test.mjs
```

预期因 formatter、call renderer 和 state wiring 尚不存在而失败；不得修改 execute 文本来取得 GREEN。

- [ ] **Step 5：实现纯 formatter**

在 `scripts/lib/subagent-dispatch/compact-rendering.ts` 增加：

```ts
export function formatCompactSubagentSpawnSummary(result: unknown): string | undefined {
  const value = record(result);
  const details = record(value?.details);
  const agent = typeof details?.agent === "string" ? details.agent.trim() : "";
  const title = typeof details?.title === "string" ? details.title.trim() : "";
  if (!agent || !title) return undefined;
  return `* subagent ${value?.isError === true ? "failed" : "started"} ${agent}: ${title}`;
}
```

只读取结构化 details；不读取 content 推断 agent/title，不删除或改写输入对象。

- [ ] **Step 6：接入 call/result renderer state**

在 `scripts/lib/subagent-dispatch/extension.ts` 为项目自有 `subagent` tool 增加可选 `renderSubagentCall`，与现有 `renderSubagentResult` 一起透传；不授予 upstream tool 注册能力，不改变 `rpcResult()` 或 execute 返回值。

在 `pi/extensions/subagent-runtime.ts`：

1. 定义常量 state key `subagentSpawnSummary`。
2. spawn 的 `renderResult` 从 formatter 得到摘要后写入 `context.state`，返回 `new Text("", 0, 0)`。
3. spawn 的 `renderCall` 读取 state；有摘要时返回单行 `Text`，尚未完成时显示 `* subagent starting <agent>: <title>`。
4. `args.action === "status"` 继续使用 `Status: <state>`；steer/interrupt/stop 等 control action 保持现有原始 result，不写 spawn state。
5. isError 且存在结构化 details 时显示 failed；没有合法 details 时回退现有 error renderer。

不得在 renderer 中移除 `ASYNC_SPAWN_GUIDANCE`，因为该提示仍是模型可见调度合同；只是不在默认 TUI 重复展示。

- [ ] **Step 7：运行 GREEN 与扩大回归**

运行：

```bash
node --test \
  test/subagent-compact-rendering.test.mjs \
  test/subagent-runtime-membrane.test.mjs \
  test/subagent-title-registry.test.mjs \
  test/subagent-workflow-spawn.test.mjs \
  test/pi-subagents-compat.test.mjs \
  test/custom-footer-subagents.test.mjs
PI_REAL_BIN="$(command -v pi)" npm run test:subagents
```

预期全部通过；真实 RPC result 仍含 runId/guidance，TUI renderer snapshot 为单行摘要。

- [ ] **Step 8：真实 TUI 验收并提交**

reload 后分别派发 executor 和 generic delegate，确认默认显示：

```text
* subagent started executor: 迁移 Shell 到官方 fullscreen
* subagent started delegate: 审查兼容性报告
```

确认 completion 仍使用现有 `✓ title · completed`，status 仍为 `Status: running`，Footer title/child browser 不变。加载 `git-commit-convention`，只暂存本 Task 六个路径并独立提交。

---

## 自检

- **范围覆盖：** T1 删除 shell 备用屏幕并使用官方 mode；T2 使用官方 focused overlay/component input 并修复 search、分页、wheel、theme cache；T3 保留必要 compact UX 但完整继承官方 tool contract；T4 完成候选路径、版本准入和隔离全量；T5 完成真实 TUI、审查、全局升级和回滚；T6 在升级完成后单独收敛 Subagent 启动显示。
- **官方优先：** 备用屏幕、退出输出、overlay focus、快捷键入口、primary search 和 tool factories 全部使用官方能力；只保留 child roster/transcript、应用内位置、overlay-specific navigation/wheel 与 compact display。
- **依赖合理性：** T1/T2/T3 只依赖 T0 的具体 bug/loader 产物并可并发；版本准入不早于三项兼容修复；全局安装不早于隔离候选完整证据。
- **写入热点：** Wave 1 三个任务无共同写入路径；README、version allowlist 和剩余测试路径统一由 T4 集成，避免并行语义合并。
- **类型一致：** `loadPiTestRuntime`、`SubagentTranscriptViewport.refresh/invalidate/handleInput`、`parseSgrWheelDirection`、官方 tool spread 与后续测试中的名称一致。
- **安全边界：** 不读凭据、不改 Goal、不操作 raw worktree、不把用户配置或会话 artifact 发给外部 reviewer。
- **非目标：** 不新增 child search、不让 physical terminal scrollback 归 child、不迁移 pi-subagents/typebox、不修改 provider/model/Goal 行为；T6 不改变 Subagent 原始 content/details、RPC、session 或 lifecycle。
