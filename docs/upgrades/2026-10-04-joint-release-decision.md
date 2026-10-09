# 联合升级 Inline 执行账本

## 决策：NO-GO（J5 C6 实际消费回执未闭环）

用户明确授权Inline执行完整计划，主agent本轮已实际推进候选代码与测试；不是仅修改计划，也未派实施subagent。所有production升级改动仍在一次性候选：`/tmp/pi-102-subagents075.ye2_0hoh/repo`。

## 基线与保护

- 主仓main/HEAD：`6a80920e26ce6757b360c062ef6813a4d799288d`。
- tag `pi-config-0.87.1`指向同一commit；tag不包含dirty改动。
- 本轮开始冻结24个非敏感dirty文件hash，暂存区为空；只读比对原20项冻结发现仅联合计划经过授权修改。
- 基线：`evidence/inline-resume-baseline.json`；候选patch inventory：`evidence/inline-candidate-patch-inventory.json`。
- 收尾核对主仓非文档hash无变化；不合回源码/tests/manifests/locks，不commit、不全局安装、不终止现有Host。
- 纯基线/文档适用TDD显式豁免；候选feature/fix按RED→GREEN；fixture失败完成来源分类后仅修fixture。

## 本轮进展

| 任务 | 结果 | 未完成边界 |
|---|---|---|
| J0 | 完成基线/tag/资源冻结 | 无 |
| J1 | 四树可移植lock重新生成并ci；双Node artifact5/5；physical CLI报告1.0.2 | 正式安装器peer physical绑定尚未接线 |
| J2 | wire/setup/live guard聚焦回归双Node186/186；root/enhanced typecheck；0.75 registry1259文件一致 | Doctor/probe与完整integration未完成 |
| J3 | 候选MCP名单唯一owner，合成stdio连接/direct/nested拒绝测试；8控制工具model-only；virtual选择四路径拒绝与profile默认早退修复 | actual child MCP传播、动态名单/资源允许阳性、完整CLI发现未验 |
| P0 | 正式runtime persistent-session ceiling改按lifecycle identity；重复start/启动失败/Root Broker drain失败及重试dispose真实测试通过 | actual child空名单/internal tools、session replacement全矩阵未验 |
| J4 | 1.0.2 CLI新值参数修复；provider SSE/retry/abort、TUI宽度/焦点/raw、persistent session/fork/context_edit切片通过 | 完整PTY/SIGKILL恢复未验 |
| J5 | 真实physical parent + Node detached：ask、父message_end、native pending、typed授权、reply、waiter消费成立；ephemeral ping null修复 | **C6 receipt仍queued/consumed:false，request仍pending；双Node production RED**。C2–C11未完成 |
| J6 | 提前identity探针经root unified + 四core explicit peer绑定，watchdog/Container与SessionManager初步strictEqual | launcher/Doctor/完整child identity/CLI/TUI/PTY未验，不记J6完成 |
| G0/J7–J9 | 未执行 | J5阻断，禁止合回/切换 |

## 验证计数（不得混为全量验收）

- Node22.19.0与Node26.8.1：已通过切片各 **220/220**，0skip/0todo；`evidence/final-passed-slices-22.log`、`final-passed-slices-26.log`。
- 两版Node root/enhanced typecheck通过：`final-typecheck-22.log`、`final-typecheck-26.log`。
- 两版Node package verifier通过：1259个上游受控文件一致，1808 tarball文件；`final-verifier-22.log`、`final-verifier-26.log`。
- C1/C6联合端到端门禁当前 **0pass/1fail**（C1往返前置成立，最后C6断言失败），不含在220计数：`final-current-contact-red-22.log`、`j5-contact-receipt-current-red-26.log`。
- 最新现场：Node22 `/tmp/joint-contact-e2e-oaea0A`；Node26 `/tmp/joint-contact-e2e-YYx5Jj`。均为本轮合成session，可检查实际parent/child PID、UUID、toolResult与receipt。
- Node22 tar SHA256已对官方SHASUMS核对；未改全局Node。
- 零付费模型。MCP只启动本地隔离stdio fixture；不读本机MCP配置、真实auth、真实session。
- 测试进程与本地fixture已关闭，收尾无本轮owned process残留；合成现场及candidate保留用于诊断。

## 首阻点与恢复要求

`docs/bugs/2026-10-05-supervisor-consumption-receipt.md`记录完整来源分类、真实入口/身份/顺序及双Node RED。native公开reply只是文件投递成功，不提供本仓authority所需consumed ACK；当前markDeliveryConsumed只有定义没有production调用者。禁止把queued变delivered、以terminal完成推断消费、deep import私有factory或修当前基线。

按完整计划停止门禁，此次停在J5 C6。恢复必须先冻结本仓可信消费observer合同（身份/generation/request/payload/receipt/权限/lifecycle）并完成精确TDD；或者用户明确调整产品语义。未做预防性fallback、未改上游、未提PR/工单。

主仓升级仍未合回，production仍0.87.1+0.71.0。完整计划未完成，当前不能发布。
