# session-owner-install lane 失败取证（wrapper exit 1）

取证 child：delegate `2f0279c7-a9c4-46bd-a3fd-91bbbfbe7efb`（纯静态，未启动 Host/pi/expect）；实验阶段续跑 `cfe69aef-1027-45be-a193-124547f97b93`。完整原文见其 async dir 与 session 文件。

## 对主会话三处错误前提的更正（必须先记住）

| 我此前记录的说法 | 现场核对结果 |
| --- | --- |
| 用例名 `installs the session owner guard without clobbering concurrent Pi locks` | 全仓 grep 0 命中、`git log --all -S` 0 命中。该文件真实用例只有 3 个：`test/session-owner-install.integration.mjs:206 / :222 / :243`。对应本次失败的是 `:222` `fresh zsh wrapper invokes official Pi version in an isolated environment and cleans its ESRCH record` |
| 失败文本 `wrapper exited with code 1` | 全仓 grep 0 命中（`src/basic-memory/extension.ts:56` 是无关的 `basic-memory exited with code`）。仓库里不存在这句话 |
| “约 30s 后、stdout 与 stderr 均为空” | 历史三次运行真实耗时 **1746/1751/1791ms**（`/tmp/rc-gate-remediation.log:44,137`、`/tmp/rc-baseline-compare.log:44`、`/tmp/rc-integration-gate-full.log:447`）；首个失败点 `:235 assert.equal(result.status, 0, result.stderr)` → `1 !== 0` 且**断言消息为空**。被证据支持的只有“stderr 空”；`:236` 的 stdout 断言从未执行，harness 从未打印 stdout ⇒ “stdout 也空”**未被观测** |

## 执行链（逐层，坐标已核对）

node 测试 `:222-241`（`:233 runOfficialFreshZsh` → `:234 assertCompleted` → `:235`）；fixture 构造 `:53-112`（`repo=<root>/installed-pi-config`，拷贝清单 `:63-68` 只有 `init-pi.sh`、`packages/pi-subagents-enhanced/src/host-runtime`、`scripts`、`src`、`pi/extensions`、`pi/settings.template.json`；**全文件 `node_modules` 0 命中**；`:72` 写 `.zshrc` 种子、`:74-96` 造 `bin/{git,npm,uv,zsh,chmod,mkdir,dirname,node}`、`:99-109` 造 fake pi、`:110` symlink）；env 从零构造 `:27-45`（不继承 `process.env`，PATH=`<fixture bin>:<ambient PATH>`，HOME/ZDOTDIR/TMPDIR 全接管，`:37` 注入 physicalLauncherFixture，`:38-40` 注入 isolated agent/session/registry）；official env `:146-153`（用 **ambient** `PI_TEST_CODING_AGENT_ROOT` 覆盖 `PI_HOST_ROOT`/`PI_PACKAGE_DIR`，ambient `PI_REAL_BIN`（`:144`）覆盖 `PI_REAL_BIN`）；expect 层 `:174-180`（`spawnSync("/usr/bin/expect", ["-c", program], {cwd: state.repo, env: officialEnv})`）；expect 程序 `:163-172`（`set timeout 20`；`:164 spawn -noecho /bin/zsh -f -c {…}`；`:165-169 expect { -re <版本> {} / eof {exit 1} / timeout {exit 1} }`；`:170 expect eof`；`:171 wait`；`:172 exit $status`）；zsh `:164`（`source "$ZDOTDIR/.zshrc"` → init-pi.sh 生成的 `[[ -f <repo>/scripts/pi-shell.zsh ]] && source …`，再 export 三个 `ISOLATED_*`，再 `pi --version`）；`pi` 是 shell function（`scripts/pi-shell.zsh:11-20`）→ `scripts/pi-launcher.zsh`；launcher 预检 `:7-16`（`:10 assert-session-tool-policy.ts`、`:11-12` node 版本、`:13 export PI_HOST_ROOT="${PI_HOST_ROOT:-$root/node_modules/@earendil-works/pi-coding-agent}"`、`:14 real_bin=$(node scripts/resolve-physical-pi.ts) || exit 1`）；最终 official pi `node_modules/@earendil-works/pi-coding-agent/dist/main.js:500-503`（`--version` 分支是这条链上**唯一**会写 stdout 的东西）。

## 分层判定

已被证据排除：expect 的 spawn 失败/Tcl 语法错/`wait` 出错（会写 expect 自己的 stderr，与“stderr 空”矛盾）；`timeout {exit 1}`（实测 1.7s ≪ 20s）；zsh 层早退/`type pi` 失败/PATH 缺 pi（`:164` 显式 source，且**同文件 `:206` 用例走完全相同的 zsh→expect→launcher 链是通过的**，历史日志 `✔ fresh init installs an idempotent owner-wrapper shell entrypoint (4011ms)`）；node 侧传播加工（`:234 assertCompleted` 未触发，`:235` 直接取 `result.status`）。

最可能层：**wrapper 的 physical Host 绑定预检 `scripts/pi-launcher.zsh:13-14`**。`:206` 与 `:222` 的唯一决定性差异是 host 绑定来源——前者用 `physicalLauncherFixture`（`test/helpers/physical-launcher-fixture.mjs:6-12`）造出真实存在的 physical 形状目录，后者用 `:148` 的 ambient `PI_TEST_CODING_AGENT_ROOT`。已实测：Node 会丢弃值为 `undefined` 的 env 项 ⇒ 该变量未设时子 env 里**根本没有** `PI_HOST_ROOT`；且本会话 ambient 未设 `PI_TEST_CODING_AGENT_ROOT`（`:27-45` 从零构造 env，救不了）。于是 `:13` 回落到 `$root/node_modules/@earendil-works/pi-coding-agent`，而 `makeFixture` 从不创建 `node_modules` ⇒ `scripts/resolve-physical-pi.ts:5` 的 `realpathSync(hostRoot)` 抛 ENOENT（已实测：`PI_HOST_ROOT=/tmp/definitely-missing-physical-host node scripts/resolve-physical-pi.ts` → ENOENT + `exit=1`，**明确报错**）⇒ `:14 || exit 1` ⇒ zsh 退出 1 ⇒ expect `:167 eof {exit 1}`。相关性佐证：同一次门禁里 joint-upgrade 13 项失败的首个偏离点也是 `PI_TEST_CODING_AGENT_ROOT` 未设。

“两个流都空”的机制（`man expect` 现场核对）：`-noecho` 只关掉“回显 spawn 命令行”（`:1191-1197`），与 `log_user` 无关；spawn 内部用 pty，子进程 stdout 与 stderr **合并在同一 pty** 并被 expect 重写到 **expect 自己的 stdout**（`:1197`、`:966-970`）。三条硬结论：(1) `result.stderr` 只可能装 expect/Tcl 自己的诊断，**永远装不到 wrapper 的错误输出** ⇒ `:235` 用 `result.stderr` 当断言消息在“子进程失败”情形下**结构性恒为空**，它不能作为“子进程静默”的证据；(2) 因此 **stdout 才是唯一可判定的观测量**，若假设成立应能在 `result.stdout` 看到 `ENOENT: … lstat '<tmp>/installed-pi-config/node_modules/@earendil-works/pi-coding-agent'`；(3) 若复跑证明 stdout 也为空，则该假设被否证（该失败路径是响亮的），剩余候选几乎穷尽（`:11 node_ok` 需 node<22.19，实测 v26.8.1；`:19/:20 mktemp/chmod` 失败会打印；`dist/main.js:500` 的 `--version` 必打印），此时需检验另一个机制：**expect 的 stdout 是管道时 Tcl 通道是否在 `exit` 前 flush**；若不 flush，pty 日志整体丢失，“两流都空”与假设并不矛盾。

本机环境相关性：硬依赖 `/usr/bin/expect`（实测 5.45）与 `/bin/zsh`（实测 5.9 arm64）；ZDOTDIR/HOME 被接管，但 **PATH 尾部是 ambient PATH**（`:15`、`:29`）；`zsh -f` 不读 `/etc/zshrc`（存在）、`/etc/zshenv`（不存在）、`~/.zshenv`（仅设 `path=`）⇒ 本机全局 zsh 配置污染可能性很低。真正与环境耦合的是两个 ambient 变量：`PI_REAL_BIN`（未设会在 `:156` 抛 TypeError，与观测到的 `1 !== 0` 不符 ⇒ 门禁里是设了的）与 `PI_TEST_CODING_AGENT_ROOT`（本会话未设）。倾向：**门禁/本机 env 与测试自足性不匹配，不是 production 代码缺陷**。

## 三分类结论

**类别 3：来源尚未证实**（fail closed，不猜测）。高置信假设形态属**类别 2**（fixture 不自足：`:146-153` 依赖 ambient 变量，而 `makeFixture` 未为 `pi-launcher.zsh:13` 的回落路径准备 `node_modules`）。**不是类别 1**：wrapper 与 `resolve-physical-pi.ts` 的行为是设计内 fail-closed 且明确报错，没有“预期 production 数据未被正确处理”的证据。收敛所需三项证据：① 失败 run 的 `result.stdout`（或 pty 日志）首个偏离点；② 该 run 的 ambient `PI_TEST_CODING_AGENT_ROOT` 是否为空；③ Tcl 管道 flush 语义（决定 ① 是否可信）。

**不需要任何 production 兼容/防御/fallback 分支。** 另记 helper 诊断缺陷（独立于本次失败）：`:235` 用 `result.stderr` 作断言消息、`:236` 的 stdout 断言因 `:235` 中止而永不可达 ⇒ 任何 wrapper 失败都表现为“无信息”。

## 已授权的收敛实验（child `cfe69aef`，串行，禁改文件/禁 commit）

1. 实验 3（先做，最便宜）：`/usr/bin/expect -c 'spawn -noecho /bin/sh -c {printf x; printf err >&2; exit 1}; expect eof; exit 1' | od -c | head` → 定 stdout 是否可信。
2. 实验 2（决定性）：`PI_TEST_CODING_AGENT_ROOT=<repo>/node_modules/@earendil-works/pi-coding-agent PI_REAL_BIN=<repo>/node_modules/@earendil-works/pi-coding-agent/dist/cli.js node --test --test-name-pattern 'fresh zsh wrapper' test/session-owner-install.integration.mjs` → 转绿即类别 2（门禁缺 ambient env）；仍红则记 stdout 首个偏离点原文。
3. 实验 1（仅在前两者不足时）：复刻 `:163-172` 的 expect 程序并 `2>&1 | tee /tmp/so-pty.log` 抓 pty 侧真实输出。

若实验 2 转绿，还需回答正确修法是“gate runner（`scripts/run-integration-gate.ts`）导出该 ambient 变量”还是“fixture 自足（`:146-153` 不依赖 ambient、`makeFixture` 自带 physical host 形状）”，以及 helper 诊断缺陷的最小修法——**只建议，不实施**，由主会话决策。
