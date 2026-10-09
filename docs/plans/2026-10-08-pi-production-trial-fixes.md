# Pi 实际试用问题统一修复计划

> **给执行 agent：**必须逐任务执行本计划，使用 `- [ ]` 跟踪。用户已明确选择 **Subagent-Driven**，主agent按下方DAG编排子任务、整合验收；计划编写、修改仍由主agent inline 完成，不交给subagent。任务依赖满足即派发，共享TUI/环境资源验证串行，无需逐任务请求用户确认。

**目标：**修复实际试用中六项已定位问题：T1 agent 名单为空、T2 profile 默认模型选择丢失、T4 成功 completion 不可见、T5 工具错误被折叠隐藏、T6 子代理历史重复、T7 MCP/codemode 替代警告。T3 按用户最新反馈暂作为误报关闭，不修复。

**架构：**typed dispatch 保持现有 repository admission 和 Root Broker/RPC 权威；在本仓启动前解析 profile 默认模型，明确传入现有 workflow leaf。TUI 仅投影原始数据：隐藏 completion 用公开 `ctx.ui.notify()` 显示实时通知，工具错误由已有 renderer 展示，历史列表按明确 facade→leaf 关系折叠。MCP/codemode 继续使用本仓自有策略入口，配置明确排除默认 builtin，不修改上游实现。

**技术栈：**Pi 四 core `1.0.2`、pi-subagents `0.75.0`、Node 原生 TypeScript，最低 `>=22.19.0`；node:test、官方 SDK/InteractiveMode/ToolExecutionComponent、tsc。验证使用人工 catalog、合成 provider、隔离临时目录；不访问真实模型。

## 全局约束

- 用户已授权按 Subagent-Driven 执行本文；仅实现声明范围的六项修复，不扩大为升级、付费产品canary、全局部署或其他任务。
- 执行代码变更前必须加载并遵循 `test-driven-development` skill；bug 修复先中文问题记录和精确 RED，再最小 GREEN。禁止把此前升级全量 GREEN 当成本轮验收。
- 六项问题以 `docs/bugs/2026-10-08-pi-1.0.2-production-trial-issues.md` 和 `docs/investigations/2026-10-08-pi-production-trial-root-causes.md` 为 provenance 记录；根因未证实不增加预防性兼容。
- T3 用户认为可能误报，且后续观察到 subagent 中可显示；暂关闭，不为它新增 renderer、投递或兼容分支。若出现新证据再重开。
- T5 **只修 TUI 错误可见性**；上游断流原因、provider、网络、代理、账户池和请求重试不在本仓负责范围，不调查、不修改。
- **所有面向用户的精简、折叠、摘要、截断和换行只能发生在 TUI renderer 层。不得为改善 TUI 展示而改写 agent 实际收到的消息、tool result、event payload、session 内容或其结构化 details；TUI renderer 必须消费原始数据并生成独立的显示文本。**
- 不改上游 Pi/pi-subagents，不深引私有 child factory，不 vendor Host，不新增万能 resolver。
- 不新建 completion authority、第二通知投递通道、workspace ledger、broker、lease 或 scheduler owner；原生消息仍唯一触发主 agent。
- 不恢复 Goal、auto-continuation、ended-child auto-resume；不扩大工具/agent/capability 权限。
- 新 production/CLI 使用 `.ts`，测试及测试 helper 可用 `.mjs`；实现必须由 `tsc --noEmit` 覆盖。中文文档和注释。
- 跨 feature 只消费公开入口；`pi/extensions/` 仅 Host 绑定，业务实现放所属 `src/<feature>/` 或 enhanced package。不得新增 `scripts/lib/` 或反向 import 宿主入口。
- 不读取或复制真实 auth、credentials、models、session/state/workspace；必要非敏感配置核对由临时脚本仅投影资源选择字段，禁止输出其他配置值。
- `pi/settings.json.enabledModels` 为 per-machine 配置，禁止改变或提交。模型定义不提交、不同步；不访问秘密。
- 不全局安装、升级依赖、commit/push、提交 `/bug`/工单、重载或终止现有会话；本轮验收只启动自有临时 fresh Host，生效使用 fresh Host，不 hot reload。
- 保留主仓全部既有 dirty hunk；不 stash/reset/restore，不宽泛覆盖，不复制 candidate node_modules。
- **只运行聚焦测试和必要静态检查**，不重复完整主 suite、36 文件 integration、五 child paid canary、60 秒 lease 过期测试或其他升级大矩阵。新发现不相关异常记录后单独处理，不扩成本计划。
- bash 工具的 cwd 参数历史上不可靠，所有命令正文显式 `cd /Users/leshi.zhy/pi-config` 或使用绝对路径。

## 范围与文件职责

| 任务 | 问题 | 主要文件与职责 |
|---|---|---|
| F0 | 基线/环境 | 仅冻结允许修改的文件 hash、实际版本、staging 与合成环境；不扫 runtime 数据 |
| F1 | T1 + T2 | enhanced compat 的 profile 元数据投影；typed list 与 generic/coding 模型选择/生成 wire。两问题同属 dispatch admission 边界，共用 `extension.ts`，由同一 owner 完成，避免并发重叠写入 |
| F2 | T4 | 新增 `packages/pi-subagents-enhanced/src/tui/completion-notices.ts`，用公开 UI 显示隐藏原生消息；既有 compact formatter 区分派发 receipt 与实际完成 |
| F3 | T5 | 根 `src/compact-tools/renderer.ts` 和 `pi/extensions/compact-tools.ts` 的折叠错误分支；本任务独占 `tsconfig.json` 的入口静态检查补齐，不触碰 execute/数据内容 |
| F4 | T6 | `packages/pi-subagents-enhanced/src/tui/session-browser.ts` 的显示身份映射与选择迁移；footer 只消费 canonical roster |
| F5 | T7 | `pi/settings.template.json` 声明唯一扩展 owner；现有 ensureSettings 的增量同步与行为检查；本机设置只定点变资源字段 |
| F6 | 汇总验收 | 汇总每任务证据、两版静态检查与短 fresh TUI 验证，更新问题账本，不创建新的 production 验收框架 |

### 关键技术决策

1. **模型选择：**profile 的“fallback”只指启动前跳过当前 catalog 中不可用的候选，选择首个可用项；不实现 provider 请求失败后隐式换模型。显式 model 规则不变。没有 profile 声明才保留默认继承。
2. **T4 实时显示：**使用 `ctx.ui.notify(text,"info")`，它在官方 interactive chat 生成独立显示行，不增加 session entry、不进入模型上下文。只在 `ctx.mode === "tui"` 消费隐藏的 `subagent-notify`；不把 RPC `hasUI` 当 TUI。
3. **T4 历史边界：**新建或继续会话后收到的新 completion 正常显示；不回放旧 completion，不修改历史 `display:false`，不承诺通知跨 resume/树导航的持久显示。Option+O 的真实会话历史由 F4 保持，不从 UI notify 推断任务状态。
4. **T5 双层折叠：**共享 renderer 和 compact-tools Host 入口都必须放行错误显示；只改共享 renderer 不够。成功工具继续一行摘要。
5. **T6 关系去重：**只有明确 root step.runId、leaf.parentWorkflowRunId、workflowKey 和同父 session 等关系一致，且 actual single leaf 存在时折叠对应 facade step。不能按标题、文本或单独 sessionFile 相等去重。
6. **T7 配置：**明确排除 `-builtin:mcp`、`-builtin:codemode`；保留本仓 policy 和 `+codemode`、models:false。不得删除 policy 或过滤真实 warning。ensure 与 `--check` 在当前目标配置存在相反精确正项时必须先报冲突且零写入，避免以后 init 静默抵消 override；project/CLI 的显式重新启用另记录有效优先级，不修改外部配置。
7. **T6 缓存：**映射确认后的 root 与所有关联 leaf 是保留/淘汰的一致性组件；关联活跃 leaf 或选中 conversation 时保留其必要 raw root，完全终局且未选中时整体淘汰，禁止删 leaf 后使 facade 历史复现。仍以 `RECENT_RUN_LIMIT=20` 限制普通 raw terminal run，不添加永久墓碑或无限历史。
8. **静态覆盖：**F3 作为唯一配置 owner，精确补齐 root tsconfig 的 `pi/extensions/compact-tools.ts` 和 `scripts/ensure-pi-settings.ts`；F6 除 tsc 成功外还核对文件实际进入检查闭包，不能用原配置 GREEN 冒充覆盖。

## DAG

```text
                   ┌─ F1 admission/list + ordered default model ─┐
                   ├─ F2 hidden completion TUI notice ───────────┤
F0 安全基线/环境 ──┼─ F3 collapsed error visibility ─────────────┼─ F6 聚焦验收/账本
                   ├─ F4 canonical browser roster ──────────────┤
                   └─ F5 builtin resource owner config ─────────┘
```

### Waves 与资源

- **Wave 0：**F0。
- **Wave 1：**F1、F2、F3、F4、F5 的 WritePaths 不重叠，可并行编码。真实 TUI、环境变量变更、stdio fixture 资源最多一个验证任务同时使用；这不是 DAG 依赖。
- **Wave 2：**F6。只依赖各任务最终 diff 与聚焦 GREEN 产物，不重新验证完整升级计划。
- **关键路径：**F0 → F4 → F6；F4 的关系持久化/选择迁移最复杂。其他独立切片不等待 F4。
- 用户若选择 Inline，串行次序：F0 → F1 → F2 → F3 → F4 → F5 → F6。

每条边的产物：F0→实现任务为保护文件清单和绝对 Node/Host 环境；实现任务→F6 为源码 diff、聚焦 RED/GREEN、原始数据不变证据。没有仅因文件重叠或端口竞争添加依赖。

## 统一验证环境与成本

当前仓库 root 是权威 physical Host，不使用全局 `pi`（仍可能为0.87.1）。

```bash
cd /Users/leshi.zhy/pi-config
NODE_MIN=/tmp/pi-100-upgrade.Nxvr1T/artifacts/node-v22.19.0-darwin-arm64/bin/node
NODE_CURRENT=/opt/homebrew/Cellar/node/26.8.1/bin/node
HOST="$PWD/node_modules/@earendil-works/pi-coding-agent"
ARENA=$(mktemp -d /tmp/pi-trial-fixes.XXXXXXXX)
mkdir -p "$ARENA/home" "$ARENA/agent" "$ARENA/config" "$ARENA/state" "$ARENA/evidence"
```

每个测试子进程使用下列白名单，不从当前 Host 清 marker 后伪装维护环境，也不安装依赖：

```bash
env -i PATH="$(dirname "$NODE_CURRENT"):/opt/homebrew/bin:/usr/bin:/bin" \
  HOME="$ARENA/home" TMPDIR=/tmp XDG_CONFIG_HOME="$ARENA/config" \
  XDG_STATE_HOME="$ARENA/state" PI_CODING_AGENT_DIR="$ARENA/agent" \
  PI_TEST_CODING_AGENT_ROOT="$HOST" PI_HOST_ROOT="$HOST" \
  PI_HOST_NODE="$NODE_CURRENT" PI_PACKAGE_DIR="$HOST" \
  PI_REAL_BIN="$HOST/dist/cli.js" \
  PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT="$HOST" \
  PI_OFFLINE=1 PI_SKIP_VERSION_CHECK=1 PI_TELEMETRY=0 \
  "$NODE_CURRENT" --test test/pi-subagents-compat.test.mjs
```

测试不得在这里读取真实agent目录。profile测试可只读仓库 `pi/agents/*.md`，model registry 一律人工提供。切换最低 Node 时同步绝对 Node、PATH、PI_HOST_NODE。

**执行预算：**每任务聚焦验证预计1–15秒（不包含实现）；单次命令若超过60秒，先停止并检查是否误选长测或未关闭自有资源，不通过增加timeout掩盖。F6 聚焦集合只复跑一次当前Node，最低Node仅跑新增回归集合；类型检查每版一次。超出预算先报告原因，不擅自升级为全量矩阵。

---

## F0：冻结允许修改的基线与资源

**Deps：**none。
**WritePaths：**`docs/plans/records/2026-10-08-pi-trial-fixes/baseline.json`。
**Resources：**none；仅本地文件元数据。
**Files：**Create 上述 baseline；不修改 production/test/settings。
**接口契约：**Produces 非敏感 `{head, stagedPaths, protectedFiles:[{path,sha256}], packageVersions, nodes, evidenceRoot}`。其他任务只消费其具体 hash 与环境事实。
**验收标准：**允许写路径与既有dirty分开；root四core1.0.2、upstream0.75.0和四peer realpath仍匹配；错误版本/不明dirty碰撞停止，不复装依赖。

- [x] **步骤1：**记录 `git rev-parse HEAD`、`git diff --cached --name-only` 与 path-only status；只对本计划 production/test/template/文档路径做sha256，不递归读取var/session/auth/models。
- [x] **步骤2：**用只读临时脚本读取实际package name/version和四peer realpath；保留当前安装，不碰已有Host。
- [x] **步骤3：**创建上方ARENA及白名单，baseline记录绝对Node/Host与证据目录。临时辅助脚本从**各任务 WritePaths 汇总**全部路径（含新增实现、测试、fixture、tsconfig 与 F6 文档），不再维护不完整的手工数组。新文件hash记null，已有文件记录完整hash，不保存环境整包或Git diff正文。脚本形式：

```python
from pathlib import Path
import hashlib, json, re, subprocess
root=Path('/Users/leshi.zhy/pi-config')
plan=root/'docs/plans/2026-10-08-pi-production-trial-fixes.md'
text=plan.read_text()
paths=set()
for block in re.findall(r'\*\*WritePaths：\*\*(.*?)(?=\*\*Resources：\*\*)',text,re.S):
    paths.update(re.findall(r'`([^`]+\.(?:ts|mjs|json|md))`',block))
assert 'tsconfig.json' in paths
assert 'test/fixtures/trial-browser-lifecycle.json' in paths
assert 'packages/pi-subagents-enhanced/src/tui/completion-notices.ts' in paths
out=root/'docs/plans/records/2026-10-08-pi-trial-fixes/baseline.json'
# 自身尚未生成；settings另行内部比较，不保存其正文或完整配置hash。
files=[p for p in sorted(paths) if p not in {'pi/settings.json',str(out.relative_to(root))}]
run=lambda *args:subprocess.check_output(['git','-C',str(root),*args],text=True).strip()
data={'schema':'pi-trial-fix-baseline.v1','head':run('rev-parse','HEAD'),
 'stagedPaths':run('diff','--cached','--name-only').splitlines(),
 'declaredWritePaths':sorted(paths),
 'protectedFiles':[{'path':p,'sha256':hashlib.sha256((root/p).read_bytes()).hexdigest()
  if (root/p).exists() else None} for p in files]}
out.parent.mkdir(parents=True,exist_ok=True)
out.write_text(json.dumps(data,ensure_ascii=False,indent=2)+'\n')
```

将步骤2实际取得的版本/realpath以及Node/evidenceRoot追加进baseline；在临时脚本内部核对本机settings的非任务字段，baseline只保存非敏感资源选择/冲突与是否保持一致的摘要，不保存整个settings或任何凭据。

- [x] **步骤4：**检查待修改文件未被外部修改；不清空已存在staging，不用reset恢复baseline。
- [x] **步骤5：**确认六项provenance与用户范围。F0为只读/文档，显式TDD豁免；不以F0完成授权任何实施之外的部署。

**F0完成证据：**executor run `fd13a2e6-ef38-4209-a824-8a6109b794f2`，baseline存于本节WritePath。31个声明路径、29个保护hash（新6项null），实际版本/peer匹配。主agent逐项hash核对0偏差，非敏感保护文件副本仅保留于arena的`baseline-files/`用于验收diff。arena=`/var/folders/27/6bnn8n7d4px6s33fvdpns89c0000gn/T/pi-trial-fixes.wivt8gou`。初次宽范围find扫描已取消并记录；后续任务使用明确paths，不重复扫描。

## F1：统一修复 admission 名单与默认模型启动选择（T1、T2）

**Deps：**F0（保护文件hash、版本及验证环境）。
**WritePaths：**
- `packages/pi-subagents-enhanced/src/compat/pi-subagents-0.75.ts`
- `packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts`
- `test/pi-subagents-compat.test.mjs`
- `test/subagent-model-selection.integration.mjs`（已有快速内存RPC/event harness，不是真实网络集成）
- `test/subagent-dispatch-extension.test.ts`
**Resources：**none；只读三个repository profile、人工catalog、内存RPC。
**Files：**Modify上述文件；不改agent配置、上游或模型definitions。

**接口契约：**
- `BuiltinAdmissionAgent` 保留name/description/systemPrompt/models/model/thinking，并按实际profile提供 `tools?:string[]`；不伪造filePath。typed `DiscoveredAgent` 同步声明 `tools?:string[]` 及已有discovery可选的 `disabled?:boolean,filePath?:string`，不通过any掩盖两种来源的字段差异。
- admission继续只来自固定三个profile，`admission:"repository-configured"`；不注册第二discovery、不扫描skill目录。
- list结果为 `details.agents:[{name,description,model,models,tools}]`。model/models是配置/声明，不是实际执行证据；没有值分别用null/空数组，不凭候选首项填model。
- `resolveSpawnModel` 无显式请求且有profile时产生 `{source:"agent-default",model:candidates[0]}`；candidates已经按声明顺序与catalog求交并校验API。无profile才 `{source:"default"}`。
- `modelSelectionDetails` 可独立包含resolvedModel，requestedModel仅用户显式请求时存在。实际模型仍由run/status/runtime证据负责。

**验收标准：**三个准入agent可列举，不调用RPC/registry；默认首位选择进入generic/coding leaf.model；前项catalog不可用才选择下一项；全不可用/virtual/缺API仍在派发副作用前失败；显式qualified/bare和blacklist规则不变。

- [x] **步骤1：在已有harness中写精确失败测试。**该文件已有 `harness()` 和公开 `createTypedSubagentExtension`，新增导入compat的admission函数与path。

```javascript
test('repository admission列表不依赖filePath，且不访问模型或RPC', async () => {
  const {pi,rpc,tools,calls}=harness();
  const admission=registerBuiltinAgentsViaEvents({pi,agentDir:new URL('../pi/',import.meta.url).pathname});
  rpc.ping=async()=>{throw Error('list禁止RPC');};
  createTypedSubagentExtension(pi,{rpc,cleanupStore:{},discoverAgents:admission.discoverAgents});
  try {
    const result=await tools[0].execute('list',{action:'list'},undefined,undefined,
      {cwd:'/tmp',modelRegistry:{getAvailable(){throw Error('list禁止registry');}}});
    assert.equal(result.isError,false);
    assert.deepEqual(result.details.agents.map(a=>a.name),['delegate','executor','reviewer']);
    assert.equal(calls.length,0);
  } finally {admission.dispose();}
});
```

在同一harness对generic和coding参数化，literal声明 `['pool/astra','direct/astra','pool/sol']`，registry顺序倒置且astra/sol均可用；读取 `spawn.params.script` 的leaf：

```javascript
const leaf=JSON.parse(calls[0].script.match(/, (.*)\);$/)[1]);
assert.equal(leaf.model,'pool/astra');
assert.equal(result.details.modelSelection.source,'agent-default');
assert.equal(result.details.modelSelection.resolvedModel,'pool/astra');
assert.equal(Object.hasOwn(result.details.modelSelection,'requestedModel'),false);
```

补覆盖仅次位可用、全缺失零调用、无profile省略model保持unset、显式model优先。对compat增加tools逗号列表/YAML数组、models只来自该字段而非其他YAML列表的测试。

- [x] **步骤2：**运行：`node --test --test-name-pattern='repository admission列表|默认profile' test/subagent-model-selection.integration.mjs`。预期名单为空与leaf.model缺失的正确RED；测试文件内新命名包含“默认profile”。把日志写ARENA/evidence。
- [x] **步骤3：最小实现。**compat用Host公开 `parseFrontmatter` 读取现有受支持字段并验证类型，避免正则把其他列表混进models；models存在时必须为非空string数组且保持声明顺序，model为可选非空string，tools支持当前profile逗号string和YAML string数组，不引入外部fallbackModels兼容。tools只做配置元数据投影，不重建上游有效tool plan。list对 `repository-configured` 不再要求filePath，其他已有discovery来源保留原有过滤，不新增开放来源。默认模型使用已经校验的candidates：

```typescript
if (!requestedModel) {
  return {source:'agent-default',model:candidates![0]};
}
```

此分支放在profile候选解析成功后；无profile原早退保留。返回详情按model是否存在添加resolvedModel，不编造requestedModel。同步typed tool描述，说明启动前有序选择与无provider-error fallback。
- [x] **步骤4：**重跑精确用例确认GREEN；检查generic和coding均从共用选择函数得到同一leaf行为，不建立两个selector。
- [x] **步骤5：相关回归。**`node --test test/pi-subagents-compat.test.mjs test/subagent-model-selection.test.mjs test/subagent-model-candidates.test.mjs test/subagent-ordered-models.test.mjs test/subagent-model-selection.integration.mjs test/subagent-dispatch-extension.test.ts`。旧断言只有真正无profile时才期待default，不机械修改所有source值。**证据：**初始 F1 arena `evidence/f1-final-2.log`，58/58；主agent验收发现自制parser偏离公开API合同后补派run `a7dc46ec-8c67-455e-a083-e24acdc800b1`。最终 `/tmp/arenaF1-followup-7Iaqgd/evidence/f1-final.log` **87 tests / 87 pass / 0 fail**，公开Host parser、BOM/CRLF、非法声明与generic/coding边界均覆盖；主agent读取RED/GREEN并核对5个最终hash全一致。`scripts/probes/pi-subagents-compat.ts` 的既有升级dirty不归F1。

## F2：隐藏成功 completion 的独立实时 TUI 提示（T4）

**Deps：**F0（physical Host/资源边界）。
**WritePaths：**
- Create `packages/pi-subagents-enhanced/src/tui/completion-notices.ts`
- Modify `packages/pi-subagents-enhanced/extensions/subagent-runtime.ts`
- Modify `packages/pi-subagents-enhanced/src/tui/compact-rendering.ts`
- Create `test/subagent-completion-notices.test.mjs`
- Modify `test/subagent-compact-rendering.test.mjs`
**Resources：**自有synthetic AgentSession与fake terminal，最多1个TUI验证同时运行；不启动detached runner。
**Files：**Create上述completion-notices实现/测试；Modify上述runtime绑定与formatter/测试，不修改原生发送器。
**验收标准：**真实interactive consumer可见隐藏完成提示，原始message/session与model回合数不变；可见消息不重复提示，非TUI不触发UI；workflow receipt不误报业务完成。

**接口契约：**
`registerCompletionNotices(pi:Pick<ExtensionAPI,'on'>):{dispose():void}`只注册session/message通知处理；不改runtime-membrane、sendMessage、event bus或completion owner。

**显示行为：**
- 仅处理当前TUI模式的 `message_end`，role custom、customType subagent-notify、display不为true；已可见的message不重复显示，其他customType不处理。
- 从原始message调用现有compact formatter，再通过ctx.ui.notify输出；不调用sendMessage/sendUserMessage/appendEntry，不返回替换message。
- 以当前sessionManager对象为session域，用WeakSet记录已处理message对象；每generation/reset只保留当前域，不按内容/title去重，不吞掉不同完成消息。
- 对workflow dispatch receipt显示“派发完成，N个子任务仍运行或待收集”，不标成child业务完成；实际leaf完成显示完成。未知格式显示unknown，不猜测。
- dispose解除自己的pi.on监听，失败只诊断不影响原始消息/model turn；原始通知投递/ACK仍完全上游拥有。

- [x] **步骤1：新测试使用真实官方interactive消费者，不只formatter。**从已有 `openJointSession` 构造合成session，factory安装registerCompletionNotices。使用真实 `sdk.AgentSessionRuntime` 与 `sdk.InteractiveMode`，注入fake terminal（write等无副作用），调用 `session.bindExtensions({mode:'tui',uiContext:mode.createExtensionUIContext()})` 并订阅官方事件；不调用真实terminal start。原型特定方法仅允许test调用，production只用公开ctx.ui。发送：

```javascript
const h=await openJointSession({factories:[pi=>{
  registerCompletionNotices(pi);
  const r=createSubagentToolRenderers();
  pi.registerMessageRenderer('subagent-notify',(message,_options,theme)=>r.renderCompletionNotification(message,theme));
}]});
const session=h.session;
const terminal={columns:100,rows:30,kittyProtocolActive:false,start(){},stop(){},async drainInput(){},write(){},
  moveBy(){},hideCursor(){},showCursor(){},clearLine(){},clearFromCursor(){},clearScreen(){},setTitle(){},setProgress(){}};
const runtime=new sdk.AgentSessionRuntime(session,{cwd:h.cwd,agentDir:h.agentDir,
  settingsManager:session.settingsManager,modelRuntime:session.modelRuntime,resourceLoader:session.resourceLoader},
  async()=>{throw Error('禁止session切换');});
const mode=new sdk.InteractiveMode(runtime,{tuiMode:'fullscreen',terminal});
mode.subscribeToAgent();
await session.bindExtensions({mode:'tui',uiContext:mode.createExtensionUIContext()});
const original={customType:'subagent-notify',content:'Background task completed: **reviewer**\nfixture-output',display:false};
const before=structuredClone(original);
await session.sendCustomMessage(original,{triggerTurn:true});
assert.ok(mode.chatContainer.render(100).some(line=>line.includes('reviewer')));
assert.deepEqual(original,before);
const saved=session.sessionManager.getBranch().filter(e=>e.type==='custom_message');
assert.equal(saved.length,1);
assert.equal(saved[0].display,false);
assert.equal(saved[0].content,original.content);
```

test需import `openJointSession/sdk`、新module的注册函数以及真实runtime入口的renderer factory，所有helper均属test。InteractiveMode构造前临时设置PI_CODING_AGENT_DIR=h.agentDir，finally恢复env、取消mode.unsubscribe、dispose footer、停止自有renderer并h.close，不启动terminal。另断言synthetic provider看到完成content、实际assistant回合数不因display observer增加、没有额外custom/session条目。用真实renderer注册display:true消息确认只出现原卡片；print/rpc模式没有notify副作用，重复同object不再通知、不同object同内容不被误吞、shutdown后不再显示。
- [x] **步骤2：**`node --test test/subagent-completion-notices.test.mjs`。缺module时先创建仅导出空注册函数的test scaffold，正确RED应是UI中无完成文字，而不是模块加载错误；之后才实现行为。
- [x] **步骤3：最小实现。**production模块仅观察原消息：

```typescript
const seenBySession=new WeakMap<object,WeakSet<object>>();
const off=pi.on('message_end',(event,ctx)=>{
  const message=event.message;
  if(ctx.mode!=='tui'||message.role!=='custom'||message.customType!=='subagent-notify'||message.display===true)return;
  const manager=ctx.sessionManager;
  let seen=seenBySession.get(manager);
  if(!seen){seen=new WeakSet<object>();seenBySession.set(manager,seen);}
  if(seen.has(message))return;
  seen.add(message);
  ctx.ui.notify(formatCompactSubagentNotification(message),'info');
});
```

加入session生命周期reset、dispose/off和显示异常诊断；notify的官方相邻状态行合并语义保持（紧邻的info提示可能更新同一状态行，测试应覆盖此公开语义，不承诺逐条持久历史），不新建通知队列。runtime入口调用注册函数，将disposable放既有extraDisposables；不要改native completion投递。formatter识别官方first-line明确的dispatch-complete子任务计数；原始字符串保持不变。
- [x] **步骤4：**聚焦GREEN，并在formatter测试覆盖成功、失败、paused/stopped、grouped completion、workflow receipt带活跃child、未知格式及raw deepEqual。
- [x] **步骤5：相关回归。**`node --test test/subagent-completion-notices.test.mjs test/subagent-compact-rendering.test.mjs`。检查session/模型数据完全不变和监听释放；不再运行60秒supervisor/lease或完整notification integration。


**F2验收证据：**接续 run `655e8fa7-a328-4a2a-95fa-074544b43345`；arena/F2/evidence/red-empty-scaffold.log 的真实InteractiveMode用例准确RED（正文缺失，不是import失败），其他scaffold缺listener错误不作为独立RED证明。green-final.log **26/26通过，0.640秒**；main已读正确triggerTurn:true/raw持久化与turn数断言、runtime注册extraDisposables和真实workflow首行处理，无mode.init或手工emitMessageEnd。自有runner已退出，许可释放给F3。

## F3：折叠工具卡片保留失败标记与具体错误（T5）

**Deps：**F0（允许修改的renderer/入口hash）。
**WritePaths：**
- `src/compact-tools/renderer.ts`
- `pi/extensions/compact-tools.ts`
- `tsconfig.json`（F3 唯一owner，仅精确补齐两个 production 入口的 include）
- `test/compact-tools-renderer.test.mjs`
- `test/compact-tools-extension.test.mjs`
- Create `test/compact-tools-error-visibility.test.mjs`
**Resources：**真实ToolExecutionComponent和内存文件/terminal组件，无模型/网络/业务命令。
**Files：**Modify共享renderer、Host入口、root tsconfig和已有测试；Create上述error-visibility测试。只改变渲染与类型检查覆盖，不改变工具执行。
**接口契约：**所有七个工具的renderResult优先读取 `context.isError`（官方Host给result可能只有content/details），可兼容直接renderer调用的result.isError；错误分支只消费原始content，不改它。成功仍一行摘要。
**验收标准：**bash toolCall-only错误在折叠态也可见；read SKILL特例不能吞错；edit/write错误不能显示done。窄屏遵循列宽，展开沿用现有完整内容/显示limits，原始result和message恒等。

- [x] **步骤1：精确RED。**新增测试使用真实 `sdk.AssistantMessageComponent` 与 `sdk.ToolExecutionComponent`，加载本仓实际compact-tools/bash-cwd renderer定义，不执行工具。输入合法合成toolCall-only assistant error，并按官方consumer对tool卡调用updateResult。验证：

```javascript
const message={role:'assistant',content:[{type:'toolCall',id:'fixture-call',name:'bash',arguments:{command:'fixture-only'}}],
  stopReason:'error',errorMessage:'Upstream response stream was interrupted',timestamp:1,
  api:'openai-completions',provider:'fixture',model:'fixture',
  usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}};
const before=structuredClone(message);
const {codingAgent:sdk,jiti}=await loadPiTestRuntime(import.meta.url);
const compactFactory=(await jiti.import('../pi/extensions/compact-tools.ts')).default;
const bashFactory=(await jiti.import('../pi/extensions/bash-cwd.ts')).default;
const definitions=[];
const api={registerTool(tool){definitions.push(tool);},on(){}};
compactFactory(api);
bashFactory(api);
const definition=definitions.find(tool=>tool.name==='bash');
const assistantCard=new sdk.AssistantMessageComponent(message,false);
const toolCard=new sdk.ToolExecutionComponent('bash','fixture-call',message.content[0].arguments,
  {showImages:false},definition,{requestRender(){}},'/tmp');
// 工具不执行；updateResult与interactive consumer的错误显示输入一致。
toolCard.updateResult({content:[{type:'text',text:message.errorMessage}],isError:true});
const visible=[...assistantCard.render(100),...toolCard.render(100)].join('\n');
assert.match(visible,/✗/);
assert.match(visible,/Upstream response stream was interrupted/);
assert.deepEqual(message,before);
```

单测遍历七工具，以 `{content,details}` 无isError的result与 `context.isError:true` 断言显示；加入SKILL.md read、空错误正文、多行中文/ANSI、40/100列和成功回归。
- [x] **步骤2：**`node --test test/compact-tools-error-visibility.test.mjs`，预期旧renderer只显示行数/空result，错误文本断言为RED。模块存在，不用import失败作RED。
- [x] **步骤3：最小实现。**共享 resultRenderer在错误时返回独立错误组件并将summary标为失败；第一条错误原因不要求用户展开才能看到。折叠错误最多4物理行，超出时最后一行为“展开查看完整错误”，由Text/wrap和truncateToWidth按宽度生成；展开沿用已有maxLines，不改raw content/structuredContent/details。

```typescript
const failed=context?.isError===true||result?.isError===true;
if(failed&&!options.expanded){
  if(context?.state)context.state[COMPACT_SUMMARY_KEY]='失败';
  const body=new Text(theme.fg('error',`✗ ${text.trim()||'工具执行失败（未提供错误信息）'}`),1,0);
  return {render(width){const lines=body.render(width);return lines.length<=4?lines:
    [...lines.slice(0,3),truncateToWidth(theme.fg('dim','… 展开查看完整错误'),width,'…')];},
    invalidate(){body.invalidate();}};
}
```

将shared resultRenderer的truncateToWidth通过createCompactToolRenderers的现有依赖传入，不新建全局utils。read的SKILL成功隐藏条件要排除failed。

Host入口 `installCollapsedSingleLineRenderer` 只有成功才吞result，错误委托共享renderer；失败时清理/替换旧success summary，不能保留done。`installCompactReadSkillRenderer`同样只隐藏成功skill-read。bash-cwd继续复用共享renderer，不改其execute/cwd。
- [x] **步骤4：**确认精确GREEN；同工具失败→成功更新后恢复成功摘要，展开/收起/主题invalidate不丢错误；原始数据deepEqual。
- [x] **步骤5：相关回归与静态覆盖准备。**`node --test test/compact-tools-renderer.test.mjs test/compact-tools-extension.test.mjs test/compact-tools-error-visibility.test.mjs test/bash-cwd-extension.test.mjs test/extension-reload-boundary.test.mjs`。只有本计划新增error测试，不新增provider retry或上游测试。在 F3 独占的 `tsconfig.json.include` 精确增加 `pi/extensions/compact-tools.ts` 与 `scripts/ensure-pi-settings.ts`；配置补齐为静态检查覆盖变更，显式 TDD 豁免，不替代 renderer 行为 RED。F6 统一运行一次 `tsc --listFilesOnly` 核对两入口确实被检查；所有新增类型报错按本任务文件最小修复，不用 exclude/skip 整个入口凑绿。


**F3验收证据：**接续run `0192a576-bb84-4d03-a1c9-5df1099d71ed`。F3/evidence/real-red.log 47项真实组件准确RED；green-error2.log 47/47 GREEN；f3-regression.log 五文件 **80/80，1.47秒**。main已核对共享/Host入口错误分支与6文件hash。早期不隔离fake日志及提前行为改动均废弃，ownedrenderer精确恢复后重做RED；tsconfig只补两个include，实际static coverage留F6。自有资源关闭并释放许可给F5。

## F4：按明确 facade→leaf 关系形成 canonical 浏览器历史（T6）

**Deps：**F0（展示数据来源和安全baseline）。
**WritePaths：**
- `packages/pi-subagents-enhanced/src/tui/session-browser.ts`
- `packages/pi-subagents-enhanced/extensions/custom-footer.ts`（selector消费canonical投影；轮询消费trackedRuns原始run身份）
- `test/subagent-session-browser.test.mjs`
- `test/custom-footer-subagents.test.mjs`
- Create `test/fixtures/trial-browser-lifecycle.json`
**Resources：**合法合成started/status/complete projection，临时status文件仅用于既有secure reader路径；不读真实child session。
**Files：**Modify上述browser状态、footer消费者和测试；Create上述合法映射fixture。没有新authority文件。
**验收标准：**确认双向关系时root facade与leaf只有一条canonical conversation；到达顺序、历史、hydrate与选择迁移一致，未确认关系/无关同标题不合并；multi-step仍轮询全部raw run。超过20个 raw terminal run 的压力下，关系对不拆散、不使已折叠facade重新出现，关联活跃leaf/选中conversation的raw root不丢失轮询。

**接口契约：**
- BrowserChild增加可选显示关系字段 `runMode?:'single'|'workflow'`、`facadeLeafRunId?:string`、`parentWorkflowRunId?:string`、`workflowKey?:string`；真实启动/轮询产生，旧hydrate缺字段不凭sessionFile猜关系。
- root facade child从官方root step.runId和workflowKey投影；actual leaf从started或status的parentWorkflowRunId/workflowKey投影。
- `snapshot()` 返回canonical可见children/active/recent；`serialize()`保留raw显示roster及关系以便hydrate。新增 `trackedRuns():ReadonlyArray<{id:string,asyncDir:string}>` 返回raw显示run的防御副本，footer轮询消费它而非只遍历已折叠snapshot，保证multi-step root仍可更新。仅改浏览器自己的显示状态，不修改任何官方status/event或session。
- confirmed映射时root facade被折叠，actual leaf为canonical conversation；多步workflow逐step处理，不删除整个root。
- selectedKey如果是被折叠facade，迁移到对应leaf key，不退出browser、不打开另一个child。
- `trimRuns()` 也消费确认后的关系图：以 root 与其确认映射的 leaf 构成显示保留组件；被选中 conversation 或任一成员仍活跃时，保护组件内必要raw root/leaf。完全终局且未选中的组件在超限时整体淘汰，不能独立删leaf留下facade，也不能独立删root使其未出现的后续step失去轮询。
- 普通 raw terminal 历史仍受 `RECENT_RUN_LIMIT=20` 约束；只有当前活跃/被选中conversation所需依赖记录可随该conversation保留，解除保护后立即重新应用20条预算。不设置永久关系墓碑/无限历史。完整组件整体淘汰可少于20条，不为凑满数量拆散组件；active run本身不因terminal预算被淘汰。

**确认条件：**root step显式引用leafRunId；leaf存在且为single child；leaf父root与workflowKey一致；双方父sessionId非空且相同、agent一致。缺条件、冲突或同sessionFile但无映射均不折叠。父session不是child session身份，不拿它单独去重。

- [x] **步骤1：在fixture中保留合法关系字段。**替换真实ID/路径为合成值，但保持：root.mode=workflow、root step.runId=leaf、leaf.mode=single、parent/key/session双向一致；root先complete而leaf尚running是合法detached receipt，不把它误标child完成。

```javascript
const browser=new SubagentSessionBrowserState();
browser.trackStarted({id:'root',mode:'workflow',agent:'workflow',asyncDir:'/tmp/root',cwd:'/repo',sessionId:'parent'});
assert.equal(browser.snapshot().children[0].agent,'workflow');
browser.reconcileRun('root',{runId:'root',mode:'workflow',state:'complete',steps:[
  {runId:'leaf',agent:'reviewer',label:'typed-key',workflowKey:'typed-key',status:'running',sessionFile:'/tmp/leaf/session.jsonl'}]});
browser.trackStarted({id:'leaf',mode:'single',agent:'reviewer',parentWorkflowRunId:'root',workflowKey:'typed-key',
  asyncDir:'/tmp/leaf',cwd:'/repo',sessionId:'parent',title:'审阅任务'});
browser.reconcileRun('leaf',{runId:'leaf',mode:'single',state:'running',parentWorkflowRunId:'root',workflowKey:'typed-key',steps:[
  {agent:'reviewer',status:'running',sessionFile:'/tmp/leaf/session.jsonl'}]});
assert.deepEqual(browser.snapshot().children.map(c=>c.key),['leaf:0']);
assert.equal(browser.snapshot().activeChildren.length,1);
```

另覆盖leaf先被hydrate恢复再收到root、完成后recent、serialize/hydrate后仍只一条、选中root placeholder `workflow` 后状态step变为reviewer再映射到leaf的完整选择演化、multi-step各leaf独立、未出现leaf保留facade、同标题无关run不折叠、key/parent/session冲突不折叠、普通resume不同run不因session相同合并。

必须追加两项**纯内存淘汰 RED**，不创建21个真实child：

1. `canonical历史淘汰不会拆散leaf先到的关系对`：leaf先started、root后started，经双方status确认同关系，二者complete；再追加21个不同id的独立terminal run。每次追加后断言可见历史不会留下已去重的root单条，serialize→hydrate后也不复现；若老关系被淘汰，raw `trackedRuns()`中root与leaf都不在。
2. `facade调度完成后仍保留活跃leaf与选中conversation的raw root`：root状态complete但leaf状态running，确认关系后追加21个terminal run；断言raw trackedRuns仍有root/leaf且可见项仍为running leaf。模拟root后续新增step并reconcile，断言该step仍进入roster；再选中canonical leaf并终结它，施加第二次压力，root/leaf均因选择保护保留。退出browser解除保护后再施加压力，预算重新收敛且完整组件淘汰。

测试可继续使用已有 `startRun()` 创建独立run，但关系fixture必须采用上方真实root `agent:'workflow'`→status reviewer step，不能用只改标题的模拟替代run/parent/key事实。
- [x] **步骤2：**`node --test --test-name-pattern='canonical|facade' test/subagent-session-browser.test.mjs`。预期现状保留root:0与leaf:0为正确RED，不以非法status fixture触发production兼容。
- [x] **步骤3：最小实现。**trackStarted/reconcileRun仅保存上述关系。增加display-only查找逻辑，用显式映射寻找canonical child；active/recent分区从canonical结果产生，不能把root complete传播给仍运行的leaf。

```typescript
// 示意：字段均由上述入口投影；不读取正文，不按title/sessionFile相似匹配。
const leaf=allChildren.find(candidate=>candidate.runId===facade.facadeLeafRunId
  && candidate.parentWorkflowRunId===facade.runId
  && candidate.workflowKey===facade.workflowKey
  && candidate.sessionId===facade.sessionId
  && candidate.agent===facade.agent);
```

在条件完整、single leaf一致后隐藏对应facade；保留raw roster供serialize与轮询，字段持久化不引入第二authority。ensureSelection先解析canonical key再判断是否关闭。重写trimRuns的选择单位而非增加缓存上限：从已确认关系构建临时无向组件，保护有活跃成员或selectedKey canonical成员的组件，只对全terminal未保护组件按最老成员顺序整组删除；删除后重新计算raw terminal历史预算。trim/hydrate/complete/reconcile均沿用同一关系判断函数，不能在淘汰路径仅依赖sessionFile。保留RECENT_RUN_LIMIT=20，禁止永久tombstone和未受控的历史积累。
- [x] **步骤4：**精确GREEN；footer selector用实际snapshot验证两条不再同时出现、canonical保留业务title、model、tokens、sessionFile，不能仅对独立state断言。footer reconcile遍历 `trackedRuns()`，每个raw run只读一次；新增root step不会因旧facade折叠而失去轮询。旧serialize/snapshot完全相等断言需改为检验hydrate后的canonical投影相等与raw关系保留，不机械删除原有legacy测试。**证据：**F4 green-three-files.log，90 tests / 90 pass / 0 fail；F4最终5路径hash已核对，早期global Host结果废弃。
- [x] **步骤5：相关回归。**`node --test test/subagent-session-browser.test.mjs test/custom-footer-subagents.test.mjs test/custom-footer-input.integration.test.mjs`。不打开用户的Option+O/真实session，不跑完整PTY矩阵。

## F5：声明 MCP/codemode 唯一扩展 owner（T7）

**Deps：**F0（配置保护与权限边界）。
**WritePaths：**
- `pi/settings.template.json`
- `scripts/ensure-pi-settings.ts`（必改：ensure/check共享精确正负项冲突检测，阻止后续init静默抵消override）
- `test/ensure-pi-settings.test.mjs`
- Create `test/mcp-policy-owner-loading.test.mjs`
- `pi/settings.json`（执行时仅定点资源字段，enabledModels禁止变更）
**Resources：**真实DefaultResourceLoader，临时agent/cwd，builtin factory+本仓policy；无真实MCP server或网络。
**Files：**Modify模板、ensure冲突检测、本机资源字段和ensure行为测试；Create上述owner加载测试。init-pi.sh继续消费同一ensure公开入口，不新增旁路。
**验收标准：**无operator相反覆盖时fresh/resume loader不产生替代warning，只有一个codemode与/mcp owner；本仓策略保留，enabledModels及其他本机字段不变；明确覆盖不被静默吞掉。

**接口契约：**template extensions精确包含 `-builtin:mcp`、`-builtin:codemode`、既有tool-search/llama.cpp排除；defaultTools保留+codemode/-tool_search。本仓policy入口仍加载，codemode tool和/mcp command唯一owner。ensureSettings保持local字段并幂等。

在任何check或merge副作用之前，ensureSettings调用内部 `assertNoExactResourceOverrideConflict(existing, template):void`：只针对已有字段 `extensions/defaultTools` 中模板声明的精确 `+selector/-selector` 与本机相反正负项检测，不扩展glob/外部project判断。冲突抛出带 `code:'SETTINGS_RESOURCE_OVERRIDE_CONFLICT'`、`field`、`selector` 的错误；错误摘要不得附带整份settings。ensure和check必须同样拒绝，且目标文件字节不变、没有新临时文件写入。新template自身正负矛盾也拒绝。用户先在本机明确解决冲突后才重跑init；不删除正项，也不悄悄追加负项。

- [x] **步骤1：先写实际owner加载RED。**SDK默认不带builtin，测试显式提供官方builtin:true/replaceable:true的codemode/mcp factories，将真实 `pi/extensions/mcp-policy.ts`复制到自有临时agent入口（使用绝对import指向feature，不复制本机config）；SettingsManager使用真实template字段，读取empty policy。resourceLoader.reload后断言：

```javascript
const root=await mkdtemp(join(tmpdir(),'trial-owner-'));
const agentDir=join(root,'agent'),cwd=join(root,'cwd');
await mkdir(join(agentDir,'extensions'),{recursive:true});await mkdir(cwd);
const policyEntry=join(agentDir,'extensions','mcp-policy.ts');
const implementation=new URL('../src/mcp-policy/index.ts',import.meta.url).href;
await writeFile(policyEntry,`export {registerConfiguredToolRuntime as default} from ${JSON.stringify(implementation)};\n`);
const template=JSON.parse(await readFile(new URL('../pi/settings.template.json',import.meta.url),'utf8'));
const settingsManager=sdk.SettingsManager.inMemory({extensions:template.extensions,
  defaultTools:template.defaultTools,enableInstallTelemetry:false,defaultProjectTrust:'always'});
const loader=new sdk.DefaultResourceLoader({cwd,agentDir,settingsManager,noSkills:true,
  noThemes:true,noContextFiles:true,noPromptTemplates:true,extensionFactories:[
    {name:'codemode',builtin:true,replaceable:true,factory:sdk.createCodemodeExtension()},
    {name:'mcp',builtin:true,replaceable:true,factory:sdk.createMcpExtension()}
  ]});
await loader.reload();
const result=loader.getExtensions();
assert.deepEqual(result.errors,[]);
assert.deepEqual(result.warnings??[],[]);
assert.equal(result.extensions.filter(e=>e.tools.has('codemode')).length,1);
assert.equal(result.extensions.filter(e=>e.commands.has('mcp')).length,1);
```

测试临时设置PI_CODING_AGENT_DIR=agentDir（policy getAgentDir依此读取），finally严格恢复env/释放loader/session/删除自有root；sdk由loadPiTestRuntime或现有joint helper解析main安装，fs/path/os函数显式import。创建fresh in-memory session并bindExtensions，确认实际codemode可用和无配置连接0；再用公开SessionManager持久化/打开自有synthetic session重建loader，重复owner/warning断言。不得读真实sessions。

对ensure增加现有local extensions/defaultTools/未知local字段/enabledModels保留、两个builtin排除追加、重放幂等、check检测缺项的行为测试，不能只grep模板。另在 `test/ensure-pi-settings.test.mjs` 使用其既有fixture/writeFile/readFile，先创建两个selector各自的合法临时配置，覆盖普通ensure和check；目标已有正负两项时check也必须报冲突而不是只因负项存在就通过：

```javascript
for (const selector of ['builtin:mcp','builtin:codemode']) {
  for (const check of [false,true]) {
    const paths=await fixture({extensions:[`+${selector}`],enabledModels:['local/model']});
    try {
      await writeFile(paths.templatePath,JSON.stringify({...template,extensions:[`-${selector}`]}));
      const before=await readFile(paths.target,'utf8');
      await assert.rejects(ensureSettings({target:paths.target,template:paths.templatePath,check}),
        error=>error.code==='SETTINGS_RESOURCE_OVERRIDE_CONFLICT'
          && error.field==='extensions' && error.selector===selector);
      assert.equal(await readFile(paths.target,'utf8'),before);
    } finally {await rm(paths.root,{recursive:true,force:true});}
  }
}
```

增加已有 `extensions:[+selector,-selector]`、template自身正负相反以及defaultTools相反精确token反例；无冲突仍幂等，不能因普通未知local项误报。
- [x] **步骤2：**`node --test test/mcp-policy-owner-loading.test.mjs test/ensure-pi-settings.test.mjs`，预期当前template产生builtin replacement warnings，以及ensure忽略正项冲突而写文件/check只报missing或通过为正确RED；invalid imports/缺包不是本问题RED。记录两个行为失败，再实施。
- [x] **步骤3：最小配置GREEN。**template只新增两个精确排除，不移除policy，不hide diagnostic：

```json
"extensions": [
  "-builtin:tool-search", "-builtin:llama.cpp",
  "-builtin:codemode", "-builtin:mcp"
]
```

**ensure必须同步修复，不能仅因能够追加负项就跳过。**在existing/template解析后、`options.check`分支前调用同一冲突检查，所有失败发生于mkdir/write/rename之前。内部精确选择器检测实现形如：

```typescript
function assertNoExactResourceOverrideConflict(existing:JsonObject,template:JsonObject):void {
  for(const field of ['extensions','defaultTools']) {
    const current=Array.isArray(existing[field])?existing[field]:[];
    const declared=Array.isArray(template[field])?template[field]:[];
    for(const entry of declared) {
      if(typeof entry!=='string'||!/^[-+]/.test(entry))continue;
      const opposite=(entry[0]==='-'?'+':'-')+entry.slice(1);
      if(current.includes(opposite)||declared.includes(opposite)) {
        throw Object.assign(new Error(`资源选择冲突：${field} ${entry.slice(1)}`),
          {code:'SETTINGS_RESOURCE_OVERRIDE_CONFLICT',field,selector:entry.slice(1)});
      }
    }
  }
}
```

该算法只处理本轮既有merge支持的精确正负项，不推导glob或跨scope有效设置；加入测试确保相反项存在时无写入。Host同一scope精确exclude胜过include，不能把两个token同时保留当作保留用户意图。通过安全临时脚本核对本机/目标project/CLI资源选择（只输出extensions/defaultTools，不输出其他值），记录显式+builtin覆盖；不修改外部项目设置。若存在相反覆盖，报告决策阻塞，禁止静默删除配置。
- [x] **步骤4：**先由临时脚本间接创建0600副本，用既有ensureSettings对副本应用真实template，再内部逐字段比较；本机仅授权extensions/defaultTools的新增项。若副本同时改变subagents/packages或其他非本任务字段，禁止将整个结果回写，改用临时脚本仅合并本任务extensions/defaultTools。确认后原子回写这两个非敏感字段，并内部比对enabledModels及其他字段严格相同，输出只含字段名与是否相等；禁止直接打印整个settings。此步骤不安装、不热重载；现有Host继续运行，新配置下次fresh生效。
- [x] **步骤5：相关回归。**`node --test test/ensure-pi-settings.test.mjs test/mcp-policy-owner-loading.test.mjs test/joint-upgrade-tool-policy.test.mjs test/joint-upgrade-model-only.test.mjs`。验证allowed本地fixture阳性/forbidden执行0与models:false不变。显式operator +builtin引起警告时不伪称无warning；记录实际生效配置边界。


**F5验收证据：**owner continuation `1ec6607d-e070-49a2-8269-c2ba70f4b966` 15/15；main发现测试依赖arena且currenttemplate为literal后补派 `2330e195-b9d8-44c9-b748-4885cc6b5169`，最终 `/tmp/f5-3a0bc04e.log` **15/15，0fail/0skip**，真实模板资源加载、旧literal对照warnings、synthetic create/open及唯一owner覆盖。当前测试不依赖tmp/candidate mandatory fixture。main核对本机resources已有全部目标排除，因此未做配置回写；enabledModels不变，不将整个ensure结果（可能改变外部r2c注册）写回本机。并行r2c adapter源码/测试增量不是本轮变更，保持原样并交F6记录来源边界。F5验证资源释放，F6接管。

## F6：一次聚焦整体验收与交付账本

**Deps：**F1、F2、F3、F4、F5（只消费各任务diff、GREEN和配置生效事实）。
**WritePaths：**
- `docs/bugs/2026-10-08-pi-1.0.2-production-trial-issues.md`
- `docs/investigations/2026-10-08-pi-production-trial-root-causes.md`
- `docs/plans/records/2026-10-08-pi-trial-fixes/acceptance.md`
- `docs/plans/2026-10-08-pi-production-trial-fixes.md`（仅主agent负责步骤状态和证据链接，不授予F6子任务写权限）
**Resources：**自有TUI/session/stdio fixture，串行验证；无需真实模型/付费child。
**Files：**仅文档记录，不新增production验收runner或改非相关测试。
**接口契约：**Produces每项 `{scope,redLog,greenLog,files,node,limitations}`、保护hunk核对与fresh生效说明。未通过/缺证据明确记未完成。

- [x] **步骤1：diff和门禁核对。**确认所有源码仍在WritePaths；原始消息、toolResult、event、session不为显示被改写；没有新completion sender/authority、provider fallback、依赖升级。F4只是display roster，F5资源字段唯一owner。
- [x] **步骤2：只跑一次当前Node聚焦集合。**命令：

```bash
"$NODE_CURRENT" --test --test-concurrency=1 \
  test/pi-subagents-compat.test.mjs \
  test/subagent-model-selection.integration.mjs \
  test/subagent-completion-notices.test.mjs \
  test/subagent-compact-rendering.test.mjs \
  test/compact-tools-error-visibility.test.mjs \
  test/subagent-session-browser.test.mjs \
  test/ensure-pi-settings.test.mjs \
  test/mcp-policy-owner-loading.test.mjs
```

使用上方完整白名单env，不能裸运行继承真实HOME。最低Node仅跑三个新增测试文件（completion-notices、compact-tools-error-visibility、mcp-policy-owner-loading）加F1/F4实际新增用例，必须分为两个命令：

```bash
# 三个新增文件完整执行，不加名称过滤。
"$NODE_MIN" --test --test-concurrency=1 \
  test/subagent-completion-notices.test.mjs \
  test/compact-tools-error-visibility.test.mjs \
  test/mcp-policy-owner-loading.test.mjs

# 名称过滤只作用于这三个既有文件。
"$NODE_MIN" --test --test-concurrency=1 \
  --test-name-pattern='F1|repository admission list|profile omission|canonical|facade' \
  test/pi-subagents-compat.test.mjs \
  test/subagent-model-selection.integration.mjs \
  test/subagent-session-browser.test.mjs
```

F1补齐用例已使用上述名称，不沿用未命中的中文pattern。不要把未命中pattern的0项通过当验收，不重复升级矩阵。任一长测超60秒先检查资源/选择，不延长。

**F6 首轮验收偏差记录：**run `e1126ddc-8634-43c4-87bf-f3c2552e7a73` 当前Node聚焦集合176/176有效；最低Node错误地将同一pattern用于六文件，51个通过项含三个 `1..0` 空文件占位，只有48个实际匹配用例，不能证明新增三个文件通过。主agent已派 `1ec02236-1662-4bc6-ba7a-354c7c907cd9` 仅补跑新增三文件（无pattern），不重跑current集合或匹配用例。静态检查四个Node/config组合均通过，但current root实际执行两次，总计五次 `--noEmit`，记录一次预算重复偏差，不声称四次执行。
- [x] **步骤3：静态覆盖核对与两Node检查各一次。**先运行一次 `node node_modules/typescript/bin/tsc --listFilesOnly -p tsconfig.json`（只读解析、不重复类型检查），将输出存ARENA/evidence，并精确检查包含 `pi/extensions/compact-tools.ts` 与 `scripts/ensure-pi-settings.ts`；缺任一项不得宣称静态门禁通过。F3独占tsconfig已补齐这两入口，F5不能重复编辑同一配置。随后两版Node在白名单环境各执行 `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` 及 `-p packages/pi-subagents-enhanced/tsconfig.json`。无需npm安装/verifier重新打包；新增module的相对import在package内自包含。
- [x] **步骤4：自有fresh TUI短验证。**复用F2/F3真实InteractiveMode/ToolExecutionComponent测试，不额外启动同功能duplicate smoke。验收list非空、人工catalog首位进入wire、completion可见但model回合数不增、toolCall-only错误可见、Option+O canonical名单、fresh/resume资源warnings无误。保留原始数据deepEqual；明确人工catalog不证明真实Astra网络可用性。
- [x] **步骤5：交付。**更新六项状态与provenance证据，T3记用户暂关闭，T5上游原因记out-of-scope；保留尚未授权的paid模型/用户旧Host不变说明。核对index未被本任务修改、原dirty未丢、owned测试资源已关闭。需要用户fresh启动才能消费修复；不自动重载现有Host，不commit。


**F6验证与文档交付已验收：**currentNode8file **176/176，3.078秒**；minimumNode首轮仅48个实际pattern用例（另3个空文件占位不得计），接续 `1ec02236-1662-4bc6-ba7a-354c7c907cd9` 无过滤new3file **57/57，7.494秒**，0fail/0skip。正确new3日志已整合到权威ARENA/evidence/f6-min-new3files.log；首次手工Host根误填造成import-only失败，属于分类2测试环境污染，无production调用/修复，诊断从ownedtoolresult保留为f6-min-new3files-invalid-env-diagnostic.json。该接续任务错误选择了非指定arena，并执行/tmp限定目录扫描，属于执行范围偏差，不重复扫描/测试，主agent只按已知文件路径归集证据。listFilesOnly为1418路径行加1人工总结行（总1419）；四个Node/config组合5次noEmit均通过。source9hash与current相符、staging空。仅doc接续 `2641e0e0-c562-4938-99c9-c749b4a4d28e` 校正交付路径/计数和保留F1–F5证据，不能再跑任何验证；其落盘文档由main读验收，纠正日志文件名与F1–F5职责映射后接受。该doc-only run因commandsRun为空被harness拒绝，属于报告门禁，不是实现或测试失败；不为满足格式继续执行命令。

## 完成、停止与回退边界

- **计划完成：**本文路径/接口/步骤/验收自检通过；不表示代码修复完成。
- **修复完成：**六项均有准确RED→GREEN、原始数据不变与各任务必要回归，F6通过；T3不占据未完成门禁。
- 任一问题出现无法证明production来源的异常，保留现场、按数据来源门禁分类，不增fallback。
- F2不能在不改原消息/不新session entry的条件下显示时，停在该任务并报告公开UI限制；不得转为伪造通知。
- F4关系不完整时保留显示记录，不凭title/text删除；metadata污染不能用“去重”掩盖。
- 配置显式override、外部dirty变化、Node/physical root不匹配均为停止点；不操作用户正在运行的旧会话。
- 本轮不设计新rollback框架。代码基线仍仅 `pi-config-0.87.1`，它不含dirty与runtime状态；不因显示问题自动回滚整个升级。

## 一次 reviewer 审阅与计划修订

审阅 run：`2456b0df-a46d-4d43-b6e0-c250383a0be6`。审阅冻结版本 SHA-256：`d8521c68cb21ae57cd732cc8e7dfa711e3cbc0948942de0d968f0e6cda1f36ba`。

结论为**整体方案可行、需调整；0 Critical、3 Important、2 Minor**。主agent对照实际源码后只修订本文，未执行修复，也未派第二轮review。

| 建议 | 采纳与定位 | 后续执行证据 |
|---|---|---|
| Important 1：static check漏production入口 | F3独占tsconfig，精确增加compact-tools与ensure入口；F0保护配置 | F6的listFilesOnly覆盖核对和两Node noEmit |
| Important 2：以后init仍抵消显式override | F5必改ensure/check共同冲突检查；冲突在写入前失败；不靠一次性人工merge替代长期入口 | selector相反、已有双token、template矛盾的行为RED/GREEN，目标字节不变 |
| Important 3：canonical去重缺淘汰合同 | F4关系组件一致淘汰、保护活跃/selected依赖root、无永久墓碑 | 两个超过20 raw terminal run的纯内存测试、hydrate与后续step轮询 |
| Minor 1：baseline遗漏新增路径/文档 | F0从任务WritePaths汇总，新增hash=null，排除自身产物/settings正文 | declaredWritePaths全集与保护清单核对 |
| Minor 2：root fixture不贴近官方placeholder | F4使用agent:workflow started→reviewer status step→actual leaf演化 | 两种顺序、placeholder选中迁移及真实映射测试 |

修订后计划主agent已自行核对 DAG/WritePaths/预算；**这不是 reviewer 对修订版再次通过的声明**。实施时依然必须观察准确RED，不以本次静态审阅替代行为验收。

**编写记录：**计划由主agent inline 编写/修订，已加载writing-plans/writing-skills/TDD，纯文档TDD豁免。一次readonly reviewer建议已纳入，未追加第二轮审阅。用户随后选择Subagent-Driven，现进入F0基线阶段；任务状态/证据随实际完成更新，不将派发回执当完成。

## 最终执行结论（2026-10-08）

**已完成：F0–F6 全部步骤已验收。**T1、T2、T4、T5、T6、T7 均在授权范围完成修复；T3按用户意见暂关闭，T5仅修renderer错误可见性，上游断流原因保持out-of-scope。最终交付：`docs/plans/records/2026-10-08-pi-trial-fixes/acceptance.md`。

- 当前Node26.8.1八文件一次聚焦集合 **176/176**。
- 最低Node22.19.0新增三文件无过滤 **57/57**；F1/F4 **48** 个实际pattern用例通过（旧聚合另3空文件占位不作为病例）。
- root/enhanced的两个Node配置组合全部通过；实际 **4 unique组合、5次noEmit**（current root重复一次）。listFilesOnly的1418路径行含两个新增入口，另1人工总结行不计源码。
- main核对source9hash未变化、三文档证据链接、空index与原始数据renderer边界；最后文档整合未再运行测试。所有已派任务均已结束，无等待队列或活跃测试资源；证据保留，不清理用户Host/会话。
- 本机资源字段已达目标，本任务未回写整份settings；enabledModels及外部r2c配置/实现保持。未commit/push、安装、热重载或进行paid产品canary。
- **须fresh Host消费代码与模板变化；现有旧Host不自动生效。**不扩大为全局Pi切换或历史升级文档收尾。
