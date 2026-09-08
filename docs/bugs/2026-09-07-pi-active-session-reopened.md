# Pi 活动 session 可被重复打开

## 基线与核验

- 上游 checkout：`var/upstream/pi`，远程为 `https://github.com/earendil-works/pi.git`。
- 固定提交：`b79e4cc834970cca69daebffab7df1da7d1e52c4`，提交主题为 `Release v0.84.4`，日期为 `2026-08-28T23:56:03+02:00`；已 detached checkout。
- tag 核验：`git tag --contains b79e4cc834970cca69daebffab7df1da7d1e52c4` 包含 `v0.84.4`。
- npm 核验：`npm view @earendil-works/pi-coding-agent@0.84.4 gitHead version` 返回同一 `gitHead` 和 `version = 0.84.4`；`packages/coding-agent/package.json` 也声明 `0.84.4`。
- 本仓库 `init-pi.sh` 固定 `PI_VERSION="0.84.4"`，与上述 npm 版本一致。

## 复现与数据来源分类

| 项目 | 结论 | 数据来源 |
| --- | --- | --- |
| 同一 session 可被两个进程取得写 manager | 已证实 | `session-single-writer.integration.test.ts` 的隔离 Vitest RED；父进程创建并持有 session，子进程通过公开入口再次 `continueRecent`，实际状态码为 0 |
| 第二 writer 的稳定拒绝码 | 未实现 | 固定源码无 `SESSION_IN_USE` 或跨进程 lease；RED 正是断言该码缺失 |
| `continueRecent()` 是否经过 `open()` | 否，已证实 | `session-manager.ts:1559-1567` 按 mtime 找到 JSONL 后直接 `new SessionManager(cwd, dir, mostRecent, true)` |
| 线上用户的重复打开事件来源 | 来源尚未证实 | 本任务未读取用户 session、认证或日志；仅证明固定生产源码的公开 API 行为 |
| 相同 root session identity 的增强 root broker | 可覆盖既有 socket，已证实 | 本仓库 `root-broker-server.ts:194-224` 在 `start()` 中先 `rm(socketPath, { force: true })`；这是独立 broker 风险，不是 Pi core session lease |
| macOS cwd 路径别名导致 session discovery 漏检 | 已证实 | 固定 checkout bundled CLI 的真实双进程 T6：session header 保存 `/var/...`，CLI cwd 解析为 `/private/var/...`；`sessionCwdMatches()` 只比较 `resolvePath()` 字符串，导致 `-c` 创建新 session、`--session-id` 报当前项目无匹配 |

测试采用临时 cwd、临时 agent/session 根目录和临时 `HOME`，命令环境显式设置 `PI_CODING_AGENT_DIR`、`PI_CODING_AGENT_SESSION_DIR`。首个 writer 通过公开 `createAgentSession(...).prompt(...)` 请求测试内监听的本地 HTTP 模型服务并持久化 session；认证仅为进程内 `setRuntimeApiKey("anthropic", "test-only-local-model-key")` 覆盖，未写 auth 文件，也没有读取、复制或输出真实 auth、settings、models 或 token。第二 writer 是 `spawnSync(process.execPath, ["--import", "tsx", ...])` 启动的独立 Node/Pi API 进程，导入包的公开 `src/index.ts`，不是内部私有模块。

## 身份、顺序与首个偏离点

当前权威的 session identity 是解析后的 JSONL 文件路径及其首个 `session` header 的 `id`；`SessionManager` 没有 owner 字段、PID、进程启动身份、generation 或可查询的活动 writer 记录。因此当前不存在“权威 writer PID”。测试中父/子 PID 只可由操作系统观察，未被 session 文件或 Pi API 绑定。

已证实的顺序如下：

1. 第一个进程调用公开 `SessionManager.create(cwd, sessionDir)`，在内存中建立 header；追加 user 和 assistant 后，`_persist()` 以 `openSync(..., "wx")` 和 `writeFileSync()` 创建 JSONL。
2. 第一个 manager 未被释放，仍具有后续 `appendFileSync()` 写能力。
3. 第二个进程调用公开 `SessionManager.continueRecent(cwd, sessionDir)`；它按 cwd session 目录的 mtime 找到同一 JSONL。
4. `continueRecent()` 直接构造第二个 `SessionManager`，其 `_setSessionFile()` 读取并索引同一文件，设置 `flushed = true`；没有调用 `open()`，也没有锁、PID 检查或拒绝。
5. 两个 manager 都可走 `_persist()` 的 `appendFileSync()` 分支。首次偏离点是步骤 4 的直接构造：在任何读修复或 append 前，没有单写者所有权线性化点。

broker 顺序另行记录：同 root identity 的 `RootBrokerServer.start()` 先创建 socket 目录，删除现存 socket path，再 listen；关闭时才关闭 transport 并删除 path。故新 broker 可在旧 broker 存活时删除其发现路径。它没有 session JSONL owner，也不能作为 session writer 权威。

### macOS `/var` 与 `/private/var` Production 偏离

T6 使用同一固定 checkout 构建的 bundled CLI 和合法 public `SessionManager` owner 复现了第二个 production 缺陷。临时 cwd 可由 macOS 同时表示为 `/var/folders/...` 与 `/private/var/folders/...`；两者指向同一 filesystem directory。session header 与 CLI 当前 cwd 分别持有这两个合法表示时，`sessionCwdMatches()` 使用 `resolvePath(cwd) === resolvedCwd`，只做词法规范化，未解析 filesystem identity。

实际顺序如下：

1. owner Host 通过 public API 在 `/var/...` cwd 创建并持有 session lease。
2. 同一 checkout 的 bundled CLI 从物理相同的 `/private/var/...` cwd 启动。
3. 显式 `--session <path>` 直接打开文件，正确命中 `SESSION_IN_USE`；`--fork <path>` 在增加源 lease 检查后也正确拒绝。
4. `-c` 经 `findMostRecentSession()` 的 cwd filter，`--session-id` 经 `SessionManager.list()` 的 cwd filter；两者都因词法路径不同漏掉 owner session。
5. `-c` 转而创建新 session并进入模型认证，显示 `No API key found`；`--session-id` 显示“当前项目无此 session”并创建同 ID 新 session。

首个偏离点是步骤 4 的 `sessionCwdMatches()` identity 规则，不是模型认证。该数据来自 macOS 正常 filesystem alias、public API、固定源码 bundled CLI 与正常事件顺序，分类为“预期 production 数据未被正确处理”。修复应位于 SessionManager 的统一 cwd identity/discovery 边界；CLI 入口不得分别增加 `listAll()+realpath` fallback。

## 当前实际入口与文件变更清单

以下为固定提交中的当前事实，不是拟议重构。

| 类别 | 实际路径 | 当前行为与缺口 |
| --- | --- | --- |
| CLI 启动 | `main.ts:332-442` | `--session`/`--session-id` 调用 `SessionManager.open()`；`--fork` 调用 `forkFrom()`；`-r` 选择后 `open()`；`-c` 调用 `continueRecent()`；默认调用 `create()`。所有路径均无 owner gate。 |
| recent 特例 | `session-manager.ts:1559-1567` | 依据 mtime 选择 recent JSONL 并直接构造 manager，不调用 `open()`。 |
| 构造、open、缺失 cwd 恢复 | `session-manager.ts:877-1042`、`main.ts:678-686` | 构造可建目录；`open()` 读取 header；`setSessionFile()` 可加载、修复空文件或迁移重写；缺失 cwd 的交互恢复再次 `open()`。均可取得持久化 writer。 |
| 新建与追加 | `session-manager.ts:931-1042` | `newSession()` 生成 header/path；首个 assistant 以 `wx` 整体写入，之后所有 append 以 `appendFileSync()` 写入。`branchWithSummary()`、label、custom、thinking、model、message、compaction 等均进入该追加路径。 |
| 分支与 fork | `session-manager.ts:1414-1514`、`1581-1631` | `createBranchedSession()` 替换当前 manager 的文件身份并可重写；`forkFrom()` 以 `wx` 写 header 后逐项 append 源历史，最后构造新 manager。 |
| SDK runtime switch/new/fork | `agent-session-runtime.ts:196-404` | `switchSession()` 先 `open()` 目标再 teardown 旧 runtime；`newSession()`/fork 可 `create()`、`newSession()`、`createBranchedSession()`；均无 reservation、rollback owner 或临时 manager dispose。 |
| import 的 pre-open copy | `agent-session-runtime.ts:361-395` | 先建目标目录并 `copyFileSync(resolvedPath, destinationPath)`，之后才 `SessionManager.open(destinationPath)`；copy 前无目标或源 owner。 |
| TUI `/resume`、`/new`、`/branch`、`/import` | `interactive-mode.ts:1919-1924`、`5350-5404`、`6062-6102`、`6390` | 均经 runtime host；resume 的 selector 回调进入 `switchSession()`。TUI session selector 的 rename 则临时 `SessionManager.open(sessionFilePath)` 后 `appendSessionInfo()`，没有释放或 gate。 |
| 删除/trash | `session-selector.ts:643-681, 847` | 先调用外部 `trash`，失败后 `unlinkSync`；删除前未检查活动 writer。 |
| RPC | `rpc-mode.ts:319-344, 437-443, 605-610` | extension actions 和 `new_session`/`switch_session` 命令进入 runtime host，无额外 owner gate。 |
| 生命周期 | `agent-session-runtime.ts:166-177, 398-405`、`agent-session.ts:882-899`、`interactive-mode.ts:3940-3971, 4027-4107`、`rpc-mode.ts:733-743` | runtime replacement 和 quit 调用 `AgentSession.dispose()`；交互模式覆盖 SIGTERM/SIGHUP、暂停时 SIGINT，RPC 清理 signal handlers 后 dispose。`AgentSession.dispose()` 只 abort/disconnect/cleanup，不关闭或禁止 `SessionManager` append；manager 本身没有 dispose。 |

此外，`repairSessionFile()` 在读取时会为 pending JSONL 尾部补写换行（`session-manager.ts:520-555`），也是写入发生在 owner 获取之前的路径。`SessionManager.open()` 的空文件初始化、迁移 `_rewriteFile()` 与 import pre-open copy 同样必须纳入后续所有权门禁。

## 上游真实命令

```sh
# 精确行为 RED（本任务已运行；预期失败）
PI_CODING_AGENT_DIR="$fixture_root/agent" PI_CODING_AGENT_SESSION_DIR="$fixture_root/sessions" HOME="$fixture_root/home" \
  npm --prefix packages/coding-agent test -- session-single-writer.integration.test.ts

# package.json 的真实测试、构建和发布前打包链
npm --prefix packages/coding-agent test -- session-single-writer.integration.test.ts
npm --prefix packages/coding-agent run build
npm --prefix packages/coding-agent run prepublishOnly

# 根 package 的真实 typecheck 链（其中含 tsgo --noEmit）
npm run check

# npm package 产物预览
npm pack --workspace @earendil-works/pi-coding-agent --dry-run
```

`packages/coding-agent` 的 `build` 实际为 `build:unbundled && node ../../scripts/build-coding-agent-bundle.mjs`，后者生成 CLI bundle；`prepublishOnly` 为 `clean && build && shrinkwrap`。本任务运行了依赖安装、模型数据水化、定向 RED 和 `npm pack --dry-run`；没有运行会生成 dist 的 build 或 `prepublishOnly`。

## 结论

T1 达到正确 RED，未实现 lease，未修改上游 production code。后续 T2 只能消费本记录的已证实范围：所有上述打开、复制、重写、rename、trash/unlink、runtime replacement 和 broker 生命周期都需要按各自资源身份建立可验证 owner；不能将当前 manager 实例、mtime 或 socket path 当作所有权证明。
