# Supervisor child 级门禁与受控清理实现计划

> **给执行 agent：** 必须逐任务执行本计划；步骤使用 `- [ ]` 跟踪。执行方式由计划完成后的用户选择决定。本次只授权计划编写；首轮自动 reviewer 返回后由父层 inline 修订，不自动实施、不自动多轮 review。

**目标：** 不让已提交 reply 或其他 child 的请求阻止目标 child steer；提供主 agent 可使用的、单 request、有核验和审计的遗留状态清理入口，不再依赖手工删除 JSON 或等待 TTL。

**架构：** 保留唯一 Supervisor Control Plane/DurableStorage。将“需要回复”“回复已提交”“回复已消费”“行政清理”分成不同事实；运行身份/owner 仍强制校验。清理通过独立 inspect/clear 工具执行，提交时重新观察上游 pending，并以 control-plane revision 和一次性 token 防止清理陈旧快照；不删除上游 request，不伪造 child ACK。

**技术栈：** Node `>=22.19.0` 原生 TypeScript、Pi `1.0.4`、pi-subagents `0.75.0`、Node test、本地 fake adapter/真实 SDK fixture。

## 1. 范围、现有证据与全局约束

- 用户明确要求：每个 subagent 独立判断；无待处理 reply 时 steer 应可排队；状态异常须有受支持的清理逃生口。
- 证据：`docs/research/2026-10-15-supervisor-steer-block-diagnosis.md`。现 gate 查询 `runId/rootSessionId/ownerGeneration` 下任一 pending，缺 childIndex；reply 成功默认 queued/consumed=false、request保持pending；消费权威观察依赖terminal对账。
- 新现场：父会话已对 `ae0ae1d2-bdc5-40bf-8fc9-af3512cad199`、`3e255363-2d88-4549-a37d-20f142d728e7` 提交已回复后的steer，收到 `SUPERVISOR_REPLY_REQUIRED`，同窗口public pending为空。此事实证明视图差异，**不能单凭它证明对应durable receipt已queued或确定具体历史根因**。
- D2新增 `readDiagnostics`，单元14/14、scoped类型通过；当时整体类型检查受并行D1污染。D1随后独立复验D0 35/35、RPC聚焦36/36、package类型通过。实施前以最终合入事实为准，不覆盖这些dirty成果。
- 本计划改变的是**门禁产品策略**，不因旧测试断言“已reply仍应阻断”便维持旧缺陷；原始request/receipt来源必须按public链实证和分类，不预加compat。
- 不修改 upstream/node_modules/vendor/fork/依赖patch；不新增深层上游import，已有兼容入口为唯一深引owner。
- 不读真实settings/models/auth/credential、完整session/authority/state；只用明确自造fixture。只读诊断不得输出正文、session路径、owner token、reply payload digest。
- owner三态、root/ownerGeneration、run身份、requestGeneration、DurableStorage CAS和terminal消费判据不放宽；unknown/unavailable/corrupt拒绝管理mutation。
- 清理不等于reply或consumed。不得写 `consumed:true`，不得调用消费对账接口作为清理手段，不删原request身份，不操作上游文件。
- 清理粒度单个 `runId + childIndex + requestId + requestGeneration`，没有clear-all/bulk/root-wide操作。
- 工具独立、主会话model-only：`subagent_supervisor_inspect`、`subagent_supervisor_clear`。不等全量“每操作独立工具”迁移，也不塞回现有action union。
- 不使用TDD/RED/相关skill；实现后补合同测试。文档/注释中文，production/CLI `.ts`，tests可 `.mjs`。
- 禁GPT/deepseek新子代理。禁止MCP。无真实Host/provider/网络/通知/kill授权；不自动工单、提交或push。
- 不stash/reset/clean，不raw删managed workspace，保护dirty。当前runtime-closeout的D3同写extension/control-plane，必须在其发布后再开始本计划相关写入；静态gate可并行。
- 本计划不涉及idle/resume(model)/triggerTurn/scheduler并发/footer/PTY/旧hb工作区清理。

## 2. 冻结功能合同

### 2.1 child identity 与 gate

使用现有live root resolver及owner authority。`steer`先规范化完整runId（不引入路径/前缀绕过），再取得可信child目录：`{runId, ownerGeneration, children:[{childIndex,agent,lifecycleIdentity,steerable}]}`。

- 显式index必须是非负整数并且属于该run；缺index只有**恰好一个可验证可steer child**时推断，否则返回 `SUPERVISOR_STEER_CHILD_AMBIGUOUS`，明确取消上游旧的无index广播行为；runId前缀歧义仍用独立TARGET错误码。
- identity读失败返回 `SUPERVISOR_TARGET_UNAVAILABLE`，不能把有界footer/fleet投影中缺行当“child不存在”。G0核定真实可用目录接口后冻结其adapter，无法证明时该分支停报。
- gate必须按精确root/run/ownergen/**childIndex**过滤，不同run/child互不影响；request缺可信child关联不能默认为0或阻断所有child，返回 `SUPERVISOR_REQUEST_SCOPE_UNVERIFIED` 并提供inspect入口。
- 先验证目标runtime可steer，再处理pending，不让已终止run被旧pending误报为“需要reply”。

### 2.2 reply提交与消费分离

不必为“reply已提交”改变现有request.state或伪造replied：

```text
needs-reply       = pending且无精确匹配的成功reply receipt
reply-submitted   = pending且有kind=reply、status=queued、consumed=false的精确receipt
consumed          = replied且对应delivered/consumed=true事实存在
cleared           = failed且带本计划administrativeResolution记录（不是业务失败/消费成功）
terminal          = 既有failed/expired/replied非待回复记录
```

匹配键包括root/run/ownergen/requestId/requestGeneration，旧代或steer receipt不参与。允许存在多个reply payload，但不能把一个request的成功receipt覆盖另一个request的未回复事实。

- 目标child有needs-reply：拒绝，并返回安全requestId/childIndex/分类；其他child的needs-reply不影响。
- 目标child只有reply-submitted：允许上游正常排队；queued/consumed原样保持，后续terminal对账仍可升级。
- reply adapter返回`isError:true`不视为提交成功；异常与commit失败须保持“提交结果未知”，不让gate凭猜测解除。steer 的上游 RPC 也必须单独检查返回对象的`isError`：`isError:true`视为本次 steer 投递失败，不能写 queued receipt；若已写入失败 receipt，后续相同 payload/epoch 必须允许按明确失败语义重试，不能被幂等短路永久锁死。只有非错误且原有delivery提交成功才写 queued。
- reply in-flight与steer并发：旧事实尚未commit时可暂拒；成功commit后下一调用应允许，不引入等待20min或等待terminal条件。
- 用reply正文重复发送steer的现有去重保护保留并收紧到同child；queued不能因为允许steer就跳过重复payload检查。失败 receipt 不得阻止同一目标的显式重试；成功 queued/delivered receipt 才参与相同payload/epoch幂等判定。补测上游返回`isError:true`、throw、delivery已失败后的重试。
- TTL内存/持久化口径须一致：只对待回复状态按既有expiresAt判断；不修改TTL时长、不以TTL作清理授权。`classifyRequest(request, receipts, now)`必须显式接收/使用时间：内存模式过期pending也不得继续作为needs-reply；过期转换是否写入仅遵循既有持久化事务，不由纯分类函数副作用完成。

### 2.3 逃生口：先inspect，再精确clear

```ts
subagent_supervisor_inspect({runId, childIndex, requestId})
// 返回状态/分类/receipt枚举/clearAllowed/blockedReasons；可清理时返回clearChallenge

subagent_supervisor_clear({
  runId, childIndex, requestId, requestGeneration,
  clearChallenge, reason // 有界非空审计说明，默认诊断不回显正文
})
```

rootSessionId/ownerGeneration由Host提供，禁止模型填写。`reason`表达agent的人工核查判断，但**不是**事实证明。

**上游检查路线：** 通过已绑定native supervisor adapter直接执行其公开`pending`操作，校验`isError!==true`、`details.pending`完整数组及每行{id,runId,childIndex,expectsReply}；先验证bind属于当前root。不解析content中的“No pending”，不绕回已包装的supervisor工具导致递归。G0确认该安装版本`discover/refreshPendingRequests`及其异常行为能给出完整可信结果，否则absence=unavailable，不签token。观察会触发上游既有`discover/refreshPendingRequests`生命周期清理：可能删除已过期/已解决/非活动的上游请求文件；计划只禁止本仓工具主动删除仍live的上游request，不能把该既有副作用描述成绝对无副作用。

上游和本仓两authority没有跨系统原子事务：只能保证**清理时观测快照**与本仓CAS一致，不能宣称绝对排除之后的新ask。风险控制是精确不可复用requestId+generation、提交时重查、从不清同child新request、不删除上游记录；发现同ID重现立即拒绝。

**清理资格：** exact本root请求仍pending、scope可证、当前owner可证、该request不在成功刷新后的upstream live集合。queued只是分类，不自动授权clear；尚无reply但已失去upstream request的orphan也可清理。上游active request仍存在一律拒绝，不能以`reason`或token强制override。owner unavailable/corrupt/child scope缺失时也拒绝；这些异常不由本工具强行逃生，保留TTL/terminal/fresh-owner等后续恢复边界，并返回固定分类码。

**明确的恢复边界：** upstream绑定不可用、owner unavailable、durable corrupt或缺child身份时本工具无法安全清理，返回具体code，不手删、不伪造proof。单纯state machine遗留而权威读面仍健康时应能成功，不把“必须已消费”作为逃生前提。若未来要允许owner已死亡的跨Host管理员恢复，须另设身份授权，不能偷渡到本工具；验收和用户文档必须列出这些不可清理类别及其剩余恢复路径。

**challenge/CAS：** 32随机bytes的opaque token，输出一次；同root state内只存hash/issuedAt/expiresAt（60s）/used/快照。snapshotHash绑定root/run/child/request/ownergen/requestgen/requestDigest及状态revision、upstream exact-absent观察。签发与消费均持原DurableStorage锁，不新造lock。签发会递增revision；clear验证签发后的expectedRevision，不用签发前revision误拒绝。无持久化模式使用同root内存队列/单调revision，不存在无锁race。

**提交：** clear锁内重载、重新验证owner、重查upstream pending、验证token与CAS后一次写：
- request.state=`failed`；新optional `administrativeResolution={code:'SUPERVISOR_ORPHAN_CLEARED',clearedAt,clearerRootSessionId,reason,previousState:'pending',auditId}`；
- 原request/correlation/digest/receipt全部保留；queued receipt不升级或重写成delivered；
- append audit（只含ids/generations/time/旧state/结果code/reason；默认投影可仅reason存在性），challenge置used；
- 写失败不报告clear成功；token/状态/审计必须同一持久化value发布，不分3文件制造部分提交；
- 重复相同token+相同目标在成功持久化后返回同一auditId；不同目标/旧revision/过期token拒绝。

late terminal consumption不得把行政cleared的request复活为replied，也不得把其queued receipt静默升级为delivered/consumed；只能记录“later consumption observed”诊断。正常queued请求的terminal对账保持原语义。

### 2.4 存储版本决策

采用显式 `supervisor-state.v2` 与request v2：新增child identity、optional administrativeResolution、clearChallenges和clearAudits，receipt现有字段保持。v1通过严格parser读取后显式内存迁移，首次成功mutation写v2；readDiagnostics不自动写迁移。必须明确：首次需要持久化challenge/clear的inspect会成为迁移触发点；仅查看而不满足clear资格时不应无谓签发challenge或写v2。未修改的旧v1 Host读取v2会按其原parser返回CORRUPT，不能承诺旧代码会返回新版本不兼容码；新Host对未知版本输出明确版本不兼容分类。两者都fail closed，恢复路径是升级fresh Host，不手工删文件。

- v1有correlation.childIndex可精确迁移；v1无关联不能猜child，应可诊断且clear不授权，等待合法public证据补齐或另案恢复。
- v1 request的旧id/digest/timestamp/终态不变，原stateDigest先验证，再生成v2digest；未知schema/字段/状态仍拒绝。补充v1/v2双向读取验收：新parser能读所有合法v1终态，v2写入后未修改的旧v1 parser明确拒绝（其既有分类为CORRUPT）；新版本仅对自身未知版本输出版本不兼容分类，不能改写旧Host事实。
- 不实现降级回写；发布前说明旧Host不能读v2，不允许同root混用旧/新Host，执行时需fresh Host。当前回话不能在热patch中装上clear立即改自己的控制状态。challenge过期或CAS失败是预期并发结果，工具文案和验收要求重新inspect后重试；并发inspect签发的新challenge会使旧challenge失效。

## 3. 文件职责

| Create/Modify | 路径与职责 |
| --- | --- |
| Create | `src/subagent-dispatch/supervisor-gate-policy.ts`（以下生产路径均在`packages/pi-subagents-enhanced/`下）：纯child目标、分类、去重key策略 |
| Create | `src/subagent-dispatch/supervisor-upstream-observer.ts`：绑定adapter的typed pending快照，不读私有文件 |
| Modify | `src/subagent-dispatch/supervisor-control-plane.ts`：v1/v2 parser、唯一事务、gate、token、audit及readDiagnostics |
| Create | `src/subagent-dispatch/supervisor-recovery-tools.ts`：两独立tool/schema/description，调用controlplane而不持第二状态 |
| Modify | `src/subagent-dispatch/extension.ts`：明确index、tool注册及steer/reply接线 |
| Modify | `extensions/subagent-runtime.ts`：注入observer、root/target authority，child early-return保持 |
| Modify | `src/subagent-dispatch/supervisor-consumption.ts`：行政cleared不复活，其余消费判据不变 |
| Create | `test/supervisor-gate-policy.test.mjs`、`test/supervisor-clear.test.mjs`、`test/supervisor-gate-runtime.integration.mjs`、`test/supervisor-upstream-observer.test.mjs` |
| Modify | `test/subagent-runtime-membrane.test.mjs`、`test/supervisor-consumption.test.mjs`、`test/supervisor-diagnostics.test.mjs`：新合同与兼容，不删其他断言 |
| Create | `docs/bugs/2026-10-15-supervisor-gate-overconvergence.md`、本计划records目录的合同/验收文档 |

不新增package exports或跨feature内部依赖。policy/observer/recovery-tools都是同一feature的实现，不放scripts/lib/common。全量tools拆分尚未实施，本计划只新增独立inspect/clear，不更改旧工具命名。

## 4. DAG、Waves、资源

```text
B 基线 ──> G0 child identity + upstream observer合同探索
                 ├─> G1 纯child/gate分类 ──> G2 gate持久接线 ───────┐
                 └─> C1 上游observer ──> C2 clear存储/事务 ──┐     │
                                  G2 ──────────────────────┘     │
                                                C3 inspect/clear接线
                                                        └─> V 公开链验收 ─> Z 总账
```

G0应分别给gate-target与upstream-absence两条ready结果；absence阻塞**不阻塞**G1/G2修复，clear单列blocked。即使完整child目录无法公开证明，G1/G2仍可先交付显式`index`+现有`correlation.childIndex`的child级gate子集；缺index推断、多child归属与clear observer单独返回fixed blocked code，不得让G0目录缺口阻塞reply-submitted放行。C2依赖G2因为共享v2 schema与control-plane事务、需要其child身份与parser；C3消费G2/C2 API。V可先验gate，clear阻塞不冒称整功能完成。

- Wave0 B；Wave1 G0；Wave2 G1/C1；Wave3 G2；Wave4 C2；Wave5 C3；Wave6 V；Wave7 Z。
- 关键路径B→G0→G1→G2→C2→C3→V→Z；C1只提供absenceobserver，不必等G1。
- `unit-runner=1`，无visible-host/网络/危险signal。静态实现可并行，G2/C2共享control-plane且确有schema产物依赖；C3在本轮runtime-closeout D3发布后方可写extension。
- Worktree隔离按资源兼容ready set调度；dirty不是自动stash/reset/commit理由，受管coding集成child负责。父层不rawintegrate。

## 5. 逐任务执行合同

共同停止条件：scope外写入、真实配置/authority读取、来源未分类、身份/absence接口无法证明、需要上游改动或门禁放宽、测试数据不可public产生时，停相关分支contact_supervisor。不得为“逃生”增加吞错、空集合fallback或force=true。

### B：保护基线

**Deps：** none。**Resources：** static-evidence。
**WritePaths / Files：** Create `docs/plans/records/2026-10-15-supervisor-gate/baseline.json`。
**接口：** Consumes git HEAD/index/status、已完成D1/D2/D3 API；Produces保护文件清单、当前tools、v1/v2及部署门禁。
- [ ] 精确read metadata和相关source，不能从用户state取schema样本；本轮D3若未完成只标依赖未ready，不改其实现。
- [ ] 写JSON并parse验证、diffcheck；不改code、不测试Host。

### G0：接口可行性冻结（探索）

**Deps：** B。**Resources：** static-evidence。
**WritePaths / Files：** Create `docs/plans/records/2026-10-15-supervisor-gate/contract.md`。
**接口：** Produces `SupervisorTargetDirectory`（§2.1）、`UpstreamPendingObservation`（下文）和controlplane方法签名。仅读supervisor-adapter/native channel/public RPC/RootBroker的真实可用接点，不能用runtimeFromStatus有限投影猜child目录。

```ts
type UpstreamPendingObservation =
 | {availability:'available';rootSessionId:string;observedAt:number;
    requests:readonly {requestId:string;runId:string;childIndex:number;expectsReply:boolean}[]}
 | {availability:'unavailable';code:'SUPERVISOR_UPSTREAM_UNAVAILABLE'};
```

- [ ] 列真实target source可覆盖single/multi/workflow leaf与unowned run的范围。缺证据分支明确阻塞，不保证全拓扑。
- [ ] 核定native `adapter.execute(...,{action:'pending'},...)` 的bind/root、刷新完整性、异常传播；不需改上游则ready，不能证明则clear blocked-upstream。
- [ ] 冻结v2 precisekeys、方法 `inspectRequest(root,target)` / `clearRequest(root,input)` / `classify` 和fixed error codes，父层inline核对后实施；不可行不得扩policy。
**验收：** gate-target与clear-observer分别结论，有实际源码/字段，不运行真实adapter/userstate。

### G1：纯child目标与gate策略

**Deps：** G0的target合同ready；若G0仅target目录blocked，则消费其已冻结的显式index/correlation子集并保持无index路径blocked。**Resources：** unit-runner。
**WritePaths / Files：** Create `packages/pi-subagents-enhanced/src/subagent-dispatch/supervisor-gate-policy.ts`、`test/supervisor-gate-policy.test.mjs`。
**接口：** `resolveTargetChild(directory,index?)`→exact target或fixed ambiguity；`classifyRequest(request,receipts,now)`→§2.2枚举并显式使用调用方时间；`steerReceiptKey(intentWithChild)`→含childIndex的精确key。G0冻结的多child缺index错误使用独立`SUPERVISOR_STEER_CHILD_AMBIGUOUS`，不复用runId前缀解析的`SUPERVISOR_STEER_TARGET_AMBIGUOUS`。
- [ ] 实现纯匹配，不IO不改request；显式index不合法拒绝、单child推断、多child不广播。
- [ ] 实现后测A pending/B可steer、不同run/root/ownergen不互影响、queued不是consumed、failed receipt不解gate、同文本发不同child不误幂等、缺correlation不默认0；另测内存模式expiresAt到期后不继续分类为needs-reply。
- [ ] `node --test test/supervisor-gate-policy.test.mjs`、package typecheck、diffcheck，exit0。

### C1：上游typed pending observer

**Deps：** G0的absence合同ready。**Resources：** unit-runner。
**WritePaths / Files：** Create `packages/pi-subagents-enhanced/src/subagent-dispatch/supervisor-upstream-observer.ts`、`test/supervisor-upstream-observer.test.mjs`。
**接口：** `createSupervisorPendingObserver({adapter,resolveBoundRoot,now}).observe(root,ctx):Promise<UpstreamPendingObservation>`。
- [ ] 直接绑定native adapter原execute，不经包装status、不解析content。schema/绑定/root/错误校验失败unavailable，checked空数组才是观察到无live请求；记录上游`discover/refreshPendingRequests`对过期/非活动请求的既有清理副作用，禁止描述为绝对无副作用。
- [ ] 一次刷新观察，无timer/缓存权威/文件扫描；request scope只过滤投影，不由本仓主动删除仍live的上游记录；允许并记录上游observer自身的过期/已解决/非活动生命周期清理。
- [ ] 实现后测试bound/unbound、刷新异常、isError、缺details/畸形数组、同root多child/多request、空集合、跨root拒绝；`node --test test/supervisor-upstream-observer.test.mjs`与package typecheck。

### G2：child门禁、提交分类与存储迁移

**Deps：** G1。**Resources：** unit-runner；必须等当前runtime-closeout D3同路径实现发布。
**WritePaths / Files：** Modify `packages/pi-subagents-enhanced/src/subagent-dispatch/supervisor-control-plane.ts`、`test/subagent-runtime-membrane.test.mjs`、`test/supervisor-diagnostics.test.mjs`；Create `docs/bugs/2026-10-15-supervisor-gate-overconvergence.md`。
**接口：** request/state v2严格parser、intent可带childIndex/目标权威，旧reply intent有效。readDiagnostics输出新增childIndex/classification而不自动迁移写盘。
- [ ] 实现严格v1→v2读取迁移、v2digest和当前root内存事务队列；不自动clear旧pending，缺scope不放行。
- [ ] resolve时先owner/targetruntime，后本childneeds-reply；queued receipt permits steer、不改consumed。提交失败不解gate；TTL内存/持久化一致；去重key包括child。
- [ ] 更新旧“reply后所有steer仍应阻断”测试为新产品合同，保留真正未回复/重复payload/owner拒绝断言；测试用public register/commit而不直接拼内存Map。
- [ ] `node --test test/supervisor-gate-policy.test.mjs test/subagent-runtime-membrane.test.mjs test/supervisor-diagnostics.test.mjs test/supervisor-consumption.test.mjs`、package typecheck、diffcheck。
**验收：** 已提交不同内容steer可进入原rpc；A请求不阻B；未知身份仍拒；v1/reload/parallel-root事务不会丢receipt；新gate功能不依赖C1/clear。

### C2：单 request challenge、clear与审计

**Deps：** G2的v2/事务、C1的observer；写supervisor-consumption.ts前还须runtime-closeout D3发布（本批已af9713e提交且未改该文件）。**Resources：** unit-runner。
**WritePaths / Files：** Modify `packages/pi-subagents-enhanced/src/subagent-dispatch/supervisor-control-plane.ts`、`packages/pi-subagents-enhanced/src/subagent-dispatch/supervisor-consumption.ts`、`test/supervisor-consumption.test.mjs`；Create `test/supervisor-clear.test.mjs`。
**接口：** `inspectRequest(root,{runId,childIndex,requestId})`返回safe snapshot+clearAllowed+可选challenge；`clearRequest(root,{runId,childIndex,requestId,requestGeneration,clearChallenge,reason})`返回audit或fixedcode。
- [ ] 原state v2内保存challenge hashes/clearAudits/adminResolution，精确字段验证不默认空错数据；60s有效、sign发后revision、锁内重新上游观察+owner核查，一次write原子发布。
- [ ] 明确write失败/重复token/idempotent恢复；不可“先写state再写audit”或writeretry只换revision重放旧快照。
- [ ] 已cleared request不能被late consumption推进replied，queued receipt不得被静默升级delivered/consumed，只记later-consumption诊断；正常queued仍可terminal consumed。其他requests/receipts原样。
- [ ] 实现后测试live拒、unknown拒、orphan成功、无receipt orphan成功、queued+upstream absent成功、otherchild不变、同ID上游重现拒、token/revision/requestgen/ownergen漂移拒、过期/重复/跨root重放拒、损坏v2拒、crash前后write fixture不实际kill。
- [ ] `node --test test/supervisor-clear.test.mjs test/supervisor-consumption.test.mjs test/supervisor-diagnostics.test.mjs`、package typecheck、diffcheck。

### C3：主会话inspect/clear与steer接线

**Deps：** G2、C2；写extension/runtime入口前须runtime-closeout D3发布（已af9713e提交）。supervisor-consumption.ts的发布依赖归C2，C3不写该文件。**Resources：** unit-runner。
**WritePaths / Files：** Create `packages/pi-subagents-enhanced/src/subagent-dispatch/supervisor-recovery-tools.ts`；Modify `packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts`、`packages/pi-subagents-enhanced/extensions/subagent-runtime.ts`；Create `test/supervisor-gate-runtime.integration.mjs`。
**接口：** 两tool独立schema，inspect必填runId/childIndex/requestId；clear再必填requestGeneration/clearChallenge/reason，additionalProperties=false。不接受root/ownergen/force override。
- [ ] tool factory单纯DI控制plane/rootresolver，工具注册仍受Host child early-return，child工具白名单不自动扩权。绑定原native adapter用于observer，避免本工具递归。
- [ ] steer在现canonicalSteerTarget后解析child，传入control intent；成功仍rpc.steer原sender，failed details给safe request/child/classification，不回显reason正文。
- [ ] 上游steer/reply返回`isError:true`时按失败语义处理：不写queued receipt；若已有failed receipt，同目标重试不得被幂等短路永久锁死；补测`isError:true`、throw、失败后重试，原wire/content不变。
- [ ] 用真实SDK+fakeadapter公开message/tool链测试注册、旧单工具还可用、新tools无child曝光、queuedsteer、B可steer、inspect签token/clear/audit/重复/owner失效；fixture不需provider网络/真Host。
- [ ] `node --test test/supervisor-gate-runtime.integration.mjs test/subagent-runtime-membrane.test.mjs test/subagent-supervisor-adapter.test.mjs`、package typecheck、diffcheck。

### V：聚焦验收

**Deps：** G2与C3完成，或C1/C2明确blocked（仅验gate，不假称clear）。**Resources：** unit-runner。
**WritePaths / Files：** Create `docs/plans/records/2026-10-15-supervisor-gate/acceptance.md`；实现文件仅读。
- [ ] 显式运行 `node --test test/supervisor-gate-policy.test.mjs test/supervisor-clear.test.mjs test/supervisor-upstream-observer.test.mjs test/supervisor-gate-runtime.integration.mjs test/supervisor-consumption.test.mjs test/supervisor-diagnostics.test.mjs test/supervisor-replay.test.mjs test/subagent-runtime-membrane.test.mjs`；未创建的blocked分支不放命令报假失败，单列未验。
- [ ] package/root类型检查、diffcheck/untracked whitespace、record实际tests/exits/skip；不运行全仓npmtest/真实user tools。
- [ ] 对每目标分别判gate-fixed、child-isolated、clear-verified、unknown cases；假fixture不替代具体用户历史故障归因，不检查用户完整session。

### Z：文档与交付

**Deps：** V。**Resources：** static-evidence。
**WritePaths / Files：** Modify `docs/plans/records/2026-10-15-supervisor-gate/acceptance.md`、`docs/bugs/2026-10-10-supervisor-reply-required-state-views.md`、`docs/todos/2026-10-10-runtime-followups.md`；Create `docs/architecture/supervisor-gate-recovery.md`。
- [ ] 记录inspect→核查→clear步骤、token期限、CAS失败后重inspect，示例只清单request，不能deleteJSON。
- [ ] 说明v2需要fresh Host与禁止旧Host混跑；未升级当前Host不得试图直接清本次pending。
- [ ] 按actualevidence结项；保留absence/owner不可验证的清理边界、历史个案unknown与旧hb残留。无commit/push/自动成果review。

## 6. 自检与执行交接

- DAG无未定义节点；G1/G2不等待clear-observer，避免逃生路径不闭合拖住独立gate修复。
- 所有生产新文件有明确owner，复用单存储/锁，不新建通用token框架；clear token/audit/request同value发布。
- 核心区别是“可信提交证明足以允许另一条steer排队”，不是“把queued升级consumed”；“精确清理行政状态”不是“删除记录”。
- 所有任务带Deps/WritePaths/Resources/Files/接口/命令/停止条件；真实Host和危险操作不包含在实施授权中。
- 首轮review后父层inline修订，再交用户选择 **Subagent-Driven / Inline / 继续review**；禁止直接执行本计划。
