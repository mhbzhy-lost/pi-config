# compat "local package source" 用例期望 supervisor target 不可用却 resolve

**状态：** 已归因，修复方向待裁决；本次复核结果与计划背景事实不一致
**分类：** (3) 来源未证实
**影响面：** 当前工作树与 HEAD 干净导出在本次普通环境复核均未复现计划所述失败；`env -i` 复现了 resolve 而非 reject。不能据此判定发行包或 live 行为受影响，也没有修改 production。

## 现象

测试 `test/pi-subagents-compat.test.mjs:184` 的用例在 `:244-247` 期望 `subagent_supervisor.execute("compat-status", { action: "status" }, ...)` reject 且错误码为 `SUPERVISOR_TARGET_UNAVAILABLE`。本次普通环境工作树运行中该断言通过；在 `env -i` 下，临时 probe 观察到该调用 resolve，输出为 `PROBE_RESULT {`（完整对象未写入报告，避免输出运行身份或环境数据）。因此不能把 resolve 稳定归因于生产缺陷。

TDD 豁免：本任务是纯文档、只读诊断，不改变 production、test、config 或 live workspace；按 `skill-overrides/test-driven-development/SKILL.md` 的“纯文档变更”豁免，不适用 RED-GREEN。

## 复现

### 工作树

前置检查：

```text
pkg node_modules: OK
jiti: MISSING
```

执行三轮：

```text
for i in 1 2 3; do node --test test/pi-subagents-compat.test.mjs ...; done
```

实际结果：

```text
workspace run1 exit=0
workspace run2 exit=0
workspace run3 exit=0
```

`/tmp/t11-ws-1.log` 显示 `tests 32`, `pass 32`, `fail 0`，目标用例通过；`grep -c "Missing expected rejection" /tmp/t11-ws-1.log` 为 `0`。

### HEAD 干净导出

执行 `git archive HEAD | tar -x -C /tmp/t11-head`，并仅以仓库 `node_modules` 与 package `node_modules` 符号链接提供依赖，再运行三轮：

```text
HEAD run1 exit=0
HEAD run2 exit=0
HEAD run3 exit=0
```

目标用例及全套 32 项均通过；因此本次 HEAD 证据不支持“HEAD 同样失败”的背景事实。由于 `jiti` 前置检查缺失，HEAD/package 布局属于环境不可完全验证，不能从 PASS 推断所有安装环境均 PASS。

### 环境无关性

执行：

```text
env -i PATH="$PATH" HOME="$HOME" node --test test/pi-subagents-compat.test.mjs
```

实际结果：`env-i exit=1`；日志为 `tests 32`, `pass 31`, `fail 1`，失败位置仍为 `test/pi-subagents-compat.test.mjs:244`，错误为 `AssertionError [ERR_ASSERTION]: Missing expected rejection`。使用临时 `/tmp/t11-probe.mjs` 等价注入 probe 后，实际打印 `PROBE_RESULT {`，即 supervisor target 路径 resolve 了一个对象结果。此组不同于工作树普通环境，故不是“环境变量无关性”的正证据；它反而证明环境上下文会改变可观察结果。

测试自身仅删除五个 marker（`:185-188`）：`PI_SUBAGENT_CHILD`、`PI_SUBAGENT_FANOUT_CHILD`、`PI_SUBAGENT_PARENT_SESSION`、`PI_ROOT_SUBAGENT_BROKER_ENABLED`、`PI_CODING_WORKSPACE_DIR`，未清理 `PI_SESSION_OWNER_REGISTRY` / `PI_SESSION_OWNER_ID`。本报告不输出其值。

## 首个偏离点

适配器的不可用分支精确位于 `packages/pi-subagents-enhanced/src/subagent-dispatch/supervisor-adapter.ts:30-32`：`executeTarget` 不存在时抛出 `SUPERVISOR_TARGET_UNAVAILABLE`，否则直接调用 target 并返回其值。不存在“target 缺失时返回空结果”的生产逻辑。

本次 `env -i` probe 的首个偏离点是 target 已被绑定（而非 adapter 缺失时静默 resolve）：`runtime-membrane.ts:224-234` 的 `registerTool` 拦截 supervisor 工具，并在 `:232` 执行 `supervisorAdapter.bind(definition.execute.bind(definition))`。绑定状态由 `supervisor-adapter.ts:37-39` 的 `isBound` 可观察。普通工作树运行则在调用时仍进入 `supervisor-adapter.ts:31` 的 unavailable 分支。

## 完整调用链

1. 测试在 `test/pi-subagents-compat.test.mjs:219-223` 调用 `result.session.bindExtensions({ mode: "rpc", ... })`。
2. 扩展入口 `packages/pi-subagents-enhanced/extensions/subagent-runtime.ts:324` 调用 `installHeadlessTypedSubagentRuntime`。
3. `extension.ts:1515` 创建空的 `createSupervisorAdapter()`；`extension.ts:1599-1602` 将它注入 `createHeadlessSubagentApi`。
4. upstream bootstrap 注册工具；runtime membrane 的 `registerTool` 分支（`runtime-membrane.ts:224-234`）发现 `subagent_supervisor` 后绑定其 `definition.execute`。
5. 主扩展 `extension.ts:1394-1398` 以 controlled adapter 创建 supervisor tool，`extension.ts:1414` 注册；工具最终由 session 暴露。
6. 测试 `:242-246` 取得工具并调用 `supervisor.execute`；`extension.ts:1054` 将非 reply 操作转发至 adapter，随后 `supervisor-adapter.ts:30-32` 要么抛 unavailable，要么调用已绑定 target 并 resolve。
7. 若 session_start 在 `extension.ts:1472-1480` 观察到 adapter 仍未绑定，会停用工具并抛 `SUPERVISOR_TARGET_UNAVAILABLE`；这不是本次 resolve 路径的抛出点。

## 三分法分类与证据

### 数据来源

本次 resolve 只通过 session public API（`bindExtensions`、`getToolDefinition`、tool `execute`）观察，调用确实走到了 adapter。没有拿到可公开验证的 Host/Store receipt、target 的 canonical 身份或完整 upstream 注册事件证明；`jiti` 缺失使计划要求的安装布局验证不完整。因此该数据来源能否由合法 public/typed 入口和权威 Store 产生，尚未证实。

### 权威身份与事件顺序

已确认的局部顺序是：session bind → extension bootstrap → membrane `registerTool` → adapter bind → tool execute。未确认的部分包括绑定 target 对应哪个 Host session、是否由同一 root session 产生、session_start 与 registerTool 的相对时序，以及 `PI_SESSION_OWNER_*` 上下文是否影响 upstream 选择。没有身份 receipt 和事件时间序列，不能声称是预期 production 数据。

### 与 production 事实的差异

普通工作树与 HEAD 导出均 PASS，而 `env -i` FAIL/resolve；这组矛盾结果本身说明尚缺稳定 fixture/provenance。失败日志仅能证明断言观察到了 resolve，不能证明 production 正常入口会产生该 target。故不归类为 (1)“预期 production 数据未正确处理”，也没有证据将其归类为 (2)测试手工制造的非法 projection/event；按门禁判为 (3)来源尚未证实，必须 fail closed，禁止预防性兼容。

## 修复方向候选（不选定，待裁决）

1. **待裁决方向 A：** 若补齐 provenance 后确认这是合法 Host target，应调整 compat 测试预期为“绑定后可执行并返回结构化结果”，同时保留 adapter 的 unavailable fail-closed 保护；不得在证据补齐前改生产。
2. **待裁决方向 B：** 若确认 local-package fixture 必须模拟“未绑定 target”，应在测试 harness 中显式阻断 upstream supervisor tool registration 或使用公开入口构造无 target session，让测试只验证 `SUPERVISOR_TARGET_UNAVAILABLE`，不添加 production fallback。
3. **待裁决方向 C：** 若确认是 session_start/registerTool 时序竞态，应先补事件序列与稳定同步点，再决定修测试时序或生产生命周期；当前不选择任何一方。

## 未解决的疑问

- 为什么同一工作树普通环境三轮 PASS，而 `env -i` 下稳定出现 resolve？是否由未清理的 session-owner 环境上下文、jiti 解析布局或外部 Host bootstrap 造成？
- `PROBE_RESULT` 对象的具体 schema、target 身份和生成事件是什么（报告不输出运行身份，需在受控脱敏 probe 中取得摘要）？
- HEAD 导出为何 PASS，与背景记录的 HEAD 3/3 失败为何冲突？是否背景使用了不同 Node、依赖布局或环境变量集合？
- 缺失 `jiti` 是否使本次所有结果只能标记为环境不可验证，而非可用于生产归因？
- 是否存在合法 public/typed 入口能够在 session_start 前绑定该 target，并且该 target 属于当前 Host 而非外部 session？
