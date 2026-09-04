# Pi Subagents Enhanced 独立包实现计划

> **给执行 agent：** 必须逐任务执行本计划；步骤使用 `- [ ]` 复选框跟踪。执行方式由计划完成后的用户选择决定。

**目标：** 将项目自有的 `subagent` tool/runtime 与全部 subagent TUI 定制迁入可独立打包的 `pi-subagents-enhanced` Pi package，本地通过 source path 直接加载，普通源码修改只需 `/reload`，不需要发布或重新安装。

**架构：** 本仓作为 monorepo，根 `pi-config` 继续保持 private，新增可独立发行的 `packages/pi-subagents-enhanced/` 子包，不新建 GitHub 仓库。新 package 明确强依赖并封装 `pi-subagents@0.62.0`，不建设通用 TUI adapter 框架；package 内拥有 typed subagent facade、Root broker、managed workspace、completion/supervisor、title/presentation、footer/browser/transcript 等完整闭包，Goal Engine 和通用 compact-tools extension 留在原领域，原共享路径以薄 re-export 保持现有调用方兼容。

**技术栈：** Node.js 22.19+、TypeScript/Jiti、Pi 0.84.4 extension API、`pi-subagents@0.62.0`、`@earendil-works/pi-tui`、Node test runner、npm Pi package manifest。

## 全局约束

- package 名固定为 `pi-subagents-enhanced`，初始版本固定为 `0.1.0`。
- 发行源码固定保存在当前 `pi-config` 仓库的 `packages/pi-subagents-enhanced/`；不得为该 package 新建独立 GitHub 仓库。
- 根 `package.json` 保持 `private: true`，只增加通过 `npm --prefix packages/pi-subagents-enhanced ...` 调用子包的脚本；子包拥有自己的 `package-lock.json` 和 package-local `node_modules`，本轮不启用 npm workspaces，避免 `bundleDependencies` 被 hoist 后破坏发行闭包。
- npm 发行从 `packages/pi-subagents-enhanced/` 子目录产生；Pi 的 git package source 按仓库根加载，当前计划不把 monorepo 根伪装成该子包，也不承诺 `git:` source 可选择子目录。
- upstream 依赖固定为 `pi-subagents@0.62.0`；所有 `pi-subagents/src/*` 深层 import 必须集中在 `src/compat/pi-subagents-0.62.ts`。
- `@earendil-works/pi-coding-agent`、`@earendil-works/pi-tui`、`@earendil-works/pi-ai`、`@earendil-works/pi-agent-core`、`typebox` 只能作为 `peerDependencies: "*"`，不得打入 package；`pi-subagents` 必须同时列入 `dependencies` 和 canonical `bundleDependencies`。
- 本地 Pi package source 固定为相对 `pi/settings.json` 的 `../packages/pi-subagents-enhanced`；不得同时启用 standalone `npm:pi-subagents@0.62.0`。
- 所有面向用户的精简、折叠、摘要、截断和换行只能发生在 TUI renderer 层。不得为改善 TUI 展示而改写 agent 实际收到的消息、tool result、event payload、session 内容或其结构化 details；TUI renderer 必须消费原始数据并生成独立的显示文本。
- typed subagent schema、异步通知、Root broker、managed worktree、Goal executor 协调、title、footer/browser 与当前通过测试的行为必须保持不变。
- Goal Engine extension、scheduler、provider、安全门禁、`read/bash/edit/write` 等通用 compact-tools extension 本轮不迁入新 package。
- child transcript 必须复用当前 Pi tool definitions 上的 renderer，不得把 `scripts/lib/compact-tools-renderer.mjs` 复制或迁入 subagent package。
- 原共享 runtime 文件允许变为只做 `export * from ...` 的兼容入口；不得保留两份可独立演进的实现。
- `pi/settings.json.enabledModels` 和 `pi/models.json` 均不得修改；`pi/settings.json` 只允许修改 `packages` 中的 subagent source。
- 不创建 commit，不执行 publish，不使用 raw `git worktree` 命令，不清理用户现有脏工作区。

## 目标文件结构

```text
packages/pi-subagents-enhanced/
├── AGENTS.md
├── README.md
├── package.json
├── package-lock.json
├── child-extensions/
│   ├── acceptance-evidence.ts
│   └── root-session-owner.ts
├── extensions/
│   ├── custom-footer.ts
│   └── subagent-runtime.ts
├── scripts/
│   ├── setup-runtime-deps.mjs
│   └── verify-package.mjs
└── src/
    ├── compat/pi-subagents-0.62.ts
    ├── goal-support/
    │   ├── contract-limits.mjs
    │   ├── repo-path.mjs
    │   ├── settlement-evidence.mjs
    │   └── workspace.mjs
    ├── subagent-dispatch/
    ├── tui/
    │   ├── browser-adapter.ts
    │   ├── compact-rendering.ts
    │   ├── footer-layout.mjs
    │   ├── native-conversation.ts
    │   ├── session-browser.ts
    │   └── session-viewport.ts
    └── worktree-lifecycle/
        ├── inventory.mjs
        ├── managed-worktree.mjs
        └── registry.mjs
```

## DAG

```text
T1（package 契约与依赖准备）
 |
 v
T2（runtime 闭包迁移）
 |
 v
T3（TUI 闭包迁移）
 |
 v
T4（本地 source 激活与初始化）
 |
 v
T5（发行闭包与全量验收）
```

## Waves

- Wave 1：T1
- Wave 2：T2
- Wave 3：T3（等待 T2 产出的 title/presentation/runtime 路径）
- Wave 4：T4（等待 T2 的 runtime entry 与 T3 的 footer entry）
- Wave 5：T5（等待本地 source 已成为唯一生产入口）

**关键路径：** T1 → T2 → T3 → T4 → T5。T2 与 T3 都需要修改现有 runtime/TUI 交叉测试，串行执行可避免同一测试文件的并发写入和中间 import 断裂。

---

### Task 1：建立可发行 package 契约与 pinned upstream 兼容层

**Deps：** `none`

**WritePaths：**
- `package.json`
- `packages/pi-subagents-enhanced/AGENTS.md`
- `packages/pi-subagents-enhanced/README.md`
- `packages/pi-subagents-enhanced/package.json`
- `packages/pi-subagents-enhanced/package-lock.json`
- `packages/pi-subagents-enhanced/scripts/setup-runtime-deps.mjs`
- `packages/pi-subagents-enhanced/scripts/verify-package.mjs`
- `packages/pi-subagents-enhanced/src/compat/pi-subagents-0.62.ts`
- `test/pi-subagents-enhanced-package.test.mjs`

**Resources：** npm registry；依赖安装串行执行，禁止与 T2/T3 同时改写 package `node_modules`。

**Files：**
- Modify：根 `package.json`，只增加 `test:subagents-enhanced`、`setup:subagents-enhanced`、`verify:subagents-enhanced` 的 `npm --prefix` 脚本
- Create：`packages/pi-subagents-enhanced/package.json`
- Create：`packages/pi-subagents-enhanced/package-lock.json`
- Create：`packages/pi-subagents-enhanced/AGENTS.md`
- Create：`packages/pi-subagents-enhanced/README.md`
- Create：`packages/pi-subagents-enhanced/scripts/setup-runtime-deps.mjs`
- Create：`packages/pi-subagents-enhanced/scripts/verify-package.mjs`
- Create：`packages/pi-subagents-enhanced/src/compat/pi-subagents-0.62.ts`
- Create：`test/pi-subagents-enhanced-package.test.mjs`

**接口契约：**
- Consumes：Pi package local-path 规则；当前 `scripts/lib/subagent-dispatch/ordered-models-runtime-patch.mjs` 的 `applyOrderedModelsRuntimePatch()` 与 `verifyOrderedModelsRuntimePatch()` 行为。
- Produces：`pi-subagents-enhanced/package.json` 的明确 `pi.extensions` 清单；`src/compat/pi-subagents-0.62.ts` 统一导出 `upstreamSubagentRuntime`、`loadConfig`、`registerSubagentNotify`、`resolveCurrentSessionId`、`currentCompletionOwnerId`、`getArtifactsDir`、`readFleetTranscript`、`renderFleetTranscript`；`npm run setup:runtime` 安装并修补精确版本；`npm run verify:package` 验证版本、patch 与 package 闭包。

**验收标准：** package 能独立安装精确 upstream 依赖，所有 upstream internal import 只有一个兼容入口，package manifest 不自动发现 upstream 自带的 Pi resources。

- [x] **步骤 1：编写失败测试**

在 `test/pi-subagents-enhanced-package.test.mjs` 运行 package 的 setup/verify 入口并通过 Jiti import compat 模块，断言精确版本、所需导出和 manifest extension 清单；测试必须因 package 不存在或兼容入口不存在而失败。

- [x] **步骤 2：运行测试确认 RED**

运行：`node --test test/pi-subagents-enhanced-package.test.mjs`

预期：FAIL，错误明确指向缺少 `packages/pi-subagents-enhanced/package.json`、setup 入口或 compat exports，而不是 fixture/网络错误。

- [x] **步骤 3：创建最小 package scaffold**

`package.json` 使用如下核心形状，不设置 `private: true`：

```json
{
  "name": "pi-subagents-enhanced",
  "version": "0.1.0",
  "type": "module",
  "engines": { "node": ">=22.19.0" },
  "keywords": ["pi-package"],
  "files": ["AGENTS.md", "README.md", "extensions", "child-extensions", "src"],
  "pi": {
    "extensions": ["./extensions/subagent-runtime.ts", "./extensions/custom-footer.ts"]
  },
  "dependencies": { "pi-subagents": "0.62.0" },
  "bundleDependencies": ["pi-subagents"],
  "peerDependencies": {
    "@earendil-works/pi-ai": "*",
    "@earendil-works/pi-agent-core": "*",
    "@earendil-works/pi-coding-agent": "*",
    "@earendil-works/pi-tui": "*",
    "typebox": "*"
  }
}
```

setup 脚本必须安装 `pi-subagents@0.62.0` 后调用 ordered-models patch；verify 脚本必须拒绝版本漂移、patch 缺失和 manifest 指向 package 外部路径。`AGENTS.md` 原样包含 TUI 精简边界，并声明不得直接扩散新的 `pi-subagents/src/*` import。

- [x] **步骤 4：安装依赖并生成 lockfile**

运行：`npm run setup:subagents-enhanced`

该根脚本内部先执行 `npm install --prefix packages/pi-subagents-enhanced --ignore-scripts`，再执行 `npm --prefix packages/pi-subagents-enhanced run setup:runtime`。

预期：生成 package-local `package-lock.json`，`node_modules/pi-subagents/package.json` 为 `0.62.0`，ordered-models patch 验证通过。

- [x] **步骤 5：运行测试确认 GREEN**

运行：`node --test test/pi-subagents-enhanced-package.test.mjs`

预期：PASS，且 compat 测试从 package 自己的 `node_modules` 加载 upstream，不访问 `pi/npm/node_modules/pi-subagents`。

### Task 2：迁移 typed subagent runtime 与 managed workspace 完整依赖闭包

**Deps：** `T1`（理由：消费 package manifest、compat exports 和 package-local upstream 依赖）

**WritePaths：**
- `packages/pi-subagents-enhanced/extensions/subagent-runtime.ts`
- `packages/pi-subagents-enhanced/child-extensions/**`
- `packages/pi-subagents-enhanced/src/subagent-dispatch/**`
- `packages/pi-subagents-enhanced/src/goal-support/**`
- `packages/pi-subagents-enhanced/src/worktree-lifecycle/**`
- `scripts/lib/subagent-dispatch/**`
- `scripts/lib/goal-engine/contract-limits.mjs`
- `scripts/lib/goal-engine/repo-path.mjs`
- `scripts/lib/goal-engine/settlement-evidence.mjs`
- `scripts/lib/goal-engine/workspace.mjs`
- `scripts/lib/worktree-lifecycle/inventory.mjs`
- `scripts/lib/worktree-lifecycle/managed-worktree.mjs`
- `scripts/lib/worktree-lifecycle/registry.mjs`
- `pi/child-extensions/acceptance-evidence.ts`
- `pi/child-extensions/root-session-owner.ts`
- Executor child extension 直接使用 package 绝对路径，不再物化 workspace runtime entry。
- `test/goal-engine-executor-binding.integration.mjs`
- `test/goal-subagent-dispatch-parity.test.mjs`
- `test/goal-runtime-real-canary.integration.mjs`
- `test/pi-subagents-project-workflow.integration.mjs`
- `test/process-birth-identity.test.mjs`
- `test/root-subagent-broker-protocol.test.mjs`
- `test/root-subagent-broker-r10b-suspension.integration.mjs`
- `test/root-subagent-broker.test.mjs`
- `test/subagent-acceptance-evidence.integration.mjs`
- `test/subagent-dispatch-extension.test.ts`
- `test/subagent-dispatch-ir-coercion.test.mjs`
- `test/subagent-dispatch-ir.test.mjs`
- `test/subagent-dispatch-rpc.test.mjs`
- `test/subagent-dispatch-schema-coercion.test.mjs`
- `test/subagent-dispatch-validation-errors.test.mjs`
- `test/subagent-dispatch-workspace.integration.mjs`
- `test/subagent-managed-worktree-facade.test.mjs`
- `test/subagent-managed-worktree.integration.mjs`
- `test/subagent-model-tier.test.mjs`
- `test/subagent-runtime-membrane.test.mjs`
- `test/subagent-runtime-production-shutdown.test.mjs`
- `test/subagent-runtime-root-broker-startup.integration.mjs`
- `test/subagent-runtime-root-upstream.test.mjs`
- `test/subagent-supervisor-adapter.test.mjs`
- `test/subagent-workflow-spawn.test.mjs`
- `test/subagent-workspace-controller.integration.mjs`
- `test/subagent-workspace-ledger.integration.mjs`
- `test/fixtures/root-broker-registry-probe.ts`
- `test/fixtures/root-session-owner-child.ts`

**Resources：** Git fixture tests；涉及 managed worktree 的测试串行运行，禁止执行 raw worktree lifecycle 命令。

**Files：**
- Create：`packages/pi-subagents-enhanced/extensions/subagent-runtime.ts`
- Move：`scripts/lib/subagent-dispatch/*` → `packages/pi-subagents-enhanced/src/subagent-dispatch/*`
- Move：`pi/child-extensions/{root-session-owner,acceptance-evidence}.ts` → `packages/pi-subagents-enhanced/child-extensions/`
- Move：`scripts/lib/worktree-lifecycle/{inventory,managed-worktree,registry}.mjs` → `packages/pi-subagents-enhanced/src/worktree-lifecycle/`
- Move：`scripts/lib/goal-engine/{contract-limits,repo-path,settlement-evidence,workspace}.mjs` → `packages/pi-subagents-enhanced/src/goal-support/`
- Modify：原 `scripts/lib/...` 路径为薄 re-export compatibility entries
- Test：上述 subagent、Root broker、workspace 和 Goal/subagent parity 测试

**接口契约：**
- Consumes：T1 的 compat exports 与 package-local patched upstream。
- Produces：package-local `installHeadlessTypedSubagentRuntime()`、`createTypedSubagentExtension()`、Root broker、workspace controller、child extensions；原 repo import 路径 re-export 同一实现，不复制逻辑。

**验收标准：** `subagent` tool 的 schema、spawn/control/workspace、completion owner、Root broker 和 Goal-bound acceptance evidence 行为与迁移前一致；从临时目录只复制 package 内容后，runtime 模块仍可解析全部相对 import。

- [x] **步骤 1：编写失败的 package-closure runtime 测试**

新增测试从 `packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts` 创建真实 typed tool，执行一个受控 RPC spawn，并从 package child extension 路径验证 Root owner/evidence 可加载；测试必须因 package runtime 尚不存在而 RED。

- [x] **步骤 2：运行测试确认 RED**

运行：`node --test test/subagent-runtime-membrane.test.mjs test/subagent-dispatch-extension.test.ts test/subagent-acceptance-evidence.integration.mjs`

预期：FAIL，缺少 package runtime import；既有行为测试本身不得被削弱。

- [x] **步骤 3：移动 runtime 与共享闭包并修正内部 import**

package 内所有 import 必须保持在 package 根内或指向 Node/core peer/upstream compat。原路径只允许如下形式的兼容导出，不得复制实现：

```js
export * from "../../../packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts";
```

`subagent-runtime.ts` 只能从 `src/compat/pi-subagents-0.62.ts` 获取 upstream 内部 API。child extension URL 必须指向 package 自己的 `child-extensions/`。

- [x] **步骤 4：运行 runtime 聚焦测试确认 GREEN**

运行：`node --test test/subagent-runtime-membrane.test.mjs test/subagent-runtime-production-shutdown.test.mjs test/subagent-runtime-root-broker-startup.integration.mjs test/subagent-dispatch-extension.test.ts test/subagent-acceptance-evidence.integration.mjs test/subagent-managed-worktree.integration.mjs test/subagent-dispatch-workspace.integration.mjs`

预期：PASS；spawn、terminal notification、Goal coordinator、workspace disposition 和 shutdown/reload 均无行为变化。

- [x] **步骤 5：运行共享调用方回归**

运行：`node --test "test/root-subagent-*.test.mjs" "test/root-subagent-*.integration.mjs" "test/goal-engine-*.integration.mjs" "test/worktree-lifecycle-*.integration.mjs"`

预期：PASS，证明 Goal Engine 与 worktree CLI 通过 compatibility entries 消费同一 package 实现。

### Task 3：迁移 subagent footer/browser/message/tool renderer，保留通用 compact-tools

**Deps：** `T2`（理由：消费 T2 已迁移的 title registry、presentation classifier、runtime renderer 注入点和稳定 package import 路径）

**WritePaths：**
- `packages/pi-subagents-enhanced/extensions/custom-footer.ts`
- `packages/pi-subagents-enhanced/src/tui/**`
- `pi/extensions/custom-footer.ts`
- `pi/extensions/lib/pi-subagents-browser-adapter.ts`
- `pi/extensions/lib/subagent-native-conversation.ts`
- `pi/extensions/lib/subagent-session-browser.ts`
- `pi/extensions/lib/subagent-session-viewport.ts`
- `scripts/lib/custom-footer-layout.mjs`
- `test/custom-footer-*.test.mjs`
- `test/pi-subagents-browser-adapter.test.mjs`
- `test/subagent-compact-rendering.test.mjs`
- `test/subagent-native-conversation.test.mjs`
- `test/subagent-presentation-status.test.mjs`
- `test/subagent-session-browser.test.mjs`
- `test/subagent-session-viewport.test.mjs`
- `test/subagent-title-registry.test.mjs`

**Resources：** terminal component rendering；无共享外部资源。

**Files：**
- Move：`pi/extensions/custom-footer.ts` → `packages/pi-subagents-enhanced/extensions/custom-footer.ts`
- Move：四个 `pi/extensions/lib/subagent-*`/browser adapter → `packages/pi-subagents-enhanced/src/tui/`
- Move：`scripts/lib/custom-footer-layout.mjs` → `packages/pi-subagents-enhanced/src/tui/footer-layout.mjs`
- Move：`scripts/lib/subagent-dispatch/compact-rendering.ts`、`presentation-status.ts`、`title-registry.ts` 到 T2 创建的 package runtime/TUI 边界内
- Delete：旧 auto-discovered `pi/extensions/custom-footer.ts` 与对应旧 lib 文件
- Test：所有 footer/browser/renderer 聚焦测试

**接口契约：**
- Consumes：T1 compat 的 transcript/artifact APIs；T2 的 title registry 与 presentation classifier 最终路径。
- Produces：两个 package extension entries；`NativeChildConversationRenderer` 接收 `resolveToolRenderer(name)`，从 `pi.getAllTools()` 读取当前 tool definition 的 `renderCall/renderResult`，不再 import generic compact renderer。

**验收标准：** footer 多 active 全量展示、title 恢复、固定 model/thinking、history、背景框、validation 精简、supervisor/steer/completion、child browser 和 transcript 行为全部保持；通用 `pi/extensions/compact-tools.ts` 与 `scripts/lib/compact-tools-renderer.mjs` 不迁移且不复制。

- [x] **步骤 1：编写失败的 package TUI 与 renderer 注入测试**

更新测试从 package 路径加载 footer/TUI；新增真实 `ToolExecutionComponent` 用例，向 native conversation 注入 parent tool definition renderer，断言 child transcript 使用同一 renderer。测试必须因 package TUI 不存在或仍静态 import root compact renderer而 RED。

- [x] **步骤 2：运行测试确认 RED**

运行：`node --test test/custom-footer-subagents.test.mjs test/subagent-native-conversation.test.mjs test/subagent-runtime-membrane.test.mjs`

预期：FAIL，原因是 package TUI/renderer resolver 尚未实现。

- [x] **步骤 3：移动 TUI 文件并实现最小 renderer resolver**

在 `session_start` 后通过闭包读取 `pi.getAllTools()`，只把当前 definition 的 `renderCall/renderResult` 交给 child transcript；没有 renderer 时使用 Pi 原生 fallback。不得改变 tool arguments、tool result、event、session 或 details。

- [x] **步骤 4：运行 TUI 聚焦测试确认 GREEN**

运行：`node --test test/custom-footer-layout.test.mjs test/custom-footer-input.integration.test.mjs test/custom-footer-fullscreen.integration.test.mjs test/custom-footer-subagents.test.mjs test/pi-subagents-browser-adapter.test.mjs test/subagent-compact-rendering.test.mjs test/subagent-native-conversation.test.mjs test/subagent-session-browser.test.mjs test/subagent-session-viewport.test.mjs`

预期：PASS；所有 display-only 输入对象均保持 `deepEqual`。

- [x] **步骤 5：验证非 subagent TUI 未迁移**

运行：`node --test test/compact-tools-renderer.test.mjs test/compact-tools-extension.test.mjs test/bash-cwd-extension.test.mjs`

预期：PASS，且这些测试继续从 `pi/extensions/compact-tools.ts`、`pi/extensions/bash-cwd.ts` 和 `scripts/lib/compact-tools-renderer.mjs` 加载。

### Task 4：以 local path package 替换 standalone upstream 安装入口

**Deps：** `T2`、`T3`（理由：settings 激活前必须同时具备 runtime 与 footer 两个可加载 entry）

**WritePaths：**
- `pi/settings.json`
- `pi/npm/package.json`
- `init-pi.sh`
- `scripts/setup-subagent-runtime-deps.mjs`
- `scripts/doctor.mjs`
- `scripts/probes/pi-subagents-compat.mjs`
- `test/init-pi.test.mjs`
- `test/setup-subagent-runtime-deps.test.mjs`
- `test/doctor.test.mjs`
- `test/pi-subagents-compat.test.mjs`
- `test/pi-subagents-runtime.integration.mjs`
- `test/subagent-ordered-models-runtime.test.mjs`
- `test/subagent-runtime-resource-isolation.test.mjs`
- `test/extension-reload-boundary.test.mjs`

**Resources：** npm registry；初始化脚本测试串行使用临时 HOME/PATH。

**Files：**
- Modify：`pi/settings.json` 仅替换 subagent package source
- Modify：`pi/npm/package.json` 移除 `pi-subagents`，保留 scheduler 等非 subagent 依赖
- Modify：`init-pi.sh`
- Modify：`scripts/setup-subagent-runtime-deps.mjs`
- Modify：Doctor/compat probe 与初始化、兼容测试
- Delete：`pi/extensions/subagent-runtime.ts`

**接口契约：**
- Consumes：T2/T3 package manifest 和 setup/verify scripts。
- Produces：唯一生产 source `{ "source": "../packages/pi-subagents-enhanced" }`；初始化只准备 package-local upstream 并验证，不再执行 `pi install npm:pi-subagents@...`；Doctor 报告 package source、版本、patch、entries 和单一所有权。

**验收标准：** `PI_CODING_AGENT_DIR=pi` 启动时只从 local package 加载一个 `subagent`、一个 `subagent_supervisor`、一个 footer owner 和两类 subagent message renderer；本地源码修改无需 package install，`/reload` 后生效。

- [x] **步骤 1：先更新行为测试并确认 RED**

测试必须通过解析实际 settings 和运行 fake init/Doctor 验证：local source 存在、standalone npm source 不存在、init 不调用 `pi install npm:pi-subagents`、依赖位于 package `node_modules`、旧 auto-discovered runtime/footer 不存在。旧实现应明确失败。

- [x] **步骤 2：运行测试确认 RED**

运行：`node --test test/init-pi.test.mjs test/setup-subagent-runtime-deps.test.mjs test/doctor.test.mjs test/subagent-runtime-resource-isolation.test.mjs`

预期：FAIL，仍观察到 standalone source、旧 extension entry 或 `pi/npm/node_modules/pi-subagents`。

- [x] **步骤 3：切换 settings 与初始化所有权**

`pi/settings.json` 将原 subagent object 替换为：

```json
{
  "source": "../packages/pi-subagents-enhanced"
}
```

保留 `subagents` 配置和其他 package 项。`init-pi.sh` 先执行 active-version preflight，再对 package 执行 `npm install --ignore-scripts` 与 `npm run setup:runtime`，最后运行 package verify；不得触碰 `enabledModels`。删除旧 auto-discovered `pi/extensions/subagent-runtime.ts`，防止重复注册。

- [x] **步骤 4：运行配置/初始化测试确认 GREEN**

运行：`node --test test/init-pi.test.mjs test/setup-subagent-runtime-deps.test.mjs test/doctor.test.mjs test/subagent-runtime-resource-isolation.test.mjs test/subagent-ordered-models-runtime.test.mjs`

预期：PASS；fake command log 中没有 standalone `pi install npm:pi-subagents`，package-local patch 与 Doctor 均通过。

- [x] **步骤 5：运行真实 local package 加载集成**

运行：`node --test test/pi-subagents-compat.test.mjs test/pi-subagents-runtime.integration.mjs test/extension-reload-boundary.test.mjs`

预期：PASS；真实 ResourceLoader 通过 settings local source 加载 package，tool/message/footer owners 不重复。

### Task 5：验证 npm 发行闭包、本地热重载边界与全量回归

**Deps：** `T4`（理由：只有生产配置切到 package 后，发行与 reload 验收才验证真实入口）

**WritePaths：**
- `packages/pi-subagents-enhanced/README.md`
- `packages/pi-subagents-enhanced/scripts/verify-package.mjs`
- `test/pi-subagents-enhanced-package.test.mjs`
- `test/pi-runtime.integration.mjs`

**Resources：** npm pack dry-run；不执行 npm publish。

**Files：**
- Modify：package README/verify script
- Modify：package closure 与真实 Pi runtime tests

**接口契约：**
- Consumes：T4 的唯一 local source 与 package 完整实现。
- Produces：从本仓 `packages/pi-subagents-enhanced/` 子目录生成的可重复 `npm pack --dry-run --json` 证据；README 中分别给出 local source 与 npm source 用法，并明确二者不得同时启用、源码与 issue 仍归属当前 monorepo。

**验收标准：** tarball 只包含 package 根内的运行文件和已 patch 的 `bundleDependencies` 条目 `pi-subagents@0.62.0`；不包含 `pi/settings.json`、models、session、日志、凭据或 repository-only tests；真实 Pi 加载、`/reload` 生命周期和全量测试通过。

- [x] **步骤 1：编写失败的发行闭包测试**

测试在 package 目录运行 `npm pack --dry-run --json`，从 JSON file list 验证两个 extension entry、child extensions、runtime/TUI closure 和 `bundleDependencies` upstream 均存在；拒绝绝对路径、`../`、`pi/settings.json`、`var/`、日志及 repository 根文件。测试必须对不完整 files/manifest RED。

- [x] **步骤 2：运行测试确认 RED**

运行：`node --test test/pi-subagents-enhanced-package.test.mjs`

预期：FAIL，指出缺失的 tarball runtime 文件或越界内容。

- [x] **步骤 3：收紧 files、verify 和 README**

verify script 必须同时检查 package import closure、精确 upstream version/patch、manifest entries 和 tarball allowlist；README 给出以下两种互斥来源：

```json
{ "source": "../packages/pi-subagents-enhanced" }
```

```text
npm:pi-subagents-enhanced@0.1.0
```

- [x] **步骤 4：运行 package 与真实 Pi 验收**

运行：`npm --prefix packages/pi-subagents-enhanced run verify:package`

运行：`npm run test:subagents-enhanced`

运行：`node --test test/pi-subagents-enhanced-package.test.mjs test/pi-runtime.integration.mjs test/pi-subagents-compat.test.mjs`

预期：PASS；不产生 tarball 文件，不访问发布凭据。

- [x] **步骤 5：运行完整回归与工作区检查**

运行：`npm test`

运行：`npm run doctor`

运行：`PI_REAL_BIN="$(command -v pi)" npm run test:integration`

运行：`git diff --check`

运行：`git diff -- pi/settings.json pi/models.json`

预期：所有测试 PASS；Doctor 只有已记录 limitation warning；`pi/settings.json` diff 只有 subagent package source，`pi/models.json` 无本任务新增 diff；没有 staged files、commit 或 publish。

## 计划自检

- 规格覆盖：subagent tool/runtime、全部 subagent TUI、local source、npm 发行闭包、upstream 精确依赖、初始化和回归均有对应任务。
- Monorepo 覆盖：根 package 保持 private，子包独立 lockfile/依赖/pack，源码和发行维护均留在当前仓库，不依赖第二个 GitHub repo。
- 占位扫描：计划不含待填充字段或未定义接口。
- 类型一致性：T1 compat exports 被 T2 runtime 和 T3 browser adapter 共同消费；T4 只在两个 extension entry 完成后激活。
- DAG 审核：T2/T3 因共享 runtime/TUI 测试和 title/presentation import 串行；T4 是唯一 settings/init 集成点；T5 只依赖真实入口完成。
- 关键边界：通用 compact-tools 不迁移；Goal Engine 通过薄 re-export 消费共享 runtime 原语，不复制实现。
