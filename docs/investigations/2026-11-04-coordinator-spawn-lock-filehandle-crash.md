# coordinator spawn 锁 FileHandle GC 崩溃诊断

日期：2026-11-04。性质：源码级生产缺陷诊断，未实施修复。

**结论：两次生产 Host 的 spawn.lock FileHandle 被 GC 关闭并产生未捕获异常，已有本地 crash 记录证实。源码存在明确的句柄释放保护缺口：成功 open 后，身份采集和锁内容写入仍在释放 finally 之外。该缺口应以最小资源生命周期修复处理；现有证据尚不能认定这两次崩溃的前置异常就是身份采集失败。**

## 现场与证据来源

- 用户报告：连续两次调用 `managed_workspace_status({workspace_id:'5cca224d-4eb5-4b31-8e6f-feb4bd864af9'})`，工具均无正常回执，主 Host 崩溃；第二次显示时间为 2026/11/4 17:14:21。
- 当前源码基线：`main`，HEAD `1a6ecfbf20bc9f4c26f94edc27d20be9f5ad644c`，提交说明为 `fix(workspace): 恢复父侧受控集成兜底`。诊断开始时 `git status --short --branch` 无工作树改动，分支领先 origin/main 两个提交。
- 当前命令环境 `node --version` 为 `v26.8.1`。这是诊断进程所解析的 Node，不是对两个已退出 Host 的可执行文件版本证明。crash 的 `version: 1.4.0` 是记录中的应用版本字段，不能当成 Node 版本。
- 已先读根 `AGENTS.md`、`packages/pi-subagents-enhanced/AGENTS.md`、`pi/AGENTS_SHARED.md`。本次只写本文，未调用 managed 工具、coordinator/daemon 业务入口、Goal、provider 或 MCP；未运行 daemon、清锁、重启、发信号、修改源码或测试、创建 fixture、提交或执行 Git 状态变更。
- 六个真实 workspace 按用户要求保留。本次不读取私有 ledger、session 正文或凭据，不以业务 audit/status 重新核验其数量、owner、lease、状态或资源有效性。

### 本地崩溃记录

位置：`pi/crashes.json`。只提取相关条目的 timestamp、version、kind、message；源码检索同时显示其 stack 只重复错误消息，没有业务调用栈。未读取记录所指向的 session 正文，本文也不记录 session 路径。

| UTC 时间 | UTC+08 对应时间 | kind | 文件描述符 | 错误对象 |
| --- | --- | --- | --- | --- |
| 2026-11-04T09:08:33.514Z | 17:08:33.514 | uncaught_exception | 20 | 同一 spawn.lock 路径 |
| 2026-11-04T09:14:21.691Z | 17:14:21.691 | uncaught_exception | 22 | 同一 spawn.lock 路径 |

两条消息均为：`A FileHandle object was closed during garbage collection. This used to be allowed with a deprecation warning but is now considered an error. Please close FileHandle objects explicitly.` 后附文件描述符和 `/tmp/pi-workspace-coordinator-501/515b17388d96851becc32fca66c84b33.sock.spawn.lock`。

这独立证实了用户描述的 GC 错误类型、两次发生及第二次时间对应关系。crash 条目不含本次工具参数、调用关联 ID、原始 capture/writeFile/close 异常或其 cause，因此“两个工具都无正常回执”仍以用户观察为来源，不能仅凭 crash 反推工具 promise 的完成时刻。

### 真实锁文件只读快照

对上述精确路径执行普通 `stat` 与 JSON 解析，仅输出 pid，不输出 birthIdentity 或其他内容：

| 字段 | 观测值 |
| --- | --- |
| exists | true |
| size | 97 bytes |
| mode | 0600 |
| mtime | 2026-11-04T09:13:03.075Z |
| JSON | 可解析 |
| pid | 14193 |

这说明观测时该路径不是空锁，且 mtime 位于两次 crash 之间。**不能把该快照说成 capture 失败留下的空文件。** 本次未采集历史 inode/fd 关联，也未探测 pid 的活性或启动身份，不能确认当前内容由哪个调用写入、是否就是第二次 GC 所指的打开实例、是否曾被替换。不能据此授权清理，也不能据 pid 判断 owner 死亡。
## 相关日志筛选与前置异常边界

仅筛选以下文件中的固定错误码、固定错误短语、相关结构化字段，未输出完整日志行或完整 ps 命令行：

- `pi/logs/interactive-stderr.log`：1,022,440 bytes，mtime `2026-11-04T09:13:03.059Z`。固定模式匹配到两条身份异常，分别在 6423、6424 行。两条均为 `phase=coordinator-owner-dead`、`reason=process-not-found`、`errno=ESRCH`、`error.code=PROCESS_BIRTH_IDENTITY_UNAVAILABLE`，owner pid 分别为 54673、11384；提取结果没有对应 timestamp 或源栈位置。
- `var/workspaces/logs/coordinator-515b17388d96851b.log`：0 bytes，mtime `2026-11-04T06:58:55.955Z`，没有相关错误字段。

`coordinator-registry.ts:40–63` 的 `classifyCoordinatorOwner` 会捕获目标 owner 的身份采集异常，再以进程探测得到 ESRCH 后记录 `coordinator-owner-dead` 并返回 dead。这两条日志是**旧 owner 被判死亡的路径**，不是 `coordinator-spawn.ts:132` 对 `process.pid` 的身份采集异常证明。不能因错误码相同而将它们串成“当前 Host capture 失败 → 泄漏 → GC”的实测调用链。

`coordinator-spawn.ts:36` 的诊断 sink 用于 owner 分类；131–135 行的自身 capture/writeFile 失败没有专门的结构化诊断。`workspace/tool.ts:103–105` 将业务异常转成工具错误回执，也不会保存完整 cause。daemon 日志重定向在 `coordinator-daemon.ts:118–120` 才装配；拉起者写 spawn 锁发生在 daemon spawn 之前，不能要求 daemon 日志替父 Host 保留这个异常。以上日志筛选未确认自身 capture、writeFile 或 close 的前置失败；也不代表所有可能的历史日志均不存在。

## 完整源码调用链与权威边界

以下路径相对于 `packages/pi-subagents-enhanced/`，行号对应当前 HEAD。此链为源码可达性证明，不冒充此次两个请求的逐帧运行 trace。

1. **工具装配**：`src/subagent-dispatch/extension.ts:2377–2379,2405–2406,2426` 构造并注册 workspace 操作工具；service 由 `requireWorkspaceService`（953–960 行）取得配置服务或 session registry 绑定。
2. **合法 public 输入**：`src/workspace/operation-tools.ts:75–88,136–168,184–208` 定义 status 只接受非空 `workspace_id`，固定注入 `action: status`，委托同一旧工具 execute；调用者不能填 owner、rootSessionId 或 action。
3. **实时 Host 身份**：`src/workspace/tool.ts:73–78` 从 `ctx.sessionManager` 解析 rootSessionId，构造 `{kind:'standalone-subagent',rootSessionId}`。Host 在 `extensions/subagent-runtime.ts:946–970` 装配 facade 并绑定 session service，1056 行注入 root-session resolver；`src/workspace/registry.ts:77–87` 保存和查找绑定。
4. **本地状态查询**：`src/workspace/tool.ts:85–89` 首先调用本地 `statusOwned`。`src/workspace/service.ts:539–540` 经 `loadOwned`（182–190 行）加载权威 ledger，核对 exact owner kind 和 rootSessionId，再生成状态。这里没有签发 token，也不需要 coordinator client。
5. **仅 active 分支进入需要类操作**：本地 receipt.state 为 active 时，tool 紧接着调用 `issueOwnedDisposition`。`src/workspace/disposition-facade.ts:6–19` 只覆盖 issue/dispose/release，保留本地 statusOwned；dispatch 再 `readOwned` 目标 receipt，以同一回执选 client 与 terminal proof。并非所有 status 都拉起 daemon；active 的 token 签发才是此工具中的触发点，也不以 allowedDispositions 非空为进入 dispatch 的前提。
6. **Host 仓库路由**：单 Git Host 的 facade resolver 直接用固定仓库 `fixedContext.requireClient()`（`extensions/subagent-runtime.ts:575–579`）；多仓库 Host 先按可信 receipt 调 `selectReceipt -> selectRepository`，复核 owner、run/lease 与 storage partition，再 requireClient（550–573、595–597 行）。不允许仅凭工具传入 ID 指定仓库权威。
7. **懒连接**：`connectRuntimeCoordinator` 在 `extensions/subagent-runtime.ts:82–100` 创建 lazy，ensure 闭包注入 repositoryId、storageRepositoryId、commonDir、stateRoot 和 registry endpoint。`src/workspace/coordinator-client.ts:216–224` 有缓存则复用；无缓存通过 connecting promise 执行 `options.ensure()`，成功才 connect，finally 清 connecting。此 finally 只管连接 promise，不拥有 spawn FileHandle。
8. **确保 daemon**：`src/workspace/coordinator-spawn.ts:78–123` 校验输入和 metadata scope，分类已有 owner；alive 且可连则复用，dead/无 metadata 才进入 spawn 锁，undetermined/mismatch 则拒绝。`src/workspace/coordinator-registry.ts:104–114` 以 commonDir 绝对路径 SHA-256 前 32 位和 uid 推导短 endpoint；spawn 锁追加 `.spawn.lock`。不需要调用业务入口即可由源码解释 crash 路径的格式。
9. **锁内正常顺序**：`coordinator-spawn.ts:126–173` 获取锁、写入拉起者 pid+birthIdentity；174 行起才进入释放 try。之后依次 double-check startup.ping、检查 listener、清理允许清理的旧产物、`spawn(process.execPath, ... detached ...)`（197 行）、等待 startupReady 和 metadata 一致（202–226 行），最后 close/unlink（228–230 行）。
10. **若 ensure 成功，才发生业务连接与签发**：lazy connect 刷新 brokerRegistration（`coordinator-client.ts:198–205`），`connectRepositoryCoordinator:47–74` 建 socket、broker.register 并核对注册回执。`coordinator-server.ts:599–630` challenge Root Broker、建立可信 owner scope，再 authorize 请求。client 的 `issueOwnedDisposition` 映射为 `binding.register(operation='issueDisposition')`（74、85 行）；server 439–443、480 行使用认证 ownerScope 调唯一 service；`service.ts:543–565` 重新计算状态，保存绑定快照的 challenge 并返回 token，tool 才公开投影回执。

因此，此调用链在 active 分支上可合法触发拉起。不能为了避免崩溃直接把 token 签发改为 ledger 降级成功或绕过 coordinator。历史生命周期计划中“纯 status 不拉起”的总述也不能替代当前 tool 内签发动作的源码事实；本次不修改产品语义或计划。

## FileHandle 所有权与首个偏离点

`coordinator-spawn.ts:128` 的 `lockHandle` 是拉起者 Host 此次 `ensureCoordinatorDaemon` 调用的局部资源。131 行 `open(lockPath,'wx',0600)` 成功后，该调用即拥有一个须显式 close 的 FileHandle 和自己的排他锁。daemon 子进程、client socket、registry、workspace ledger 均不接收该句柄的所有权。

**首个源码资源保护偏离点是 131 行成功 open 之后，尚未进入 finally 保护便在 132 行执行可失败的异步初始化。** 求值顺序为：取得 handle → 等待 `captureProcessBirthIdentity(process.pid)` → JSON 序列化 → `lockHandle.writeFile(...)` → break → 174 行保护区。capture 或 writeFile 抛出的非 EEXIST 错误在 135 行直接重抛，跳过 228–230 行释放区，已取得的 handle 无显式关闭路径。若后续失去可达引用并被 GC，则会出现已记录的错误类型。这是确定的源码漏洞；两次实际请求是否恰经该失败边仍未实测。

| 路径 | 是否已经持有本次锁 | 现有释放边界 |
| --- | --- | --- |
| open 自身失败，未取得句柄 | 否 | 不应 close/unlink 他人锁；EEXIST 走竞争者判定 |
| open 成功，capture 或 writeFile 非 EEXIST 失败 | 是 | 135 行退出，未进入 finally，明确缺口 |
| 写入成功并 break，后续 double-check/握手/metadata/超时失败或成功 return | 是 | 228–230 行都会执行 close 然后 unlink |
| finally 中 close 或 unlink 失败 | 是 | 当前 `.catch(() => undefined)` 吞掉错误；日志不足以排除 close 失败，未证实本次发生 |

锁内容初始化与 open 共用一个 EEXIST catch 也使竞争者分支边界不够精确；修复时只应将 open 的 EEXIST 解释为未获得锁，不应让持有锁后的异常冒充竞争者状态。

`process-birth-identity.ts:34–62` 使用 `ps -ww -p <pid> -o lstart= -o command=`，默认最大输出 1 MiB（9–13 行），随后验证非空和严格英文/本地化单行格式（23–31 行），最后对原始字节哈希。exec 失败/空白为 `PROCESS_BIRTH_IDENTITY_UNAVAILABLE`，格式异常为 `PROCESS_BIRTH_IDENTITY_OUTPUT_INVALID`；这些都可能从 132 行失败边传播。**本次没有读取 ps 全命令行、没有在真实 Host 上重跑 capture，没有确认 locale、输出格式、maxBuffer、文件系统错误或 close 失败是事发原因。**

还需区分时间：GC 崩溃是资源未正确关闭后的异步表现，不一定紧邻第一次异常。第二次调用也可能撞上已经留下的锁；两次 crash 同一路径不证明同一 inode、同一 pid、同一生成步骤或两次相同前置异常。

## 数据来源分类

| 观察对象 | 分类 | 依据与限制 |
| --- | --- | --- |
| 生产 Host 的 spawn.lock GC 未捕获异常 | 1：生产资源处理缺陷 | 用户真实 public 调用报告 + 两条本地 crash；不是 fixture 失败。工具/Host/唯一 service/正常拉起顺序的源码链已列出；handle 由正常 fs.open 创建，必须显式释放，不依赖放宽数据校验 |
| 锁获取成功后初始化失败未被 finally 覆盖 | 生产实现的确定缺口 | 当前 HEAD 的控制流可直接证明；不是测试制造数据。缺少此次实际抛错位置证据，不等同于已证明此次完整因果链 |
| “本次自身 capture 失败/ps 格式异常”或“本次 writeFile/close 失败” | 3：来源及事发路径尚未证实 | crash 无原始 cause；现有 identity 日志是旧 owner 的 ESRCH 分类；当前 97 字节可解析锁不能证明失败瞬间内容 |
| 既有测试的死 pid、错误 birthIdentity、malformed 锁 | 2：测试构造输入 | 测试文件显式预置，用于验证 fail-closed；不得把这些 fixture 当成本次 production 身份事实，也不得据此放宽 production 判定 |

实际 workspace 的 owner/lease、事发时 state、当时 metadata 分类和 Node 二进制未在本次重新核验。因此源码链证明“合法 active workspace 可以走到此资源分配”，不证明目标 workspace 当时每个资源事实都已被本次独立核验。首个实际前置异常仍缺证据，不能据此增设 production 兼容、跳过身份校验或自动清理真实锁。

## 最小修复建议（未实施）

1. 将句柄获取成功后的初始化与后续拉起全过程纳入同一个确定的 try/finally 资源所有权范围。只有本调用成功 open 才有释放权；捕获 open 的 EEXIST 与初始化异常分开。无论 capture/writeFile、double-check、spawn 或握手在哪一步失败，都应显式 close 本调用取得的句柄，并按持锁所有权释放本次锁。
2. 保留原始异常 code/cause；关闭或锁释放失败不可替换为业务成功。评估现有吞 close 错误的处理，确保关闭失败具有可诊断证据，避免清理异常覆盖首因。不要简单在循环外无条件 unlink，否则竞争失败的调用可能删除别人的锁。
3. 可考虑在 open 前完成自身 birthIdentity 采集以缩短持锁初始化窗口，但这只是辅助：writeFile 仍会失败，不能替代 finally。身份检查继续 fail-closed；不修改 ps 正则、不新增 locale fallback、不把未知 owner 当死 owner、不用 TTL 强行覆盖、不以 Node 降级或屏蔽 GC 异常代替显式释放。
4. 现存真实锁和六个 workspace 保留。修复代码与历史锁恢复是不同操作，本报告不授予清理、重启或重放业务的授权。

## 可复用的现有验证与本次检查

已完整阅读下列三个测试文件，未改动、未新增、未执行。修复后可在另行获准的隔离验证环境复用：

```sh
node --test test/process-birth-identity.test.mjs
node --test test/coordinator-registry-lock.test.mjs
node --test test/managed-workspace-coordinator.integration.mjs
```

- `process-birth-identity.test.mjs:26–129`：invalid PID、精确 argv、原始字节哈希、malformed/空白/exec 失败的拒绝，以及测试进程自身身份稳定性。主要为注入 exec 的单元断言，最后一项执行测试进程的真实 ps；不能证明事发 Host 的 ps 格式或此次泄漏。
- `coordinator-registry-lock.test.mjs:44–110`：四态 owner 分类、活锁不回收、死 pid 回收、pid reuse 拒绝、malformed 锁保留及移除后恢复。fixture 使用临时 repo/state，但会执行 Git 初始化/提交、启动 daemon、SIGKILL 清理和文件删除；本次不运行。
- `managed-workspace-coordinator.integration.mjs:48–308`：endpoint 与 state-root 范围、registry 原子写、长路径、runtime lazy requireClient、真实进程注册、双进程竞态、死 owner 重拉、跨范围拒绝、Root Broker challenge。会启动测试 broker/daemon、监听 socket、发 RPC 与清理测试进程；本次不运行。

后二者的 endpoint 由临时 commonDir 哈希推导到共享 `/tmp/pi-workspace-coordinator-<uid>`，不是全部文件都位于 fixture root 内；部分子进程继承环境。未来执行前须核对隔离环境、唯一 endpoint 与状态路径，不把“临时 fixture”视作自动满足当前禁止真实业务的合同。本次只给出原有命令，不扩写测试矩阵。

这三个现有文件均没有直接断言“成功 open 后自身 capture/writeFile 失败时句柄仍被显式关闭”；其全绿不能替代该缺口的验证。本次未新增断言或故障注入，未作动态 GC 复现，也未作修复完成声明。

本次实际验证为：Git 只读基线检查、Node 版本查询、源码与现有测试静态核对、指定锁 stat/只提取 pid、crash 字段提取、两个相关日志的固定错误字段筛选，以及报告写入后的写路径/暂存区检查。报告不包含 token、credential、birthIdentity、完整 session 或完整 ps 命令行。

收尾检查出现需保留的并发现场：开始时工作树 clean；写完报告后 `git status` 另显示 `M pi/extensions/bash-cwd.ts` 和 `?? pi/bin/apply_patch`。这两处不是本任务写入，来源及授权尚未确认；已经上报主管，主管要求保留、不检查、不清理、不纳入本任务。本任务写工具记录仅涉及本文，未打开或修改这两处并发变更，未创建任何 worktree。不得将当前全仓状态表述为“只有报告变化”。

检查结果：`git diff --cached --name-only` 为空；`git diff --check` 通过。自检中报告存在、调用链/句柄边界/来源分类/未验证限制/三条现有测试命令/无行尾空格均通过；`onlyReportChanged` 因上述两项并发变更为 false，首轮自检命令因此退出 1。这不是诊断结论或测试失败，但阻止对全仓唯一改动作断言；最终范围验收依据本任务实际写工具记录，而非覆盖或清理外部现场。

剩余阻塞是**事故首因定位**：现有日志不能确认当前 Host 的前置异常及原始调用栈。它不阻塞交付源码诊断，但阻塞把 capture 失败写成生产根因，或据此引入身份兼容/降级逻辑。此次没有为补齐该证据触发真实 workspace/daemon 操作。

### 补充诊断：startup socket 提前关闭的结算与句柄生命周期

本节只针对 `coordinator-spawn.ts` 当前源码的 `pingStartup`、`probeEndpoint` 和其生产关闭路径；不重做前一节的真实锁、crash 或 workspace 采集。

#### 静态结算证据

`src/workspace/coordinator-spawn.ts:38–46` 的 `probeEndpoint` 只在 `connect`、`error` 或 `timeout` 调用 `finish`。它不监听 `end`/`close`，但成功连接时已经在 `connect` 事件中结算为 `true`；若连接在 `connect` 前异常关闭，Node 通常以 `error` 或最终 timeout 进入已有分支。peer 在 connect 后关闭不会把一个仍 pending 的 probe 留到永久，因为 probe 已在 connect 时 settle。

`src/workspace/coordinator-spawn.ts:49–72` 的 `pingStartup` 只在收到完整换行帧、解析失败、`error` 或 `timeout` 调用 `finish`。对端若在换行前只发送半帧后执行 FIN，客户端会收到已有 `data`，但 `buffer.indexOf("\\n") < 0` 直接 return；随后 `end`/`close` 没有监听器，故该 Promise 在 peer close 到 timeout 之间保持 pending。默认 timeout 为 1000ms，且代码没有在 `end`/`close` 上清除或提前触发该 timer；因此按现有代码可确定为**有限 pending 至 timeout**，不能称为永久 pending。若发生 error，则已有 error listener 会提前以 `undefined` settle。

`pingStartup` 的两个调用均位于持锁的 `ensureCoordinatorDaemon` continuation 中：锁内 double-check 为 `coordinator-spawn.ts:174–180`，拉起后的 startupReady 重试为 `:201–224`。每一次半帧关闭最多把对应 await 推迟到 1000ms；多次重试可把整体等待延长至 `spawnTimeoutMs`，默认 10 秒。timeout 触发 `finish` 后，`pingStartup` 的 Promise settle，async continuation 继续执行，最终到 `:225–228` 的 finally 显式 close 并 unlink。

这条链不能证明“未 settle 的 await 会使 FileHandle 失根并被 GC”。在当前函数中 `lockHandle` 在 await 之后仍被 finally 使用，暂停的 async continuation 需要保留该局部状态以便恢复；仅观察到一个 socket Promise 在 close 后尚未立即 settle，不足以推导 FileHandle 已不可达。前一节已确定的更直接缺口仍是 `open` 成功后 `captureProcessBirthIdentity`/`writeFile` 位于 `:131–135` 的 finally 之外。若进程在 timeout 前因其他原因退出，任何 finally 都不会获得执行机会，但这不是本次 socket 事件单独造成的 GC 证据。

#### production 可达性与关闭语义

提前关闭不是非法身份或乱序 ledger 构造。`coordinator-server.ts:704–705` 的正常 `close` 会遍历 clients 并 `socket.destroy()`，再等待 `server.close()`；`coordinator-daemon.ts:130–153` 的 SIGTERM/SIGINT shutdown 会调用该路径。daemon 进程退出时，内核也会关闭其 UNIX socket。服务端普通 startup ping 响应在 `coordinator-server.ts:598–600` 写完整行后继续保持连接，客户端正常完成后自行 destroy；服务端关闭、进程退出或写响应中断均可能使客户端在完整换行回复前收到 `end`/`close`。所以 transport 关闭事件在 production 是可达的。

但“可达”不等于“两次 2026-11-04 fatal 的已证实前置因果”。现有 crash 记录只有 GC close 错误，没有 ping 的 request trace、原始 cause、半帧数据或 close 时间。真实 daemon 正常响应路径也会发送完整换行；本次没有在真实 endpoint/daemon 上重放或注入关闭。结论边界是：源码存在缺少 end/close 结算的 transport 缺口；该缺口会产生至多一个 timeout 窗口的 pending await；尚无证据把它串接到两次 FileHandle GC fatal。

#### 隔离诊断尝试及限制

按任务授权仅启动了本地临时 UNIX listener 的 Node 诊断命令，未使用真实 endpoint、state、managed workspace、daemon、Host、锁、Goal、MCP、provider 或凭据，也未写入业务路径。诊断脚本尝试复刻 `probeEndpoint`/`pingStartup`，发送半帧后关闭，并用 `--expose-gc` 观察 finally 前后的弱引用；临时目录由 `mkdtemp` 创建。

- 第一次命令（20 秒上限）超时，无结构化结果；不能把超时归因于生产代码或事故。
- 第二次仅增加临时 socket 跟踪和清理的命令（10 秒上限）仍超时，无结构化结果；同样不能归因于生产代码。
- 第三次 debug 变体（8 秒上限）输出了 `listening`、`server connection 1`、`probe result true`、`ping begin`、`server connection 2`、`ping connect`、`server partial`、`ping data 54`、`server end first`、`early pending` 后超时。该变体的换行字面量转义与目标函数不完全相同，且没有走完最终 ping settlement、finally 和 GC 观测；因此只能记录为临时 listener 在 100ms 观察点仍 pending 的辅助现象，不能作为 production 函数的完整复现或 FileHandle GC 证据。

这些命令由工具超时中止，未获得可安全核验的本任务 PID 和临时 scope；未再尝试猜测 PID、killall 或清理。若运行时残留临时目录/监听，它们属于上述隔离诊断范围，不能据此触碰任何业务资源；本限制作为残余风险记录。未因诊断超时修改源码、测试或 fixture。

#### 最小修复范围与“只扩大获取锁 finally”是否足够

最小修复应包含两层、且两层职责不同：

1. 在 `pingStartup` 增加幂等 `finish(undefined)` 的 `end`/`close` 处理，并保持 timer 在所有结算路径清除、socket 显式销毁。`probeEndpoint` 的主要 close 风险较小，因为 connect 已结算；为统一资源生命周期，可同样使用幂等 finish，并在 close 前未 connect 时返回 `false`。
2. 将 `open` 成功后的 owner 身份写入与整个锁内流程放进同一个确定的 try/finally；初始化异常、ping 异常、spawn/握手异常都必须关闭本次取得的 FileHandle，并只由本调用按所有权释放 lock path。保留 EEXIST 竞争分支与 fail-closed 身份判定。

单独扩大获取锁的 finally **不能覆盖 socket 结算缺口**：它能保证 `pingStartup` 已经 settle 后释放句柄，但不能消除 peer close 到 timeout 的延迟，也不能解决任何未来没有 timer 或 timer 未运行的 transport await。反过来，单独给 `end`/`close` 加 handler 也**不能覆盖初始化 cleanup 缺口**：`captureProcessBirthIdentity` 或 `writeFile` 在进入现有 finally 前抛错时，句柄仍可能丢失显式 close。两者是独立的最小修复面；在当前事故证据尚未证明 socket 前置因果的情况下，不应借此添加身份降级、未知 owner 兼容、TTL 覆盖或真实锁自动清理。

本次补充仍未实施生产修复、未新增或修改测试、未提交、未创建 worktree；唯一业务写入是本报告追加。真实 crash 与初始化缺口、socket 关闭结算缺口、以及事故前置因果未证实三者保持分层记录。

### 补充收尾验证

本次实际运行的隔离命令均为临时 Node `--expose-gc` listener 诊断；前两次分别在 20 秒、10 秒上限超时，第三次在 8 秒上限超时并只得到上述 debug 输出，均不能作为完整动态复现。未运行生产测试、未启动真实 Host/daemon、未访问真实 endpoint/state、未执行 managed_workspace_*。报告追加后仅需检查本文件 diff 与暂存区；并发现场 `pi/extensions/bash-cwd.ts`、`pi/bin/apply_patch` 继续保留，不纳入本任务。

剩余限制仍是：没有真实调用的 ping request trace，也没有经过正确实现的 end/close 隔离实验来证明 FileHandle 的 GC 可达性变化。因此本节支持“transport close 可达、当前代码在 timeout 前 pending、源码缺少 close 结算”，不支持“该缺口已经导致两次 FileHandle GC fatal”。
