# 集成测试的 Host 二进制解析不一致：一处静默回退到过期全局 pi

- 日期：2026-10-01
- 级别：P1（测试基础设施缺陷；直接污染缺陷归因，并已导致一次错误定性）
- 状态：已定位，待修（需先由 T8/T7 的 A/B 对照实验闭合因果）
- 关联：reviewer Blocker B3；`var/upgrade/t7-workaround-feasibility.md` §2.1；
  `var/upgrade/t8-bounded-experiment.md`（T8 版本错配已证实）

## 现象

三个被集成门禁排除的文件，对「用哪个 pi 作为真实 Host」的解析方式**互不一致**：

| 测试文件 | 解析方式 | 未设置 `PI_REAL_BIN` 时的行为 |
|---|---|---|
| `test/pi-subagents-runtime.integration.mjs:15` | `process.env.PI_REAL_BIN`（无回退） | `assert.ok(piBinary, "PI_REAL_BIN must point to an explicitly supported Pi runtime")` → **响亮失败** |
| `test/subagent-auto-integration-resumed-child.integration.mjs:16` | `process.env.PI_REAL_BIN ?? "/opt/homebrew/bin/pi"` | **静默回退到全局 pi** |
| `test/session-owner-runtime.integration.mjs`（原状） | `PI_REAL_BIN: "/opt/homebrew/bin/pi"` 硬编码 | 静默使用全局 pi |

其余同类文件（`pi-subagents-project-workflow`、`subagent-runtime-root-broker-startup` 等）
均为「无回退 + `assert.ok(piBinary, ...)`」的响亮失败模式，属正确写法。

## 关键事实：没有任何 script 注入 `PI_REAL_BIN`

```
test:all-integration = node scripts/run-integration-gate.ts
test:subagents       = node --test test/pi-subagents-runtime.integration.mjs
```

`scripts/run-integration-gate.ts:52` 的子进程环境是
`{ ...process.env, TMPDIR: process.env.TMPDIR ?? "/tmp" }` —— **不注入 `PI_REAL_BIN`**。
`test:subagents` 是裸 `node --test`，同样不注入。

因此 `PI_REAL_BIN` 只可能来自**执行者的环境**。推论：

1. `pi-subagents-runtime.integration.mjs` 在未显式设置该变量的环境里**根本无法运行**
   （立即断言失败）。而它被排除的理由是 `WIRED-ELSEWHERE: 已由 test:subagents script 维护验收`
   —— 这精确印证 reviewer 的判断：**「有独立 script 不等于有通过的门禁」**。
   所谓 3/5 的结果，必然是在某个 ambient 设置了 `PI_REAL_BIN` 的环境里得到的，
   而该环境未被记录、不可复现。
2. `subagent-auto-integration-resumed-child.integration.mjs` 在同样环境里**不会失败**，
   而是静默使用 `/opt/homebrew/bin/pi`。

## 版本事实（绝对路径核实，2026-10-01）

```
$ /opt/homebrew/bin/pi --version
0.85.1
$ stat -f '%Sm' /opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js
2026-09-12 20:14:34            # 数周未变；T12 第三段「全局安装 0.87.1」尚未执行
$ which -a pi
/opt/homebrew/bin/pi           # PATH 上只有这一个
$ ./node_modules/.bin/pi --version
0.87.1                         # 本仓 repo-local
```

即：**全局 pi = 0.85.1，本仓 = 0.87.1，二者并存**。

## 后果：一次已证实的错误定性

`test/session-owner-runtime.integration.mjs` 的 PTY 用例长期被定性为
「夹具时序脆弱（SIGKILL 接管超 60s 预算）、非生产缺陷」。T8 的有界实验**证伪**了它：

- registry record 在 63 秒内被采样 **15668 次恒为空**（不是状态不对，是根本没有记录）
  → 不是「晚到」，是「永不到」；
- 失败发生在**第一个** owner，根本没走到 SIGKILL 接管阶段；
- 原诊断依赖的 `PI_OWNER_READY` 标记**并非 pi 或扩展打印**，而是 expect 脚本自己
  `send_user` 的（原 `:362`，匹配到 provider 名 `deterministic` 就发）
  → 把「进程启动」误当成「扩展注册成功」；
- 真实机制：`scripts/pi-launcher.zsh:5` 的 `$root` = 本仓，`:92`
  `exec "$real_bin" -e "$root/pi/extensions/session-owner.ts"` —— 用**全局 0.85.1 Host**
  加载**本仓 0.87.1 时代的扩展**（`pi/extensions/session-owner.ts:1` import
  `../../src/session-owner/extension.ts`），扩展在旧 Host 下未成功注册 → record 恒空。

## 对 T7 归因的影响（尚未闭合）

`var/upgrade/t7-workaround-feasibility.md` 已确证两件事：

- **上游代码缺口真实存在且与 Host 版本无关**：`pi-subagents@0.71.0` 的
  `runs/foreground/subagent-executor.js:2938-3002`，`runAsyncPath` 调 `executeAsyncSingle`
  时未复制请求级 `params.subagentOnlyExtensions`；`async-execution.js:1599-1605,1744-1746`
  只读 `agentConfig.subagentOnlyExtensions`，而 workflow 注入值不在 agent profile 上
  → step 缺该字段。runner 读取点 `subagent-runner.js:510/:867` →
  `runner-child-launch.js:31-33`，**runner 不是首个偏离点**。
- **child 是进程内拉起**（由本仓 pinned `pi-subagents@0.71.0` 的 runner，
  经 `subagent-runner-bootstrap.js:163-167`、`child-session.js:10-16,151-166`），
  **不经全局 pi 二进制** → 该子假设已排除。

但 **root Host 仍是 `PI_REAL_BIN ?? /opt/homebrew/bin/pi` = 0.85.1**，与 T8 已证实的错配
模式同构。因此「观测到的挂起是否由该上游缺口造成」尚未闭合：缺口客观存在，
但它在**当前这个版本错配环境**下是否是挂起的实际原因，需要 A/B 对照实验才能定论。

## 修复方向

1. **统一 Host 二进制解析契约**：所有需要真实 Host 的集成测试一律
   「无回退 + 响亮断言」，或统一优先 repo-local pi（如 T8 已改的
   `process.env.T8_PI_REAL_BIN ?? repoLocalPi` + 记录 `T8_PI_VERSION`）。
   **禁止**任何测试静默回退到一个可能滞后于本仓的全局安装。
2. **由 gate runner 显式注入** `PI_REAL_BIN`（指向 repo-local cli），使集成门禁
   **自洽可复现**，不依赖执行者 ambient 环境；并在日志中记录所用 Host 版本。
3. 修正 `scripts/run-integration-gate.ts` 排除表中 `WIRED-ELSEWHERE` 的表述：
   `test:subagents` 在未注入 `PI_REAL_BIN` 时无法运行，不构成有效门禁。
4. 闭合 T7 因果：对 `subagent-auto-integration-resumed-child.integration.mjs` 做
   `PI_REAL_BIN` = 全局 0.85.1 / repo-local 0.87.1 的 A/B 对照，观测挂起是否仍复现。

## 数据来源分类

**类别 2（测试制造的非预期数据）为主**：缺陷位于测试基础设施（Host 解析契约不一致），
不是 production 代码。但其**后果**是污染了对 production 缺陷的归因判断
（已导致 T8 一次错误定性），故必须按 P1 处理，且不得据此为 production 增加兼容分支。

注：T7 涉及的上游 `subagentOnlyExtensions` 传播缺口属**类别 1**（production 可达的真实缺陷），
与本条测试基础设施缺陷是**两个独立问题**，不可混为一谈。
