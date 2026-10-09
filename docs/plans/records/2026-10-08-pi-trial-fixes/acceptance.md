# F6 最终验收记录

## 结论与变更边界

本记录及本轮三份文档均为纯文档收尾。按 test-driven-development Skill，纯文档整合适用 TDD 豁免，不新增 RED/GREEN，不改变 production、test、settings 或 config index。本记录引用 F1–F5 已有的 RED→GREEN 与接受证据，不把本轮文档收尾写成新的测试或实现。

当前六项状态如下：

- T1、T2、T4、T5、T6、T7：**implemented + focused accepted**。
- T3：**closed**，按用户最新现场判断关闭并移出修复范围。
- T5：仅 **display fixed**；更底层 upstream stream interruption 原因 **out of scope**。
- 修复需 **fresh Host** 生效，不 hot reload；无 paid canary、无真实模型、无用户进程操作或网络验证。

历史调查中“只读/未实施”的句子仍是当时现场事实，不覆盖上述当前状态。历史 dirty 保留；外部 r2c adapter/missing-adapter 变更为 **not ours**，不回退。

## F1–F5 既有接受证据

下列证据对应本轮已接受的实现；不把文档整合视为新的测试。`ARENA` 为 `/var/folders/27/6bnn8n7d4px6s33fvdpns89c0000gn/T/pi-trial-fixes.wivt8gou`。

| 任务 | 修复与验收边界 | RED → GREEN 与接受记录 |
|---|---|---|
| F1（T1、T2） | admission 名单与默认首位可用模型进入真实 generic/coding leaf；显式 model 规则不变，不增加 provider-error 换模 | `/tmp/arenaF1-followup-7Iaqgd/evidence/f1-red.log` → `f1-final.log`，**87/87**；同目录 `f1-hashes.json` |
| F2（T4） | 隐藏 completion 仅通过公开 UI notify 实时呈现；原 native message 独自驱动模型回合，无显示副本、无额外回合 | `ARENA/F2/evidence/red-empty-scaffold.log` → `green-final.log`，**26/26**；main 接受记录 `ARENA/evidence/F2-main-acceptance.json` |
| F3（T5） | 双层工具 renderer 保留 `context.isError`、失败标记与具体原因；仅修显示，不调查 upstream 断流 | `ARENA/F3/evidence/real-red.log` → `green-error2.log`，新增 **47/47**；`f3-regression.log` **80/80**；main 接受记录 `ARENA/evidence/F3-main-acceptance.json` |
| F4（T6） | 只折叠已确认的 facade→leaf 关系，保留 raw roster 轮询，并保护活跃/选中组件与关系一致淘汰 | `ARENA/F4/evidence/red-baseline.log`、`red-footer.log`、`red-trim.log` → `green-three-files.log`，**90/90**；同目录 `changed-hashes.json` |
| F5（T7） | 真实共享模板声明 builtin 排除，唯一 MCP/codemode owner；ensure/check 对相反精确 selector 在写入前拒绝 | 原 loader owner RED 与旧资源字面量对照、真实模板 GREEN；最终 `/tmp/f5-3a0bc04e.log` **15/15，0 skip**；main 接受记录 `ARENA/evidence/F5-main-acceptance.json` |

F5 fresh loader/start 与 synthetic `SessionManager.create/open` 恢复仅证明本地 owner/资源加载，不宣称真实 MCP connection/network 验证。completion 的提示是实时 UI 状态，不承诺恢复历史隐藏通知。F1 的人工 catalog 不证明真实 Astra 网络可用性；请求模型、选择元数据与实际 child 模型证据不混同。

F1–F5 不为 TUI 展示改写 raw message、toolResult、details、structured/event/session；没有新增 completion sender/authority、provider fallback、retry 或上游兼容分支。外部 r2c adapter/missing-adapter 修改并非 F1–F5 的交付，保持原样。

## F6 权威证据与计数

本轮 F6 的唯一权威 evidence arena 为：

`/var/folders/27/6bnn8n7d4px6s33fvdpns89c0000gn/T/pi-trial-fixes.wivt8gou/evidence`

该 arena 已保存并核对以下日志/诊断文件：

- `f6-current-8files.log`
- `f6-min-pattern.log`
- `f6-min-new3files.log` 与对应 `.exit`
- `f6-listFilesOnly.log`
- `f6-current-root-noemit.log`
- `f6-current-enhanced-noemit.log`
- `f6-min-root-noemit.log`
- `f6-min-enhanced-noemit.log`
- `f6-min-new3files-invalid-env-diagnostic.json`（首次手工环境误配的分类诊断）

计数必须分列理解：

- current Node 26.8.1 的八文件集合：**176/176 pass，0 fail，0 skipped，0 todo**。
- minimum Node 22.19.0 的三新增文件无过滤聚焦结果：**57 actual new / 57 pass，0 fail，0 skipped，0 todo**；三文件没有 pattern 过滤。
- 旧 global pattern 聚合：**51 = 48 actual pattern cases + 3 old empty-file placeholders**。因此应写作 **48 actual pattern + 3 old placeholder**，不能把 51 称为三新增文件的实际病例，也不能把该聚合与 57 actual new 合并成全套总数。

静态证据准确为：`--listFilesOnly` 输出 **1418 source paths + 1 summary line**（共 1419 lines；不是 1419 个 source），并包含 `pi/extensions/compact-tools.ts` 与 `scripts/ensure-pi-settings.ts`。静态检查共 **5 次调用、4 个 unique Node/config 组合**，均通过；current-root 的 `--noEmit` 历史执行 2 次，其余 current-enhanced、minimum-root、minimum-enhanced 各 1 次。本轮不重跑静态检查。

## 验收边界与保护

F6 仅记录既有实现的聚焦验收，不代表 full matrix、长 integration、真实模型、网络安装、paid canary、hot reload 或 user process 验证。T3 保持 closed；T5 保持 display-only/upstream-out-of-scope；统一修复需 fresh Host 才生效。

本轮没有 production、test、settings、config index 或 evidence 文件变更。首次 `PI_TEST_CODING_AGENT_ROOT` 环境误配属于手工 test 数据（分类 2），不是 production 缺陷；更正 root 后的 57/57 结果才是最低 Node 证据。oldsource9 hash 与 current 完全 match；三份文档从 1ec latest hash 的核对也已由 main 证实 matched（历史错误临时路径不作为当前 arena）。不隐藏首次环境偏差。原始消息、details、toolResult、structured/event/session 保护边界仍有效。

主agent已核对日志、当前 source hash、文档链接与空 staging；最终文档 hash 保存于权威 arena 的 `f6-doc-hashes.log`，主agent接受记录为 `F6-main-acceptance.json`。计划状态由主agent inline 更新，不由子任务修改。文档子任务 `2641e0e0-c562-4938-99c9-c749b4a4d28e` 因报告 `commandsRun: []` 被 harness 拒绝（任务明确禁止继续运行命令）；该拒绝不是测试或实现失败。main审阅其落盘文档并仅纠正日志文件名与 F1–F5 对应关系后接受，不新增测试。
