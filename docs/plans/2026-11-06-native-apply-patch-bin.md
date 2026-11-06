# 将 apply_patch 纳入 pi/bin 原生工具实现计划

> **给执行 agent：** 必须逐任务执行本计划；步骤使用 `- [ ]` 复选框跟踪。只有整体交付终态全部验证通过，才算计划执行完成。本次由当前主会话 inline 执行，不使用 subagent。

**目标：** 将 `pi/bin/apply_patch` 从 Node 明文脚本迁移为与 `pi/bin/fd`、`pi/bin/rg` 一致的原生 arm64 二进制，并让 system prompt 明确 `pi/bin` 三个工具的调用方式，退役重复的模型侧 `apply_patch` 工具注册。

**架构：** 复用现有 `src/apply-patch` 的 patch 解析和文件变更实现，增加一个仅负责 stdin、cwd、错误码和 A/M/D 输出的原生可执行入口。通过仓库现有二进制构建链或 Node SEA/本机原生打包方式生成 `pi/bin/apply_patch`，保持它作为 shell 工具由 `bash` 调用；删除模型工具注册及其 profile/TUI 专属引用，避免两个 apply_patch 入口并存。

**技术栈：** Node.js `>=22.19.0`、TypeScript、现有 `src/apply-patch` 实现、macOS arm64 原生可执行格式、Pi system prompt/profile 配置。

## 全局约束

- Node 最低版本固定为 `>=22.19.0`。
- `scripts/` 不新增 production 共享实现；复用实现归属 `src/apply-patch/`。
- 不新增测试；只运行既有测试、类型检查和二进制行为验证。
- 不修改用户已有的 dirty 工作区；本次明确保留当前 `pi/agents/delegate.md`、`pi/agents/executor.md`、`pi/agents/reviewer.md` 的既有改动。
- 不提交 commit；不读取或输出任何凭据。
- 文档、system prompt 和代码注释使用中文，专业标识符与命令保持原样。
- `pi/settings.json` 的 `enabledModels` 不得修改。

## 整体交付终态

| ID | 必须成立的条件 | 验证方法与环境 | 通过判据 | 证据位置 | 覆盖任务 |
| --- | --- | --- | --- | --- | --- |
| F1 | `pi/bin/apply_patch` 是可执行的 macOS arm64 原生二进制 | `file`, `otool -hv` 或等价只读检查 | 类型为 Mach-O arm64 executable，权限可执行，文件不再是文本脚本 | 最终命令输出与 `git diff --stat` | T1 |
| F2 | 二进制入口保留现有 patch CLI 行为 | 在临时目录通过 stdin 运行 add/update/delete、空输入和非法 patch | 成功输出 A/M/D 且文件内容正确；空输入退出 2；非法 patch 退出 1 并输出错误 | 临时目录验证输出 | T1 |
| F3 | system prompt 明确 `pi/bin/fd`、`pi/bin/rg`、`pi/bin/apply_patch` 的用途和调用方式 | 静态审阅实际生效的 system prompt/append 配置及相关 prompt 测试 | 三个工具均说明通过 `bash` 在当前 cwd 调用，且 apply_patch 使用 stdin structured patch | prompt 文件 diff 与既有测试输出 | T2 |
| F4 | 模型侧 `apply_patch` tool 入口退役，调用面不再重复注册 | `rg` 搜索注册点、profile 白名单、TUI 专属 resolver，并运行相关既有测试 | 不存在生产注册/白名单/TUI 对该旧 tool 的残留；现有其他工具行为测试通过 | `rg` 输出、测试输出 | T2 |
| F5 | 既有 apply-patch 实现与仓库类型检查保持通过 | `npm run typecheck:root` 与 apply-patch/工具相关既有测试 | 命令退出码为 0；未引入新的类型错误 | 命令输出 | T1、T2 |

**完成规则：** 所有必要终态同时满足，且验证证据对应当前交付版本，才能标记计划执行完成；仅完成文件修改不能替代终态验证。

**未满足时：** 在已授权范围内持续 `fix → test（验证）→ 对照终态`；真实阻塞记录为未完成并保留现场，不删除或覆盖无关 dirty 改动。

## DAG

```text
T1（原生 apply_patch CLI 构建与行为迁移） ──> T2（prompt 更新与旧模型 tool 退役） ──> T3（最终验证）
```

## Waves

- Wave 1：T1
- Wave 2：T2（依赖 T1 确认新的 CLI 入口和调用合同）
- Wave 3：T3（依赖 T1、T2 的最终候选）

**关键路径：** T1 → T2 → T3。

---

### Task 1：构建原生 apply_patch CLI

**Deps：** `none`

**WritePaths：**
- `pi/bin/apply_patch`
- `src/apply-patch/**`（仅在确认原入口无法被原生打包消费且需要最小入口调整时）

**Resources：** `none`

**Files：**
- Replace：`pi/bin/apply_patch`
- Modify：`src/apply-patch/**`（仅必要的入口兼容修复）

**接口契约：**
- Consumes：stdin 中完整 `*** Begin Patch ... *** End Patch` 文本；工作目录取进程 cwd。
- Produces：stdout 每个操作一行 `A <path>`、`M <path>` 或 `D <path>`；空 stdin 退出码 2；解析或应用失败退出码 1 并向 stderr 输出 `apply_patch: ...`。

**终态关联：** `F1`、`F2`、`F5`

**验收标准：** `pi/bin/apply_patch` 由可复现的仓库构建步骤生成原生 arm64 可执行文件，行为与原 Node 适配器一致；不修改 `src/apply-patch` 的 patch 语义。

- [ ] **步骤 1：核对现有二进制构建链与运行时依赖**

确认 `fd`、`rg` 的来源、架构和构建/生成记录；确认原生入口能加载当前 TypeScript 实现或确定最小可维护的打包方式。若只能依赖未入仓的本机临时工具链，停止并记录阻塞。

- [ ] **步骤 2：生成并替换 `pi/bin/apply_patch`**

保留 stdin/cwd/错误码/A-M-D 输出合同；设置可执行权限；不把 Node 明文脚本或额外 runtime 文件放入 `pi/bin`。

- [ ] **步骤 3：运行既有静态检查并记录结果**

运行：`file pi/bin/apply_patch`、`otool -hv pi/bin/apply_patch`、`npm run typecheck:root`。

记录：架构、可执行权限、类型检查 exit 和未验证限制。

- [ ] **建议（待用户授权）：新增测试或全新 fixture/压力场景**

本次不新增测试；使用临时目录和现有命令完成 CLI 行为验证。

---

### Task 2：更新 system prompt 并退役模型侧 apply_patch

**Deps：** `T1`（理由：system prompt 必须指向已经稳定的 `pi/bin/apply_patch` stdin CLI 合同）。

**WritePaths：**
- `pi/SYSTEM.qwen.md`
- `pi/SYSTEM.anthropic.md`
- `pi/AGENTS_APPEND.md`
- `pi/extensions/apply-patch.ts`
- `pi/agents/delegate.md`
- `pi/agents/executor.md`
- `src/compact-tools/index.ts`
- `src/compact-tools/renderer.ts`

**Resources：** `none`

**Files：**
- Modify：实际存在且负责生效 system prompt 的文件（以静态入口核对结果为准）
- Delete or disable：`pi/extensions/apply-patch.ts` 的模型 tool 注册入口
- Modify：delegate/executor 工具白名单、compact renderer 的 apply_patch 专属字段和相关中文注释

**接口契约：**
- Consumes：T1 的 shell CLI 合同。
- Produces：system prompt 指导模型使用 `bash` 调用 `pi/bin/fd`、`pi/bin/rg` 和 `pi/bin/apply_patch`；仓库只保留 shell CLI 作为 apply_patch 实现入口。

**终态关联：** `F3`、`F4`、`F5`

**验收标准：** prompt 清楚说明三个二进制的用途、当前工作目录和 apply_patch 的 stdin patch 用法；旧 `apply_patch` 模型 tool 不再注册、暴露或被 profile/TUI 单独维护；保留 `src/apply-patch` 作为 CLI 消费的实现模块。

- [ ] **步骤 1：核对真实生效 prompt 和引用边界**

以仓库入口和既有 prompt 注入代码为准确定修改文件；不得根据历史计划中的已删除文件新增内容。确认 `pi/bin` 说明应放在实际生效的 system prompt/append 位置。

- [ ] **步骤 2：完成最小 prompt 与退役改动**

删除重复模型 tool 注册及其白名单/TUI 维护点；把调用说明集中到 `bash` 工具使用指导中，明确示例命令和 structured patch stdin 约束。

- [ ] **步骤 3：运行相关既有检查并记录结果**

运行：`rg -n "apply_patch|pi/bin/(fd|rg|apply_patch)" pi src test`，以及与 prompt、compact tools、apply-patch 相关的现有测试集合。

记录：旧注册点无生产残留、system prompt 说明存在、既有测试 exit 和未验证限制。

- [ ] **建议（待用户授权）：新增测试或全新 fixture/压力场景**

本次不新增测试；如现有测试直接锁定旧模型 tool 暴露，应仅按新架构同步调整已有断言。

---

### Task 3：最终候选验证

**Deps：** `T1`、`T2`

**WritePaths：** `none`

**Resources：** `none`

**Files：**
- Read：最终候选文件和现有测试

**接口契约：**
- Consumes：T1 的二进制与 T2 的 prompt/注册面修改。
- Produces：对应 F1–F5 的真实命令证据。

**终态关联：** `F1`、`F2`、`F3`、`F4`、`F5`

**验收标准：** 最终候选通过二进制格式、CLI 行为、prompt 静态边界、旧注册面清理和类型/既有测试检查；当前三个 agent profile 的既有 dirty 改动不被覆盖。

- [ ] **步骤 1：执行临时目录 CLI 回归**

覆盖 add、update、delete、空输入和非法 patch，核对 stdout、stderr、exit code 与文件结果。

- [ ] **步骤 2：执行类型检查和相关既有测试**

至少运行 `npm run typecheck:root` 及 apply-patch、prompt/compact-tool 相关的既有测试；失败时按来源归类，不为 fixture 污染增加 production fallback。

- [ ] **步骤 3：核对最终 diff 和 dirty 现场边界**

运行 `git diff --check`、`git status --short` 和目标路径 diff；确认没有修改 `pi/settings.json`，且三个既有 agent profile 改动仍保留。

- [ ] **建议（待用户授权）：新增测试或全新 fixture/压力场景**

本次不新增测试。
