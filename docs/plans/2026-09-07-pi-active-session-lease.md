# Pi 活动 Session 独占租约实现计划

> **给执行 agent：** 必须逐任务执行本计划；步骤使用 `- [ ]` 复选框跟踪。执行方式由计划完成后的用户选择决定。

**目标：** 防止多个 Pi 进程同时写入、替换或删除同一个持久化 session；交互式 `pi -c` 命中活动 session 时进入 `pi -r` 选择器；独立定位 subagent tool call 长时间停留在 `starting` 的首个阻塞阶段，以及无同 cwd 活动 session 时 idle Pi 突然显示 working 的触发来源。

**架构：** 核心修复在上游 `earendil-works/pi` 的 `packages/coding-agent` 完成。先冻结 0.84.4 基线并枚举全部 session 文件写入口，再以原子 `O_EXCL` 创建实现跨平台单写者 lease；正常退出释放，异常崩溃留下的 stale/corrupt lease 一律 fail closed 并要求人工恢复，不做存在 ABA 风险的自动接管。`SessionManager` 统一持有 owner lease，import、fork、rename、delete 与 runtime replacement 通过事务化 API 消费。同步派发卡顿与 idle-working 闪现属于独立诊断路径，仅增加显式启用的结构化 phase trace，不预设重试或 fallback。

**技术栈：** Node.js `>=22.19.0`、TypeScript、Vitest（上游 Pi）、Node test runner（本仓库）、Pi Extension/RPC event bus。

## 全局约束

- 仓库和 package 的最低 Node 版本固定为 `>=22.19.0`。
- 生产代码、配置或 Skill 行为变更必须执行 RED-GREEN-REFACTOR；RED 必须是可加载测试中的行为断言失败，不得以模块不存在或测试执行错误代替。
- 缺陷修复前必须创建中文问题记录，记录实际入口、权威身份、事件与资源顺序、首个偏离点和 production 可达性分类。
- 文档、Skill 正文和代码注释必须使用中文，仅专业用词可豁免。
- 不得直接修改 `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/**`；核心改动必须进入上游源码并由同一 checkout 的源码测试和打包 CLI 验收。
- `pi -c` 命中活动 session 时，交互式 TUI 必须进入与 `pi -r` 相同的选择器；非交互模式必须明确失败。
- `-c`、`-r`、`--session`、`--session-id`、TUI `/resume`、RPC `switch_session`、SDK runtime switch/import/fork 必须复用同一所有权门禁。
- lease 身份必须包含 PID、无损且可由操作系统复核的进程启动身份、随机 owner ID 和 generation；PID 存在但启动身份不匹配时只标记 stale，不自动接管。
- lease 获取的线性化点固定为 `O_EXCL` 创建成功；不得把普通 check-then-write、固定路径 rename 或 mtime stale 判断视为 CAS。
- 打开、修复、覆盖、rename、trash、unlink session 文件以及启动 root broker 前必须持有相应写 owner。
- owner 发布不完整、PID 已退出、PID 复用、身份查询不确定、权限拒绝和锁后端异常必须 fail closed；production 流程不得自动删除任何现存 lease。
- 释放必须核对 owner ID 与 generation，并在停止 session 写入及 broker shutdown 完成后发生；dispose 后禁止继续 append。
- TUI 展示只能消费原始状态生成独立文本，不得为展示改写 event、tool result 或 session 内容。
- 不读取、记录或提交密钥、凭据和证书。
- `pi/settings.json` 的 `enabledModels` 与 `pi/models.json` 本机定义禁止提交。
- 同步派发卡顿和 idle-working 闪现当前分类均为“来源尚未证实”；完成各自 provenance 分类前禁止增加 production 重试、fallback、伪造 started handle、吞掉超时或放宽 completion ownership。
- 不自动发布 npm 包，不自动创建工单，不默认创建 git commit。

## 仓库边界

- **配置仓库：** `/Users/leshi.zhy/pi-config`。保存计划、问题记录、subagent 诊断插桩与探针、发布后版本固定。
- **上游 Pi 仓库：** 独立 checkout `https://github.com/earendil-works/pi.git`。标注 `[upstream pi]` 的路径均相对此 checkout 根目录。
- T1 必须将上游 checkout 固定到 npm `@earendil-works/pi-coding-agent@0.84.4` 对应 tag/commit；后续不得在未记录的移动分支上执行。
- 上游发布是人工门禁。T7 仅在用户确认采用且 npm 已存在包含本改动的正式版本后执行。

## Session 操作矩阵

| 入口 | 目标操作 | 冲突行为 |
| --- | --- | --- |
| TUI `-c` | 获取 recent session 写 owner | 进入 `-r` 选择器，活动项禁选 |
| print/json/rpc `-c` | 获取 recent session 写 owner | stderr 返回稳定 `SESSION_IN_USE`，非零退出 |
| TUI `-r`、`/resume` | inspect 列表，确认时获取写 owner | 活动项禁选；确认竞态时刷新且保持选择器 |
| `--session`、`--session-id` | 获取指定 session 写 owner | 所有模式均返回 `SESSION_IN_USE`，不自动改选 |
| RPC `switch_session` | 获取目标写 owner后替换 runtime | `success:false`；旧 runtime 保持可用 |
| SDK switch/import/fork | reserve 目标后执行事务 | 失败回滚；旧 runtime 或源 snapshot 保持有效 |
| rename/delete/trash | 获取目标写 owner | 活动目标拒绝；操作完成后释放临时 owner |

## DAG

```text
T1（基线、provenance、入口清单）
  └─> T2（纯文件 fail-closed 锁后端）
      └─> T3（lease 与 SessionManager 所有权）
           └─> T4（文件事务：import/fork/rename/delete）
                └─> T5（CLI/TUI/RPC/SDK 路由与生命周期）
                     └─> T6（真实双进程验收）
                          └─> T7（人工发布后采用）

T8（同步派发 phase trace 与 provenance，独立）──> T9（idle-working completion provenance）
```

## Waves

- Wave 1：T1、T8（可并行；T8 独占一个真实 Pi Host）
- Wave 2：T2
- Wave 2D：T9（仅依赖 T8 的 trace 基础设施，独占 `~/taoappuse` 复现 Host）
- Wave 3：T3
- Wave 4：T4
- Wave 5：T5
- Wave 6：T6
- Wave 7：T7

**关键路径：** T1 → T2 → T3 → T4 → T5 → T6 → T7。诊断路径 T8 → T9 独立，不阻塞已证实的重复 session 修复。

---

### Task 1：冻结上游基线并记录完整 Production 调用链

**Deps：** `none`

**WritePaths：**
- `docs/bugs/2026-09-07-pi-active-session-reopened.md`
- `[upstream pi] packages/coding-agent/test/session-single-writer.integration.test.ts`

**Resources：** 上游 Pi checkout；两个本地 Pi 进程；同一隔离 cwd 与 sessionDir；本地受控模型服务

**Files：**
- Create：`docs/bugs/2026-09-07-pi-active-session-reopened.md`
- Create：[upstream pi] `packages/coding-agent/test/session-single-writer.integration.test.ts`
- Inspect：[upstream pi] `packages/coding-agent/src/main.ts`
- Inspect：[upstream pi] `packages/coding-agent/src/core/session-manager.ts`
- Inspect：[upstream pi] `packages/coding-agent/src/core/agent-session.ts`
- Inspect：[upstream pi] `packages/coding-agent/src/core/agent-session-runtime.ts`
- Inspect：[upstream pi] `packages/coding-agent/src/modes/interactive/interactive-mode.ts`
- Inspect：[upstream pi] `packages/coding-agent/src/modes/interactive/components/session-selector.ts`
- Inspect：[upstream pi] `packages/coding-agent/src/modes/rpc/rpc-mode.ts`

**接口契约：**
- Consumes：npm 0.84.4 对应的固定上游 commit，以及真实 public CLI/SDK 入口。
- Produces：实际写入口清单，至少覆盖 `continueRecent` 直接构造、`open`、`create/newSession`、`setSessionFile`、branch/fork/forkFrom、import 的 pre-open copy、rename、trash/unlink、临时 manager、缺失 cwd 恢复、RPC switch 和所有 dispose/信号路径；同时产出一个可加载的双进程行为 RED。

**验收标准：**问题记录证明两个合法 Pi 进程可取得同一 session 的写能力，明确当前 `continueRecent()` 不经过 `open()`；测试通过现有 public API/CLI 加载后因“第二 writer 未被拒绝”而断言失败。

- [ ] **步骤 1：固定基线并核实命令**

  记录上游 commit、package version、`packages/coding-agent/package.json` 的真实 test/typecheck/build 命令，以及打包 CLI 的生成命令。

- [ ] **步骤 2：建立隔离 production fixture**

  使用独立 `PI_CODING_AGENT_DIR`、`PI_CODING_AGENT_SESSION_DIR`、临时 cwd 和本地受控模型服务；通过合法 public prompt 创建 session，不复制真实 auth 或配置。

- [ ] **步骤 3：编写可加载的双 writer RED**

  测试只 import 0.84.4 已存在的 public API，保持第一个 writer 活跃后打开第二个 writer，断言第二个得到稳定 `SESSION_IN_USE`；观察当前实现实际成功，测试以断言失败进入 RED。

- [ ] **步骤 4：运行并确认 RED**

  运行：`npm --prefix packages/coding-agent test -- session-single-writer.integration.test.ts`

  预期：FAIL，失败原因是第二 writer 未被拒绝，不是 import、fixture 或命令错误。

- [ ] **步骤 5：枚举并记录完整生成调用链**

  对照固定源码逐项记录所有文件变更入口、manager owner 转移、extension/broker 启停和信号处理，不把拟议重构写成当前事实。

- [ ] **步骤 6：完成数据来源分类**

  记录实际入口、权威 session/PID、文件与 broker 顺序、首个偏离点。若真实入口不能复现，则分类为“来源尚未证实”并停止 T2-T7。

### Task 2：实现并证明纯文件 Fail-Closed 锁后端

**Deps：** `T1`（理由：消费固定平台范围、完整入口清单和已确认 production RED）

**WritePaths：**
- `[upstream pi] packages/coding-agent/docs/session-lease-design.md`
- `[upstream pi] packages/coding-agent/src/core/session-lock-backend.ts`
- `[upstream pi] packages/coding-agent/test/session-lock-backend.contract.test.ts`
- `[upstream pi] packages/coding-agent/test/fixtures/session-lock-contender.ts`

**Resources：** macOS、Linux、Windows CI；真实子进程屏障

**Files：**
- Create：[upstream pi] `packages/coding-agent/docs/session-lease-design.md`
- Create：[upstream pi] `packages/coding-agent/src/core/session-lock-backend.ts`
- Create：[upstream pi] `packages/coding-agent/test/session-lock-backend.contract.test.ts`
- Create：[upstream pi] `packages/coding-agent/test/fixtures/session-lock-contender.ts`

**接口契约：**
- Consumes：T1 的平台、入口和崩溃窗口清单。
- Produces：同步 `SessionLockBackend.acquire(canonicalIdentity, owner, signal): SessionLockHandle` 固定契约；handle 提供 `owner`、`generation`、同步 `release()`。后端只使用 Node `fs` 原子 `O_EXCL` 创建，不新增依赖；设计文档必须列出线性化点、owner 完整发布协议、每个崩溃点、stale/corrupt 人工恢复状态和 macOS/Linux/Windows 支持矩阵。同步 facade 只执行本地有界文件与进程身份检查，不等待、不轮询、不访问网络。
- `ProcessBirthIdentity` 使用不透明、无损字符串，不把粗粒度 `ps lstart` 或 `Date.now() - uptime` 作为跨平台等价身份。

**验收标准：**后端通过真实多进程互斥、正常 owner 释放、PID 复用注入、完整发布崩溃点和确定性旧 generation 交错测试；owner 崩溃后第二进程必须得到 `stale`/`corrupt` 阻塞而非取得写权，无法验证身份时返回 `unverifiable`。

- [ ] **步骤 1：修订并运行后端合同 RED**

  保留已经可加载且明确 `unsupported` 的 candidate；将原“崩溃自动释放”断言修订为“崩溃后 stale/corrupt fail closed”，并增加正常 release 后可重新 acquire。测试继续因 candidate 不支持互斥而 RED，不是加载错误。

- [ ] **步骤 2：建立确定性旧 Generation 交错**

  用 IPC 屏障强制 B 观察 generation G1 后暂停，A 正常释放 G1 并发布 G2，再恢复 B；断言 B 不能删除、替换或取得 G2。另覆盖两个 contender 同时 acquire、`O_EXCL` 后 metadata 写入前 SIGKILL、完整发布后 SIGKILL、release 后延迟 cleanup；崩溃状态均只允许 blocked/stale/corrupt。

- [ ] **步骤 3：运行合同测试确认 RED**

  运行：`npm --prefix packages/coding-agent test -- session-lock-backend.contract.test.ts`

  预期：FAIL，失败于互斥行为断言。

- [ ] **步骤 4：实现最小 `O_EXCL` 后端**

  以 canonical lease path 的 `openSync(..., "wx", 0o600)` 成功为唯一 acquire 线性化点；在同一 file descriptor 同步写完整 version/PID/processBirthIdentity/ownerId/generation 后 `fsyncSync`。任何已存在、空、部分写入、schema 错误或身份不确定状态都拒绝 acquire，不执行 unlink/rename。

- [ ] **步骤 5：固定设计决策**

  在设计文档写明 canonical identity、锁位置、owner/generation、initializing/active/stale/unverifiable/corrupt 状态、查询 timeout、权限错误和线性化点。人工恢复要求确认 owner PID/启动身份已不存在且没有 contender；本版本不提供自动恢复 API。

- [ ] **步骤 6：运行三平台合同测试**

  运行：`npm --prefix packages/coding-agent test -- session-lock-backend.contract.test.ts`

  预期：macOS、Linux、Windows 均 PASS；任何平台不满足则该平台 fail closed，不宣称已验证。

### Task 3：实现 Lease 与 SessionManager 单写所有权

**Deps：** `T2`（理由：消费已证明的 `SessionLockBackend`、canonical identity 和状态机）

**WritePaths：**
- `[upstream pi] packages/coding-agent/src/core/session-lease.ts`
- `[upstream pi] packages/coding-agent/src/core/session-manager.ts`
- `[upstream pi] packages/coding-agent/src/core/agent-session.ts`
- `[upstream pi] packages/coding-agent/test/session-manager.test.ts`
- `[upstream pi] packages/coding-agent/test/session-lease.test.ts`
- `[upstream pi] packages/coding-agent/test/session-single-writer.integration.test.ts`

**Resources：** 测试临时目录；三平台 CI

**Files：**
- Create：[upstream pi] `packages/coding-agent/src/core/session-lease.ts`
- Modify：[upstream pi] `packages/coding-agent/src/core/session-manager.ts`
- Modify：[upstream pi] `packages/coding-agent/src/core/agent-session.ts`
- Create：[upstream pi] `packages/coding-agent/test/session-lease.test.ts`
- Modify：[upstream pi] `packages/coding-agent/test/session-manager.test.ts`
- Modify：[upstream pi] `packages/coding-agent/test/session-single-writer.integration.test.ts`

**接口契约：**
- Consumes：T2 的 backend 与状态机。
- Produces：`SessionLease.acquire()`、`inspect()`、`release()`；`SessionInUseError`；持久化 `SessionManager` 明确拥有一个写 lease，`dispose()` 幂等关闭写能力并释放；in-memory/无 session manager 不获取 lease。
- canonical identity：既存 regular file 使用 realpath 加设备/文件 identity；未创建目标使用 realpath(parent)+basename reservation。symlink 解析到目标；hardlink 若平台无法证明同一文件 identity则明确拒绝写打开。

**验收标准：**`open`、`continueRecent` 直接构造、`create/newSession`、`setSessionFile` 和缺失 cwd 恢复都不能绕过 owner；dispose 后 append 明确失败；任何构造/校验失败均在 finally 释放本次新取得的 owner，既存 stale/corrupt lease 保持不变。

- [ ] **步骤 1：扩展现有行为 RED**

  在 T1 可加载测试上增加 alias、`continueRecent`、`setSessionFile`、临时 manager 未 dispose 和 dispose 后 append 行为；逐个观察当前 public 行为断言失败。

- [ ] **步骤 2：实现 lease facade 与 canonical identity**

  封装 T2 backend，不自行实现 stale 接管算法；公开错误只包含 session path、状态、PID 与可展示启动身份，不暴露 owner ID。active、stale、unverifiable、corrupt 均阻止写打开。

- [ ] **步骤 3：接入所有 manager 构造与切换路径**

  将 lease acquire 置于任何 JSONL 读取修复或写入之前；manager owner 转移使用显式 commit/rollback，失败路径统一 finally。

- [ ] **步骤 4：闭合 AgentSession dispose**

  `AgentSession.dispose()` 必须 dispose 其拥有的 manager；临时 manager 也必须在 finally 释放。释放后所有 append/branch mutation fail closed。

- [ ] **步骤 5：运行 GREEN 与回归**

  运行：`npm --prefix packages/coding-agent test -- session-lease.test.ts session-manager.test.ts session-single-writer.integration.test.ts`

  预期：PASS。

### Task 4：事务化 Import、Fork、Rename、Delete 与 Trash

**Deps：** `T3`（理由：消费可转移、可回滚的 manager/lease owner）

**WritePaths：**
- `[upstream pi] packages/coding-agent/src/core/agent-session-runtime.ts`
- `[upstream pi] packages/coding-agent/src/core/session-manager.ts`
- `[upstream pi] packages/coding-agent/src/modes/interactive/interactive-mode.ts`
- `[upstream pi] packages/coding-agent/src/modes/interactive/components/session-selector.ts`
- `[upstream pi] packages/coding-agent/test/session-file-transactions.test.ts`
- `[upstream pi] packages/coding-agent/test/agent-session-runtime.test.ts`

**Resources：** 测试临时 session 目录

**Files：**
- Modify：[upstream pi] `packages/coding-agent/src/core/agent-session-runtime.ts`
- Modify：[upstream pi] `packages/coding-agent/src/core/session-manager.ts`
- Modify：[upstream pi] `packages/coding-agent/src/modes/interactive/interactive-mode.ts`
- Modify：[upstream pi] `packages/coding-agent/src/modes/interactive/components/session-selector.ts`
- Create：[upstream pi] `packages/coding-agent/test/session-file-transactions.test.ts`
- Modify：[upstream pi] `packages/coding-agent/test/agent-session-runtime.test.ts`

**接口契约：**
- Consumes：T3 的 owner lease、只读 snapshot 和事务化 owner 转移。
- Produces：import 在 copy 前 reserve 新目标；fork 从当前 owner 的只读 snapshot 创建并 reserve 新目标，不再次写打开当前 session；rename/delete/trash 在操作前获取或验证 owner；所有临时 manager 有 finally。

**验收标准：**活动目标文件在冲突返回前字节级不变；fork 不自锁；rename/delete/trash 不能操作其他进程持有的 session；事务失败不泄漏 owner。

- [ ] **步骤 1：编写 import 覆盖与 fork 自锁 RED**

  目标 session 由进程 A 持有时，进程 B import 同名目标，断言完整字节与长度不变；当前 runtime fork 断言创建新文件且不第二次写打开源 session。

- [ ] **步骤 2：编写 rename/delete/trash RED**

  对活动 session 执行三个 public UI/runtime 操作，断言稳定 `SESSION_IN_USE` 且文件与 owner 都保持；测试在当前实现允许操作时 RED。

- [ ] **步骤 3：运行并确认 RED**

  运行：`npm --prefix packages/coding-agent test -- session-file-transactions.test.ts agent-session-runtime.test.ts`

  预期：FAIL 于目标文件被覆盖、活动文件可删除或 owner 生命周期断言。

- [ ] **步骤 4：实现 reserve-copy-commit 与 snapshot-fork**

  import reserve 未创建目标 identity 后写临时文件并原子发布；fork 使用当前 manager snapshot 写新目标。失败时清理临时文件并释放 reservation，不触碰活动目标。

- [ ] **步骤 5：统一 destructive operation 门禁**

  selector 与 interactive mode 不直接 trash/unlink；调用 session file transaction API，成功或失败均关闭临时 owner。

- [ ] **步骤 6：运行 GREEN 与回归**

  运行：`npm --prefix packages/coding-agent test -- session-file-transactions.test.ts agent-session-runtime.test.ts session-manager.test.ts`

  预期：PASS。

### Task 5：统一 CLI、TUI、RPC、SDK 路由与 Shutdown 生命周期

**Deps：** `T4`（理由：消费完整文件事务和 owner 转移，避免入口层绕过）

**WritePaths：**
- `[upstream pi] packages/coding-agent/src/core/session-lock-backend.ts`
- `[upstream pi] packages/coding-agent/src/core/session-lease.ts`
- `[upstream pi] packages/coding-agent/src/main.ts`
- `[upstream pi] packages/coding-agent/src/cli/session-picker.ts`
- `[upstream pi] packages/coding-agent/src/core/agent-session-runtime.ts`
- `[upstream pi] packages/coding-agent/src/modes/interactive/interactive-mode.ts`
- `[upstream pi] packages/coding-agent/src/modes/interactive/components/session-selector.ts`
- `[upstream pi] packages/coding-agent/src/modes/rpc/rpc-mode.ts`
- `[upstream pi] packages/coding-agent/test/session-routing.test.ts`
- `[upstream pi] packages/coding-agent/test/session-lock-backend.contract.test.ts`
- `[upstream pi] packages/coding-agent/test/session-lease.test.ts`
- `[upstream pi] packages/coding-agent/test/agent-session-runtime.test.ts`
- `[upstream pi] packages/coding-agent/test/suite/agent-session-runtime.test.ts`

**Resources：** 可注入 TTY/picker；测试临时 session 目录

**Files：**
- Modify：[upstream pi] `packages/coding-agent/src/core/session-lock-backend.ts`
- Modify：[upstream pi] `packages/coding-agent/src/core/session-lease.ts`
- Modify：[upstream pi] `packages/coding-agent/src/main.ts`
- Modify：[upstream pi] `packages/coding-agent/src/cli/session-picker.ts`
- Modify：[upstream pi] `packages/coding-agent/src/core/agent-session-runtime.ts`
- Modify：[upstream pi] `packages/coding-agent/src/modes/interactive/interactive-mode.ts`
- Modify：[upstream pi] `packages/coding-agent/src/modes/interactive/components/session-selector.ts`
- Modify：[upstream pi] `packages/coding-agent/src/modes/rpc/rpc-mode.ts`
- Create：[upstream pi] `packages/coding-agent/test/session-routing.test.ts`
- Modify：[upstream pi] `packages/coding-agent/test/session-lock-backend.contract.test.ts`
- Modify：[upstream pi] `packages/coding-agent/test/session-lease.test.ts`
- Modify：[upstream pi] `packages/coding-agent/test/agent-session-runtime.test.ts`
- Modify：[upstream pi] `packages/coding-agent/test/suite/agent-session-runtime.test.ts`

**接口契约：**
- Consumes：T4 的 lease-aware open 与 file transaction API。
- Produces：上文 Session 操作矩阵；appMode 显式传入 session creation；picker inspect active 状态但确认时重新 acquire；target acquire 成功后才关闭 picker或 teardown 旧 runtime；shutdown 顺序为停止新写入 → abort/settle → session_shutdown → broker close → manager dispose/release。

**验收标准：**所有入口冲突语义一致；目标冲突时旧 runtime 与 picker 保持可用；teardown 后新 runtime 创建失败时返回结构化失败且无双 owner；quit、SIGINT、SIGTERM、SIGHUP 均闭合 owner。

- [ ] **步骤 1：编写完整模式矩阵 RED**

  参数化测试 `-c/-r/--session/--session-id` × TUI/print/json/rpc，并覆盖 picker cancel、确认时竞态、跨项目确认；断言稳定错误码及 stdout/stderr 边界。

- [ ] **步骤 2：编写 runtime/RPC 存活性 RED**

  session B 活跃时，从 A 执行 SDK switch 与 RPC `switch_session`，断言失败后 A 可继续 prompt/append，未发送 A 的 `session_shutdown`。

- [ ] **步骤 3：运行并确认 RED**

  运行：`npm --prefix packages/coding-agent test -- session-routing.test.ts agent-session-runtime.test.ts`

  预期：FAIL 于现有入口未拒绝活动 session 或 picker/runtime 生命周期断言。

- [ ] **步骤 4：实现模式路由与 picker 行为**

  TUI `-c` 仅捕获 `SessionInUseError` 并复用 `-r` picker；非交互 `-c` 与显式 session 参数失败。活动项不可确认；TOCTOU 冲突刷新列表且不关闭 picker。

- [ ] **步骤 5：事务化 runtime replacement**

  prepare 阶段取得目标 owner并完成 cwd/trust 校验；commit 后 teardown 旧 runtime。分别处理 prepare 失败与 teardown 后 apply 失败，所有临时 owner finally 关闭。

- [ ] **步骤 6：闭合所有 shutdown 入口**

  TUI 与 RPC 信号处理共享幂等 shutdown；确认 broker/socket 不再使用 session identity 后才释放 manager lease。

- [ ] **步骤 7：运行 GREEN 与相关回归**

  运行：`npm --prefix packages/coding-agent test -- session-routing.test.ts agent-session-runtime.test.ts session-file-transactions.test.ts`

  预期：PASS。

### Task 6：真实双进程与打包 CLI 验收

**Deps：** `T5`（理由：需要全部 public 入口、文件事务和 shutdown 行为）

**WritePaths：**
- `[upstream pi] packages/coding-agent/test/session-single-writer.integration.test.ts`
- `[upstream pi] packages/coding-agent/test/fixtures/session-owner-host.ts`
- `[upstream pi] packages/*/dist/**`
- `[upstream pi] packages/session-backends/*/dist/**`

**Resources：** 同一隔离 cwd 的两个真实 Pi 子进程；本地受控模型服务；PTY；最多 1 组实验

**Files：**
- Modify：[upstream pi] `packages/coding-agent/test/session-single-writer.integration.test.ts`
- Create：[upstream pi] `packages/coding-agent/test/fixtures/session-owner-host.ts`
- Generate：[upstream pi] `packages/*/dist/**`
- Generate：[upstream pi] `packages/session-backends/*/dist/**`

**接口契约：**
- Consumes：T5 完整行为和 T1 固定的 build/package 命令。
- Produces：从同一 checkout 构建的 public API 与打包 CLI 双重验收；fixture 输出 ready 屏障、session identity、owner identity 和可控 append 命令，不输出 auth/prompt。

**验收标准：**A 静止期间 B 不能改变 session 完整字节/长度，不能替换 owner；拒绝 B 后 A 的 broker socket 仍可连接且 A 能继续 append。两轮正常退出与一轮 SIGKILL 恢复均无进程和 owner 泄漏。

- [ ] **步骤 1：用源码构建打包 CLI**

  执行 T1 核实的 build/package 命令，断言测试调用的 CLI 和 public API 都来自同一固定 checkout，不调用全局 0.84.4。

- [ ] **步骤 2：验证双进程排他**

  A ready 后冻结写入并记录完整 bytes/hash/length；启动 B 执行 `-c`、显式 session 和 destructive operation，逐项断言 B 被拒绝、完整文件不变、owner generation 不变。

- [ ] **步骤 3：验证 A 仍健康**

  B 被拒绝后探测 A 的 broker socket owner 与连通性，再命令 A 合法 append，断言新 entry parent/leaf 正确。

- [ ] **步骤 4：验证崩溃和不确定状态**

  SIGKILL A 后验证 B 明确返回 stale/corrupt 并拒绝写打开，记录人工恢复指引但不自动删除 lease；PID 复用仅用 process identity provider 的确定性注入测试，不冒充真实 OS PID 复用实验。

- [ ] **步骤 5：运行上游全量测试与静态检查**

  执行 T1 从固定上游 manifest 核实并记录的精确命令。

  预期：测试、类型检查和打包均退出码 0，无错误或警告。

### Task 7：在配置仓库采用人工发布版本

**Deps：** `T6`（理由：只采用同一 checkout 完整验收后人工发布的正式版本）

**WritePaths：**
- `init-pi.sh`
- `test/pi-runtime.integration.mjs`
- `docs/bugs/2026-09-07-pi-active-session-reopened.md`

**Resources：** npm registry；人工发布与采用确认；安装操作交由 subagent

**Files：**
- Modify：`init-pi.sh:5-7`
- Modify：`test/pi-runtime.integration.mjs`
- Modify：`docs/bugs/2026-09-07-pi-active-session-reopened.md`

**接口契约：**
- Consumes：T6 对应 commit 人工发布后的确切 npm 版本与 tarball integrity。
- Produces：本仓库固定该正式版本；真实 runtime adoption 测试；问题记录附 commit、版本、integrity 与验收证据。

**验收标准：**重新安装后真实 Pi runtime 拒绝重复 writer；不提交 `enabledModels` 或 `pi/models.json` 本机差异。

- [ ] **步骤 1：人工发布门禁**

  仅在用户确认后核对 npm manifest、commit 与 tarball 内容；不匹配则停止且不改版本。

- [ ] **步骤 2：编写 adoption RED**

  在旧 0.84.4 下通过真实 CLI 启动两个 writer，断言第二个 `SESSION_IN_USE`；观察行为断言失败。

- [ ] **步骤 3：更新固定版本并安装**

  仅修改 `init-pi.sh` 固定版本；安装是长耗时操作，交由 subagent 执行，不热补丁全局 dist。

- [ ] **步骤 4：运行 GREEN 和仓库回归**

  运行：`npm run test:integration && npm run typecheck && npm test`

  预期：PASS；`git diff -- pi/settings.json pi/models.json` 无待提交变化。

### Task 8：为 Subagent 同步派发建立可关联的 Phase Trace

**Deps：** `none`

**WritePaths：**
- `docs/bugs/2026-09-07-subagent-dispatch-startup-stall.md`
- `packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts`
- `packages/pi-subagents-enhanced/src/subagent-dispatch/rpc-client.ts`
- `packages/pi-subagents-enhanced/src/subagent-dispatch/workflow-spawn.ts`
- `packages/pi-subagents-enhanced/extensions/subagent-runtime.ts`
- `scripts/probes/subagent-dispatch-startup.ts`
- `test/subagent-dispatch-startup-probe.test.mjs`
- `test/subagent-dispatch-rpc.test.mjs`
- `test/subagent-runtime-membrane.test.mjs`
- `tsconfig.json`

**Resources：** 一个真实 Pi Host；先单发再双发；双发阶段并发容量 2；每轮有界停止并回收 run handle

**Files：**
- Create：`docs/bugs/2026-09-07-subagent-dispatch-startup-stall.md`
- Modify：`packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts`
- Modify：`packages/pi-subagents-enhanced/src/subagent-dispatch/rpc-client.ts`
- Modify：`packages/pi-subagents-enhanced/src/subagent-dispatch/workflow-spawn.ts`
- Modify：`packages/pi-subagents-enhanced/extensions/subagent-runtime.ts`
- Create：`scripts/probes/subagent-dispatch-startup.ts`
- Create：`test/subagent-dispatch-startup-probe.test.mjs`
- Modify：`test/subagent-dispatch-rpc.test.mjs`
- Modify：`test/subagent-runtime-membrane.test.mjs`
- Modify：`tsconfig.json`

**接口契约：**
- Consumes：真实 subagent tool call、现有 5 秒 typed RPC timeout、最长 120 秒 leaf-start collector、显式诊断输出路径。
- Produces：仅当 `PI_SUBAGENT_DISPATCH_TRACE_FILE` 指向调用方创建的 `0600` regular file 时启用的 JSONL trace。每条记录为 `{ version:1, toolCallId, phase, monotonicMs, method?, requestId?, rootRunId?, leafRunId?, errorCode? }`；禁止 prompt、task、环境变量、凭据和任意额外字段。
- phase 与真实 hook 一一对应：`tool-entered`、`agent-discovery-started/finished`、`rpc-ping-sent/replied`、`rpc-spawn-sent/replied`、`leaf-wait-started/finished`、`tool-returned/failed`。RPC diagnostic context 显式携带 toolCallId/requestId；不得从标题或时间邻近推断关联。

**验收标准：**一次同步 tool call 能按 toolCallId 重建真实 phase；RPC 无 reply 在约 5 秒进入 `tool-failed`，spawn 已回复但 leaf 未启动时最长等待遵循当前 collector 配置并明确显示阻塞区间。trace 不改变 tool result、event payload、session 和 TUI renderer。

- [ ] **步骤 1：创建中文问题记录并保持分类未证实**

  记录用户手动取消前约 5 分钟只看到 `starting`、当前 `spawnWorkflowLeaf()` 先 await `rpc.spawn()` 再 await leaf collector、现有 5 秒/120 秒边界，以及先前调查因无界 artifact 枚举自身超时的非 production 证据。

- [ ] **步骤 2：编写可加载的 trace RED**

  通过现有 extension factory 注入 `diagnosticSink`，分别让 agent discovery、RPC ping、RPC spawn、leaf collector 挂起；断言阶段顺序、toolCallId/requestId 关联、单调时间、错误阶段和敏感字段拒绝。当前 sink 不存在时测试以“未收到 phase”断言失败。

- [ ] **步骤 3：运行并确认 RED**

  运行：`node --test test/subagent-dispatch-startup-probe.test.mjs test/subagent-dispatch-rpc.test.mjs test/subagent-runtime-membrane.test.mjs`

  预期：FAIL 于 phase 缺失，不是 module/import 错误。

- [ ] **步骤 4：实现纯观测 diagnostic sink**

  在三个内部边界发出 phase；rpc client 在 emit 前生成 requestId 并通过内部 diagnostic context 关联 toolCallId。sink 抛错必须被隔离并记录为 extension error，不得改变 dispatch 成败或 timeout。

- [ ] **步骤 5：实现显式文件 sink 与有界 probe**

  extension 仅在显式环境变量存在时校验目标为调用方拥有的 `0600` regular file；probe 要求 parent session/toolCallId，禁止扫描历史 artifacts。单发观察上限 130 秒；双发并发 2，总上限 150 秒；到期对已获得 handle 调用公开 stop，未获得 handle 则停止 Host 并保留 trace。

- [ ] **步骤 6：运行 GREEN、静态检查和敏感字段测试**

  运行：`node --test test/subagent-dispatch-startup-probe.test.mjs test/subagent-dispatch-rpc.test.mjs test/subagent-runtime-membrane.test.mjs && npm run typecheck`

  预期：PASS；trace schema 无任务正文、prompt、环境值或凭据。

- [ ] **步骤 7：执行 production 复现并分类**

  使用一个真实 Host，先单发再双发。按 trace 定位相邻 phase；10 秒仅作为用户体验标记，5 秒 RPC timeout 与最长 120 秒 leaf wait 才是协议边界。记录实际 identity、事件顺序和首个偏离点。

- [ ] **步骤 8：建立后续修复门禁**

  若证明合法 production 调用违反现有 timeout/ACK 契约，另写精确 RED 和最小修复计划；若只是 collector 合法等待但 TUI 无阶段反馈，则仅在 renderer 展示原始 trace 状态；若证据不足，保持 fail closed，不增加 fallback。

### Task 9：定位 Idle Pi 突然显示 Working 的 Completion 来源

**Deps：** `T8`（理由：复用 T8 已验证的显式 trace 文件、单调时间和 tool/session 关联基础设施）

**WritePaths：**
- `docs/bugs/2026-09-07-pi-idle-working-without-visible-request.md`
- `packages/pi-subagents-enhanced/src/subagent-dispatch/runtime-membrane.ts`
- `packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts`
- `packages/pi-subagents-enhanced/extensions/subagent-runtime.ts`
- `scripts/probes/subagent-working-state.ts`
- `test/subagent-completion-ownership.test.mjs`
- `test/subagent-runtime-membrane.test.mjs`
- `test/subagent-idle-working-probe.test.mjs`
- `tsconfig.json`

**Resources：** 一个位于 `~/taoappuse` 的真实 idle Pi Host；不得同时在该 cwd 启动第二个 Pi；最多一个有界复现 run

**Files：**
- Create：`docs/bugs/2026-09-07-pi-idle-working-without-visible-request.md`
- Modify：`packages/pi-subagents-enhanced/src/subagent-dispatch/runtime-membrane.ts`
- Modify：`packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts`
- Modify：`packages/pi-subagents-enhanced/extensions/subagent-runtime.ts`
- Create：`scripts/probes/subagent-working-state.ts`
- Create：`test/subagent-completion-ownership.test.mjs`
- Modify：`test/subagent-runtime-membrane.test.mjs`
- Create：`test/subagent-idle-working-probe.test.mjs`
- Modify：`tsconfig.json`
- Inspect：`packages/pi-subagents-enhanced/node_modules/pi-subagents/src/runs/background/notify.ts:369-381`
- Inspect：`packages/pi-subagents-enhanced/node_modules/pi-subagents/src/runs/background/notify.ts:482-559`

**接口契约：**
- Consumes：T8 的 trace writer；Pi 原始 `session_start`、`agent_start`、`agent_end`、`agent_settled`、`queue_update`、`ui_prompt_start`、`ui_prompt_end`；`subagent:async-complete`、`subagent:foreground-complete`；completion notifier 对 `sendMessage` 的真实调用。
- Produces：按当前 Host 单调时间记录 `{ version:1, hostSessionId, completionOwnerId, event, monotonicMs, source?, runId?, eventSessionId?, eventCompletionOwnerId?, ownershipDecision?, customType?, triggerTurn?, deliverAs?, display? }`。event 固定为 `host-idle`、`completion-received`、`completion-accepted`、`completion-rejected`、`send-message`、`queue-update`、`agent-start`、`agent-end`、`agent-settled`、`ui-prompt-start`、`ui-prompt-end`；不得记录 completion summary、prompt、task、消息正文或环境变量。
- ownership 判定必须记录真实分支：foreground 当前只比较 `sessionId`；async 同时比较 `sessionId` 与 `completionOwnerId`。trace 只观察，不改变该现有语义。

**验收标准：**一次 working 闪现能够关联到紧邻的原始事件，并回答是否由 accepted completion 的 `sendMessage(..., { triggerTurn:true })` 引发；无 completion 时必须区分 queue continuation、UI prompt 与其他 agent start。未取得 eventSessionId/owner/source 证据时保持“来源尚未证实”。

- [ ] **步骤 1：记录独立现场事实**

  问题记录明确：观察 cwd 为 `~/taoappuse`，当时该 cwd 没有其他活动 session；因此同 cwd 重复打开不是此现象的既证前提。记录 working 出现/消失但无可见请求，不把视觉状态等同于模型调用。

- [ ] **步骤 2：编写 completion ownership 与 trace RED**

  使用可加载的现有 notifier/runtime factory，覆盖 async 正确 owner、async 错误 owner、foreground 同 session、foreground 不同 session、`triggerTurn:false`、batch flush 和 notifier dispose。断言每次 decision、`sendMessage` 参数与后续 agent lifecycle 可关联；当前无 trace 时以 phase 缺失断言 RED。

- [ ] **步骤 3：运行并确认 RED**

  运行：`node --test test/subagent-completion-ownership.test.mjs test/subagent-idle-working-probe.test.mjs test/subagent-runtime-membrane.test.mjs`

  预期：FAIL 于 ownership/sendMessage/agent phase 不可观测，不是 import 或 fixture 错误。

- [ ] **步骤 4：在 membrane 边界实现纯观测 trace**

  在 completion 进入、ownership decision、`sendMessage` 调用和 Pi agent/queue/UI 事件处写 trace。记录 exact session/owner identity 供本机 debug；不得把这些字段写入 git 管理的 fixture 或用户可见消息。trace sink 失败不得触发 working、agent turn或改变 completion ACK。

- [ ] **步骤 5：实现有界 idle probe**

  `scripts/probes/subagent-working-state.ts` 只消费显式 trace 文件并按单调时间关联，不扫描其他 cwd、session 或历史 artifact。启动时确认目标 Host idle；观察窗口 180 秒，到期自行退出，不向 Host 注入 prompt 或 completion。

- [ ] **步骤 6：运行 GREEN、静态检查与非干扰测试**

  运行：`node --test test/subagent-completion-ownership.test.mjs test/subagent-idle-working-probe.test.mjs test/subagent-runtime-membrane.test.mjs && npm run typecheck`

  预期：PASS；开启和关闭 trace 时 tool result、session entries、completion ACK 数量及 TUI 原始事件完全一致。

- [ ] **步骤 7：在 `~/taoappuse` 执行单 Host 复现**

  确认该 cwd 无第二个 Pi 后启动 trace，使 Host idle 并观察。若出现 working，保存从最后一个 `host-idle` 到 `agent-settled` 的完整结构化事件，不读取消息正文。

- [ ] **步骤 8：按首个偏离点分类**

  若 accepted completion 的 session/owner 与当前 Host 权威身份不一致，分类为 production ownership 缺陷并另写精确 RED；若身份一致且 `triggerTurn:true`，先判定是否为预期 completion continuation，再单独评估“无可见消息”的 renderer/消息生命周期；若没有 completion 事件，则沿 queue/UI/agent source 继续归因。证据不足保持“来源尚未证实”。

## 实现后审阅补救 DAG

实现后 reviewer 对 T1-T9 的 verdict 为 `revise`。T10-T13 是发布前强制补救任务；T7 继续阻塞。

```text
T10（SessionManager 与锁事务）──> T11（Runtime 与调用方生命周期）──> T12（真实 Runtime 验收、公开 API 与文档）──> T7

T13（Trace 生命周期、关联与有界 I/O，独立）
```

### Task 10：修复 SessionManager 与锁事务完整性

**Deps：** `T6`（理由：消费现有 lease、事务与 bundled CLI RED/GREEN 基线）

**WritePaths：**
- `[upstream pi] packages/coding-agent/src/core/session-lock-backend.ts`
- `[upstream pi] packages/coding-agent/src/core/session-lease.ts`
- `[upstream pi] packages/coding-agent/src/core/session-manager.ts`
- `[upstream pi] packages/coding-agent/test/session-lock-backend.contract.test.ts`
- `[upstream pi] packages/coding-agent/test/session-lease.test.ts`
- `[upstream pi] packages/coding-agent/test/session-manager.test.ts`
- `[upstream pi] packages/coding-agent/test/session-file-transactions.test.ts`
- `[upstream pi] packages/coding-agent/test/session-id-reservation.integration.test.ts`

**Resources：** 固定上游 checkout；真实子进程屏障

**接口契约：**
- Consumes：同步 fail-closed `SessionLease`。
- Produces：`newSession`、`setSessionFile`、`forkFrom` 的 prepare/commit/rollback 状态机；canonical cwd+session-id reservation；仅撤销当前 fd/inode reservation 的 publication-failure cleanup。

**验收标准：**关闭 reviewer A1、A2、A3、A4、A9；任何失败后 manager 的 session state 与 lease 指向同一文件；两个同 cwd/same session-id 的未落盘 session 不能并发创建。

- [ ] 为 A1/A2/A3/A4/A9 分别建立可加载行为 RED，并记录 production 调用链。
- [ ] 实现候选 state 加载、目标 lease 预留、临时文件完整发布和一次性 commit；旧 lease 仅在 commit 后释放。
- [ ] `forkFrom` 在源 lease 下读取不修复的 snapshot，先 reserve 目标再发布。
- [ ] lock publication 失败只在确认 path 仍指向当前打开 fd 对应 identity 时撤销；无法证明则 fail closed。
- [ ] 运行 T2-T6 与新增真实双进程 tests、build typecheck、只读 Biome 和 diff check。

### Task 11：闭合 Runtime、CLI 与只读调用方所有权

**Deps：** `T10`（理由：消费完整 manager prepare/commit/rollback 与 session-id reservation）

**WritePaths：**
- `[upstream pi] packages/coding-agent/src/main.ts`
- `[upstream pi] packages/coding-agent/src/core/agent-session-runtime.ts`
- `[upstream pi] packages/coding-agent/src/core/export-html/index.ts`
- `[upstream pi] packages/coding-agent/src/core/sdk.ts`
- `[upstream pi] packages/coding-agent/src/modes/interactive/components/session-selector.ts`
- `[upstream pi] packages/coding-agent/src/modes/interactive/interactive-mode.ts`
- `[upstream pi] packages/coding-agent/test/runtime-session-ownership.integration.test.ts`
- `[upstream pi] packages/coding-agent/test/session-selector-rename.test.ts`
- `[upstream pi] packages/coding-agent/test/suite/agent-session-runtime.test.ts`

**Resources：** 固定上游 checkout；本地 faux provider；RPC/TUI harness

**接口契约：**
- Consumes：T10 manager ownership transaction。
- Produces：missing-cwd 在同 owner 上应用 override；export 使用真正只读 snapshot；SDK/startup/runtime 所有候选 manager 都有 finally；in-memory fork 创建独立 snapshot；rename 冲突可见且不产生 unhandled rejection。

**验收标准：**关闭 reviewer A5、A6、A7、A8、A10；prepare 失败不 teardown 当前 runtime，commit 后 apply 失败不泄漏目标 owner；export 与无模型退出不遗留 lease。

- [ ] 为每个 public 入口建立精确 RED，禁止用手工非法 projection。
- [ ] 统一 runtime replacement owner scope，禁止重开自持 session。
- [ ] 修复 missing-cwd、export、SDK resource failure、new/fork/import 与 in-memory fork。
- [ ] 捕获 rename `SessionInUseError`，保持 picker并展示错误；当前 session rename 复用当前 manager。
- [ ] 运行 runtime/RPC/TUI/export/SDK focused tests、T2-T6 回归、build typecheck与只读格式检查。

### Task 12：真实 AgentSessionRuntime 验收与公开契约

**Deps：** `T11`（理由：需要完整 runtime/CLI/SDK owner 生命周期）

**WritePaths：**
- `[upstream pi] packages/coding-agent/src/index.ts`
- `[upstream pi] packages/coding-agent/docs/sdk.md`
- `[upstream pi] packages/coding-agent/CHANGELOG.md`
- `[upstream pi] packages/coding-agent/test/session-single-writer.integration.test.ts`
- `[upstream pi] packages/coding-agent/test/fixtures/session-owner-host.ts`
- `[upstream pi] packages/coding-agent/test/runtime-session-ownership.integration.test.ts`
- `[upstream pi] packages/coding-agent/dist/**`

**Resources：** 固定 checkout bundled CLI；真实 AgentSessionRuntime；本地 faux provider

**接口契约：**
- Consumes：T11 完整 owner 生命周期。
- Produces：公开 `SessionInUseError`/inspection 类型；SDK dispose 文档；真实 runtime owner、RPC switch、TUI route、shutdown/rebind 和 bundle provenance 验收。

**验收标准：**关闭 reviewer A11、A13、A14；T6 owner 不再是裸 manager；bundle hash/build provenance 可验证；发布文档明确 fail-closed stale recovery 边界。

- [ ] 用 faux provider 启动真实 `AgentSessionRuntime` owner，建立旧 T6 不覆盖的 RED。
- [ ] 验证 interactive `-c/-r`、RPC owner/switch、信号 shutdown、prepare/apply failure 和 broker关闭前持锁。
- [ ] 导出 public error/inspection 类型并更新 SDK、CHANGELOG 与设计状态。
- [ ] 运行 coding-agent 全量测试、build、pack dry-run、只读 check 子命令；范围外基线错误单列。

### Task 13：修复 Trace 生命周期、因果关联与有界 I/O

**Deps：** `T8`、`T9`（理由：修正已实现但 reviewer 判定 production 不可达或可误判的诊断链）

**WritePaths：**
- `docs/bugs/2026-09-07-subagent-dispatch-startup-stall.md`
- `docs/bugs/2026-09-07-pi-idle-working-without-visible-request.md`
- `packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts`
- `packages/pi-subagents-enhanced/src/subagent-dispatch/runtime-membrane.ts`
- `packages/pi-subagents-enhanced/extensions/subagent-runtime.ts`
- `scripts/probes/subagent-dispatch-startup.ts`
- `scripts/probes/subagent-working-state.ts`
- `test/subagent-runtime-membrane.test.mjs`
- `test/subagent-completion-ownership.test.mjs`
- `test/subagent-dispatch-startup-probe.test.mjs`
- `test/subagent-idle-working-probe.test.mjs`

**Resources：** 一个真实 Pi Host；显式 0600 trace fd

**接口契约：**
- Consumes：真实 `pi.on` extension lifecycle、AgentSession subscriber、completion notifier delivery result。
- Produces：ownership-match、actual-delivery、send accepted、agent-start/settled 的同 run/owner/generation 因果链；固定 fd、fstat、no-follow trace sink；有字节/记录/时间窗与输出预算的 probes。

**验收标准：**关闭 reviewer B1-B4；删除手工 `pi.events.emit(agent_settled)` 的 production 伪证；证据不足永远返回 `unproven`。

- [ ] 将现有 lifecycle 测试分类为测试污染并建立真实 Host/runner RED。
- [ ] lifecycle 使用 `pi.on`，queue 使用真实 session subscriber；不得把 ExtensionRunner 事件伪装成 event bus event。
- [ ] 在 notifier 实际 dedupe/batch/suppress/send 之后记录 delivery result，并以 run+session+owner generation关联 agent start/settled。
- [ ] trace sink 持有 `O_NOFOLLOW` 打开的 fd并逐次 fstat；替换/轮转后停止写入，不按路径重建。
- [ ] probes 使用有界尾读与严格 schema，处理 partial trailing line并限制输出。
- [ ] 运行 RED/GREEN、真实 Host smoke、typecheck、只读格式和diff check。

## 最终复验补救

最终 reviewer verdict 为 `revise`：A6、A7、A11、B1-B4 仍 open；A12、A13 为 accepted-risk；其余 closed。按用户要求不再派发 reviewer。

```text
T14（A6/A7/A11 上游生命周期与真实验收）
T15（B1-B4 Trace 最终修复）
```

T14 与 T15 可并行；二者均通过后只执行既有自动化门禁，不新增审阅。

### Task 14：关闭 A6、A7、A11

**Deps：** `T12`

**WritePaths：** `[upstream pi] packages/coding-agent/src/**`、`[upstream pi] packages/coding-agent/test/**`、`[upstream pi] packages/coding-agent/docs/**`、`[upstream pi] packages/coding-agent/CHANGELOG.md`、`[upstream pi] packages/coding-agent/dist/**`

**Resources：** 固定 checkout bundled CLI；真实 AgentSessionRuntime/RPC/TUI harness；faux provider

**验收标准：** startup diagnostics/no-model 在退出前 dispose；new/fork candidate 从创建起纳入 owner scope，import 发布前验证；真实 RPC owner/switch、interactive `-c/-r`、信号 shutdown/rebind/apply failure 与完整 bundle chunks provenance全部有行为测试。

### Task 15：关闭 B1-B4

**Deps：** `T13`

**WritePaths：** `packages/pi-subagents-enhanced/**`、`scripts/probes/subagent-*.ts`、`test/subagent-*.test.mjs`、两份相关 `docs/bugs/*.md`

**Resources：** 真实 ExtensionRunner lifecycle；固定 0600 trace fd

**验收标准：**不再把不存在的 queue event 或手工 handler 当 production 证据；delivery 因果严格同 session/owner/run/时序，缺失即 `unproven`；尾读丢弃截断首行并做完整 schema；sink 在 shutdown/reload/init rollback关闭且有真实生命周期测试。
