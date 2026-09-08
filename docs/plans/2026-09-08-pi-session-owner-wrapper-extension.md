# Pi Session Owner Wrapper 与 Extension 实现计划

> **给执行 agent：** 必须逐任务执行本计划；步骤使用 `- [ ]` 复选框跟踪。执行方式由计划完成后的用户选择决定。

**目标：** 在“所有人工 Pi 均从仓库管理的 zsh 入口启动”前提下，用启动前 wrapper 和运行期 extension 防止用户误入其他活动 Pi 的 session，不修改或发布 Pi core。

**架构：** `scripts/pi-launcher.zsh` 在 `exec` 真实 Pi 前调用 feature-owned TypeScript CLI，在短 critical section 内完成目标解析、冲突检查、精确 pending reservation 与进程 record 发布；`exec` 保持 PID，随机 owner token 通过环境传给强制注入的 owner extension。Pi 绑定 extension 后，`session_start` 将 pending/selecting record 原子更新为精确 session identity，`session_before_switch` 只检查并拒绝其他 live owner，`session_shutdown` 才按 quit/reload/replacement 更新状态。Registry 每个进程使用不可复用的 owner-ID 文件；PID 仍存在时保守视为 live，只有 `ESRCH` 才自动清理，避免跨 `exec` command 变化与 PID reuse 导致误删。

**技术栈：** zsh、Node.js `>=22.19.0` 原生 TypeScript type stripping、Pi Extension API 0.84.4、Node test runner。

## 全局约束

- 所有人工 Pi 启动必须经过 `scripts/pi-shell.zsh` 定义的 `pi()` 函数和 `scripts/pi-launcher.zsh`。
- 真实 Pi 路径通过 `PI_REAL_BIN` 或 `whence -p pi` 解析，禁止递归调用 shell function。`pi()` 调用独立 launcher 脚本，只有 launcher 子进程执行 `exec`，不得替换用户交互 shell。
- `var/upstream/pi` 的 Pi core 改造停止推进，仅作为 ignored 实验产物保留；不得安装、发布、提交或自动删除。
- 不修改全局 `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/**`。
- Wrapper 只保护人工 interactive persistent session；`--no-session`、print、JSON、RPC 和 subagent child 不登记 interactive owner。
- `-c` 必须在 registry critical section 内按 Pi 0.84.4 当前配置语义解析 recent，并在同一 critical section 发布精确 pending target：该 session 有 live/pending owner 时阻断；available 时固定为已检查的精确 `--session <path>` 后启动；不存在 recent 时保留 `-c` 新建行为。不得仅因同 cwd 存在其他、但未持有 recent 的 Pi 而阻断。
- `-r` 只在不存在任何 live/pending/selecting interactive record 时允许；wrapper 在启动 picker 前发布全局 `selecting` record。该 record 未被 `session_start` 更新为精确 target 前，其他 wrapper 必须阻断所有 `-c/-r/--session/--session-id` session-reuse intent。
- `--session`、`--session-id` 在启动前只允许无歧义目标；活动目标必须阻断，无法可靠解析时 fail closed。
- `--fork` 的 source 可解析且活动时阻断；新 fork target 由运行期 lifecycle登记。
- 普通 `pi` 始终允许新建独立 session，即使同 cwd 已有其他 Pi。
- `/resume`、RPC `switch_session` 和 import 通过 `session_before_switch` 检查；`/new`、`/fork`、`/clone` 通过 replacement lifecycle更新 owner。
- `session_shutdown(reason="reload")` 不得释放当前 owner；reload 后的新 extension generation 继续持有同一 record。
- 运行期 `/resume` 是人工低频操作，本方案只做 owner 检查，不宣称跨进程原子 CAS；两个用户同时确认同一空闲目标属于明确 accepted operational risk。
- Registry 每进程一文件；文件名包含不可预测 owner ID，不复用 PID-only path，不存在共享 current-owner 文件。
- Registry 写入使用 caller-owned `0700` 目录、`0600` regular file、no-follow 校验和临时文件原子发布。
- Registry 清理只能删除 PID 查询明确返回 `ESRCH` 的独立 record，或当前 owner 自己的 record；PID 存在、`EPERM`、身份不可查和 PID reuse 均保守视为 live，不自动删除。不依赖包含 command/argv 的 birth identity，不实现 session lease recovery。
- extension无法获得实际session identity前，普通`pi`的targetless preliminary只用于cwd/global门禁；`-c/--session/--session-id`必须发布精确pending target，`-r`必须发布全局selecting reservation。只有`session_start`可将它们提交为active ownership。
- Launcher 必须在 `--` 前强制注入绝对路径 `-e <pi/extensions/session-owner.ts>`；用户传 `--no-extensions` 时显式 owner extension仍须加载。Owner extension初始化或registry检查失败必须 fail closed，before hooks不得通过throw表示阻断。
- `PI_SUBAGENT_CHILD=1` 或 `PI_SUBAGENT_FANOUT_CHILD=1` 时 owner extension必须明确skip；subagent不经过用户zsh function，且按run使用独立session。
- 未加载 extension 的 SDK、绕过 wrapper 的真实 Pi、外部 registry cleanup 和自动 recovery 均为 unsupported。
- T8/T15 的 dispatch/working trace 修复保留，但不声称 wrapper 已解决 subagent `starting` 卡顿或 idle-working 现象。
- 文档、代码注释和 Skill 正文使用中文，仅专业术语可豁免。
- 生产逻辑按 RED-GREEN-REFACTOR；RED 必须是可加载测试中的行为断言失败。
- 不读取、记录或提交凭据；不得修改 `pi/settings.json` 的 `enabledModels` 或 `pi/models.json`。
- 不自动提交、发布、安装或创建工单。

## 启动门禁矩阵

| Intent | Scope | Wrapper 行为 |
| --- | --- | --- |
| `pi` | 新 session | 允许，先发布 preliminary process record |
| `pi -c` / `--continue` | canonical cwd 的当前 recent session | critical section内解析并发布精确 pending；target live/pending时拒绝，available时固定为`--session <path>`；无 recent时原样允许 |
| `pi -r` / `--resume` | 全局 selecting reservation | 任一 live/pending/selecting record存在时拒绝；否则先发布全局 selecting record再允许picker |
| `pi --session <full-path>` | canonical session file | 精确目标 active 时拒绝；available 时允许 |
| `pi --session <full-id>` | resolved session file | 唯一解析后检查；prefix/歧义在存在 live owner 时拒绝 |
| `pi --session-id <id>` | canonical cwd + exact ID | 同 scope live 时拒绝；不存在时允许创建 |
| `pi --fork <path/full-id>` | source session | source active 时拒绝；available 时允许创建新 target |
| `pi -p` / `--mode json|rpc` | 非 interactive | 不登记 interactive owner；禁止与 `-r` 组合。RPC不受session owner extension保证，作为unsupported分层记录 |
| `pi --no-session` | ephemeral | 不登记 owner，原样透传 |

## 运行期生命周期矩阵

| Event | Registry 行为 |
| --- | --- |
| `session_start(startup)` | 将 preliminary record 更新为 current session ID/file |
| `session_before_switch(new)` | 只检查，不修改 record；允许 |
| `session_before_switch(resume)` | 只检查；target 被其他 live/pending owner持有则返回 cancel，registry错误也返回 cancel |
| `session_before_fork` | 只检查当前 source owner，不修改 record |
| `session_shutdown(reload)` | 保留 current record，不释放 |
| `session_shutdown(new|resume|fork)` | 原子更新为 transitioning，等待新 `session_start` 覆盖；replacement失败则保守保持 transitioning直到进程退出/重启 |
| `session_shutdown(quit)` | 仅删除当前 owner 自己的独立 record |

## 文件结构

```text
src/session-owner/
  contract.ts
  registry.ts
  lifecycle.ts
  extension.ts
  index.ts
scripts/pi-session-owner.ts
scripts/pi-launcher.zsh
scripts/pi-shell.zsh
pi/extensions/session-owner.ts
test/session-owner-contract.test.mjs
test/session-owner-registry.test.mjs
test/session-owner-wrapper.test.mjs
test/session-owner-extension.integration.mjs
test/session-owner-runtime.integration.mjs
docs/session-owner.md
tsconfig.json
```

## DAG

```text
T1（合同与 identity）──> T2（per-process registry）─┬─> T3（wrapper + zsh）──┐
                                                   └─> T4（extension）───────┴─> T5（真实集成与文档）
```

## Waves

- Wave 1：T1
- Wave 2：T2
- Wave 3：T3、T4（可并行；分别拥有 scripts 与 extension 文件）
- Wave 4：T5

**关键路径：** T1 → T2 → T3/T4 → T5。

---

### Task 1：定义 Launch Intent 与 Canonical Identity 合同

**Deps：** `none`

**WritePaths：**
- `src/session-owner/contract.ts`
- `src/session-owner/index.ts`
- `test/session-owner-contract.test.mjs`
- `tsconfig.json`

**Resources：** `none`

**Files：**
- Create：`src/session-owner/contract.ts`
- Create：`src/session-owner/index.ts`
- Create：`test/session-owner-contract.test.mjs`
- Modify：`tsconfig.json`

**接口契约：**
- Consumes：Pi 0.84.4 CLI argv；cwd；可选 session resolver。
- Produces：

```ts
export type LaunchIntent =
  | { kind: "new" }
  | { kind: "continue" }
  | { kind: "resume" }
  | { kind: "session"; value: string }
  | { kind: "session-id"; value: string }
  | { kind: "fork"; value: string }
  | { kind: "ephemeral" }
  | { kind: "non-interactive" };

export type CanonicalScope = Readonly<{
  cwd: string;
  sessionId: string | null;
  sessionFile: string | null;
}>;

export function classifyPiLaunch(argv: readonly string[]): LaunchIntent;
export function canonicalizeCwd(cwd: string): string;
export function normalizeSessionPath(path: string, cwd: string): string;
export function resolveRecentSession(input: ResolveRecentSessionInput): Promise<ResolvedSession | null>;
```

**验收标准：**启动矩阵中的每种 argv 只映射到一个 intent；路径 alias 使用 registry filesystem identity；无法解析或冲突参数返回结构化错误，不猜测 Pi prefix 语义；根 TypeScript检查覆盖全部新 feature、CLI 和 extension入口。

- [ ] **步骤 1：编写可加载 argv 与路径行为 RED**

```js
const api = await import("../src/session-owner/contract.ts").catch(() => ({}));
test("classifies every guarded startup form", () => {
  assert.equal(typeof api.classifyPiLaunch, "function");
  assert.deepEqual(api.classifyPiLaunch(["-c"]), { kind: "continue" });
  assert.deepEqual(api.classifyPiLaunch(["-r"]), { kind: "resume" });
  assert.deepEqual(api.classifyPiLaunch(["--session", "/repo/s.jsonl"]), {
    kind: "session",
    value: "/repo/s.jsonl",
  });
});
```

- [ ] **步骤 2：运行测试确认 RED**

  运行：`node --test test/session-owner-contract.test.mjs`

  预期：FAIL于函数存在性/行为断言，不是test runner装载错误。

- [ ] **步骤 3：实现最小纯函数合同**

  处理Pi 0.84.4真实支持的分离参数形式、短参数、`--`后prompt、冲突参数、wrapper传入的stdin/stdout TTY facts和`--no-session`；不得把0.84.4视为unknownFlags的`--mode=rpc`、`--session=...`、`--session-dir=...`误当内建等价语法。Registry canonical cwd对存在路径使用realpath。Recent resolver直接调用当前正式Pi package的public `SessionManager.list(cwd, resolvedSessionDir)`并取其排序首项；sessionDir固定按CLI `--session-dir`→`PI_CODING_AGENT_SESSION_DIR`解析，本仓库shell总是设置后者。候选header cwd与当前canonical cwd不一致或discovery失败时fail closed。

- [ ] **步骤 4：运行 GREEN 与静态检查**

  修改`tsconfig.json`覆盖`src/session-owner/**/*.ts`、`scripts/pi-session-owner.ts`和`pi/extensions/session-owner.ts`，再运行：`node --test test/session-owner-contract.test.mjs && npm run typecheck`

  预期：PASS。

### Task 2：实现 Per-Process Registry

**Deps：** `T1`（理由：消费 canonical scope 与 launch intent）

**WritePaths：**
- `src/session-owner/registry.ts`
- `src/session-owner/index.ts`
- `test/session-owner-registry.test.mjs`

**Resources：** registry critical-section lock；真实子进程

**Files：**
- Create：`src/session-owner/registry.ts`
- Modify：`src/session-owner/index.ts`
- Create：`test/session-owner-registry.test.mjs`

**接口契约：**

```ts
export type RegistryStore = Readonly<{
  root: string;
  guardTimeoutMs: number;
}>;

export type LaunchReservation =
  | { kind: "new" }
  | { kind: "selecting" }
  | { kind: "session"; cwd: string; sessionFile: string; sessionId: string | null }
  | { kind: "session-id"; cwd: string; sessionId: string };

export type ProcessOwnerRecord = Readonly<{
  protocol: "pi-session-owner.v1";
  ownerId: string;
  pid: number;
  cwd: string;
  sessionId: string | null;
  sessionFile: string | null;
  state: "pending" | "selecting" | "active" | "transitioning";
  pendingSessionFile: string | null;
  startedAt: string;
}>;

export type BlockReason =
  | "session-owned"
  | "session-id-owned"
  | "selector-active"
  | "active-owner-exists"
  | "registry-busy"
  | "registry-unavailable";

export type PrepareLaunchResult =
  | { decision: "allow"; record: ProcessOwnerRecord; recordPath: string }
  | { decision: "blocked"; reason: BlockReason; conflictingOwnerId?: string };

export function prepareLaunch(input: {
  store: RegistryStore;
  pid: number;
  ownerId: string;
  startedAt: string;
  reservation: LaunchReservation;
}): Promise<PrepareLaunchResult>;

export function listLiveRecords(store: RegistryStore): Promise<readonly ProcessOwnerRecord[]>;

export function updateOwnRecord(input: {
  store: RegistryStore;
  ownerId: string;
  pid: number;
  state: "active" | "transitioning";
  cwd: string;
  sessionId: string | null;
  sessionFile: string | null;
  pendingSessionFile?: string | null;
}): Promise<ProcessOwnerRecord>;

export function releaseOwnRecord(input: {
  store: RegistryStore;
  ownerId: string;
  pid: number;
}): Promise<void>;
```

匹配规则固定为：`new` 不因其他 owner 阻断；`selecting` 在任一 live interactive record存在时返回`active-owner-exists`；任一 live `selecting` 阻断 `session/session-id`；`session` 按 canonical `sessionFile/pendingSessionFile` 匹配；`session-id` 按 canonical `cwd + sessionId` 匹配。所有 guard/registry异常都返回 fail-closed blocked，不通过 throw 绕过。

**验收标准：**每个owner独立record；两个同时启动的wrapper在同一critical section内完成ESRCH cleanup、目标decision与pending/selecting publication；精确target在extension绑定前已被其他wrapper视为占用；旧owner永远不能删除另一个owner文件。

- [ ] **步骤 1：编写多进程竞争和 stale 行为 RED**

  测试先通过可加载candidate接口返回`unsupported`形成行为RED。使用真实Node子进程屏障强制A在发布pending target后、exec前暂停，验证B对同一recent被拒绝；同cwd两个不同session owner不互相阻断。`selecting`存在时所有startup reuse intent被拒绝；两个普通`new`均允许并拥有不同record path。

- [ ] **步骤 2：运行测试确认 RED**

  运行：`node --test test/session-owner-registry.test.mjs`

  预期：测试文件可正常加载，FAIL于`prepareLaunch`不是函数或返回`unsupported`，不是import/runner错误。

- [ ] **步骤 3：实现安全 store 与短 critical section**

  Registry root默认位于`${XDG_RUNTIME_DIR:-TMPDIR}/pi-session-owner-<uid>`。使用`0700` root、`0600` record、no-follow/fstat；临时文件与目标同目录原子rename。共享critical-section guard使用`O_EXCL` owner record，取得、释放、record update、ESRCH cleanup均在同一协议内；等待上限固定且超时fail closed。Guard owner崩溃仅在PID明确ESRCH时以“删除旧guard→重新O_EXCL竞争”恢复，删除后不假定自己已获锁。

- [ ] **步骤 4：实现 live/stale 判定与跨 exec owner token**

  Wrapper生成随机owner ID并通过环境跨`exec`传给extension；PID在launcher与Pi间保持。Registry仅在`kill(pid,0)`明确ESRCH时清理独立record；PID存在或EPERM一律live，避免command变化与PID reuse误删。增加真实zsh→Node exec断言：PID和owner token不变。不得深层import其他feature的process-birth实现。

- [ ] **步骤 5：验证 owner 隔离与 GREEN**

  运行：`node --test test/session-owner-contract.test.mjs test/session-owner-registry.test.mjs && npm run typecheck`

  预期：PASS，无残留 live 子进程或可写宽权限文件。

### Task 3：实现 Zsh Launcher 与启动门禁

**Deps：** `T2`（理由：消费原子 prepareLaunch 与 preliminary record）

**WritePaths：**
- `scripts/pi-session-owner.ts`
- `scripts/pi-launcher.zsh`
- `scripts/pi-shell.zsh`
- `test/session-owner-wrapper.test.mjs`
- `test/pi-shell.test.mjs`

**Resources：** zsh；fake Pi executable；registry critical section

**Files：**
- Create：`scripts/pi-session-owner.ts`
- Create：`scripts/pi-launcher.zsh`
- Modify：`scripts/pi-shell.zsh`
- Create：`test/session-owner-wrapper.test.mjs`
- Modify：`test/pi-shell.test.mjs`

**接口契约：**
- `scripts/pi-session-owner.ts prepare --pid <pid> --cwd <cwd> --stdin-tty <0|1> --stdout-tty <0|1> --decision-dir <0700-dir> -- <pi argv>`：完成门禁与pending/selecting发布；把固定枚举action、严格owner ID及可选exact session path分别写入decision dir中的`0600`文件，path使用NUL终止字节，不通过stdout、eval或shell quoting传结构化数据。
- `scripts/pi-launcher.zsh`：创建私有decision dir，取得自身真实PID和原始TTY facts，调用prepare并安全读取固定文件；仅在`--`前删除真正的`-c/--continue` token并插入`--session`与exact path，导出`PI_SESSION_OWNER_ID`、`PI_SESSION_OWNER_REGISTRY`，随后`exec "$PI_REAL_BIN" -e <absolute-owner-extension> "$@"`。
- `scripts/pi-shell.zsh`：`pi()` 仅调用 launcher，不直接调用真实 Pi。

**验收标准：**启动矩阵全部由真实 zsh + fake Pi argv测试；launcher script PID 与 fake Pi PID一致；blocked 启动不执行真实 Pi、不遗留 preliminary record。

- [ ] **步骤 1：编写真实 zsh wrapper RED**

```js
test("blocks continue while another wrapper owns the cwd", () => {
  const result = runZsh(["-c"], { activeCwdOwner: true });
  assert.equal(result.status, EXPECTED_BLOCKED_STATUS);
  assert.equal(fakePiInvocations().length, 0);
});
```

- [ ] **步骤 2：运行测试确认 RED**

  运行：`node --test test/session-owner-wrapper.test.mjs test/pi-shell.test.mjs`

  测试动态探测launcher/CLI并以“未产生预期decision/fake Pi调用”断言RED，不把ENOENT当runner错误。

- [ ] **步骤 3：实现 launcher 与参数门禁**

  实现启动矩阵；`-c`在critical section内解析recent并发布pending：active/pending则拒绝，available则固定exact path，无recent保留原参数。`-r`先发布selecting；bare/prefix session ID在无法唯一解析时fail closed。原始TTY facts决定interactive，helper stdout重定向不得改变判定。Blocked stderr区分：recent被占用时提示回到owner窗口；`-r`保守阻断时提示普通`pi`后在已有窗口使用`/resume`。

- [ ] **步骤 4：验证 exec PID 与环境透传**

  Fake Pi输出PID、argv与允许的owner环境元数据；测试PID和owner token跨exec不变，`--`后的`-c`、参数值内`-c`、空格/换行prompt、未知extension参数逐字保留。验证只删除`--`前真实continue token并在`--`前插入精确session参数；`--no-extensions`存在时强制`-e`仍保留。

- [ ] **步骤 5：运行 GREEN 与 shell 语法检查**

  运行：`zsh -n scripts/pi-launcher.zsh scripts/pi-shell.zsh && node --test test/session-owner-wrapper.test.mjs test/pi-shell.test.mjs && npm run typecheck`

  预期：PASS。

### Task 4：实现 Session Owner Extension

**Deps：** `T2`（理由：消费 own record update/release 与 live owner query）

**WritePaths：**
- `src/session-owner/lifecycle.ts`
- `src/session-owner/extension.ts`
- `src/session-owner/index.ts`
- `pi/extensions/session-owner.ts`
- `test/session-owner-extension.integration.mjs`

**Resources：** Pi 0.84.4 Extension API；隔离 registry

**Files：**
- Create：`src/session-owner/lifecycle.ts`
- Create：`src/session-owner/extension.ts`
- Modify：`src/session-owner/index.ts`
- Create：`pi/extensions/session-owner.ts`
- Create：`test/session-owner-extension.integration.mjs`

**接口契约：**

```ts
export function installSessionOwnerExtension(
  pi: ExtensionAPI,
  deps?: SessionOwnerLifecycleDeps,
): void;
```

**验收标准：**生命周期矩阵全部通过真实Host事件；before hook只检查且任何registry异常均返回cancel；后续handler cancel不会产生transition；shutdown后replacement失败保守保持transitioning；reload不释放；重复session_start幂等；quit仅释放自身record；child marker下零注册。

- [ ] **步骤 1：编写 lifecycle RED**

  先让动态import现有入口并对缺失hook/状态行为作断言形成RED。使用Pi 0.84.4真实`createAgentSessionRuntime`与extension runner触发startup、resume、new、fork、reload、quit；覆盖后续handler cancel、target校验失败、createRuntime/reload失败、重复start和未落盘destination，不手工拼非法session projection。

- [ ] **步骤 2：运行测试确认 RED**

  运行：`node --test test/session-owner-extension.integration.mjs`

  预期：测试文件可正常加载，FAIL于入口未注册预期hook或返回`unsupported`，不是import/runner错误。

- [ ] **步骤 3：实现 startup 与 switch gate**

  `session_start`要求wrapper owner ID、当前PID与pending/selecting record匹配后原子更新own record；`session_before_switch(resume)`只查询，不修改状态，目标由其他live/pending owner持有时返回`{ cancel:true }`并通知。Registry错误必须被捕获并返回cancel，不能throw后被Host忽略。

- [ ] **步骤 4：实现 replacement/reload/quit**

  只有`session_shutdown(new|resume|fork)`标记transitioning；before hook或其他handler cancel时record保持active。Reload保留record；quit releaseOwnRecord。Replacement在shutdown后失败时record保持transitioning直到进程退出或用户重启，文档明确该fail-closed恢复。初始化失败不得删除其他owner；extension reload generation与重复`session_start`保持幂等。

- [ ] **步骤 5：实现 child policy**

  `PI_SUBAGENT_CHILD=1` 或 `PI_SUBAGENT_FANOUT_CHILD=1` 时入口立即返回，测试确认不注册 hooks、不写 registry。

- [ ] **步骤 6：验证强制 Extension 与 RPC 分层**

  Wrapper即使收到`--no-extensions`也必须显式`-e`加载owner入口；owner extension factory初始化失败使interactive Host启动失败或保持pending fail closed。无wrapper owner ID的RPC/JSON/print Host明确不登记、不提供switch保护，测试与文档不得宣称覆盖。

- [ ] **步骤 7：运行 GREEN 与回归**

  运行：`node --test test/session-owner-registry.test.mjs test/session-owner-extension.integration.mjs test/subagent-runtime-production-shutdown.test.mjs && npm run typecheck`

  预期：PASS。

### Task 5：真实 Runtime 集成、安装入口与文档

**Deps：** `T3`、`T4`（理由：需要启动前 preliminary record 与运行期精确 session owner）

**WritePaths：**
- `test/session-owner-runtime.integration.mjs`
- `test/pi-runtime.integration.mjs`
- `docs/session-owner.md`
- `init-pi.sh`
- `scripts/pi-shell.zsh`

**Resources：** `/opt/homebrew/bin/pi@0.84.4`；zsh 5.9；macOS `/usr/bin/script` PTY harness；临时agentDir/sessionDir/registry；无网络占位provider；同一registry串行测试

**Files：**
- Create：`test/session-owner-runtime.integration.mjs`
- Modify：`test/pi-runtime.integration.mjs`
- Create：`docs/session-owner.md`
- Modify：`init-pi.sh`
- Modify：`scripts/pi-shell.zsh`

**接口契约：**
- Consumes：T3 launcher 与 T4 extension。
- Produces：从 zsh 到真实 Pi runtime 的端到端证据；安装器继续只 source `scripts/pi-shell.zsh`；中文运行边界、恢复和排错文档。

**验收标准：**真实PTY下两个同cwd人工Pi可通过普通`pi`创建不同session；`-c`在recent available时继续精确recent、在该recent active时才阻断、在同cwd仅旧session active时仍允许；启动`-r` selecting期间其他reuse intent被阻断；运行中`/resume`活动目标被extension cancel；reload保持owner；quit后record删除；SIGKILL后下一次wrapper按ESRCH清理独立stale record；subagent child不登记。无owner-ID RPC明确验证为unsupported，不宣称受保护。

- [ ] **步骤 1：编写真实 wrapper/runtime RED**

  使用macOS`/usr/bin/script`创建真实双TTY，以环境白名单启动zsh launcher；`PI_REAL_BIN=/opt/homebrew/bin/pi`，`PI_CODING_AGENT_DIR`、`PI_CODING_AGENT_SESSION_DIR`、registry、HOME均指向临时目录；通过显式`-e`加载owner extension与无网络占位provider，不读取本机auth/settings/models。验证pending/selecting→active转换及阻断矩阵。非macOS平台必须有明确skip和后续平台验证记录。

- [ ] **步骤 2：运行测试确认 RED**

  运行：`env -i PATH="$PATH" HOME="$fixture_home" PI_REAL_BIN=/opt/homebrew/bin/pi node --test test/session-owner-runtime.integration.mjs`

  预期：若 T3/T4 尚未集成正确，FAIL于 owner转换或 switch gate，而非认证/fixture错误。

- [ ] **步骤 3：补齐真实 replacement 与 stale cleanup 验收**

  覆盖reload/new/resume/fork/import；before后续handler cancel不改变record，shutdown后createRuntime失败保持transitioning。RPC无wrapper owner ID按unsupported断言。SIGKILL仅在PID明确ESRCH时清理进程独立record，不处理Pi session文件。每个子进程有ready barrier、严格timeout和finally。

- [ ] **步骤 4：更新安装和运维文档**

  文档明确：启动期`-r`的selecting reservation和全局保守阻断；`-c`只在精确recent active/pending时阻断，available时内部固定精确session path；header.cwd必须与当前canonical cwd一致；运行期人工低频检查的非CAS风险；unsupported SDK/direct binary/RPC；display name rename不改文件identity，而JSONL文件rename/delete/replace不受本方案保护；subagent独立session；trace只能诊断dispatch/working问题。

- [ ] **步骤 5：运行完整回归**

  运行：`zsh -n scripts/pi-launcher.zsh scripts/pi-shell.zsh && node --test test/session-owner-contract.test.mjs test/session-owner-registry.test.mjs test/session-owner-wrapper.test.mjs test/session-owner-extension.integration.mjs test/session-owner-runtime.integration.mjs test/pi-shell.test.mjs test/pi-runtime.integration.mjs test/subagent-runtime-production-shutdown.test.mjs && npm run typecheck && git diff --check`

  预期：PASS；`git diff -- pi/settings.json pi/models.json` 不包含本计划变更。

- [ ] **步骤 6：确认旧 core 方案未进入交付**

  验证当前仓库tracked diff不包含`var/upstream/pi`，`init-pi.sh`仍安装正式Pi版本，不从实验checkout安装。只报告本计划实际路径；不得输出或断言已有`pi/settings.json`、`pi/models.json`内容。保留实验目录，不执行清理。

## 执行后 Reviewer 补救

执行后 reviewer verdict 为 `revise`。以下 T6-T8 为强制补救；原 T1-T5 的 GREEN 仅作为回归，不再代表计划完成。

```text
T6（argv/target/recent + registry原子性）──> T7（launcher/extension身份闭合）──> T8（真实Pi PTY矩阵与文档）──> T9（初始化脚本收尾验收）
```

### Task 6：修复启动解析、目标解析与 Registry 原子性

**Deps：** `T5`

**WritePaths：**
- `src/session-owner/contract.ts`
- `src/session-owner/registry.ts`
- `src/session-owner/index.ts`
- `scripts/pi-session-owner.ts`
- `test/session-owner-contract.test.mjs`
- `test/session-owner-registry.test.mjs`
- `test/session-owner-wrapper.test.mjs`

**Resources：** Pi 0.84.4正式包；registry guard；真实多进程屏障

**接口契约：**消费式argv解析必须跳过所有已知选项值并采用last-wins mode；target resolver统一解析path、full ID、prefix歧义、`--session-id`现有文件。`-c`候选使用`SessionManager.list`取得同一候选集合后按`stat.mtime`重排，不使用逻辑modified。Target discovery、live检查和pending publication由`prepareLaunch`在同一guard内调用异步resolver完成。共享guard不自动恢复stale；超时返回`registry-busy`并给人工恢复路径。Own record更新使用temp+fsync+rename直接原子替换，不先unlink。

**验收标准：**关闭reviewer findings 1-4、6、7；所有反例probe成为自动测试；discovery unavailable与target歧义fail closed；不同intent对同一session的file/ID reservation互相阻断。

### Task 7：闭合 Launcher Decision 与 Runtime Identity

**Deps：** `T6`

**WritePaths：**
- `scripts/pi-launcher.zsh`
- `scripts/pi-session-owner.ts`
- `src/session-owner/lifecycle.ts`
- `src/session-owner/extension.ts`
- `src/session-owner/index.ts`
- `pi/extensions/session-owner.ts`
- `test/session-owner-wrapper.test.mjs`
- `test/session-owner-extension.integration.mjs`

**Resources：** zsh；真实ExtensionRunner；隔离registry

**接口契约：**launcher必须先解析真实Pi并传给helper；decision action/owner/path/UID/mode/NUL严格校验，exec前删除decision dir。Bypass不写owner文件、不导出owner环境、不注入extension。Runtime identity与switch target统一canonicalize；session_start只能把匹配pending/session-id/selecting reservation提交为active，mismatch请求shutdown fail closed。Before hook registry错误返回cancel。

**验收标准：**关闭reviewer findings 5、8、9；`--no-extensions`不能绕过interactive owner extension；child marker在helper与extension两层bypass；update失败保持旧active record。

### Task 8：真实 Pi Persistent PTY 矩阵与文档验收

**Deps：** `T7`

**WritePaths：**
- `test/session-owner-runtime.integration.mjs`
- `test/session-owner-wrapper.test.mjs`
- `test/session-owner-extension.integration.mjs`
- `test/pi-runtime.integration.mjs`
- `scripts/pi-shell.zsh`
- `docs/session-owner.md`
- `init-pi.sh`

**Resources：** `/usr/bin/expect`；`/opt/homebrew/bin/pi@0.84.4`；临时agentDir/sessionDir/registry/HOME；无网络provider

**接口契约：**Expect必须启动真实Pi persistent session而非fake `--version`；source shell后重新设置全部隔离环境，或直接调用launcher并另测shell函数。覆盖双Pi、mtime与message时间逆序recent、pending/selecting、`-r`、显式ID/path、`--no-extensions`、resume/new/fork/import、后续handler cancel、reload/replacement failure、quit/SIGKILL。无owner RPC明确bypass。

**验收标准：**关闭reviewer findings 10、11；真实PTY零skip；文档只描述已验证行为，全部新增注释为中文；settings/models与旧core实验不进入交付。

### Task 9：初始化脚本 Fresh Install 收尾验收

**Deps：** `T8`（理由：只在wrapper、extension和真实Pi矩阵稳定后验证最终安装入口）

**WritePaths：**
- `init-pi.sh`
- `scripts/pi-shell.zsh`
- `scripts/pi-launcher.zsh`
- `scripts/pi-session-owner.ts`
- `test/init-pi.test.mjs`
- `test/pi-shell.test.mjs`
- `test/session-owner-install.integration.mjs`
- `docs/session-owner.md`

**Resources：** 临时`HOME`与`ZDOTDIR`；zsh；fake Pi；正式`/opt/homebrew/bin/pi@0.84.4`

**Files：**
- Modify（仅验收发现缺陷时）：`init-pi.sh`
- Modify（仅验收发现缺陷时）：`scripts/pi-shell.zsh`
- Modify（仅验收发现缺陷时）：`scripts/pi-launcher.zsh`
- Modify（仅验收发现缺陷时）：`scripts/pi-session-owner.ts`
- Modify：`test/init-pi.test.mjs`
- Modify：`test/pi-shell.test.mjs`
- Create：`test/session-owner-install.integration.mjs`
- Modify：`docs/session-owner.md`

**接口契约：**
- Consumes：T8 已验收的launcher、decision CLI和owner extension。
- Produces：可重复执行的fresh-install证据，证明`init-pi.sh`只安装正式Pi版本、将正确source块写入`$ZDOTDIR/.zshrc`、保持其他用户zsh内容、确保launcher/CLI可执行和路径可解析，并且新zsh实际通过launcher调用真实/fake Pi。

**验收标准：**全新临时环境首次安装和第二次幂等安装都得到唯一source块；重开`zsh -f`并source生成的`.zshrc`后，`type pi`指向wrapper函数，fake Pi收到强制owner extension和正确argv；正式Pi版本仍为计划固定版本；未引用`var/upstream/pi`，未读取或写入真实HOME/config。

- [ ] **步骤 1：编写 fresh install 行为 RED**

  使用临时`HOME/ZDOTDIR`和fake可执行依赖运行初始化流程，断言source块、可执行权限、owner extension绝对路径和实际wrapper调用；测试必须加载现有脚本并失败于缺失安装行为，而非fixture错误。

- [ ] **步骤 2：运行测试确认 RED**

  运行：`node --test test/session-owner-install.integration.mjs test/init-pi.test.mjs test/pi-shell.test.mjs`

  预期：FAIL于初始化脚本尚未正确配置本次改动的具体行为。

- [ ] **步骤 3：最小修复初始化入口**

  仅修复RED证明的安装缺口。Source块必须幂等，不覆盖用户其他`.zshrc`内容；launcher路径从仓库source位置解析，不写死本机绝对路径；初始化不得安装实验checkout或修改per-machine model设置。

- [ ] **步骤 4：执行 fresh zsh 端到端 GREEN**

  在临时环境执行两次初始化，再启动独立zsh source生成配置；分别用fake Pi验证argv/env，用正式Pi仅执行`--version`验证仍为0.84.4且不访问模型网络。

- [ ] **步骤 5：运行最终显式回归**

  运行：`zsh -n scripts/pi-launcher.zsh scripts/pi-shell.zsh && bash -n init-pi.sh && node --test test/session-owner-contract.test.mjs test/session-owner-registry.test.mjs test/session-owner-wrapper.test.mjs test/session-owner-extension.integration.mjs test/session-owner-runtime.integration.mjs test/session-owner-install.integration.mjs test/init-pi.test.mjs test/pi-shell.test.mjs test/pi-runtime.integration.mjs && npm run typecheck && git diff --check`

  预期：PASS、PTY零skip、无真实HOME或`pi/settings.json`/`pi/models.json`本次改动、tracked diff不包含`var/upstream/pi`。

## 最终执行 Reviewer 补救

执行后 reviewer verdict 为 `revise`，无 blocker；T10-T12关闭剩余4个major与4个minor。

```text
T10（解析/target/UID）──> T11（fork语义与真实replacement）──> T12（文档/fresh正式Pi/最终验证）
```

### Task 10：修复 Target Identity 与 Registry 权限边界

**Deps：** `T9`

**WritePaths：** `src/session-owner/contract.ts`、`src/session-owner/registry.ts`、`src/session-owner/index.ts`、`scripts/pi-session-owner.ts`、`test/session-owner-contract.test.mjs`、`test/session-owner-registry.test.mjs`、`test/session-owner-wrapper.test.mjs`

**Resources：** Pi 0.84.4正式包；真实多进程registry

**验收标准：**重复`--session-dir` last-wins；existing path读取有效header并关联ID；ID/path双向pending互斥；错误sessionDir为unavailable；合法noninteractive session请求bypass、非TTY`-r` blocked；registry root/guard/record校验caller UID。

### Task 11：实现 Fork Source Reservation 与真实 Replacement 验收

**Deps：** `T10`

**WritePaths：** `src/session-owner/registry.ts`、`src/session-owner/lifecycle.ts`、`src/session-owner/extension.ts`、`scripts/pi-session-owner.ts`、`test/session-owner-extension.integration.mjs`、`test/session-owner-runtime.integration.mjs`

**Resources：** 真实Pi AgentSessionRuntime/ExtensionRunner；Expect PTY；隔离registry

**验收标准：**`fork-source`只保护source检查且允许同cwd新destination提交；真实Host触发resume/new/fork/import、后续handler cancel、reload和replacement failure，禁止手工emit冒充完整验收。

### Task 12：文档、正式 Pi Fresh Zsh 与最终验证

**Deps：** `T11`

**WritePaths：** `docs/session-owner.md`、`src/session-owner/**`、`test/session-owner-runtime.integration.mjs`、`test/session-owner-install.integration.mjs`、`test/pi-shell.test.mjs`

**Resources：** 临时HOME/ZDOTDIR；正式`/opt/homebrew/bin/pi --version`；显式测试列表

**验收标准：**文档只保证真实测试覆盖行为；解释性注释中文；fresh zsh在完全隔离环境通过wrapper调用正式Pi `--version`；T1-T12显式测试、PTY、typecheck、语法和diff check全部通过。

### Task 13：优化 `pi -c` Recent 热路径

**Deps：** `T12`

**WritePaths：** `src/session-owner/contract.ts`、`scripts/pi-session-owner.ts`、`test/session-owner-contract.test.mjs`、`test/session-owner-wrapper.test.mjs`、`docs/session-owner.md`

**Resources：** 100个大session fixture；文件读取预算探针

**接口契约：**`continue`不得加载完整Pi package或调用`SessionManager.list()`。Resolver只枚举目标sessionDir的`.jsonl`、读取mtime并降序排列，再逐个有界读取首个session header，找到canonical cwd匹配的首个候选后停止。ID/prefix/fork低频路径仍可加载正式Pi package。

**验收标准：**100个大session下读取量只与header预算相关，不读取消息body；recent exact path与Pi 0.84.4 mtime语义一致；helper common `-c`路径不调用`loadPublicSessionManager`；registry行为和全部既有测试保持GREEN。
