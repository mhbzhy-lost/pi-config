# Supervisor gate G2/G2-wire 验收

## 当前交付

用户已改为Inline；G1 bcad81a基础上实现child gate与投递失败事实处理，未实现clear。

- 严格v1 intent parser不扩字段；v2显式childIndex（可为0），缺index拒绝，不猜0/不broadcast。
- state/request v2显式写入；读取合法v1并在内存迁移，首次mutation写v2，旧request身份/digest/时间不变；readDiagnostics不触迁移/TTL写。
- pending A只阻已证A，B可投递；queued reply允许新正文steer，不表示已消费；相同reply正文保护、steer幂等按child隔离。
- correlation缺失不默认0，返回scope-unverified。上游投递返回isError不能写queued；failed reply仍pending，failed receipt允许显式重试，原content/异常边界保留。
- 内存模式同root串行事务，无新存储/锁/观察authority。
- diagnostics安全投影增加childIndex/classification，D3二次白名单同步；不输出correlation正文、路径、digest。

## 来源分类

中文问题与完整链见 `docs/bugs/2026-10-15-supervisor-gate-overconvergence.md`。合法public native ingress→register→reply/steer→commit及权威correlation证明生产可达；新策略输入mock不替代用户历史个案归因。

早期Inline补丁产生多个真实回归（v1 key/混用schema/类型）；均保留失败日志并修正，不用旧任务回执冒充最新状态。旧测试缺index/correlation按新产品合同修fixture，不为测试恢复旧广播；失败reply不再变failed终局，测试相应expect pending。新增throw测试修为typed工具失败结果而非抛出，与原执行边界一致。

## 最终真实验收

- `node --test test/supervisor-gate-wire.test.mjs test/supervisor-gate-policy.test.mjs test/subagent-runtime-membrane.test.mjs test/supervisor-consumption.test.mjs test/supervisor-diagnostics.test.mjs test/supervisor-replay.test.mjs`：exit0，**173/173**；最终日志 `/tmp/g2-final-verified.log`。
- `npm_config_registry=https://registry.npmjs.org/ npm_config_offline=true npm run typecheck`：root/package均exit0。
- `git diff --check`与精确stage后的cached check通过。

## 不外推

C1/C2/C3 clear功能blocked-upstream：原native pending存在静默漏检，exact absence不可证；不签clear token，不注册空壳工具，不改上游、不读真实state/当前Host控制现场。旧Host读取v2会CORRUPT，需要fresh Host且不能同root混用旧/新Host；没有热重载当前会话。

具体用户历史incident、全child目录、外部provider选择行为未证。新14工具尚待S4注册，当前只完成gate与原工具wire链验收。无真实provider/网络/kill/通知，无push，无旧heartbeat现场清理。
