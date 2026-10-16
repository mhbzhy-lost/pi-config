# Session Owner PTY 六测试就绪度调研（read-only research）

- 任务：`dispatch-23981e28`（executor；只调查、只写本报告；不是 implementation plan，不替代父计划）
- 日期：2026-10-14
- 性质：**纯 read-only 调研**。本窗口未运行任何 node/test/npm/typecheck/Host/kill/网络/用户 session；未修改任何测试或 production 代码；未 stage/commit/reset/stash。
- 写路径：仅本文 `docs/research/2026-10-14-session-owner-pty-readiness.md`。

## 0. 结论速览

| # | 测试（test/session-owner-runtime.integration.mjs） | 行号 | 状态 | 关键依据 |
|---|---|---|---|---|
| 1 | 真实 Pi Expect PTY 落盘 assistant 响应并在运行中保持 active owner | L453 | **ready** | 全临时根 + fake provider；绿灯路径零 SIGKILL（quit 走 EOF 优雅退出） |
| 2 | 真实 Pi PTY: active recent blocks a second -c before real Pi exec | L520 | **ready** | 阻断发生在 launcher prepare 层，不 exec Pi；绿灯零 SIGKILL |
| 3 | 真实 Pi PTY: -c pins the exact free recent session while another old session is active | L534 | **ready** | utimes 仅改临时 fixture mtime；绿灯零 SIGKILL |
| 4 | 真实 Pi PTY: --no-extensions cannot bypass an active owner | L558 | **ready** | launcher 无条件追加 `-e session-owner`，真实产品强制路径；绿灯零 SIGKILL |
| 5 | 真实 Pi PTY: selecting picker blocks -c and --session reuse before either Pi executes | L573 | **ready** | selecting reservation；取消走 Ctrl-C；`killPty` 仅失败兜底 |
| 6 | 真实 Pi PTY: SIGKILL owner is cleaned by ESRCH before the next wrapper starts | L593 | **needs-permission** | L603 `process.kill(killedPid,"SIGKILL")` 对真实 Pi fixture 进程一次性 kill，按合同不继承 H2 一次父 kill 授权，需单独授权或接受替代方案（§5） |

- **无 needs-fixture-correction 硬阻塞**：六条测试的 fixture 形状均为 production public 入口 + 临时根合法造数据；未发现必须先改测试才能跑的缺陷。1 个**条件性运行时假设**（§7-A：test 6 wrapper 在 `expect_user` 上依赖 20s 超时回落才退出）失败模式有界，不阻塞，但见 §5.3 的运行期核验步骤。
- **未发现任何真实缺陷指控**（§7-C）：静态核对未发现 production 源码与 docs/session-owner.md 合同矛盾点。
- 真实网络：无（§6.1）；用户配置：不读（§6.2）；trace/log 泄密：审计通过（§6.3）。

## 1. 范围与方法与现场版本证据

只读证据文件（全文件已读）：

- `docs/plans/records/2026-10-13-session-owner-acceptance.md`（S1v 验收记录，PTY 6 项 `blocked-environment` 的出处）
- `test/session-owner-runtime.integration.mjs`（全文件，659 行）
- `test/helpers/test-runtime.mjs`（`createTestRuntime` 临时根）
- `test/helpers/pi-runtime.mjs`（`loadPiTestRuntime` 物理 SDK 解析）
- `scripts/pi-launcher.zsh`、`scripts/pi-shell.zsh`、`scripts/pi-session-owner.ts`（公开入口链）
- `pi/extensions/session-owner.ts`、`src/session-owner/extension.ts`、`src/session-owner/lifecycle.ts`、`src/session-owner/registry.ts`
- `test/fixtures/deterministic-provider.mjs`
- 现场 SDK dist：`node_modules/@earendil-works/pi-coding-agent/dist/{main.js,cli/args.js,core/model-runtime.js}`（只 grep/sed 定位行为，未执行）

现场只读版本探测（`which`/版本查询级，read-only）：

- Node `v26.8.1`（满足 launcher 的 `>=22.19` 检查，pi-launcher.zsh:6–7）
- `/usr/bin/expect` 存在，`expect version 5.45`
- `/bin/zsh`、`/usr/bin/stat` 存在（launcher 依赖）
- 物理 SDK：`node_modules/@earendil-works/pi-coding-agent/dist/cli.js` 存在（169B 入口 shim，`main.js` 真体）；HEAD `a9875d6`；现场 dirty（既有 dirty 保护，本任务未触碰）

## 2. 公共启动链与逐层预检（六测试共享）

每次 PTY 启动的进程树与调用链（read-only 证据）：

```
node --test（测试进程，env 白名单注入）
└─ /usr/bin/expect -c <脚本>                      [test L102/L129 spawn]
   └─ spawn -noecho $env(LAUNCHER) <piArgs…>       [expect 脚本，pi-launcher.zsh]
      └─ zsh pi-launcher.zsh（PID = $$，后续 exec 不变）
         ├─ node scripts/assert-session-tool-policy.ts "$@"   （子进程，校验后退出）
         ├─ node -p 'node 版本 >=22.19'                        （子进程，退出）
         ├─ node scripts/resolve-physical-pi.ts                （子进程，产出 PI_REAL_BIN 后退出）
         ├─ node scripts/pi-session-owner.ts prepare --pid $$ …（子进程，写 0700 decision_dir 后退出）
         └─ exec node <PI_REAL_BIN> -e pi/extensions/session-owner.ts <args…>
            （**与 launcher 同 PID**；registry record.pid 即此 PID）
```

逐层预检（全部有 read-only 证据定位）：

1. **expect 可执行**：测试硬编码 `spawn("/usr/bin/expect", …)`（L102、L129）；`ptyFixture` 先 `spawnSync(piBinary,["--version"])` 断言 `status===0`（L72–75），失败即停止、不进入任何 PTY。
2. **node/Pi 版本**：launcher 强制 Node≥22.19（pi-launcher.zsh:6–7）；`PI_REAL_BIN` 由 `resolve-physical-pi.ts` 从 `PI_HOST_ROOT`（缺省仓内 node_modules）解析；测试侧默认 `repoLocalPi`（L67–68），可被 `T8_PI_REAL_BIN` 覆盖用于 `--version` 预检（L71）。注意：launcher 内部会**重新** export `PI_REAL_BIN`（pi-launcher.zsh:11–13），若 `T8_PI_REAL_BIN` 与 launcher 解析结果不一致，预检与真实执行可能指向不同二进制——默认运行两者同为仓内 SDK，无分歧。
3. **`--version` 预检无网络**：`main.js:500–504` `if (parsed.version) { console.log(VERSION); process.exit(0); }` 在 settings/网络任何路径之前直接退出；即使预检 env 未带 `PI_SKIP_VERSION_CHECK` 也无副作用（只读 stdout 一行）。
4. **prepare 决策**：`pi-session-owner.ts` prepare 在 0700 decision_dir（launcher `mktemp -d "${TMPDIR:-/tmp}/pi-session-owner.XXXXXXXX"`，TMPDIR 已指向测试临时根）内写 `action/owner-id/continue-arg-index(/session-path)`；`blocked` 时 launcher 打印「Pi session 已阻断…」并 exit 1（pi-launcher.zsh:42），**不 exec Pi**——这正是 test 2/4/5 的 `assertBlocked`（L289–299）断言面。
5. **PI_SESSION_OWNER_REGISTRY 继承**：launcher 用 `${PI_SESSION_OWNER_REGISTRY:-默认用户运行时目录}`（pi-launcher.zsh:57），测试 env 已显式设为临时 registry（L80/L486），不会落到用户真实 registry。

## 3. 六测试逐条明细

### 3.0 公共隔离环境

- **ptyFixture（L65–83，test 2–6 共用）**：`createTestRuntime(t,"session-owner-pty-matrix-")`（test-runtime.mjs：`mkdtemp` + `t.after(rm -rf)`）→ `root=realpath(fixture.root)`（macOS `/var→/private/var` canonical 化，与 docs/session-owner.md 符号链边界一致）→ mkdir `home/agent/sessions/tmp/registry/cwd` 各 0700。
- **env 白名单（L76–82）**：`PATH`(继承)、`HOME=root/home`、`PI_CODING_AGENT_DIR=fixture.agentDir`、`PI_CODING_AGENT_SESSION_DIR=fixture.sessionDir`、`PI_SESSION_OWNER_REGISTRY=store.root`、`PI_CODING_WORKSPACE_DIR`、`PI_CODING_GOAL_DIR`、`PI_HOST_NODE=process.execPath`、`PI_HOST_ROOT/PI_PACKAGE_DIR=process.env.PI_TEST_CODING_AGENT_ROOT`（未设时该键以 undefined 传入，node spawn 跳过 undefined 键，launcher 内部 `PI_HOST_ROOT:-$root/node_modules/...` 自愈）、`PI_SKIP_VERSION_CHECK=1`、`PI_TELEMETRY=0`、`TMPDIR=root/tmp`、`PI_REAL_BIN`、`T8_PI_VERSION`、`LAUNCHER`、`PROVIDER`、`TERM=xterm-256color`。**不含** ZDOTDIR/PI_CONFIG_HOME/XDG_RUNTIME_DIR/任何用户 shell 导出——用户配置物理上不可达。
- **piArgs（L68–70）**：`--offline --provider fake --model fake/deterministic -e <deterministic-provider> --no-skills --no-prompt-templates --no-themes --no-context-files`；test 2–6 再追加 `--session-dir root/sessions`（L88），test 1 用 env `PI_CODING_AGENT_SESSION_DIR` 等价物（L487，不追加分参）。
- **expect 超时**：每个 expect 脚本 `set timeout 20`（L87、L115）；ready 屏障 = TUI 输出 marker + registry 出现**新 ownerId** 的 active record（`readyPty` L238–249，`waitForRecord` 默认 `timeoutMs 60_000`、watch+25ms 轮询，L188–236）。
- **test 级超时**：test 1 `30_000`（L453）；test 2–6 各 `120_000`（L520/534/558/573/593）。六项最坏合计 630s。

### 3.1 Test 1：真实 Pi Expect PTY 落盘 assistant 响应并在运行中保持 active owner（L453–518，ready）

- 启动：独立临时根 `mkdtemp("session-owner-pty-")`（**未 realpath**，断言已按 resolve/realpath 双形式自洽，见 L472/L496–497）；expect 先等 prompt 回显，再等 `deterministic` 响应 → `send_user PI_OWNER_READY`。
- 断言：record `active`、`cwd===realpath(cwd)`、`sessionFile` 前缀 `root/sessions`；sessionDir 恰 1 个 JSONL 且内容 match `/deterministic/`（真实落盘证据）。
- 退出清理（**绿灯零 SIGKILL**）：`child.stdin.end("PI_OWNER_QUIT\n")` → expect `send "\004"`（EOF）→ pi TUI 优雅退出（extension `session_shutdown(reason=quit)` → `releaseOwnRecord`，lifecycle.ts:328–330）→ expect `eof→exit 0`；断言 exit 0 且 `listLiveRecords=[]`（L505–512）。
- 失败兜底：finally `if (child && child.exitCode===null) child.kill("SIGKILL")`（L515）——**仅 expect wrapper**（测试进程自身直接子进程），正常路径不触发；wrapper 死后内核关 pty master → SIGHUP 给前台进程组回收残余 pi；临时根 rm。
- 风险：若 pi 对 SIGHUP 不退出（理论上 TUI raw mode 不改默认 disposition，风险极低），会遗留持有已删除路径的孤儿进程 → 记入 fail-closed 停止条件 §9.3-d。

### 3.2 Test 2：active recent blocks a second -c before real Pi exec（L520–533，ready）

- 流程：`freeSession`（launch→record active→quit，合法 public 入口造 session fixture）→ `readyPty --session <file>`（旧 owner active）→ `assertBlocked ["-c",…]`：等待「Pi session 已阻断」、exit 1、**registry 仍 1 条**、**sessions 目录清单不变**（阻断先于任何真实 Pi 执行的直接证据）。
- 清理：finally `stopPty(first?.child)`（quit 优先、SIGKILL 仅 quit 失败兜底且只打 wrapper）+ rm。绿灯零 SIGKILL。
- 风险：无独立于公共面的风险；阻断文案来自 launcher（pi-launcher.zsh:42），不依赖 extension。

### 3.3 Test 3：-c pins the exact free recent session while another old session is active（L534–557，ready）

- 流程：两个 `freeSession`（old/recent）→ owner 挂在 oldSession → `utimes` 把 old mtime 拨后 60s、recent 拨到 now（**临时 fixture 文件的时间戳操作**，合法）→ `-c` 期望精确 pin `recentSession`（free recent），且 ≠ owner 的 oldSession。
- 清理：`quitPty(continued)` 后 finally `stopPty(continued)/stopPty(owner)`；绿灯零 SIGKILL。
- 风险：`-c` recent 解析按真实 mtime 排序（docs/session-owner.md 启动矩阵），`utimes` 幅度 60s 足够区分；无跨测试状态（临时根独立）。

### 3.4 Test 4：--no-extensions cannot bypass an active owner（L558–572，ready）

- 流程：freeSession → owner 以 `--no-extensions --session <file>` 启动且必须 `active`（launcher 末尾 `exec … -e "$root/pi/extensions/session-owner.ts"` **无条件**追加，pi-launcher.zsh:59；与 pi-shell.zsh「--no-extensions 下仍加载」注释一致）→ `assertBlocked ["-c",…]`。
- 这是真实产品强制路径（不是 fixture 特判）：用户级绕过企图在 prepare/exec 层失效。
- 清理：finally `stopPty(first)`；绿灯零 SIGKILL。

### 3.5 Test 5：selecting picker blocks -c and --session reuse before either Pi executes（L573–592，ready）

- 流程：freeSession → `startPicker`（`-r`，expect 等 `PI_PICKER_READY`）→ registry 出现 `state==="selecting"` record → 两次 `assertBlocked`（`-c` 与 `--session` reuse，均 exit 1、无新 record、无 session 文件）→ `cancelPicker`：stdin `PI_PICKER_CANCEL` → expect `send "\003"`（Ctrl-C）→ picker 退出。
- 清理：finally `killPty(picker)`——`killPty`（L260–264）对 `exitCode!==null` 直接 return，故**成功取消后是 no-op**；仅取消失败时 SIGKILL wrapper（测试自身直接子进程）。绿灯零 SIGKILL。
- 风险：`cancelPicker`（L273–280）不断言 exit code（设计如此：finally 兜底覆盖）；若 Ctrl-C 后 picker 卡死，失败模式 = finally SIGKILL wrapper + pty SIGHUP，有界。

### 3.6 Test 6：SIGKILL owner is cleaned by ESRCH before the next wrapper starts（L593–634，needs-permission）

- 流程：`readyPty -- "killable owner"`（带 trace）→ 断言 `record.pid !== child.pid`（registry 记的是真实 spawned Pi，即 expect 子进程经 exec 链的同一 PID）→ **L603 `process.kill(killedPid,"SIGKILL")`（kill 对象 = 本次运行自造 record 中的 fixture Pi PID）** → 等 wrapper exit → ESRCH 探针循环（`kill(pid,0)`，10s/25ms，L612–615）→ `listLiveRecords` 观察（此时 `recordsLocked` 对 ESRCH record 执行 `unlinkSync`，registry.ts:411–413——清理即发生在这次观察里，也可由下一个 wrapper 的 prepareLaunch 完成）→ 第二个 wrapper 正常启动且 registry 恰 1 条新 ownerId → quit。
- 唯一价值面（替代方案不可完全覆盖）：真实 Pi 写入的**真实 PID** record + expect 对 zombie 的 reap 时序（被 kill 的 pi 在 wrapper 退出前是 zombie，`kill(pid,0)` 对 zombie 成功——测试注释 L596–601 已论证探针必须排在 wrapper exit 之后）+ 下一个 wrapper 启动前的清理闭环。registry 层 ESRCH sweep 已由 S1a 单测覆盖（acceptance record §3.4），纯 registry 复造不能替代这条端到端链。
- 其余清理：finally 写 trace（仅当 `T8_TRACE_FILE` 设置）→ `stopPty(second)` → `killPty(first?.child)`（first 已退出则 no-op）→ rm。**passing run 中全测试文件唯一一次主动 SIGKILL 就是 L603。**

## 4. 公共基建 API 面与风险速查

- `startPty`（L85–111）：JSON 逐参引号拼 expect 脚本，无 shell 注入面；marker 屏障 + EOF 协议。
- `startPicker`（L113–130）：同上，`-r` + Ctrl-C 取消协议。
- `waitForOutput`（L132–143）：stdout/stderr 合流匹配，child error/exit 即 reject 并附已捕获输出（内容仅 fixture 文案）。
- `readyPty/quitPty/killPty/stopPty/cancelPicker/freeSession/assertBlocked`（L238–299）：见 §3 各条；`assertBlocked` 同时核验「无 record + sessions 清单不变」双 fail-closed 证据。
- `waitForRecord`（L188–236）：watch+轮询双通道、`REGISTRY_UNAVAILABLE` 吞掉重试、其余错误立即 reject；本地实现，不依赖 SDK 内部。
- registry guard：所有 record 读写走 `.guard` 0600 独占（registry.ts `acquireGuard`），测试内并发仅存在于自身 wrapper 之间；guard 陈旧在临时根内不可能继承用户状态。

## 5. SIGKILL 授权缺口专项（test 6）

### 5.1 kill 对象全量清单（一次 passing run）

| 信号 | 对象 | 触发点 | 授权属性 |
|---|---|---|---|
| SIGKILL | fixture Pi（`first.record.pid`，expect 子进程 exec 链同 PID） | L603，test 6 主动 | **需单独授权**（本行） |
| SIGKILL | expect wrapper（测试进程自身直接子进程） | L263 `killPty`（test 5/6 finally、stopPty 兜底）、L515（test 1 兜底） | 测试对自生子进程的常规清理权；绿灯不触发 |
| 信号 0 | 同 killedPid（liveness 探针） | L614 | 无副作用 |
| SIGHUP（内核） | wrapper 退出后 pty 前台进程组 | expect 死亡→master 关闭的内核行为，非测试主动 kill | 内核语义 |

### 5.2 为什么不继承 H2 一次父 kill 授权，以及三个处置选项

H2 的授权对象是那次运行的父进程 kill，形状与「SIGKILL 一个由 expect spawn、PID 取自临时 registry record 的 fixture Pi」不同；按 dispatch 合同不能默认继承。选项：

- **A（推荐，needs-permission）**：给一次显式 scoped 授权，语言建议：「允许在本次 visible-host 窗口内、由 `node --test --test-name-pattern='^真实 Pi PTY: SIGKILL'` 进程执行的测试代码，对满足以下全部条件的 PID 发出至多一次 SIGKILL：(a) PID 来自本窗口临时 registry（`os.tmpdir()` 下 mkdtemp 根）中由本窗口 wrapper 刚写入的 record；(b) 该 record 的创建可追溯到本窗口 expect wrapper 的 spawn 链；(c) SIGKILL 发出后立即等待 wrapper exit 并做 ESRCH 探针，禁止对该 PID 之外的任何进程发信号」。expect wrapper 自身兜底 SIGKILL 属测试对自生子进程的清理，包含在「本窗口自生进程树」内。
- **B（安全替代，弱化覆盖）**：本窗口只跑 test 1–5（零主动 SIGKILL，passing run 无任何 kill），test 6 记 `blocked-permission`；ESRCH 清理语义引用 S1a registry 级证据（acceptance record §3.4），并在账面明确「真实 Pi PID + zombie reap 时序的端到端链未验证」。不伪造通过。
- **C（需改测试，本任务不做，仅设计备案）**：合成「自然死亡 PID」record（spawn 短命进程→自然退出→以该 PID 写 record）可免 kill，但会同时失去真实 Pi record 与 reap 时序两个断言面，只等价于重跑 S1a；若要走此路须 fixture-correction 授权，不属于本次 read-only 范围。

### 5.3 PID 复用与运行期核验

- L603 之前 `killedPid` 来自 readyPty 刚返回的 record；pi 若在此窗口内自行退出且 PID 被系统复用（macOS 环绕式复用，需数万进程更替，亚秒窗口内概率可忽略但非零），SIGKILL 可能命中无关进程。**缓解（不改测试，写进执行合同）**：运行窗口保持机器安静；SIGKILL 授权语言限定 (a)(b)(c) 三条件；出现 `assert.notEqual(record.pid, child.pid)` 或 ESRCH 探针异常即停止。
- **运行期核验步骤（首次执行 test 6 时做，不预先假设）**：观察 L605–607 wrapper 是否在 SIGKILL 后 ≤20s 退出。机制分析（§7-A）：wrapper 卡在 `expect_user -re {PI_OWNER_QUIT}`，Expect 文档只说 expect_user 读 stdin（man expect:675–679），未承诺 spawned-eof 会唤醒它；但脚本 `set timeout 20` 使 expect_user 20s 超时后**静默落空继续下一条**（无 timeout action），随后的 `send "\004"` 至已死 pty 要么无害要么 Tcl 报错终止，最终裸 `expect{eof}`/异常退出都会让 wrapper 在 ≤20s 内退出——测试对 exit code 无断言（仅等 exit 事件），故两种回落都成立。失败模式有界：最长 20s 延迟，不会把 10s ESRCH 窗口耗尽（探针在 wrapper exit 之后才开始）。若实测 wrapper 不退出 → 触发 §9.3-e 停止条件，按 §7-B 设计备案走 fixture-correction，不得现场放宽。

## 6. 网络 / 用户配置 / 泄密审计

### 6.1 真实网络：无

- provider 为 extension 内注册的 `registerProvider("fake")`，模型调用走 `streamSimple`（纯进程内事件流，deterministic-provider.mjs:19–118）；SDK 侧 `model-runtime.js:513` 直接 `prepared.provider.streamSimple(...)`，无 HTTP 分支；`baseUrl:"http://127.0.0.1:9"` 是永不拨号的字面量。
- `--offline` 落地为 `PI_OFFLINE=1` + `PI_SKIP_VERSION_CHECK=1`（main.js:452–456）；interactive 模式无后台 catalog refresh（后台 refresh 仅 rpc 分支，main.js:765）；版本检查被跳过（main.js PI_SKIP_VERSION_CHECK 引用唯一在 L455）。
- `--version` 预检在 settings/网络路径之前 exit（main.js:500–504）。
- 结论：**测试内无任何出网请求面**；`auth.json/models.json` 即使被 Pi 在临时 agentDir 读写也不出网（`--provider fake` 不查凭据）。

### 6.2 用户配置：物理隔离

- 子进程 env 为白名单对象（非 `...process.env`）：无 ZDOTDIR/PI_CONFIG_HOME/XDG_*/用户 token；HOME/TMPDIR/agentDir/sessionDir/registry/workspace/goal 全部位于本次 mkdtemp 临时根（L76–82、L483–490）。
- launcher 的 decision_dir 在测试 TMPDIR 下且 0700 + 私有文件校验（pi-launcher.zsh:15–17、38–55）；`PI_SESSION_OWNER_REGISTRY` 显式继承临时值，不会写用户运行时 registry。
- 六测试 registry/session/agent 数据全部由真实 Pi 经 public 入口（launcher→prepare→exec `-e session-owner`）在临时根内合法自造，属「production public 入口合法造数据」，无 fixture 形状造假。

### 6.3 trace/log 不泄密（逐项内容审计）

- **test 6 trace**（L594、L630–631）：`piBinary` 路径、`piVersion` 字符串、events（时间戳/pid/ownerId/类型）、`recordSamples`（registry record 全量：ownerId/pid/state/cwd/sessionId/sessionFile——全为临时根路径与本地生成 ID）、wrapper 输出累积（fixture 提示词与 deterministic 回复的 TUI 投影）。**无 token/凭据/用户会话正文**。
- **decisions.log**（pi-session-owner.ts:80–93）：仅 `blocked/pin-session` 决策追加 `{timestamp,action,reason,conflictingOwnerId,pid,cwd}`，cwd 为 fixture cwd；落在临时 registry 内，随根销毁。
- **会话 JSONL**：内容 = fixture prompt + "deterministic"/fake provider 回复；api/provider 均为 "fake"，`apiKey:"not-used"` 从不出机。
- **console.error**（extension/registry 失败路径）：只含分类、reason、临时路径与错误消息，无凭据。
- 约束：`T8_TRACE_FILE` 若设置必须指向本窗口允许的写路径（建议临时根**外**的授权 artifact 目录——finally 写 trace 先于 `rm state.root`，写进 state.root 会随根丢失）；未设置则 trace 仅留进程内存，随测试结束丢弃。

## 7. fixture 修复 vs 真实缺陷（严格区分）

- **A. 条件性运行时假设（非缺陷，不阻塞）**：test 6 wrapper 退出依赖 `expect_user` 20s 超时回落（§5.3）。机制上两种回落路径都收敛到 wrapper exit，测试对 exit code 无断言，失败模式有界。处置：首次运行时按 §5.3 观察；若假设不成立，**设计备案**（不改 test，须另获 fixture-correction 授权）：kill 路径的 expect 脚本改为对 spawn id 显式 `expect -i $spawn_id eof`（或 `expect_background` 监听 spawn eof），使 wrapper 在 pi 死亡瞬间退出，消除 20s 依赖。
- **B. 无必须 fixture 修复**：六条测试的临时根/canonical 路径/双形式 sessionFile/utimes mtime/JSON 引号拼接均与 docs/session-owner.md 合同和 registry 严格比较语义自洽；`ptyFixture` 对 `PI_TEST_CODING_AGENT_ROOT` 缺省有 launcher 自愈路径；`spawnSync --version` 无超时参数属健壮性小瑕（受 test 级 timeout 约束，非阻塞）。
- **C. 无真实缺陷指控**：静态核对未发现 production 源码（registry/lifecycle/extension/launcher/prepare）违反 docs/session-owner.md 声明语义的点；本报告不做任何实现修改，也不要求任何 fallback 代码。
- **D. 数据合法性分类**：六条全部是「production public 入口合法造数据」（真实 launcher/真实 prepare/真实 Pi 在临时根写 registry 与 JSONL）；不存在 fake Pi 冒充（wrapper/contract 两套 11+15 项单测另行拥有 fake Pi 面，本批不涉及）。

## 8. writePaths / resources / visible-host / unit-runner 判定

- **writePaths（执行窗口需要）**：`os.tmpdir()` 下 mkdtemp 子树（home/agent/sessions/registry/tmp/cwd/workspaces/goals + launcher decision_dir）；可选 `T8_TRACE_FILE` 指向授权 artifact 路径。**不需要任何仓内写路径**（不改 test、不改 production、不落 docs）。
- **resources**：`/usr/bin/expect`(5.45)、`/bin/zsh`、`/usr/bin/stat`、Node≥22.19、仓内物理 SDK `dist/cli.js`、`PATH` 继承；并发 pi launcher ≤2（test 3 的 owner+continued、test 6 的先后两个）。
- **visible-host=1：需要**。六测试 spawn 真实 expect/pty/交互 TUI 进程树，且 test 6 需要跨进程 SIGKILL；unit-runner（进程内 node --test 沙箱）**不能替代**——若 unit-runner 禁止 spawn 真实二进制/PTY/信号则六项全不可行。建议拆分：test 1–5 可先在仅允许「自生子进程树管理」的窗口跑（零主动 SIGKILL），test 6 单独在含 §5.2-A 授权的窗口跑。
- **显式前置 env 建议**：`PI_TEST_CODING_AGENT_ROOT` 设为仓内 SDK 绝对路径（消除 undefined 传递歧义）；`T8_PI_REAL_BIN` 不设（用默认仓内 cli.js），如设必须与 launcher 解析一致；`T8_TRACE_FILE` 可选。

## 9. 可执行验收合同（供父调度直接引用）

### 9.1 命令与计数

```
node --test --test-name-pattern='^真实 Pi' test/session-owner-runtime.integration.mjs
```

- 精确匹配六项（文件内其余 8 项测试名前缀分别为 `waitForRecord`/`real AgentSessionRuntime`/`真实 SDK：`/`session_start `/`session_before_switch `/`owner-less`，不命中）。
- 预期：**6 tests / 6 pass / 0 fail / 0 skipped / 0 cancelled**，exit 0。预检顺序：`/usr/bin/expect -v` 可执行、`node --version`≥22.19、`node_modules/@earendil-works/pi-coding-agent/dist/cli.js --version` exit 0（此三条为窗口开场探测，非测试内执行授权的扩展）。
- 分粒度备用 pattern（拆窗口/授权隔离用）：test1 `'^真实 Pi Expect PTY'`；test2–5 `'^真实 Pi PTY: (active recent blocks|-c pins|--no-extensions|selecting picker)'`；test6 `'^真实 Pi PTY: SIGKILL'`。
- 时长预算：常规 2–5min（约 13–15 次真实 pi 冷启动 + test6 ≤20s kill 回落）；硬上限 = Σtest timeout 630s；外层再包 `timeout 900` 防悬挂。

### 9.2 通过判据（每条的可见证据）

- test1：`PI_OWNER_READY` marker + record active + sessionDir 恰 1 个含 `deterministic` 的 JSONL + quit exit 0 + registry 空。
- test2/4/5：blocked wrapper 输出「Pi session 已阻断」+ exit 1 + registry 计数不变 + sessions 清单不变。
- test3：continued record.sessionFile === recentSession 且 ≠ owner 的。
- test6：`record.pid≠child.pid` → SIGKILL 后 wrapper exit → ESRCH 探针 true → second record 唯一且 ownerId 不同 → quit。

### 9.3 fail-closed 停止条件（命中即停，不得放宽断言或重试换语义）

- a) 开场三预检任一失败（expect 缺失/Node<22.19/`--version` 非 0）→ 不进任何 PTY。
- b) 任一 `assertBlocked` 出现新 record 或 sessions 清单变化 → 停（阻断层被击穿是产品级信号，不是 flake）。
- c) test6 ESRCH 探针 10s 内未观测到 ESRCH → 停，账面记 fail；不得改成跳过探针。
- d) 任何 wrapper quit 失败且 SIGKILL 兜底后仍检测到存活孤儿 pi → 停并报告孤儿 PID/启动时间（持有已删除临时路径）。
- e) test6 wrapper 在 SIGKILL 后 >20s 未退出（§7-A 假设被证伪）→ 停，转 §7-B 设计备案。
- f) registry `.guard` 异常（`registry-busy` 持续）→ 临时根内应不可能陈旧；若出现说明窗口被外部 registry 污染 → 停。
- g) `T8_TRACE_FILE` 目标不在授权写路径 → 取消该 env 再跑，不得临时扩权。
- h) 授权窗口内出现任何非 §5.1 清单内的 kill 需求 → 停。

## 10. 证据索引（file:line）

- 启动命令/预检：`test/session-owner-runtime.integration.mjs:65-83`（ptyFixture+--version 预检）、`pi-launcher.zsh:1-13`（node/SDK 解析）、`main.js:500-504`（--version 即退）、`main.js:452-456`（--offline 落地）、`cli/args.js:37-39`。
- env 隔离白名单：`integration.mjs:76-82`（test2–6）、`:483-490`（test1）；`test/helpers/test-runtime.mjs:1-27`；`pi-runtime.mjs:14-26`（物理 SDK 不回退 global）。
- 进程树/kill：`integration.mjs:102`、`:129`（expect spawn）；`:260-264`（killPty→SIGKILL wrapper）、`:267-271`（stopPty）、`:273-280`（cancelPicker）、`:515`（test1 兜底）、`:603`（**SIGKILL fixture Pi**）、`:612-615`（ESRCH 探针）、`:596-601`（zombie 时序注释）；`pi-launcher.zsh:56-59`（exec 链同 PID）、`pi-session-owner.ts:35-37`（--pid $$）。
- 清理语义：`lifecycle.ts:328-330`（quit→releaseOwnRecord）、`registry.ts:411-413`（ESRCH unlink）、`registry.ts:226-253`（guard 独占）。
- 无网络：`deterministic-provider.mjs:19,63-118`（streamSimple 进程内）、`model-runtime.js:513`（直调 provider.streamSimple）、`main.js:765`（rpc 才后台 refresh）。
- 阻断面：`pi-launcher.zsh:42`（已阻断文案）、`pi-session-owner.ts:44-47,80-93`（bypass/审计日志）、`assert-session-tool-policy.ts:1-11`。
- 超时：`integration.mjs:87,115`（expect timeout 20）、`:145,169,453,520,534,558,573,593`（test 级 timeout）、`:190`（waitForRecord 60s）。
- expect_user 语义：`man expect`（macOS 5.45）L675-679（expect_user 读 stdin）、L614-631（expect_background 对照，仅用于 §7-B 备案）。
- 历史定位：`docs/plans/records/2026-10-13-session-owner-acceptance.md` §2/§3（六项 blocked-environment 出处、unit 窗口既有 8/8 证据）、`docs/session-owner.md`（启动矩阵/切换事务/ESRCH 清理/回归覆盖）。
