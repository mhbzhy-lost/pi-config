# Plan Runner pi-subagents Flat Harness

## 目标

Harness 用于确定性执行已批准 Plan，同时把 Plan 领域权威、Root-owned subagent运行事实和Git副作用分开。当前支持Pi `0.82.0`/`0.82.1`/`0.83.0`，精确锁定`pi-subagents@0.37.2`与`typebox@1.1.38`。

领域拓扑是`Main -> Plan Runner -> Executor`；runtime拓扑是`Root -> [Plan Runner generations, Executors]`。领域父子关系描述审批与合同责任，不表示进程嵌套。

## 角色

| 角色 | 责任 | 禁止事项 |
|---|---|---|
| Main | 批准Plan、启动`plan_run`、提交明确Attention决策 | 不编译IR，不派发Executor，不接管其他Root的handle |
| Root runtime/broker | 持有Plan Runner与Executor、grant、Supervisor route、revival和有序关闭 | 不写Plan领域成功事件，不依据status文本宣告完成 |
| Plan Runner | 重放Plan、授权frontier、持久化Attention、集成结果、触发Gate | 不绕过Capsule派发，不自行回答blocking Attention |
| Executor | 在单个Attempt worktree实现并提交结构化结果 | 不改DAG/cwd/resources，不派发Agent，不写accumulator |

Plan Runner调用项目`subagent`工具，Capsule校验Event Writer已提交的一次性合同，child adapter再把请求交给Root broker。Executor不属于Plan Runner进程树；它们都是同一Root的一级async run。

## 身份与事实

三类事实不得相互替代：

1. canonical Plan Runner session中的append-only `pi-plan-event-v1`与Git提交证明Task、Attempt、Attention、integration、Gate和Plan终态。
2. 官方`process-terminal.json`、runId、asyncDir、sessionId和cwd证明实际进程身份与终态；只有`state=observed`的合法`ProcessTerminalV1`授权completion、recovery和shutdown。
3. `var/plan-runs/<planId>/status.json`和widget是可再生投影，只用于观察与对账。

session-local `pi-plan-handle.v4`记录planId、revision、stable logical Plan Runner runId、初代asyncDir、worktree和Root session identity。handle只在创建它的Root内有效，不落Host handle文件，不跨Root attach。

初始Plan Runner runId是stable logical caller。revival生成新的actual runId、token和grant，旧actual identity立即stale；所有generations继续写入同一canonical session。每个Executor runId只归一个logical caller所有。

## 仓库根绑定

Launcher是`originRoot`和`stateRoot`的唯一权威。它验证Git top-level、创建`var/plan-worktrees/<planId>` accumulator，并把已验证的绝对路径放入受信recovery descriptor；模型只接收revision identity，不提交root路径、IR JSON或hash。

status、Attention、revision、Attempt lease和control文件只使用验证后的`stateRoot`。禁止从`git-common-dir`的目录层级猜业务根；普通仓和submodule没有统一的父目录语义。

## 正常执行

1. Revision service读取source bytes，编译并冻结唯一`plan-ir.v3`，发布immutable revision artifact。
2. Plan Runner从event重放active claim，按Plan顺序选择authorized frontier。
3. 每个Task分配独立Attempt worktree和owner token。
4. Coordinator先写`attempt.dispatch-requested`，Capsule按contract hash授权一次`subagent`调用，Root broker完成spawn/bind。
5. Executor lifecycle通过authenticated broker push到owning Plan Runner；模型刷新`plan_status`，不调用`subagent_wait`轮询完成。
6. validator检查结构化acceptance report、Git谱系、cleanliness、路径、symlink和受控命令证据。
7. Integration Queue按Plan顺序串行cherry-pick并cleanup Attempt。
8. deterministic、plan-audit、external-review和final-completeness四道Gate绑定同一clean HEAD；全部通过后写入`validated`和`validatedHead`。

RPC ACK、formatted status、socket write和进程退出文本均不等于业务完成。缺失、畸形或身份不匹配的结果必须fail closed，禁止自动重复spawn。

## Attention

Executor的native Supervisor request先经Root broker owner route到唯一Plan Runner。Plan Runner把正文写入0600 Markdown并提交Attention event，再发送应用层`supervisor.ack`；ACK只表示领域记录成功，不表示请求已消费。

Main从当前projection读取request identity，取得用户明确决策后调用`plan_attention_reply`。Launcher先写完整durable command，再以authenticated private wake恢复stable logical caller。Plan Runner在当前generation读取版本化`PI_PLAN_ATTENTION_REPLY` envelope，以`plan_executor_supervisor`投递exact reply；native delivery成功后才记录resolved和ack文件。

```text
supervisor.request -> durable Attention -> Main explicit reply
-> private wake -> plan_status -> plan_executor_supervisor -> application ACK
```

每个generation最多认领一个distinct FIFO wake。current marker畸形时fail closed，不能回退旧generation；未ACK request只在对应Plan Runner official proof后重排。

## 恢复规则

- Plan Runner revival：只有当前actual Runner official proof加durable follow-up、queued push或live Executor completion debt才能启动下一代。
- Live completion：按actual generation计数；proof与completion顺序无关，successful handoff只消费快照，in-flight新增debt转移到revived actual。
- Pending handoff：resume成功后固定revivedRunId；grant失败重试同一actual，禁止再次resume制造orphan。
- Started ownership：grant与Root release都等待`runId + asyncDir + role + lifecycleSessionId`精确匹配的trusted started fact。
- Amendment pointer：`plan.created/plan.amended`是revision权威，`current.json`只是缓存；event已提交而pointer未写入时，原Root revival按canonical session修复pointer。
- Executor reconcile：只接受Plan event绑定的runId、asyncDir、session、cwd、唯一output和official terminal。
- Integration recovery：HEAD前进时仅在单父提交、parent=expected HEAD、diff SHA=validated SHA全部成立后补记完成。

其他Root必须拒绝旧handle，不attach、不resume、不发送signal。Standalone Host、re-root、fanout-child和persisted process identity均已退役。

## 关闭与排障

Root关闭顺序固定：停止新派发，drain所有Executors并等待official proof，再drain Plan Runner generations，关闭broker transport，最后dispose upstream。缺失或冲突的started ownership必须保留cleanup debt并fail closed，不能超时后释放。

排查顺序：

1. 读取canonical Plan event和derived status确认领域状态。
2. 读取Root broker diagnostics确认logical/actual alias、grant、follow-up和close阶段。
3. 对每个run解析official terminal sidecar并核对matching runner process instance。
4. 检查Attempt lease、Git HEAD、status、diff和唯一output。
5. 修复后由同一Root的durable入口继续，不手工伪造event、terminal或重复spawn。

路径越界、dirty result、缺commit、merge commit、symlink逃逸、验证失败、RPC不一致、stale base、patch篡改、cherry-pick冲突和cleanup failure都保留现场。

## 验证

```bash
npm test
npm run doctor
PI_REAL_BIN="$(command -v pi)" npm run test:subagents
PI_REAL_BIN="$(command -v pi)" npm run test:plan-harness
```

`test/plan-flat-runtime-harness.integration.mjs`覆盖双Plan、并行Executor、Attention、multi-generation continuation与Root shutdown；`test/plan-amendment-harness.integration.mjs`只补充event-to-pointer crash/revival。真实Harness必须隔离`PI_CODING_AGENT_DIR`，并同时断言Plan `validated`、official terminal、canonical session、PID `ESRCH`、socket/grant cleanup和accumulator精确产物。仅进程退出不算通过。
