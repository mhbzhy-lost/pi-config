# 联合目标 physical 加载决策

## 当前决策：初步physical身份GREEN，整体仍NO-GO

目标拓扑固定为physical parent + Node detached physical child，不支持foreground/binary/hot reload。不能再把历史bundled失败外推为physical失败，也不能把初步identity GREEN当作完整J6通过。

## 历史对照

原候选使用独立host bundle入口，actual native watchdog与embedded Container不同、native SessionManager与embedded Host不同；双Node1pass/1fail。这是旧bundled/physical混合RED，仅保留历史证据，已不作为目标拓扑验收。

## 本轮实际目标证据

1. 官方1.0.2发布artifact有`dist/cli.js`：setupCli→main，build:unbundled生成；官方RPC示例消费该路径。两版Node直接运行报告1.0.2。
2. 仅换成unbundled入口但保留独立host/root/enhanced安装：native仍解析其他物理副本，identity失败。
3. unified Host选择root锁定core1.0.2安装；enhanced冷安装`omit=dev/peer`仍留下bundle闭包物理core，watchdog Container仍不同，不能靠npm flags宣称解决。
4. 候选安装feature提供`bindPhysicalHostPeers`：先校验四core manifest/version/root，只将enhanced四peer入口显式绑定root physical来源；不改上游受控文件、不使用loader hook/万能resolver。真实native ESM identity RED→GREEN；原依赖保留可失败回滚。
5. 正式public compat真实watchdog消费测试，parent physical/native Container与SessionManager strictEqual；双Node已过。未比较跨进程JS对象。
6. 真实physical parent + Node detached child已跑C1往返，required launch-resolved列root-session-owner/integration-queue；actual child有native contact_supervisor。完整required ack、child全部namespace、launcher/Doctor/TUI/session-owner/PTY未验。

## 证据路径

候选：`/tmp/pi-102-subagents075.ye2_0hoh/repo`。

- `evidence/j1-physical-identity-characterization-22.log`：独立安装physical RED。
- `evidence/j1-cold-unified-physical-identity-22.log`：省略dev/peer仍不充分。
- `evidence/j6-peer-install-red-22.log`、`j6-peer-install-green-22.log`：部署绑定行为RED→GREEN。
- `evidence/final-passed-slices-22.log`、`final-passed-slices-26.log`：实际public compat identity初验通过。
- `docs/upgrades/2026-10-04-joint-candidate.json`记录exact physical root、lock/SRI与来源。

## 发布边界

正式setup必须可重复地产生同一peer绑定；Doctor既不能将local peer自动视为健康，也不能通过env bool放行，必须检查物理realpath与fresh Host-backed identity。launcher只允许官方physical entry并固定root/Node，无ambient/global/bundle fallback。上述生产接线未完成，本轮因J5 C6 receipt生产RED停止，没有修改主仓launcher/Doctor、没有切换全局。

同版本不是同实例；仅删除peer不是完整修复；初步public加载不是完整CLI/child全链证明。继续遵循不改上游、不提PR/工单、不创建私有bridge方针。
