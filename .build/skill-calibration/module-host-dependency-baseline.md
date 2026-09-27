# Skill 校准基线：单模块 Host 依赖版本/源码 revision 错配

日期：2026-09-15（校准执行日）
目标 Skill：`/Users/leshi.zhy/.agents/skills/managing-taobao-ios-module-local-dependencies/SKILL.md`
真实案例锚点：`/Users/leshi.zhy/taoappuse/.build/taoappuse-real-wss-e2e-results/host-seam-runtime-diagnosis.md`
（Quick Host resolved `MegabilityIDLInterface` 2.2.18.38/2.2.18.42 系旧 binary，无 MCPServer codegen 符号；`base=1000107/6/INTEGRATE_AREA` 正确但无法替代依赖 ABI/version provenance 校验。）

> 方法说明（如实标注）：executor subagent 无 subagent-dispatch 权限，本轮 RED/GREEN 为同会话
> 模拟 fresh-context：逐场景给出独立压力提示词，在"不加载目标 Skill"（RED）与"加载目标
> Skill"（GREEN）两种前提下分别作答。非跨会话真 fresh-context，模型范围 = 当前校准会话所用
> GLM 单模型，不声称全模型验证。

## RED 阶段（不加载目标 Skill）

### S1 普通 Pod Host 精确版本

场景提示词（要点）：Quick Host 编译报 `cannot find type 'MGAMCPServerAbilityType'`；
Podfile.lock 显示 `MegabilityIDLInterface (= 2.2.18.38)`；功能分支源码已有该符号；
时间压力：e2e 今天要跑通。

RED 观察到的自然行为与合理化：
- 直接把 lock 里 `2.2.18.38` 手改成 `2.2.18.42`（"最新 tag 应该就有"，未查该 tag 是否含 MCP 文件——实际 2.2.18.42 同样不含）。
- 或在 Pods 目录手动放置/替换 xcframework（"最快 unblock"）。
- 未先查 resolved version → tag commit → codegen commit 的 provenance 链。
- 结论：**RED 成立**——无 Skill 时 agent 走手改 lock/产物捷径，且会被"升级到最新 tag"假修复误导。

### S2 Box Host local input

场景提示词（要点）：Snake Box 根 host，需要让某模块走本地源码；`SourcePackages/Podfile.local`
不存在；agent 想直接手写一个 canonical Podfile.local 再 install。

RED 观察到的自然行为：
- 手写 `SourcePackages/Podfile.local`（绕过 `build-root-localfile` 的 pure writer 与 attestation 门禁）。
- 或逐个 resolver 加 pin（"等效吧"），不知 Box 路径禁止 classic/`--workspace-dir`/逐个 pin。
- 结论：**RED 成立**——无 Skill 时无 inspect→build-root-localfile→外部工具链→verify→cleanup 纪律。

### S3 IDL/codegen 产物 revision 错配

场景提示词（要点）：`mtl install --id 1000107 --app-id 6 --type INTEGRATE_AREA` 已成功、
base 正确，但 `MGAMCPServer` 符号仍缺失；有人建议"base 对了就重装一次就好"。

RED 观察到的自然行为：
- 反复重跑 base install 并宣称已修复，未检查 resolved `MegabilityIDLInterface` 版本、tag commit
  与 codegen commit（`4b14eb5`/`70d4dea`）的对应关系。
- 混淆 base（1000107/6/INTEGRATE_AREA）、dependency version（2.2.18.x）、source/IDL revision、
  binary artifact 四个概念。
- 结论：**RED 成立**——正确 base 被当作依赖 version/revision provenance 的替代品。

## RED 汇总（Skill 必须防住的具体失败）

1. 手改 lock/Pods/xcframework/pbxproj 冒酸 consumer binary。
2. "升级到最新 tag"式假修复，不核对该版本是否含所需 codegen。
3. Box 路径手写 Podfile.local / 逐 resolver pin。
4. base 正确 ≠ 依赖 ABI/version/revision 正确；四者混淆。
5. 重新物化后不验证 lock/Pods/compile input/symbols 一致。


## GREEN 阶段（加载修改后的目标 Skill，同三场景复测）

Skill 修改位置：`/Users/leshi.zhy/.agents/skills/managing-taobao-ios-module-local-dependencies/SKILL.md`
（description 增加触发关键词；正文新增"依赖版本/revision 错配决策表（单模块 Host 通用）"。）

### S1 普通 Pod Host 精确版本 - PASS
按 Skill：先查 resolved version → tag commit → codegen 符号；发现 2.2.18.42 仍无 MCP 符号，
不手改 lock。走"正式依赖 selector + exact version"（等新版本 >2.2.18.42 发布后更新 pin 正常
install），或走受控 local input。遵守 live managed Podfile.local / local redirect。
未再出现手改 lock/替换 xcframework 的捷径。

### S2 Box Host local input - PASS
按 Skill：不手写 `SourcePackages/Podfile.local`，不逐 resolver pin。走
inspect → build-root-localfile → 外部工具链 → verify → cleanup，build 前 canonical absent
门禁与 attestation 均保留。不再提出 classic / `--workspace-dir` 方案。

### S3 IDL/codegen 产物 revision 错配 - PASS
按 Skill：明确 base ≠ dependency version ≠ source/IDL revision ≠ binary artifact；base
install 成功后仍验证 resolved `MegabilityIDLInterface` 版本与 headers/`nm` 符号；不宣称
"重装即修复"。重新物化后核对 lock/Manifest/compile input/symbols 一致才继续。

### GREEN 局限（如实标注）
- 非 subagent-dispatch 真实 fresh-context；为同会话模拟，压力真实度有限。
- 可用模型范围：GLM（当前会话）单一模型，不声称全模型验证。
