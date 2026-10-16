# 独立操作工具计划 S6 验收

## 最终结果

S1/S2/S3 factory、G1/G2 gate与S5 guidance已分别验收；S4注册切换后执行最终聚焦组合。clear C1/C2/C3因upstream absence不可证保持blocked，不注册空壳工具。

## 命令证据

- S6组合聚焦：`node --test` 指定24个S1/S2/S3/S4/S5/G1/G2/replay文件，最终 **492 tests / 492 pass / 0 fail / 0 skip / 0 todo**，exit0；原首跑4个失败为G2-wire测试仍找旧union名，改为新工具名后最终通过。
- root/package `npm_config_registry=https://registry.npmjs.org/ npm_config_offline=true npm run typecheck`：exit0。
- offline `npm run verify:subagents-enhanced`：exit0，1259 upstream files、156 import edges、1823 tarball files。
- `git diff --check`：exit0。
- fresh synthetic SDK probe：14个新工具全部active/model-only，旧三名不active，14个均不可nested调用；`supervisor_request_pending`与`subagent_roster` smoke成功。生成的`/tmp/s6-operation-probe.json`只含测试fixture与schema/UTF8字节投影，不读用户配置/session。

UTF8字节基线（无token或收益断言）：迁移前旧三工具 description/schema/snippet/guidelines合计4352/3000/336/1082；迁移后14工具合计5259/4558/1124/2280。工具数和说明总量都上升，未宣称节省；收益只在操作面字段隔离和对象区分，provider选择/实机兼容保持unknown。

## 交付边界

- S4已切换唯一模型注册面，membrane仍捕获上游旧名但fresh Host不注册旧union。
- S5已迁移自有operation guidance、AGENTS_GLOBAL示例、workspace reminder与bash_async clear_queue限定；raw/session/details/上游通知不重写。
- 旧integration fixtures仍有旧tool name引用，未在本S4/S6 WritePaths外自动批量修改；真实Host/CLI integration不因synthetic probe而宣称通过。需要真实fixture迁移的项目另列后续。
- 既有失败：`joint-upgrade-ceiling-runtime` 3项、`subagent-runtime-resource-isolation` 1项未修；它们在HEAD对照副本同样失败，属既有缺陷/环境，不扩大本计划。
- clear blocked不等于gate失败：G1/G2 gate已通过，absence observer不能提供可靠exact absence，所以不实现危险清理fallback。
