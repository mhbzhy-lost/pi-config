# 统一后台活动区实现计划

> **给执行 agent：** 必须逐任务执行本计划；步骤使用 `- [ ]` 复选框跟踪。执行方式由计划完成后的用户选择决定。本计划目前仅获编写授权，禁止自动实施。

**目标：** 将 TUI footer 左下角改为后台活动区，统一呈现 subagent、scheduler 与 bash_async，统一行结构、缩进和只读详情交互，用类型图标区分任务。

**架构：** 保留 enhanced package 为唯一 footer 安装者；可复用的现有 footer/browser 接线下沉到 package 实现，根 `background-activity` 显示 feature 通过 Host 本地 bus 提供统一 presenter。各任务 owner 提供 snapshot + invalidate 观察接口；统一层不调度任务、不发送消息、不维护任务权威状态或恢复账本。package 没有根 presenter 时仍能独立使用原 subagent footer。

**技术栈：** Node `>=22.19.0` 原生 TypeScript、Pi SDK `1.0.4` 的公开 `setFooter/custom/registerShortcut/pi.events` 与 TUI Component、现有 subagent browser/native transcript。

## 全局约束

- 「tui footer区域需要改变定位，左下角目前我们有subagent和scheduler展示，subagent是实心圆形，scheduler是钟表图形，现在还要加一个 bash async 任务，因此左下角改为『一切后台活动任务』展示区域，统一格式缩进，统一详情展示逻辑，图标区分后台任务类型。这部分你可先写计划，不着急执行。」
- 「bash_async和scheduler的问题形成结论就直接修，统一后台那个计划只是先做计划，不着急执行。」两项缺陷修复独立推进，本计划不能成为其阻塞，也不得重写这些修复。
- 本轮“一切”覆盖上述三类具有稳定身份和权威观察点的任务；不是把任意 extension status、watcher、诊断文本都解释成任务。
- Node 最低版本固定为 `>=22.19.0`；production/CLI 使用 `.ts`；新增 TS 必须由 `tsc --noEmit` 覆盖。
- 不通过 MCP 接入任何工具；不新增 daemon、跨进程调度器或 durable exactly-once 承诺。
- 所有精简、折叠、摘要、截断和换行只在 TUI renderer 层发生。agent 消息、tool result、event payload、session 和结构化 details 保持原样。
- `pi/extensions/` 与 package `extensions/` 只做 Host API 接线；跨 feature 经明确公开入口，禁止深引其他 feature 内部，也不反向依赖宿主入口。
- enhanced package 可独立部署，不依赖包外根源码；唯一 `setFooter` owner，不能以扩展加载顺序 last-wins 作为协调机制。
- TUI 接线须判断 `ctx.mode === 'tui'`，不能只看 `hasUI`；不为 RPC 构造 terminal overlay，不改变既有 RPC status、消息投递或执行行为。
- 保留 dirty 现场；不 stash/reset、清真实任务、删锁、杀进程、改 settings/models 或提交 commit。
- 不使用 TDD/相关 skill；步骤是明确契约、实现、验证，运行既有测试并在实现后补充展示/契约验收。
- production 异常修复先记录入口、身份、资源顺序与数据来源分类；纯 renderer 合成对象不是 production 可达证明。

## 现场依据与范围决策

只读报告：

- `/tmp/background-activity-footer-research.md`：现 footer、source、生命周期及公开 API。
- `/tmp/bash-async-tui-diagnosis.md`：调用与完成回执缺 renderer 的独立修复。
- `/tmp/scheduler-delete-orphan-diagnosis.md`：scheduler timer/删除/多 Host 缓存边界；修复合同正在独立补证。

关键事实（执行时重新定位行号）：

1. `packages/pi-subagents-enhanced/extensions/custom-footer.ts:210–242` 实际布局用 `selectorThirdLine || schedulerStatus`，subagent 多行会挤掉 scheduler。不是一个通用注册表。
2. 同文件 `:244–450` 拥有 browser、状态轮询、Alt+O、详情 overlay、editor/draft 恢复；不能只替换一段字符串就完成统一。
3. `src/bash-async/index.ts` 已返回 controller；`snapshot()` 有 active/completed，无 subscribe。completed 最多64，原生输出只在终态可读，无实时输出 API。
4. scheduler 当前30秒 refresh已有任务 list，但 footer只得到截短字符串。必须观察原始任务字段，不能反解析 `⏱ label +N`。
5. 类型和状态分开：scheduler enabled表示有计划，不是模型正在执行；lastStatus success表示 runner投递完成，不证明业务任务成功。subagent reported/unknown不能变成completed。
6. Alt+O现为只读 subagent browser；`/cron`被adapter拦截，没有可沿用的 scheduler menu。
7. upstream恢复中的subagent不一定重发started。当前首屏恢复完整性有缺口；本计划不新增扫描器或运行恢复行为，也不宣称已补齐全量恢复。若要改变恢复发现能力，应另行授权确证问题及其修复。本计划保证现有权威browser已观察到的任务不丢失，并保留此已知限制。

### 产品与视觉默认值

- 类型列固定：subagent `●`，scheduler沿用现有 `⏱`，bash_async `⌘`。图标只是类型，不是成功/失败事实；状态另列文字。窄宽可截断显示，但不改变对象身份。
- 主视图按类型顺序 subagent → bash_async → scheduler；每类按source稳定顺序，不因每次tick排序跳动。活动/计划优先，最近历史仅详情可见；主视图可追加单行 `◯ recent N` 提示，N按统一列表key去重。
- 启用 scheduler 为 scheduled；禁用且无正在投递状态的 scheduler 只在详情中显示。一次性任务完成后disabled记录仍属于scheduler记录，不误称“删除成功”。
- 每项首行左侧padding 1、选择列2、类型图标列按 `visibleWidth` 计算、列间空格1；换行延续在label内容列对齐。显示布局禁止用字符串length算终端列。
- 状态样例：subagent `运行中/待处置/已完成`由现有presentation解释；bash `运行中/成功(exit 0)/失败(exit N)/超时/已取消/执行异常`由typed outcome解释；scheduler `等待触发/正在投递/上次投递失败/已禁用`。
- 主footer保留cwd/context、provider/model/thinking右侧信息；逐项显示左区，不能用 `+N` 将某一类型整体遮蔽。窄宽优先右侧已有信息预算；左区额外行仍可见。
- 详情共用头部、类型、身份、状态、滚动与快捷键提示；正文按领域显示。subagent为可信native transcript，bash为原生命令结果，scheduler为经过既有安全边界的元数据/任务详情。
- 详情不增加cancel/delete/run按钮，不改变现有命令授权。切换、打开、关闭详情不会执行任务或取消任务。

## 文件结构与职责

下列是规划写路径，不是当前已修改文件。执行前以当时dirty基线核对。

### 根显示 feature

- Create `src/background-activity/index.ts`：公开入口，只导出根 presenter/layout/detail factory；registry 从 package 公共入口消费，不在根重复实现。
- Create `src/background-activity/layout.ts`：统一左区域纯显示投影、类型图标、挂起缩进、宽度预算。
- Create `src/background-activity/detail-controller.ts`：只读导航、viewport与draft恢复协调。
- Create `src/background-activity/presenter.ts`：footer组件、统一详情壳、主题与requestRender接线。
- Create `pi/extensions/background-activity.ts`：发布presenter及跨入口握手；不直接调用setFooter。
- Modify `tsconfig.json`：新增feature/入口静态检查覆盖。

### package独立公共协议与subagent owner

- Create `packages/pi-subagents-enhanced/src/tui/background-activity.ts`：公开显示协议类型、bus channel 常量、registry 实现与纯校验/匹配 helper；不依赖根 feature。
- Create `packages/pi-subagents-enhanced/src/tui/index.ts`：明确 public 入口，导出协议、registry factory 与 package provider factory；T1 只导出已经创建的协议/registry，不提前 re-export T2 provider/runtime。
- Create `packages/pi-subagents-enhanced/src/tui/subagent-activity.ts`：从既有browser投影subagent行/详情，保持canonical root/leaf关系。
- Create `packages/pi-subagents-enhanced/src/tui/footer-runtime.ts`：由现entry下沉runtime接线、single-owner安装/替换及standalone fallback；subagent权威读取仍留package。
- Modify `packages/pi-subagents-enhanced/extensions/custom-footer.ts`：薄Host入口，只注入SDK/TUI、绑定footer owner和Alt+O handler。
- Modify `packages/pi-subagents-enhanced/package.json`：新增 `./tui/background-activity` export指向 `src/tui/index.ts`，不改变其他exports/发现列表。
- 保留既有 `session-browser.ts/session-viewport.ts/native-conversation.ts/browser-adapter.ts` 实现，除必要纯提取/公开出口不重写领域状态机。

### source观察接线

- Modify `src/bash-async/contracts.ts/controller.ts/index.ts`：只读snapshot失效订阅，保留唯一jobs Map和完成出口。
- Modify `pi/extensions/bash-cwd.ts`：注册现有controller的source publisher，不影响独立renderer修复。
- Create `src/task-scheduler/index.ts`：对外观察入口。
- Create `src/task-scheduler/activity-source.ts`：从adapter刷新结果构造未经缩短的display记录/受控详情查询。
- Modify `src/task-scheduler/adapter.ts`：既有refresh接点失效通知/公共观察依赖，不新建第二轮询。
- Modify `pi/extensions/task-scheduler.ts`：source接线，保留RPC status与工具门禁。

### 验证与文档

- Create `test/background-activity-registry.test.mjs`、`test/background-activity-layout.test.mjs`、`test/background-activity-details.test.mjs`、`test/background-activity-runtime.integration.mjs`。
- Create `test/subagent-activity-provider.test.mjs`、`test/bash-async-activity.test.mjs`、`test/task-scheduler-activity.test.mjs`。
- Modify既有custom-footer/package测试以新public入口/薄entry验证实际行为，不删除原有canonical、trusted read、editor、RPC验收。
- Create `docs/architecture/background-activity-display.md`：注册、ownership、source事实和非保证事项。

## 公共协议（T1锁定）

协议放在package公开入口，根代码本仓用明确public入口 `../../packages/pi-subagents-enhanced/src/tui/index.ts` 导入，禁止导入其内部browser/renderer；独立npm消费者经package export。运行协议仅在Host内存bus传递函数，不写session entry、不发模型消息、不成为RPC wire协议。

```ts
export type ActivityKind = 'subagent' | 'scheduler' | 'bash_async';
export type ActivityPlacement = 'main' | 'recent';
export type ActivityRow = Readonly<{
  key: string; kind: ActivityKind; label: string;
  stateLabel: string; placement: ActivityPlacement;
}>;
export type ActivityAvailability = 'available' | 'unavailable' | 'stale';
export type ActivitySnapshot = Readonly<{
  availability: ActivityAvailability;
  rows: readonly ActivityRow[];
  observedAt?: string;
  errorLabel?: string;
}>;
export type DetailComponent = {
  render(width: number): string[]; invalidate(): void; dispose?(): void;
};
export type DetailRequest = Readonly<{
  expanded: boolean; requestRender(): void;
}>;
export interface ActivitySource {
  kind: ActivityKind;
  snapshot(): ActivitySnapshot;
  subscribe(invalidate: () => void): () => void;
  detail(key: string, request: DetailRequest): Promise<DetailComponent | undefined>;
}
export type HostScope = Readonly<{
  sessionManager: object; sessionId: string; token: object; hostKey: object;
}>;
export interface ActivityRegistry {
  register(source: ActivitySource): () => void;
  snapshot(): readonly ActivityRow[];
  sourceSnapshot(kind: ActivityKind): ActivitySnapshot | undefined;
  sourceFor(key: string): ActivitySource | undefined;
  subscribe(invalidate: () => void): () => void;
  dispose(): void;
}
```

`DetailComponent`是TUI Component兼容最小接口，不包含输入/执行能力。详情异步完成必须由统一壳核对selection+epoch，旧组件dispose。row key含类型、source稳定ID和必要child index；不能按标题去重。registry实现与 `createActivityRegistry():ActivityRegistry` 同归package，owner可独立创建；根层仅消费实例，不保留第二实现。registry只持有source和unsubscribe，snapshot即时拉取，不把terminalReceipt压缩存回source。

可用性不占任务身份：`available`且rows为空才表示当前已确认无任务。source查询失败后有上次观察值则返回`stale`+原rows/observedAt，无历史则`unavailable`+空rows。统一布局显示独立source提示并将旧行标记“过期观察”，不算作当前main/recent数量、不推断删除/完成；旧条目只在详情过期分组保留，不向任务owner写回。不创建假的“scheduler错误任务”。

### Bus handshake 与唯一 owner

channel常量定义在公开协议：

- `background-activity:owner-ready`：footer runtime宣布 `{scope, ownerRegistrationId}`。
- `background-activity:owner-request`：source/presenter启动后请求匹配的owner重发ready，payload为 `{sessionManager, sessionId, hostKey}`。
- `background-activity:source-register`：`{scope, registrationId, source}`，owner核对token、hostKey和manager身份后接入，并记录该registrationId。
- `background-activity:source-unregister`：`{scope, registrationId, kind}`；只撤销同scope、同registrationId的旧注册，不能删除同kind的新注册。
- `background-activity:presenter-register`：`{scope, registrationId, factory}`，owner仅接受当代匹配注册；相同registrationId幂等，不重复关闭当前详情。
- `background-activity:presenter-unregister`：`{scope, registrationId}`；只撤销对应presenter，恢复standalone，不销毁owner整体。
- `background-activity:owner-close`：`{scope}`，清当代订阅/视图；不能取消真实任务。

token为footer runtime每次session_start创建的对象，不是process-global Symbol。本期 `hostKey` 取当前 runtime 的 `sessionManager` 对象身份；同一 runner 的ctx返回同一manager，跨extension可匹配，而正常两个Host使用不同manager。本期支持前提：同一bus上的每个并行Host须有不同sessionManager；不支持两个Host复用同一manager，不声称支持可选却未实现的composition key注入。source/presenter只回答与当前捕获的sessionManager、sessionId和hostKey同时匹配的ready，不按cwd、标题或业务source内部sessionFile猜owner；若不能证明前提，停止接线，而非广播共用源。

注册顺序无关：owner先监听request后announce ready；publisher先订阅ready再request；owner先登记source，再将registry交给presenter。重复ready/request以registrationId幂等，不重置选中项或关闭overlay。source/presenter撤销有明确registrationId，旧撤销不能删除新注册；owner-close才清理当代整体。shutdown先使token失效再dispose；不保留旧ctx闭包；reload只继承现有subagent plain roster语义。

只有package runtime调用 `ctx.ui.setFooter`，唯一Alt+O注册由薄entry委托runtime当前视图。root presenter通过factory返回component/openDetails/dispose，不能调用setFooter或重复registerShortcut。

factory精确形状：

```ts
export type FooterBindings = Readonly<{
  scope: HostScope; registry: ActivityRegistry;
  ctx: import('@earendil-works/pi-coding-agent').ExtensionContext;
  fallback: () => MountedActivityView;
}>;
export type MountedActivityView = {
  createFooter: import('@earendil-works/pi-coding-agent').ExtensionUIContext['setFooter'] extends
    (factory: infer F) => void ? NonNullable<F> : never;
  openDetails(): Promise<void>;
  dispose(): void;
};
export type ActivityPresenterFactory = (bindings: FooterBindings) => MountedActivityView;
```

T1根据本机types.d.ts核对类型名/签名；不能用`any`掩盖与SDK合同不符。`fallback`仅返回既有standalone视图，非业务失败兼容，不加载根源码；正常根presenter撤销后按既有UI状态恢复，不能双安装。

## DAG

```text
T1 显示协议/registry ─┬─> T2 package subagent provider/入口下沉 ─┐
                     ├─> T3 bash观察source ───────────────────┤
                     ├─> T4 scheduler观察source ─────────────┤
                     └─> T5 统一布局与只读详情壳 ─────────────┤
                                                            v
                                                   T6 owner/接线与生命周期
                                                            |
                                                            v
                                                   T7 汇总验收与文档
```

依赖边理由：T2/T3/T4消费T1的source/detail协议；T5消费T1 registry与共享fixture但不等待真实source实现；T6消费T2 package runtime、T3/T4 source publishers及T5 presenter完成Host接线；T7消费T6真实接线验收结果。不存在T3↔T4或source→layout的多余串行边。

## Waves

- Wave 1：T1。
- Wave 2：T2、T3、T4、T5，可并行，写路径不重叠。
- Wave 3：T6，所有前驱实际完成即可派发；Wave不是屏障。
- Wave 4：T7。

**关键路径估算：** T1（25min）→ T2（50min）→ T6（50min）→ T7（25min），约150min；T5同为50min，故 T1→T5→T6→T7 是并列关键路径。估时是组织预算而非runtime timeout保证。T2/T5/T6必须按下述<=30min单元分别派发，禁止一次打包整节点。独立bash/scheduler缺陷修复不是DAG节点；执行T3/T4时消费其当时基线，若仍在同文件写入则按资源冲突等待或隔离，不能覆盖。

### 实际派发单元（与上图聚合节点等价）

- T1：25min，完整协议/registry；首次public index只导出已创建模块。
- T2a：25min，下沉footer-runtime/薄entry，保持standalone现有行为，交付机械迁移回归证据。
- T2b：25min，Deps T2a；实现subagent provider、源ownership/分区roster及其验证；T2整体输出仅在T2b完成后满足下游。
- T3：25min，bash observer/source，按本任务路径派发。
- T4：25min，scheduler observer/source，按本任务路径派发。
- T5a：25min，layout与动态Geometry/viewport壳，交付纯布局测试和 `ActivityGeometry`。
- T5b：25min，Deps T5a；detail-controller与presenter交付，T5整体输出在T5b后满足下游。
- T6a：25min，Deps T2b/T3/T4/T5b；owner/注册撤销幂等接线与load顺序验证。
- T6b：25min，Deps T6a；其余生命周期/RPC/package隔离集成验证，不重写source实现。
- T7：25min，Deps T6b，文档及完整回归验收；命令耗时超预算时单独后台运行现有验证，不扩大代码任务。

内部单元WritePaths为所属Task的明确子集，T2a仅footer-runtime/entry和custom-footer-subagents测试，T2b为subagent-activity/public index/provider测试及T2a文件的ownership精确追加；T5a仅layout/layout测试，T5b为detail-controller/presenter/public index/detail测试；T6a为footer-runtime/entry/root入口/runtime integration的握手用例，T6b为同integration生命周期用例及既有input/fullscreen/package tests。同节点相邻单元因消费迁移或layout/握手产物真实依赖串行；不同分支仍按ready set并行，无额外Wave屏障。

---

### Task T1：公共显示协议与registry

**Deps：** none。

**WritePaths：**
- `packages/pi-subagents-enhanced/src/tui/background-activity.ts`
- `packages/pi-subagents-enhanced/src/tui/index.ts`
- `packages/pi-subagents-enhanced/package.json`
- `src/background-activity/index.ts`
- `test/background-activity-registry.test.mjs`
- `tsconfig.json`

**Resources：** 无真实任务；本地Node测试。根tsconfig/package manifest写入只在本任务。

**Files：** Create上述TS与test；Modify package exports和root tsconfig。

**接口契约：** Consumes Pi公开types；Produces本计划完整ActivityRow/Source/Registry、HostScope、factory/channel常量及合法renderer fixture（测试明确为display fixture，不充当production数据）。

**验收标准：** pull读取source当前事实；重复注册kind释放旧订阅；清理幂等；不可按label去重；多owner token严格隔离；异常source不给其他source伪造状态，也不传播至任务执行路径。

- [ ] 步骤1：完整读SDK `docs/extensions.md/tui.md/rpc-extension-ui.md`及所需交叉引用/examples；核对FooterBindings中SDK类型名称及factory函数实际签名。
- [ ] 步骤2：在package公共background-activity模块实现registry：内部Map以kind存source/unsubscribe，register调用旧dispose，snapshot读取source.snapshot().rows与availability；lookup按精确key；dispose置closed、unsubscribe、clear。sourceSnapshot保留可用性返回，不写回source。public index此阶段不导出尚未创建的provider/runtime，根index也不提前导出T5文件。
- [ ] 步骤3：实现协议scope匹配helper，校验token/hostKey/manager identity/sessionId，拒绝跨代注册；registrationId由publisher在当代source/factory创建时生成随机ID，并在重复ready时复用。registry的dispose closure先比对当前handle身份，旧dispose不得移除新source；bus unregister由owner按registrationId匹配后调用closure。明确不支持共享同一manager的并行Host，不在registry自动推断业务sessionFile。
- [ ] 步骤4：实现后补显示契约验证：两个不同owner同sessionId不互收、同label异key共存、snapshot变化后不需重register、旧dispose不删新source、重复ready保持同handle、dispose后late invalidate无效果、available空/unavailable/stale三者可区分、raw对象无修改。
- [ ] 步骤5：运行 `node --test test/background-activity-registry.test.mjs`、`npm run typecheck`、`git diff --check`，验证package export可独立解析且不import根路径。

### Task T2：package subagent provider与footer实现下沉

**Deps：** T1，消费ActivitySource/detail/factory与channel协议。

**WritePaths：**
- `packages/pi-subagents-enhanced/src/tui/subagent-activity.ts`
- `packages/pi-subagents-enhanced/src/tui/footer-runtime.ts`
- `packages/pi-subagents-enhanced/src/tui/index.ts`
- `packages/pi-subagents-enhanced/extensions/custom-footer.ts`
- `test/subagent-activity-provider.test.mjs`
- `test/custom-footer-subagents.test.mjs`

**Resources：** Node假terminal与临时trusted transcript fixture，不启动真实subagent。

**Files：** Create provider/runtime/test；Modify公共出口、薄entry和既有测试。

**接口契约：** ConsumesT1；Produces `createSubagentActivitySource({browser,renderDetail,subscribe}):ActivitySource` 和 `createFooterRuntime(pi,dependencies)`；runtime先保留standalone模式与现有Alt+O委托，T6再绑定统一presenter，不提前创建第二owner。

**验收标准：** browser canonical root/leaf、标题、unknown/reported、history cap20和trusted transcript保持；native先行/fallback保持；现有standalone footer和快捷键可独立运行；entry无反向根import；plain roster按已证明的Host/session分区且不保留ctx/callback。源级隔离必须覆盖started/complete事件和reload，不只是新注册协议token隔离。

- [ ] 步骤1：依据报告重新读actual custom-footer、browser、native renderer、viewport和package规范，列出原入口副作用与cleanup，禁止使用未被actual entry调用的旧footer factory替代。
- [ ] 步骤2：将runtime实现机械下沉到footer-runtime，入口只注入公开SDK/TUI、title/status读取依赖和注册；不改poll频率、身份关系、恢复行为、消息和trusted文件防线。
- [ ] 步骤3：source.snapshot返回available+browser active/recent原始label与presentation行，稳定key使用browser现有key加kind。package source在trackStarted/trackCompleted前复用既有runtime ownership能力核对事件归属；不改raw event、不让根猜sessionFile。plain roster由未分区全局槽迁为以当前Host manager身份+session身份分区的弱引用结构，只存plain rows，reload仅恢复本分区；有歧义事件不进入browser并保留诊断。若现有权威入口不能证明归属，停止T2b请求决策，不按sessionId相同就宣称多Host隔离。订阅existing started/completed/reconcile后invalidate；detail仍由package native/Fleet能力生成Component，不让根层读sessionFile。
- [ ] 步骤4：实现后验证active/recent同标题不同identity、root/leaf不重复、unknown不标成功、trusted拒绝/原生fallback、reload roster与旧ctx释放；同时共享bus两个不同Host的真实started/complete与reload只更新所属browser/roster。同sessionId不替代Host ownership证据；fresh Host恢复限制保持明确，不造磁盘扫描fallback。
- [ ] 步骤5：运行 `node --test test/subagent-activity-provider.test.mjs test/custom-footer-subagents.test.mjs test/subagent-session-browser.test.mjs test/pi-subagents-browser-adapter.test.mjs test/subagent-native-conversation.test.mjs` 和package typecheck。

### Task T3：bash_async只读观察source

**Deps：** T1，消费Source与scope协议，不依赖完成renderer修复的内部接口。

**WritePaths：**
- `src/bash-async/contracts.ts`
- `src/bash-async/controller.ts`
- `src/bash-async/index.ts`
- `pi/extensions/bash-cwd.ts`
- `test/bash-async-activity.test.mjs`

**Resources：** 注入operations/deferred barrier；与独立completion renderer修复的index/入口写冲突需隔离或待其交付，不是DAG业务依赖。

**Files：** Modify上述TS；Create activity test。

**接口契约：** ConsumesT1；Producescontroller `subscribe(listener:()=>void):()=>void`、public `createBashAsyncActivitySource(controller,displayDependencies):ActivitySource` 和入口scope publisher。

**验收标准：** 接受即见、完成即从main移除，suppressed/delivery-error也可在recent解释；source错误不能影响原生命令和唯一completion；active不能显示虚构stdout；所有receipt/raw output/发送行为完全不变。

- [ ] 步骤1：重新读已修复基线index/renderer，记录controller现有变更出口和generation/branch guard。
- [ ] 步骤2：在jobs.set、terminal归档、start/reset、branch invalidation、shutdown收束后触发只读invalidate；listener以独立try/catch隔离，不吞原执行错误；subscribe不创建第二jobs Map，UI退订不abort job。
- [ ] 步骤3：source.snapshot即时读取active/completed；label保留原command，格式化延至renderer；状态从outcome及delivery事实区分，accepted不是ACK。详情active显示launch元数据，terminal读原content blocks，无新streaming API。
- [ ] 步骤4：入口保留completion renderer注册，另外监听owner ready/request注册source，shutdown退订旧scope；不改cancel/shutdown/compaction原语义。
- [ ] 步骤5：实现后验证极速完成、suppressed、send失败、late prepare、listener抛错、branch/new代隔离、raw深层引用与内容未变。运行 `node --test test/bash-async.test.mjs test/bash-async-activity.test.mjs` 和root typecheck，不启动真实sleep/子进程实验。

### Task T4：scheduler只读观察source

**Deps：** T1，消费Source/detail/scope协议。

**WritePaths：**
- `src/task-scheduler/index.ts`
- `src/task-scheduler/activity-source.ts`
- `src/task-scheduler/adapter.ts`
- `pi/extensions/task-scheduler.ts`
- `test/task-scheduler-activity.test.mjs`

**Resources：** 隔离临时store/注入tool definitions；与独立scheduler删除修复的adapter写冲突须隔离或待其交付，不等待用户真实任务。

**Files：** Create观察source/public入口/test；Modifyadapter和Host入口。

**接口契约：** ConsumesT1；Produces `createSchedulerActivitySource(observer):ActivitySource`，observer为 `snapshot():{availability:ActivityAvailability; records:readonly SchedulerActivityRecord[]; observedAt?:string; errorLabel?:string}; subscribe(listener:()=>void):()=>void; detail(id:string):Promise<原始受控ToolResult|undefined>`。record仅id/name/type/schedule/enabled/lastStatus/nextRunAt/runCount及scope，不携带prompt摘要作身份。

**验收标准：** 复用现有initial/create/delete/30s refresh，不新增poll；每task独立稳定key；enabled不映射运行中，投递成功不映射业务成功；详情走既有安全扫描与不可信边界；RPC既有status保留。

- [ ] 步骤1：读删除修复后的adapter/public store基线，明确refresh实际拿到的任务字段和安全处理边界；禁止从48字符标签反向解析任务。
- [ ] 步骤2：在既有refresh完成且owner/epoch仍匹配时更新当代只读record/observedAt并置available后invalidate；query error若有记录则stale，无记录则unavailable，errorLabel仅独立source状态，不能造错误task或按空数组猜已删除。恢复后重新读取；pending单飞/late promise不改。
- [ ] 步骤3：详情仅调用受控get对应稳定id，不直接读tasks文件，不绕过safety scanner，不因详情访问触发schedule/create/delete/run-now。
- [ ] 步骤4：scope publisher接线只在TUI发布，仍保留RPC `pi-scheduler` status；TUI统一owner接管后不重复安装widget或第二timer。
- [ ] 步骤5：实现后验证多任务、disabled/once/history、真实删除后的刷新、投递错误/暂不可读、旧epoch查询完成、恶意prompt/ANSI安全边界。运行 `node --test test/task-scheduler-adapter.test.mjs test/task-scheduler-activity.test.mjs test/task-scheduler-package-isolation.test.mjs`、root typecheck。

### Task T5：统一左布局与只读详情壳

**Deps：** T1，消费registry与display fixture；不等待T2/T3/T4。

**WritePaths：**
- `src/background-activity/layout.ts`
- `src/background-activity/detail-controller.ts`
- `src/background-activity/presenter.ts`
- `src/background-activity/index.ts`
- `test/background-activity-layout.test.mjs`
- `test/background-activity-details.test.mjs`

**Resources：** 假TUI、注入Component/detail provider，无真实任务和文件读取。

**Files：** Create布局/controller/presenter/test；Modify公开出口。

**接口契约：** ConsumesT1；Produces `createActivityPresenter(bindings,uiDependencies):MountedActivityView`，`renderActivityRows(rows,width,selection?,theme):string[]`，详情controller只消费source.detail和SDK公开custom/editor API。

**验收标准：** 三类同时呈现不互相挤掉；统一padding/continuation；右metadata保留；跨类型左右导航、稳定selection、真实物理行滚动；旧异步详情不能覆盖新选项；关overlay恢复草稿和editor；无业务副作用。

- [ ] 步骤1：按视觉默认值实现type glyph映射与state独立列；清理ANSI/control只生成显示文本，不改label/raw；按visibleWidth挂起换行，width0/1不越界。
- [ ] 步骤2：生成第一行cwd/context，第二行首activity+model，第三行次activity+thinking，追加其余activities；右metadata预算使左区不足最小内容列（图标+一个终端列）时将该activity移到下一条全宽行，不让某类完全消失。空main不制造运行任务，详情仍可从recent进入。
- [ ] 步骤2a：layout公开 `ActivityGeometry={footerRows:number,reservedBottomRows:number,bodyRows:number}`；主视图物理行预算为`max(0,terminalRows-6)`，超出时最后一行显示“还有 N 项 · Alt+O”，三类所有记录仍在只读详情导航；预算不足3行时显示可容纳的summary且Alt+O仍可开，不以颜色/截断改变raw。详情模式footer固定最多3行导航，reserve=`min(terminalRows,footerRows+1)`，bodyRows=`max(0,terminalRows-reserve)`。SDK动态`overlayOptions:()=>({margin:{bottom:geometry.reservedBottomRows},...})`和viewport消费同一geometry getter，每次resize/任务增减requestRender后重算，禁止一方更新一方固定4。bodyRows=0只显示可容纳的关闭提示，Esc/Alt+O保持有效，不设负高度。
- [ ] 步骤3：实现统一detail Component wrapper：公共标题/身份/状态+领域body，provider组件始终只读；shared viewport计算实际物理行、autoFollow/manual anchor；x仅切换DetailRequest.expanded，provider无展开时不执行其他动作。
- [ ] 步骤4：保留Alt+O/Esc退出、左右切换、上下/j/k、page/home/end、SGR wheel语义；repeat/release行为沿用实际controller，其他键吞掉；stable key消失时选择相邻项或回空状态，不按标题复活。
- [ ] 步骤5：实现后验证三类各两项、同label、CJK/emoji/ANSI/resize/theme、超长命令、footer高于3行、详情晚回、选中任务settle/delete、Esc/draft/overlay focus。运行两个新纯展示test与root typecheck；raw前后deepEqual与引用验证。

### Task T6：唯一owner、握手与生命周期集成

**Deps：** T2公开package runtime/source；T3/T4 source publishers；T5 presenter。理由是本任务实际绑定完整路径，不承担各分支业务实现。

**WritePaths：**
- `packages/pi-subagents-enhanced/src/tui/footer-runtime.ts`
- `packages/pi-subagents-enhanced/extensions/custom-footer.ts`
- `pi/extensions/background-activity.ts`
- `src/background-activity/index.ts`
- `test/background-activity-runtime.integration.mjs`
- `test/custom-footer-input.integration.test.mjs`
- `test/custom-footer-fullscreen.integration.test.mjs`
- `test/pi-subagents-enhanced-package.test.mjs`

**Resources：** 真实SDK+fake TUI/provider/operations、临时独立artifact，无网络/真实scheduler任务；不与子分支同文件写入并行。

**Files：** Create新薄入口/integration；Modifyowner及既有验证接线。

**接口契约：** Consumes已完成factory/provider；Produces唯一owner可用组合，standalone fallback与root-presenter可替换路径、当代scope teardown。

**验收标准：** 任意extension启动顺序均可source补snapshot；只一个footer/shortcut owner；reload/new/resume/fork旧ctx和listener不残留；RPC不调用footer/overlay；package独立加载无根依赖；无任务执行或消息额外投递。

- [ ] 步骤1：package owner从自身公共factory创建registry与当代scope，先监听request/register/unregister，再发ready；root入口先监听ready再request；source拒绝不匹配manager/ID/hostKey。登记registrationId+handle，重复ready同ID幂等；旧ID撤销不删新handle。publisher在shutdown/本source卸载时发对应unregister，并退订本地ready；owner-close只清当代整体。全部同步登记/撤销，不等待其他extension的session_start结束。
- [ ] 步骤2：唯一owner收到不同registrationId presenter替换时关闭旧overlay、恢复editor/draft、dispose旧组件，再调用自己setFooter(factory)；相同ID重发不能重复setFooter/关overlay。shortcut只委托当前mounted view；匹配ID的撤销presenter恢复standalone，不叠加，过期ID撤销无效。
- [ ] 步骤3：shutdown token失效先于异步cleanup，所有late registration/detail/poll无效；source自身任务生命周期保持原样。tree不重建scheduler/subagent，bash原分支取消仍由其owner执行，UI只观察。
- [ ] 步骤4：实现后用真实SDK公开session/event顺序验证publisher-first/consumer-first、source缺席、重复start、multiHost共享bus隔离、reload/new/resume/fork、导航取消、tree/compaction以及RPC；使用in-memory session/provider和合法公开tool流水线，不伪造production投影。
- [ ] 步骤5：运行 `node --test test/background-activity-runtime.integration.mjs test/custom-footer-input.integration.test.mjs test/custom-footer-fullscreen.integration.test.mjs test/custom-footer-subagents.test.mjs test/pi-subagents-enhanced-package.test.mjs`、`npm run typecheck`、`git diff --check`。若原基线失败分别登记，禁止为坏fixture添加生产兼容。

### Task T7：汇总验收与架构文档

**Deps：** T6 Host接线验收结果。

**WritePaths：** `docs/architecture/background-activity-display.md`。

**Resources：** 本地回归，真实Host手工视觉验收需用户授权/操作；不自动创建业务任务。

**Files：** Create架构文档；既有及新增tests仅读/运行。

**接口契约：** ConsumesT6证据；Produces产品语义/注册协议/生命周期说明和最终验收矩阵。

**验收标准：** 文档准确区分source权威、展示/history、scheduler投递与业务完成、bash delivery与消费ACK，指出fresh subagent恢复已知边界；原始数据保持、无双owner/独立daemon，完成情况以证据而非spawn回执判断。

- [ ] 步骤1：逐条核对规格映射T1–T6，记录各source实际接口和raw invariants，更新当前dirty基线、既有失败清单，不改settings或任务文件。
- [ ] 步骤2：运行所有新增background/provider tests，以及原footer/browser/viewport/native/通知、scheduler adapter/package隔离、bash unit/compact-renderer验证；不因completion renderer已独立修复而跳过回归。
- [ ] 步骤3：运行 `npm run typecheck`、`npm test`、`git diff --check`；全仓若存在既有失败与当前基线比较，明确未全绿，不能宣称全部通过。
- [ ] 步骤4：提供用户视觉核验步骤：在授权Host中使三类均可见、Alt+O跨类型切换、长中文命令和窄宽、关闭恢复draft、一次终态回执；不自动执行真实创建/后台命令。不把fake TUI证据冒充现场截图验收。
- [ ] 步骤5：报告范围/验证/已知边界，不提交；成果review需用户单独授权，不自动派发。

## 停止条件与风险

- 发现当前API与protocol类型矛盾、无法证明scope隔离、缺少package public capability、唯一owner与standalone不能同时满足时，停止相关步骤并请求决策，禁止凭last-wins或全局singleton补洞。
- 发现真实生产可达恢复/删除缺陷，只保留证据并独立修复，不将统一显示变成新调度器/恢复引擎。
- 未启用的source显示为空；暂不可读取与无任务必须可区分，不能虚构成功或删除。
- 详情读取可能含不可信内容，沿用source安全边界。统一层不直接读真实session/store，不将输出另写持久log。
- 三类活动数量增加会增高footer；正常宽高逐项显示，超出主视图`terminalRows-6`物理预算时按T5步骤2a显示剩余数量与Alt+O入口，详情完整导航；不得负高度/崩溃，不偷偷删source记录。
- 独立缺陷修复可能改变基线行号；按当时事实整合，不恢复HEAD覆盖dirty。

## 计划自检与交接

- 规格映射：区域定位/图标/缩进T5；三sourceT2–T4；详情T5/T6；唯一owner和Host隔离T1/T6；独立部署T2/T6；raw/RPC/生命周期T3/T4/T6/T7。
- DAG/Deps/Waves一致；T5仅依赖协议即可独立验收，未人为等待source；共享文件写入在T1→分支→T6的真实接口交付边界整合。
- 首轮reviewer仅审阅计划，不实施；父会话inline修订后向用户询问Subagent-Driven / Inline /继续review。用户选择前不启动T1–T7。
