# Doctor 放行纠正：合法 Pi 开发依赖造成 native ESM 身份分叉

## 纠正结论与分类

**撤回先前「仅 typings」「整个 runtime 安全」「四项全是误报」的结论及 Doctor 新增放行。** manifest 中 devDependencies 的声明不能证明 Node 不会在运行时消费这些目录。当前 Doctor 恢复原严格检查，四个 package-local Pi peers 存在即 error，不通过精确 dev 版本、wildcard peer 或安装 manifest 推断安全。

数据来源分类：**production 来源已确认**。合法 setup 安装与 manifest 能产生这些目录；实际 compat/upstream native 消费链产生了可重复的身份分叉，不是非法 projection/event 或缺字段 mock。首个安全推断偏离点是将官方 loader 对直接 TS imports 的 jiti aliases 外推成所有 native JS/MJS transitive imports 都使用 Host 对象。错误放行属于诊断门禁缺陷；**身份分叉已证，具体用户故障、是否造成某次 crash/TUI 异常尚未证实**。不得为了消除 Doctor error 添加兼容、改变 loader 或安装声明，此类修复需要单独决策。

## 权威安装事实与完整生成/消费链

现场权威目录：

- Host：`/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent`，其 manifest 与解析到的四包均为 `0.87.1`。
- enhanced：`packages/pi-subagents-enhanced/package.json` 为 `pi-subagents-enhanced@0.1.0`，四包均声明为 `devDependencies: "0.87.1"` 和 `peerDependencies: "*"`；package-local 四包 manifest 也均为 `0.87.1`。
- 上游：enhanced 安装的 `pi-subagents@0.71.0`。根 node_modules 由另一执行单元同步，本次没有读其 Pi 对象来建立身份判断，更没有安装或重建。

合法资源生成顺序（只读取源码，**未执行安装或完整 init**）：

1. `init-pi.sh:2` 使用 `set -euo pipefail`；先做运行依赖检查，再在 `:47` 调用根 `setup:subagents-enhanced`。
2. 根 script 调用 `scripts/setup-subagent-runtime-deps.ts`；`:57–58` 对 enhanced 执行 `npm install --ignore-scripts --omit=peer` 与 `setup:runtime`。
3. `packages/pi-subagents-enhanced/scripts/setup-runtime-deps.ts:11` 同样对 enhanced 安装 `--omit=peer`，未 omit dev。故开发包落盘来自正常声明入口，不是人为构造的非法目录。
4. `init-pi.sh:101–102` 最后执行测试与 Doctor；Doctor error 会阻断初始化后续流程。合法安装不意味着该状态满足运行身份门禁。

实际生产消费链及首个分叉边界：

1. enhanced manifest → `extensions/subagent-runtime.ts` → `src/compat/pi-subagents-0.71.ts`。compat 静态 import 上游 `pi-subagents` public root。
2. 上游 `index.js` 在非 child 模式动态 import `src/extension/index.js`。
3. extension index → `src/watchdog/register-main.js` → `src/watchdog/render.js`；后者原生 import `@earendil-works/pi-tui`，并在 `renderWatchdogWarning` 内 `new Container()`。
4. 全局官方 `dist/core/extensions/loader.js:getAliases / loadExtensionModule` 用 jiti aliases 加载 TS factory；**该 alias 表没有成为 native ESM resolver hook**。native 子图按其 Node 解析目录消费 enhanced 本地 Pi 副本，版本一致仍是不同模块实例。
5. `registerMainWatchdog` 注册的真实 `subagent_watchdog_warning` renderer 消费完整 warning details 后返回 enhanced Container，不是全局 Host Container。此处证明实际 consumer 的输出身份分叉，但不据此宣称 Host 展示一定崩溃（结构化 render 在探针中可执行）。

上游 `child-session.js:loadHostPiCodingAgent` 的绝对 Host SDK 选择、detached runner 的 `runner-peer-preload.mjs` 与 alias 传播是**不同加载边界**。它们成功不等于前台 native watchdog/render 子图安全；本次保留它们作为对照，而不是修复依据。

## 纠正实现与 TDD 证据

已读 `test-driven-development/SKILL.md` 及 `writing-good-tests.md`。生产纠正没有使用 TDD 豁免。首次修改 Doctor 前先更新本问题记录与回归期望，观察精确 RED：

```sh
env -u PI_SUBAGENT_CHILD -u PI_SUBAGENT_FANOUT_CHILD TMPDIR=/tmp node --test --test-name-pattern='doctor rejects all four package-local' test/doctor.test.mjs
```

输出 `1 test / 0 pass / 1 fail`，`AssertionError: 0 !== 4`。此时未撤回的 dev exact/peer* 分支漏报四个冲突；不是 import/fixture 异常。

最小 GREEN：只撤回 `scripts/doctor.ts` 新增的 manifest 放行分支及其专属状态/常量改名，恢复原 `FORBIDDEN_LOCAL_PI_PEERS` + `lstat` 严格行为。**该文件最终与 HEAD 相同**，未丢弃其它用户文件改动。测试保留声明/manifest 变化检查，但每种本地四目录状态都应四项 error；权限检查改为真实 lstat 父目录不可访问，另补目录不存在不报冲突的用例。不为旧测试的一项 error 期望增加生产分支。

纯文档纠正免于单独文档测试；native 身份测试是针对未修改 upstream/loader 的窄范围 characterization，不宣称经历 loader 修复的 RED/GREEN。生产 RED/GREEN 是上述 Doctor 门禁。

## 真实官方 loader 与上游 consumer 回归

`test/doctor-pi-peer-runtime.test.mjs` 和 `test/fixtures/doctor-pi-peer-probe.mjs` 使用真实全局官方 `loadExtensions`，不自建 jiti、不替换官方 aliases，不安装依赖。

- **直接 TS 阳性对照**：`SessionManager / Box / Agent / streamSimple` 均严格等于 Host 对象。此测试已重命名，明确不能外推 native 子图安全。
- **native MJS 子图**：TS factory → MJS bare Pi imports；四对象均 `!== Host` 且 `=== enhanced`。探针还读取权威四包 manifest，Host/enhanced 都是 `0.87.1`，排除版本差异解释。
- **实际上游 consumer**：TS factory → 真实 enhanced compat `upstreamSubagentRuntime` → public upstream root 正常注册。取官方 loader 返回的真实 watchdog message renderer，以完整 warning details 调用，断言返回 `constructor !== Host.Container`、`constructor === enhanced.Container`，并验证 warning 实际可 render。
- **detached preload 对照**：用真实上游 alias resolver/preload，其四对象与 Host 相等；只支持该 detached 边界。

native/consumer 两项在 fresh subprocess 中运行，白名单环境、不继承 child/live/root markers、凭据或 JITI_ALIAS/NODE_OPTIONS，`HOME / PI_CODING_AGENT_DIR / PI_SUBAGENTS_TEMP_ROOT` 都指向隔离目录，`TMPDIR=/tmp`。只加载、注册和渲染；不发 `session_start`、不执行 subagent/model 工具、不读取 auth/models、不注册 production sockets。完成后执行上游 session_shutdown 清理及官方 runtime invalidate。

首次组合验证 `26/28`：两个新增探针虽已证明 `!== Host`，但 `=== enhanced` 期望错误地解析到了 enhanced coding-agent 自身的**nested peers**，而非 enhanced 顶层 peers。此为测试来源错误（类别 2），只修 test 的权威解析起点到 enhancedRoot；未改生产或 loader。修正后再次检查四包版本，最终：

```sh
env -u PI_SUBAGENT_CHILD -u PI_SUBAGENT_FANOUT_CHILD TMPDIR=/tmp node --test test/doctor.test.mjs test/doctor-pi-peer-runtime.test.mjs
```

**28 tests / 28 pass / 0 fail**。实际输出：

```text
SessionManager: native === enhanced, native !== Host
Box: native === enhanced, native !== Host
Agent: native === enhanced, native !== Host
streamSimple: native === enhanced, native !== Host
Host and enhanced Pi peer versions: all four 0.87.1
upstream watchdog renderer: Container === enhanced, Container !== Host; warning rendered
Host and enhanced Pi peer versions: all four 0.87.1
```

## 实际 Doctor 拒绝证据与剩余阻塞

```sh
env -u PI_SUBAGENT_CHILD -u PI_SUBAGENT_FANOUT_CHILD -u PI_SUBAGENT_PARENT_SESSION -u PI_ROOT_SUBAGENT_BROKER_ENABLED TMPDIR=/tmp node scripts/doctor.ts
```

**exit 1（预期 fail closed）**，实际四项 error：

```text
[error] pi-subagents-enhanced contains a package-local Pi core peer: @earendil-works/pi-agent-core
[error] pi-subagents-enhanced contains a package-local Pi core peer: @earendil-works/pi-ai
[error] pi-subagents-enhanced contains a package-local Pi core peer: @earendil-works/pi-coding-agent
[error] pi-subagents-enhanced contains a package-local Pi core peer: @earendil-works/pi-tui
```

历史 orphan/untrusted-legacy 与既有限制 warning 原样保留，未处理历史 state。本次没有根同步、安装、commit、stage、修改 package/lock/loader。`git diff --check` 及 Doctor/两测试/fixture 的 `node --check` 均通过。Doctor 恢复 HEAD 的原实现，无新增 TypeScript 实现；为避免和根依赖同步竞争，本次不跑根 tsc/full suite，不把之前的 typecheck 或 Doctor exit 0 当作此次验收证据。

剩余阻塞：必须另行决策前台 native Pi 单例身份加载/安装边界，当前初始化不能以 Doctor 放行结束。尚未证实真实用户故障或完整前后台派发安全；未测试真实模型、Bun/SEA/bundled Host、未来 loader 或全部 transitive consumer。根依赖漂移与同步由独立任务负责，即使根四包同步至 0.87.1，也不能据此消除本次 enhanced/global 的同版本 native 身份分叉。
