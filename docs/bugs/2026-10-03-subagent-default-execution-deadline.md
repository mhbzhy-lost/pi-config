# Subagent 30 分钟 execution deadline 被默认恢复

## 现象与来源分类

正常公开 generic/reviewer 派发的 leaf 在30分钟后硬终止。两个真实事故run为 `6891ea7d-73df-4484-b363-942e89d3a459`、`515a12ed-e922-4d96-9dd7-8b948d8f93f2`，status记录timeoutMs=1800000、timedOut=true，recovery绑定同一absoluteDeadlineAt。父workflow无deadline且数十毫秒完成。属于正常production输入的默认执行策略不符合用户要求，不是fixture污染。

生成链：enhanced genericWorkflowSpawnParams → workflow runs.run async leaf → pi-subagents0.71 resolveSingleAgentLaunchTimeout → DEFAULT_ASYNC_TIMEOUT_MS=1800000 → executeAsyncSingle写deadline → detached subagent-runner timer → subagent.run.timed_out。首个偏离点是caller省略timeout时上游自动补默认。coding显式注入曾由9f6460e删除，fcc43a68 merge恢复，并有测试断言30分钟。

## 用户批准的新策略

用户明确选择runtime默认传足够大且不溢出的正整数，而非patch上游。generic/coding child统一传 `2147000000ms`（约24.85天），小于Node timer最大值2147483647，余量483647ms。它不是无限执行，超过该期限仍可能终止。保留RPC请求等待、collector等待和无活动提醒；不改上游、安装与verifier。

runtime统一覆盖child执行窗口，公开调用者仍不能传timeout；contractHash原本不包含Host timeout，保持不变。canonical codec供其它纯合同使用的默认值不在本次改动范围；实际公开runtime两分支明确注入长窗口，不靠省略字段。

## RED与验收结果

先修改现有真实typed execute测试：coding、generic实际生成的workflow leaf必须显式有2147000000；root不加deadline。聚焦3测试正确RED：coding实际1800000、generic两个case实际undefined，而期望2147000000；日志 `/tmp/pi-deadline-red.log`。

最小GREEN：`extension.ts`统一Host常量，coding child与generic child显式注入；coding IR也由Host注入同值，collector仍独立120000ms。

- 真实typed execute测试35/35通过。
- 扩展/workflow collector/root-session-owner lifecycle回归63/63通过，日志 `/tmp/pi-deadline-regression.log`。
- root/enhanced `npm run typecheck`通过，日志 `/tmp/pi-deadline-typecheck.log`。
- `git diff --check`通过。

上游默认令人意外，新增窄characterization直接import installed0.71原resolver，消费真实runtime生成的coding/generic leaf输入：无config默认与config默认1800000两种情况均返回2147000000。真实Node setTimeout的内部有效delay保持2147000000而非溢出后1ms；立即clear，不等待24天，不宣称长期存活已验证。

## 生效与生命周期边界

现有run的已持久化deadline不会因新源码自动撤销；live Host已缓存模块是否刷新未验。需要fresh Host，新派发叶子的status/recovery可核验长窗口；本次没有启动真实付费child或改live run状态，不将resolver阳性描述成真实runnerstatus已验。

owner/lease心跳回收保留未修改。root-session-owner每5秒检查到期，Broker按既有机制续租；主Host结束后是否每类run都可快速退出仍依赖注册、lease和stop链，不能只凭长timeout或心跳存在给全局保证。未擅自停止/重启当前会话。

未安装、未patch node_modules、未提交；保护此前Doctor/shell/审计计划等工作区改动。
