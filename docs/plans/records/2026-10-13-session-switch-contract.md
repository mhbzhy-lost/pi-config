# S1g：受控运行期 session switch 事务合同

## 终态与冻结资格

- taskId：`dispatch-17ed7992`；计划节点：`S1g`。
- status：`verified`，**仅表示静态合同 gate 核实**，不是运行期独占已实现或竞态测试通过。
- 基线：`a9875d62a75a0d5ee2893646ea5a96e89bbf8e27`，现场物理 SDK `@earendil-works/pi-coding-agent@1.0.4`。
- 可实施资格：已有目标文件、身份可由有界 header 验证的受控运行期 resume；S1a/S1b 必须消费本文整体，不拆成 list→check→write。
- 子路径终态：外部 import 在 before 时 destination 尚无 header，`blocked-upstream`；任意 cwdOverride 的实际值不在 before event 中，不承诺其前置完整身份验证。缺失/无效 header 明确取消，不猜 ID、不调用 `SessionManager.open` 探测、不自动初始化目标。
- 主管决策：本次通过 `contact_supervisor(need_decision)` 报告外部 import 字段缺口。主管明确接受“可验证既存目标 resume 可实施；外部 import 子路径 fail closed 并记录 blocked-upstream；new/fork 后置新 ID commit”的支持矩阵。不是自行删除产品要求。父层 inline 核对并同步计划后才派 S1a/S1b。
- 本任务只创建本文；不改计划、production、上游、node_modules、vendor，不新增全局独占、不伪造 new/fork 目标。

## 1. 静态证据与实际调用链

下列 SDK 路径均以前缀 `node_modules/@earendil-works/pi-coding-agent/` 为准，仅读源代码而未启动 Host。

| 证据 | 精确位置与事实 |
|---|---|
| event 字段 | `dist/core/extensions/types.d.ts:555–580`：`SessionStartEvent.reason = startup\|reload\|new\|resume\|fork`；replacement 带 `previousSessionFile?: string`。`SessionBeforeSwitchEvent` 仅 `type:'session_before_switch'`、`reason:'new'\|'resume'`、`targetSessionFile?: string`。`SessionBeforeForkEvent` 仅 `entryId:string`、`position:'before'\|'at'`，无目标 ID/file。 |
| before result | `dist/core/extensions/types.d.ts:1095–1102`：`SessionBeforeSwitchResult { cancel?: boolean }`；fork result 另有 `skipConversationRestore?: boolean`。只用显式 `{cancel:true}` 拒绝。 |
| shutdown 字段 | `dist/core/extensions/types.d.ts:617–622`：`reason:'quit'\|'reload'\|'new'\|'resume'\|'fork'`、`targetSessionFile?:string`。不是成功/失败结果事件。 |
| runner 顺序 | `dist/core/extensions/runner.js:807–840`：handler 按加载/注册顺序快照、逐个 await；before handler 返回 cancel 立即停止后续 handler；throw 被报告后继续，**throw 不取消**；普通 `session_start/session_shutdown` 的返回值不会取消 runtime。 |
| resume 首个目标访问 | `dist/core/agent-session-runtime.js:128–147`：`emitBeforeSwitch('resume', sessionPath)` → cancelled 则 return → `SessionManager.open(sessionPath, undefined, options?.cwdOverride)` → `assertSessionCwdExists` → teardown → create/apply → finish。before 在 open 和旧 session abort/dispose 前。 |
| teardown | 同文件 `97–108`：`session.abort()` → shutdown handlers → beforeSessionInvalidate → `session.dispose()`。shutdown 发生在目标 open 后，不能作为提前占用入口。 |
| new | 同文件 `149–173`：before('new') 无 target → 创建新 SessionManager/新 ID → teardown → runtime replacement。 |
| fork | 同文件 `175–251`：before_fork 先执行，无目标身份；其后校验 entry、创建新 session 或 branched file；持久化 fork 可先写新文件，再 teardown。不能宣称新目标先被 claim。 |
| import | 同文件 `258–298`：校验输入存在、可能 mkdir sessionDir、确定 destination → before('resume', destination) → 可能 COPYFILE_EXCL → open → teardown。复制输入路径、header、cwdOverride 未发给 event；不存在 destination 时不能提前解析其身份。 |
| public runtime 签名 | `dist/core/agent-session-runtime.d.ts:73–106`：`switchSession(sessionPath:string, options?:{cwdOverride?:string;withSession?:(ctx:ReplacedSessionContext)=>Promise<void>;projectTrustContextFactory?:(cwd:string)=>ProjectTrustContext}):Promise<{cancelled:boolean}>`；`importFromJsonl(inputPath:string,cwdOverride?:string):Promise<{cancelled:boolean}>`。这些 method result 不会广播给 extension。 |
| 绑定新 session | `dist/modes/interactive/interactive-mode.js:366` 的 rebind；`1472` 的 bindExtensions；`dist/core/agent-session.js:2594–2616` 在 bind 后 await runner.emit(_sessionStartEvent)。新 extension 闭包不得依赖旧闭包的 token。 |
| UI resume/override | `dist/modes/interactive/interactive-mode.js:4767,4784` 调用 runtime.switchSession；import 在 `5468,5482`。override 重试仍不向 before event 传 cwdOverride。 |
| open 不是纯探测 | `dist/core/session-manager.js:644–730,1326–1348`：open 创建 manager、load 完整 entries；loadEntriesFromFile 可补末尾换行（`326–369`）；空文件初始化并 rewrite；旧版本 migration 可 rewrite。禁止以 open 作为身份探测。 |
| bounded header 合法工具 | 本仓 `src/session-owner/contract.ts` 公共 `canonicalizeCwd`、`normalizeSessionPath`、`MAX_SESSION_HEADER_BYTES = 16*1024`、`readSessionHeaderBytes`。readSessionHeaderBytes 用只读 fd、遇首个 LF 停止，最多 16KiB。 |
| 当前非 CAS | `src/session-owner/lifecycle.ts`：beforeSwitch 当前先 sourceIsUnavailable(list)，再 list 检查目标，无 publish；start 的 list+update 也在不同 guard。shutdown 当前清空 pending。必须替换，不是复用这条 check 作为事务。 |
| 可复用 private guard | `src/session-owner/registry.ts`：withGuard/withGuardAsync、recordsLocked、publishLocked、privateJson；同 guard 内 scan+rename 自身单条 record 可同时保留 source/pending。root 0700、record/guard 0600、caller UID、no-follow、inode 校验、ESRCH-only 清理；陈旧 guard 不自动删除。 |

`docs/session-owner.md` 中“运行期只检查、不修改记录、接受同时确认竞态”是**当前**行为，不是 S1a 完成证明；S1b 必须更新该说明。文档旧 Pi 版本号及现有测试标题版本不能代替现场 1.0.4 metadata。

### 无公开结果 hook 的完整边界

1. 更早 before handler cancel：owner handler 根本没执行，没有新增 reservation。
2. owner handler 先 reserve 成功，更晚 handler cancel：旧 source 未 teardown，record 仍 active source + pending target；**没有自动 abort**。
3. 更早/更晚 handler throw：runner 报告异常后继续；owner 自身异常必须 catch 并返回 cancel。不能把 throw 当事务 rollback 信号。
4. `SessionManager.open`、cwd 校验失败：旧 source 通常尚未 teardown，source + pending 保留。目标 open 自己可能已产生文件 mutation，不能声称“open 失败目标完全未变”。
5. `abort()` / shutdown / createRuntime / rebind / bindExtensions 失败：可能旧 runtime 已销毁、record transitioning，仍保留 source + pending。shutdown 通知不是可撤销 teardown，不能通过 throw 阻止它。
6. commit guard/check/publish/releaseGuard 失败：新 manager 可能已经打开甚至绑定；不等于成功取消。通知并请求 `ctx.shutdown()`，不允许继续把该 Host 当健康独占。没有公开能力保证新 session_start 其他 handler 尚未执行，不能声称 session_start 是全局可取消初始化屏障。
7. createRuntime/rebind 后 `withSession` 失败：可能已 commit target；不自动恢复 source，不 abort 已 committed token。

## 2. 身份解析合同（S1b）

### source

仅用本次 ctx 的公开 `sessionManager.getCwd():string`、`getSessionId():string|null`、`getSessionFile():string|null`（本仓 `extension.ts` 的 identity）。先 canonicalizeCwd，非空 file 先 normalize。正常 source 不读 session 正文、header、私有 authority 或 `.state`。source 比较必须三字段严格相等，不使用“file 或 ID 任一相同”的宽松 own 身份判定。

### target

仅处理 `reason === 'resume' && typeof targetSessionFile === 'string' && targetSessionFile !== ''`。

1. selected absolute path 进行本仓公开 normalizeSessionPath；相对路径按真实 `process.cwd()` 解算，不以 header cwd 解算。先用 `node:os.homedir()` 展开 `~`/`~/`，`file://` 用 `node:url.fileURLToPath()` 解码（非法 URL 拒绝），再规范化；不做 trim/Unicode 空格替换。依据 SDK `dist/utils/paths.js:61–91` normalizePath/resolvePath 默认规则；当前 POSIX 受控入口不新增 Windows shell 路径转换承诺。不能让 extension 与 runtime 对同一个字符串打开不同文件。
2. `stat` 为既存 regular file；canonical path 只用于本地路径 identity。不将 normalizeSessionPath 的 ENOENT fallback 当“已验证目标”。
3. 只通过公开 `readSessionHeaderBytes(path)` 读取，预算 16KiB，首个 LF 截止；解析首个物理行（去末尾 CR），要求对象 `type:'session'`、非空 string `id`、非空 string `cwd`，且 cwd 能 canonicalize 为既存目录。
4. 可接受有 EOF 无 LF、长度严格小于 16KiB 的完整首行；长度达到上限且无 LF 必须拒绝（不能证明首行完整）。超过上限、空文件、缺字段、非法 JSON、读取/权限失败、cwd 不可验证，一律 `target-unverifiable` 并 cancel；不回退 open/list/loadEntries。
5. 目标 identity 为 `{cwd:canonicalHeaderCwd, sessionId:header.id, sessionFile:canonicalPath}`。header cwd 可以不同于 source cwd，支持合法跨 cwd resume，不要求等于 source。
6. public helper 可以作为 S1b lifecycle 私有函数复用；不必新增 contract.ts 写路径。**不得调用 contract.ts 私有 sessionHeader/resolveLaunchTarget 路径探测**：当前 sessionHeader 使用 readFileSync 全文件，不符合本 gate 预算。
7. SDK 允许跳过 malformed prefix、1MiB 级 header、缺 cwd fallback、空文件生成新身份等宽语义；它们不在本次可验证前置身份矩阵内，明确拒绝，不能新增 production “兼容 fallback”。目标文件外部 rename/delete/replace、copy/hardlink/NFS/跨机器仍 unsupported；guard 保护 registry 不是文件系统内容锁。

cwdOverride 不是 event 字段，禁止从私有 runtime/调用栈猜值。若某条合法 override 得到的新 ctx.cwd 与保留 target.cwd 不同，commit 必须 mismatch fail closed；不得将 header cwd 改成 source cwd 把它伪装成已验证。该限制写入 S1b 运维说明。

## 3. S1a 精确公开 API（待父层 inline 冻结）

以下是要实现的新签名，不是当前已有 exports。全部导出自 `src/session-owner/registry.ts`，由现有 `src/session-owner/index.ts` 的公开入口消费；不从别的 feature 深引。

```typescript
export type SwitchIdentity = Readonly<{
  cwd: string;
  sessionId: string | null;
  sessionFile: string | null;
}>;
export type SwitchTarget = Readonly<{
  cwd: string;
  sessionId: string;
  sessionFile: string;
}>;
export type SwitchBlockReason =
  | 'owner-mismatch' | 'source-mismatch' | 'transition-in-progress'
  | 'target-mismatch' | 'stale-reservation' | 'session-owned'
  | 'selector-active' | 'registry-busy' | 'registry-unavailable';
export type SwitchBlocked = Readonly<{
  decision: 'blocked';
  reason: SwitchBlockReason;
  conflictingOwnerId?: string;
}>;
export type ReserveSwitchTargetInput = Readonly<{
  store: RegistryStore;
  ownerId: string;
  pid: number;
  source: SwitchIdentity;
  target: SwitchTarget;
}>;
export function reserveSwitchTarget(input: ReserveSwitchTargetInput): Promise<
  | Readonly<{ decision: 'reserved'; reservationId: string }>
  | SwitchBlocked
>;

export type CommitSwitchTargetInput = Readonly<{
  store: RegistryStore;
  ownerId: string;
  pid: number;
  target: SwitchIdentity;
}> & (
  | Readonly<{ kind: 'resume'; source: SwitchIdentity; reservationId: string }>
  | Readonly<{ kind: 'startup'; source: null; reservationId: null }>
  | Readonly<{ kind: 'reload'; source: SwitchIdentity; reservationId: null }>
  | Readonly<{ kind: 'new' | 'fork'; source: SwitchIdentity; reservationId: null }>
);
export function commitSwitchTarget(input: CommitSwitchTargetInput): Promise<
  | Readonly<{ decision: 'committed'; record: ProcessOwnerRecord }>
  | SwitchBlocked
>;

export type AbortSwitchTargetInput = Readonly<{
  store: RegistryStore;
  ownerId: string;
  pid: number;
  source: SwitchIdentity;
  target: SwitchTarget;
  reservationId: string;
}>;
export function abortSwitchTarget(input: AbortSwitchTargetInput): Promise<
  | Readonly<{ decision: 'aborted'; record: ProcessOwnerRecord }>
  | SwitchBlocked
>;
```

- registry 输入必须是已规范化 absolute cwd/file；校验结构、安全整数 pid、ownerId、非空 target id/file。目标解析错误属于 lifecycle `target-unverifiable`，不混入 registry API。未知结构 fail closed，不自动补字段。
- `ownerId` 本身就是 launcher owner nonce；仅相同 PID 不代表自身。事务 nonce `reservationId` 由 registry `randomUUID()` 生成，不由事件或调用方伪造。
- 返回 blocked 不代表没有发生 publish（guard finally 可能失败）；调用方必须以持久 record/下次 guard 重试 reconcile。不得把错误结果转换成自动 abort。
- 校验失败返回上述 blocked reason，不泄漏 record 正文；权限/解析/publication/guard 错误分别 registry-unavailable/busy。不得吞错后 allow。

## 4. record schema 与 same-guard 事务

保留 `protocol:'pi-session-owner.v1'` 和全部原字段、历史缺 forkSource→null 的既定规则；**仅为新实现增加 optional 字段**。缺 switchReservation 的 legacy v1 等价 null；有字段但畸形则 registry-unavailable，绝不当成 legacy。

```typescript
export type SwitchReservation = Readonly<{
  reservationId: string;
  source: SwitchIdentity;
  target: SwitchTarget;
  phase: 'reserved' | 'committed' | 'aborted';
}>;
// ProcessOwnerRecord 增加：
// switchReservation?: SwitchReservation | null;
```

| 原字段/新增字段 | reservation 存在期间的不变量 |
|---|---|
| protocol, ownerId, pid, startedAt | 不变；ownerId+pid 双重验证，只写自身 `<ownerId>.json`。 |
| cwd, sessionId, sessionFile | reserve / transitional shutdown 期间始终是原 source，不能先换成 target。 |
| state | reserve 后仍 active；resume shutdown 才 transitioning。 |
| pendingSessionFile | reserved 时等于 switchReservation.target.sessionFile；committed/aborted 为 null。原 startup pending 仍按原 launcher 语义。 |
| forkSource | startup 原合同保持；runtime reserve 要求自身 active，不借 forkSource 伪造 target。 |
| switchReservation.source/target | 精确三字段身份快照；跨 cwd target 的 ID 冲突不能用 source.cwd 比较。 |
| phase + reservationId | 留最后一次 committed/aborted receipt 支持同 token 幂等、拒绝旧 token；新的 reserve 替换终态 receipt，不能删除 live reserved。receipt 不占用旧 source/target。 |

### reserveSwitchTarget（一个现有 private guard）

1. acquire guard → recordsLocked（完整校验所有 record；只有 ESRCH 清理）。坏 record/EPERM 未证明死亡都保留并 fail closed。
2. 找 ownerId 对应 record，pid 必须相同；自身不存在/同 ownerId 不同 pid：owner-mismatch。扫描冲突时只有 ownerId+pid 都匹配才排除自身，**另一 owner 同 PID 仍冲突**。
3. active 且顶层 source 三字段精确相等，否则 source-mismatch/transition-in-progress。
4. 如有 phase reserved 且 source、target 完全相同：同 guard 校验所有 other live 冲突后返回原 reservationId，不重新生成 nonce。已有不同 target/source 的 reserved：transition-in-progress，无副作用，不偷偷换目标。
5. 所有其他 live record 的 active source、startup pending file/ID、forkSource、reserved target 都纳入冲突；既检查本次 target，也检查 own source 是否被另一记录占用。file 规范路径相等 **或** canonical cwd + sessionId 相等即冲突；reserved target 的 cwd/id 独立于顶层 source。selector 延续既定规则，返回 selector-active；不新增 running owner 全局锁。
6. 同 guard 内生成新 nonce，将 source 顶层保留并新增 target pending、phase reserved，publishLocked 原子 rename 自身一个 record → release guard。不使用 listLiveRecords 的 snapshot 作为 CAS，不建立第二文件/第二锁。

`recordMatches/conflict` 必须扩展 reserved target 匹配；`session-id` startup intent 也须检查 pending target.cwd/id，不能只有 file 请求看到 pending。老 source claim 直到 commit 成功一直被识别。

### shutdown 保留（S1b + S1a 原 update helper）

- reload 不 release、不清 pending、不改 source；active+reserved 也允许重新绑定同 source，reservation 保留。
- resume shutdown 只把 state 改 transitioning，其他 source/reservation/pending 不变；验证公开 shutdown source 与保留 source 一致。shutdown target file 若提供则规范化核对，但不是提前 claim。
- new/fork 只在无 phase reserved 时获 before 放行；shutdown 保留真实 source，state transitioning，清除旧committed/aborted receipt为null，无新目标 ID/file claim。
- quit 仅 `releaseOwnRecord({store,ownerId,pid})`；不得释放另一个 owner，同 PID 也不得。
- S1a 的 `updateOwnRecord` 不能再用 `pendingSessionFile ?? null` 静默清除 live reservation：字段省略应保留；在 phase reserved 下显式清 pending / 替换 source / 改 reservation 的一般 update 必须拒绝（唯有专用 commit/abort 可做）。此项无需扩大写路径，函数仍在 registry.ts。不得在 shutdown 另做 list→update 覆盖。

### commitSwitchTarget（一个 guard 完成 validate+publish）

所有 mode 都扫描 other live records 并检查 target 冲突，然后单条 publish；不得沿用 lifecycle.start 的 list→update。

- resume：phase reserved、nonce 相等、source 相等、target 精确等于新 ctx identity，state 必须 transitioning；在同 guard 将顶层改 target、state active、pending null、forkSource null、phase committed。旧 source 的占用与 pending 的清除只在此原子 publish 一起发生。
- resume 同 nonce 重入：phase committed 且 source/target/token 相等、顶层 active target 等于输入，无冲突时返回 committed；别的 token、aborted token、新 reservation 后的旧 token一律 stale-reservation，不改 record。
- startup：无 live reserved，按 launcher 原 pending/selecting/session-id/forkSource 的可启动规则校验真实 target，冲突也在同 guard 检查。startup active 重入仅同 identity 可成功；不能允许任意 target 覆盖 active。
- reload：source===target===顶层当前 identity 且 state active；保留 phase reserved 和 pending（它可能来自 late cancel/open 失败）；只作为原子验证，不释放 claim。transitioning reload 不冒充恢复成功。
- new/fork：无 live reserved；state transitioning、source===顶层保留 source，target 为实际新 ctx 身份；target 与 source 的新 ID 语义核实（fork 不能把 source 自己当 destination）；在同 guard 冲突检查后切为 active target、清原 startup fields，不制造 before 新 ID。
- new/fork 重复 session_start：当前 active target 完全相等且无 live reserved 时可幂等验证；不同 active identity拒绝。不复用已经失效的 resume receipt 来允许旧 commit。
- 任何 mismatch/foreign owner/registry 故障均不主动清 source/pending；extension 通知具体原因并请求有序 shutdown。`session_start` return `{cancel:true}` **不是** SDK 支持的取消，不能作为验收成功证据。

receipt 在 commit 后只用于幂等，不再作为资源 claim。startup首次commit与new/fork成功commit清旧终态receipt为null；reload保留receipt。startup/reload/new/fork 不得凭旧 receipt 冲突旧 session；不能造永久 global exclusive。

schema校验还须验证phase一致性：reserved的顶层身份===source、state为active或transitioning、pendingSessionFile===target.file；committed的顶层身份===target、state active、pending null；aborted的顶层身份===source、state active、pending null。receipt target/source字段不可缺失，nonce为非空UUID格式；不一致即坏record拒绝，不忽略。new/fork shutdown清终态receipt，绝不重新激活其target claim。

### abortSwitchTarget（可用 API，但本批不在猜测结果后自动调用）

- phase reserved + exact ownerId/pid + exact nonce/source/target + 顶层 active source，才能在同 guard 清 pending、标记 phase aborted；source 顶层不变。
- phase aborted、同 token/source/target、仍 active source，重复返回 aborted。
- transitioning、committed、不同 token/target/source、owner 不匹配一律拒绝，不把已经打开/替换的 target 当没发生过。
- 生命周期无法从 public event 得知晚 cancel/open 失败，所以不安排自动 abort；不加后台 timeout、定时解锁或猜测“没有 session_start”。本批没有新恢复 command 写路径。API 只供明确知道尚未 teardown 的合法调用方/隔离测试使用，不能暗示用户已有运行期 abort 操作。

## 5. 支持矩阵、保守恢复与正反例

| 路径/场景 | before 处理 | 持久结果/恢复 | 状态 |
|---|---|---|---|
| 既存 free target header 有效 | reserve；再返回 undefined | open → shutdown 保留 → session_start guard commit | 可实施，待 S1v 验证 |
| 两 owner 同目标 | 一个 guard reserve 成功，另一 cancel | loser source 不动；winner 尚未 commit 也阻断 reuse | 可实施 |
| 另一 owner 同 PID 不同 nonce | 不排除另一 record，cancel | 不删除/覆盖另一 owner | 可实施 |
| 同 owner/source/target 重试 | 返回原 nonce | 无重复 claim；再次正常 resume 可 commit | 可实施 |
| reserved 后 late cancel / open 失败 | 无 result hook，不 abort | active source + pending target 保留；可重试**同一 target/身份** | 保守支持，自动 rollback 不可用 |
| pending 存在时改选另一 target/new/fork | cancel，transition-in-progress | 不放弃原 pending；提示重试同目标或退出重启 | 可实施 |
| resume teardown 后 create/bind 失败 | 不猜恢复 | transitioning source + pending 保留；退出该进程后重启 | 保守支持 |
| quit / 异常进程退出 | quit 只 own release；死进程 ESRCH-only | 退出后其他 launcher scan 清死 record；EPERM/坏 record/陈旧 guard 必须人工确认 | 原合同保持 |
| reload/tree | 不释放；reload guard 验证原 source | pending 也保留；tree 不更改 owner | 可实施 |
| new/fork 正常新 identity | before 仅 source 可用性/冲突核验，无 target claim | shutdown transitioning source → 实际 session_start 原子 commit 新 identity | 原新 ID 语义保持，不宣称前置目标事务 |
| import 输入已经是 destination | before 可读既存有效 header | 按 resume 处理（无 override 时） | 有条件支持 |
| 外部 import 尚不存在 destination | header 不存在，target-unverifiable cancel | 不读取未公开 inputPath、不 copy/初始化/猜 ID；早先 mkdir 不保证回退 | blocked-upstream 子路径 |
| header 不存在/空/畸形/过大/cwd 未知 | cancel，target-unverifiable | 不 reserve、不 open；不误称别人占用 | fail closed |
| cwdOverride 与 header cwd 不同 | event 无值，不能预验证 override | 真实 ctx身份不匹配时 commit拒绝、请求shutdown；不假装独占成功 | 未承诺该 override 子路径 |
| rename/delete/replace/copy/hardlink/NFS/绕过 wrapper | 不扩范围 | 仍 unsupported，不靠 SessionManager.open 修复身份 | 不适用 |

正常恢复动作只有：当前 source 尚 active 时重试**同 target**（原 path/id/cwd仍可信）；或者退出该 Pi 进程并从受控 launcher 重启。若已 transitioning，不允许恢复旧 runtime 健康状态。PID 活着但失去旧 runtime 时不能由另一进程擅自删 record；异常退出的 ESRCH scan 是恢复条件而非提前释放。共享 guard 陈旧仍按原人工流程处理。

正例 fixture：A=`{cwd:'/fixture/cwd',sessionId:'a',sessionFile:'/fixture/sessions/a.jsonl'}`，B=`{cwd:'/fixture/other',sessionId:'b',sessionFile:'/fixture/sessions/b.jsonl'}`；真实临时目录 + 自生成 `{"type":"session","id":"b","cwd":"<canonical fixture other>"}\n` header。A reserve B 后顶层仍 A，pending/target 为 B；other owner 对 A/B 均被阻断；commit B 后 A 可重新获 claim。

反例：另一路径 B2/header ID 同 B/cwd同 B，必须 ID 冲突；同 PID 另一 ownerId 不能绕过；owner PID 不同不能 commit；token1 abort 后 token2 reserve，token1 commit/abort拒绝；同 token但不同 target拒绝；source file相同但 source ID/cwd不一致拒绝；active+pending reload只验证source，不能 commit target；畸形新增字段即使原 v1字段有效也不忽略。

## 6. S1a/S1b 精确写路径与实施后验证

本 gate 没有新增测试、没有运行以下命令。实施者必须在实现后补合同测试，不使用 TDD/RED skill。

### S1a

- 写：`src/session-owner/registry.ts`、`src/session-owner/index.ts`、`test/session-owner-registry.test.mjs`。
- 测试必须覆盖：双 owner（同 PID 和不同 PID）争同 target；source 与 pending 均冲突；target 跨 cwd ID；startup `session-id` 能看见 pending target；own 重入同 token；pending 不同 target拒绝；nonce/PID/source/target mismatch；旧 token commit/abort；abort/commit各自幂等但不互换；legacy v1缺字段接受/畸形字段拒绝；ESRCH-only、EPERM、坏 record、外国 UID、symlink、guard busy；publish与releaseGuard失败不伪报rollback；new独立不新增global锁。
- 命令：`node --test test/session-owner-registry.test.mjs`；`npm run typecheck:root`；`git diff --check`。

### S1b

- 写：`src/session-owner/lifecycle.ts`、`src/session-owner/extension.ts`、`docs/session-owner.md`、`test/session-owner-extension.integration.mjs`、`test/session-owner-contract.test.mjs`。
- DI：lifecycle/extension deps 加入上述三个公开事务函数；普通 start不再list→update。目标 parser留lifecycle私有、复用public bounded reader，无需写contract.ts。
- beforeSwitch 返回取消 boolean 仍可保留内部形式，但 extension必须显式转换 `{cancel:true}`。reason new/fork只source核验；unknown event/missing target拒绝。通知区分 ownership conflict、身份不可验证、pending transitional与registry故障，不能统一误称另一窗口占用。
- shutdown 同guard状态更新不能清pending；start(reason, previousSessionFile, identity)从持久receipt取nonce/source（读取快照只是输入，commit guard必须重新校验），不用旧闭包捕获ctx。previousSessionFile如有必须与保留source file规范匹配；无source证据不猜。新extension通过registry字段重建plain token；session_start本身无reservationId。
- 测试必须覆盖：真实SDK取消发生open/teardown前；先reserve再open再shutdown再commit顺序；before更早cancel无新增record、晚cancel保留record；handler throw不当cancel；open失败active+pending；create/bind失败transitioning+pending；session_start失败不靠return cancel，确实request shutdown；reload保留pending；new/fork目标ID不在before且源保持；外部import缺header显式cancel；首行有界且不读body marker；合法跨cwd、CRLF、无LF短header、oversize/empty/malformed/missing cwd/ENOENT拒绝；同nonce重试；quit只自身；raw event不改写。
- `test/session-owner-extension.integration.mjs` 当前使用 `/sessions/...` 手拼缺文件ctx，现有“before不修改record”的断言是旧合同；必须改自生成header fixture与新断言，不能为这些不合法fixture新增production fallback。当前源的特殊旧v1测试标题不是本任务运行结果。
- 命令：`node --test test/session-owner-contract.test.mjs test/session-owner-extension.integration.mjs`；`npm run typecheck:root`；`git diff --check`。
- 后续 S1v 才验证受控入口与实际竞争；本 gate 不运行 PTY、Host、provider、网络或 kill。

## 7. 数据来源、残余风险与验证记录

- 本任务仅静态源码和自生成fixture代码审查。无production异常样本、无真实session读取，无凭据/配置/settings/models/auth/authority/.state读取。
- import字段不足属于现场合法public调用链证据，不是手工mock异常：`importFromJsonl(inputPath)` → destination选址 → before(destination) → copy → open。缺口首点就在before payload，故不能通过缺字段fixture fallback伪修。
- 原 dirty五计划输入+baseline保护；其他八任务精确非重叠写入是已声明并行工作，不归类 unknown dirty。不stage/commit/stash/reset。
- v1 optional schema兼容既有record读取不代表旧runtime实现自动支持pending target ID；只保证升级后本仓受控extension/launcher实现的合同。长期活着的旧实现需有序退出/加载新实现后才宣称新事务保护，不为此扩上游。
- 目标header到open间外部文件replace不在保证内；SDK cwdOverride缺payload、外部import缺header、无result hook、session_start不能cancel全局初始化均已显式保留限制。
- 实施尚未发生；S1a/S1b/S1v 测试、root typecheck、runtime race 均未运行，不声称功能完成。

### 实际静态命令与证据

| 命令 | exitCode | 结果 |
|---|---:|---|
| `git status --short && git diff --cached --name-only && git rev-parse HEAD` | 0 | 开始时仅五计划输入+baseline dirty，index为空，HEAD如上。 |
| `git diff --check` | 0 | 只检查现有tracked diff；本文untracked另作有界文档审计。 |
| 本文链接/关键字段/空白静态审计（`python3 - <<'PY' … PY`，只读） | 0 | `S1g static artifact audit: PASS; 15 paths exist; API/schema/boundary markers and whitespace valid; 270 lines`；不import production、不执行测试。 |
| `git diff --cached --name-only` 与最终 `git diff --check` | 0 | index 输出空；diff check 输出空。静态审计后仅将本行结果补入本文，未写其他路径。 |

终态下一步：父层 inline 冻结本文接口与支持矩阵、同步统一计划，再派 S1a；S1a通过后派S1b。外部import解除阻塞需要上游公开before输入header/可信identity或明确合法不同入口授权，本批不申请工单、不改上游。自动rollback若将来成为产品要求，需要公开switch结果hook，当前不能承诺。
