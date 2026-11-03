# Pi 远端更新与 provider 参数迁移诊断

记录时间：2026-11-03（本机时区 +08:00）。工作区：`/Users/leshi.zhy/pi-config`。任务：`dispatch-5a5e948c`。

## 结论与范围

本阶段仅执行本地只读调查并生成本报告。未执行 Git fetch/pull/merge、Pi 更新、网络模型请求、配置迁移、凭据读取、测试新增或提交。唯一写路径为 `docs/reports/pi-provider-update-diagnosis.md`。

已确认三项关键事实：

1. 初始工作区干净，`main` 跟踪 `origin/main`，本地缓存的上游与 HEAD 一致；尚未联网，不能声称远端没有新提交。
2. Pi 1.4.0 支持 `pi update --models` 刷新目录，但它会访问全部 provider 的凭据，并可能刷新、保存过期 OAuth 凭据。当前阶段不能执行。源码提供的公开目录 HTTP 地址可用于后续无凭据获取参数。
3. codex-pool 现有两模型均采用 `openai-responses`。Sol 的 700,000 上下文与安装包定义 272,000 不一致；Astra 缺少思考档位映射，使 `xhigh`、`max` 在当前配置下折算为 `high`。这些是配置与本地权威定义的差异，不能代替网关实际兼容性证据。

经主管确认，后续迁移范围按“保留 codex-pool 标识与现有两模型，以刷新后的内置 openai 定义逐字段比较并同步非敏感参数”收敛。“各档位”优先指 thinking levels，并同时记录上下文与价格 tiers。现有网关专用 thinking/sampling 参数没有等价证据时保留；不新增模型，不改协议、连接或认证配置。本报告提出候选变更，不代表这些变更已实施或已获网关兼容性验证。

## 规范与文档证据

已先完整阅读 `.agents/skills/manage-providers/SKILL.md`，并检查同目录 `manage-providers.py` 的读取与写入边界。该工具的 `list` 会打印原始 base URL、header 名及 metadata 标识；为避免这些本机信息进入日志，本次选用合同允许的内存脚本，仅投影 codex-pool 的模型白名单字段。没有直接 read 本机 `models.json`，没有打开任何凭据文件，也没有解析认证值或运行其中可能存在的命令。

现场规范已读取：`AGENTS.md`、`pi/AGENTS_SHARED.md`。关键约束包括：配置根目录为 `pi/`；禁止新增测试；禁止覆盖 dirty 现场；本机模型文件已忽略且不提交；`enabledModels` 属于本机配置，不得提交；npm 仅用官方源。

以下 Pi 文档均已完整读取（以 `node_modules/@earendil-works/pi-coding-agent/` 为前缀）：

- `README.md`。
- `docs/models.md`、`docs/models-configuration.md`、`docs/providers.md`、`docs/custom-provider.md`。
- 与目录位置、刷新命令、档位设置、运行副作用相关的交叉引用：`docs/configuration.md`、`docs/cli.md`、`docs/settings.md`、`docs/security.md`、`docs/environment-variables.md`、`docs/quickstart.md`、`docs/packages.md`。
- `node_modules/@earendil-works/pi-ai/README.md` 全文，包括静态目录查询、provider refresh、thinking、兼容性与旧 API 迁移说明。

本阶段不实施扩展、SDK 集成或 TUI 改造；未将文档中的示例凭据操作、MCP 操作或建议测试当作执行授权。

## 工作区与安全拉取条件

| 项目 | 现场证据 |
| --- | --- |
| 仓库根目录 / Git 公共目录 | `/Users/leshi.zhy/pi-config` / `.git` |
| 分支与上游 | `main` / `origin/main` |
| HEAD 与本地缓存上游 | 均为 `779d466`，提交日期 2026-11-02 |
| 提交主题 | `fix(subagents): 使用内核锁修复异常退出后的锁残留` |
| ahead / behind | `git rev-list --left-right --count HEAD...@{upstream}` 输出 `0 0` |
| 远端 | `origin`，SSH 形态，主机 `github.com`；用户名、仓库路径已省略 |
| branch 配置 | remote=`origin`，merge=`refs/heads/main` |
| fetch refspec | `+refs/heads/*:refs/remotes/origin/*` |
| 本地其他远端跟踪引用 | `origin/archive/plan-runner-before-removal-20260805`、`origin/feat/goal_engine` |
| FETCH_HEAD 文件时间 | 2026-11-02 16:59:39 +08:00，仅代表本地记录时间 |
| shallow | `false` |
| 初始工作区 / 暂存区 | `git status --short --branch` 仅显示分支；两种 diff 名称列表为空 |
| 未完成 Git 操作 | 未发现 MERGE_HEAD、CHERRY_PICK_HEAD、REVERT_HEAD、rebase-merge、rebase-apply、index.lock |
| 本机模型 / 目录缓存 | `pi/models.json` 未跟踪且被忽略；`.gitignore:48` 忽略 `pi/models-store.json`，`:54` 忽略 `pi/models.json` |

报告落盘后工作区会新增本报告，不能继续沿用“完全干净”的初始判断。应保留该文件并检查与远端路径是否冲突，不自动 stash、reset、clean、提交或覆盖。

下一阶段获授权后的建议操作如下，每一步成功并审阅后再执行下一步；本报告未执行这些写操作：

```bash
cd /Users/leshi.zhy/pi-config
git status --short --branch
git diff --cached --name-only
git fetch --no-tags origin refs/heads/main:refs/remotes/origin/main
git rev-list --left-right --count HEAD...origin/main
git log --oneline HEAD..origin/main
git diff --stat HEAD..origin/main
git diff --name-only HEAD..origin/main
git merge-base --is-ancestor HEAD origin/main
git rev-parse origin/main
```

该单分支 fetch 不带强制 `+`；若远端改写导致引用更新失败，应停下决策。fetch 后应固定已审阅的上游完整 SHA，再执行 `git merge --ff-only <已审阅的完整SHA>`，以避免再次拉取未经审阅的新提交。用户若要求直接 pull，可用 `git pull --ff-only origin main`，但需重新检查其实际获取的目标。

合并前必须同时满足：当前分支与 HEAD 未被并发改变；上游是当前 HEAD 的后继；工作区修改及未跟踪报告不会被覆盖；远端未重新跟踪 `pi/models.json` 等本机文件；远端指令、依赖、锁文件、启动入口与 provider 相关变化已完成针对性审阅。若出现分叉、dirty 冲突、忽略文件碰撞、权限或凭据提示，停止相应操作，不推断如何清理。不能用当前 `0 0` 代替联网后的 ancestry 检查。

依赖安装应由拉取后的实际 diff 决定。若确需按 lockfile 重装，可审阅后使用 `npm ci --ignore-scripts --registry=https://registry.npmjs.org/`；它会修改 `node_modules/`，不是本阶段动作，也不等价于升级 Pi 版本。

## Pi 版本与刷新权威入口

`package.json` 将 `@earendil-works/pi-agent-core`、`pi-ai`、`pi-coding-agent`、`pi-tui` 均锁定为 `1.4.0`。本机 `node_modules/@earendil-works/pi-coding-agent/package.json` 与 `pi-ai/package.json` 也均为 `1.4.0`。Node 实测 `v26.8.1`，满足项目最低 `>=22.19.0`。未调用可能触发初始化的完整 Pi 进程；版本结论来自实际包清单，不代表 PATH 中任意全局 `pi` 的版本。

`docs/models.md` 说明目录由 bundled catalog 起步，叠加 pi.dev 新数据；`docs/cli.md` 区分以下命令：

| 目的 | 受支持入口 | 对本任务的意义 |
| --- | --- | --- |
| 更新 Pi 程序 | `pi update` | 不是仅刷新模型元数据；本仓固定依赖需单独审阅版本与 lockfile |
| 刷新目录 | `pi update --models` | 正式 CLI 入口，但有下述凭据与缓存副作用 |
| 更新安装的扩展包 | `pi update --extensions` | 与本次两模型元数据同步无直接关系 |
| 重载自定义模型 | 交互 `/model` | 会重读模型文件，也可能后台刷新目录，不是本阶段安全探针 |
| 读取安装包静态定义 | `getBuiltinModel()`，从 `@earendil-works/pi-ai/providers/all` 导入 | 已验证，无需创建配置运行时或解析凭据 |

源码调用链：

1. `node_modules/@earendil-works/pi-coding-agent/dist/package-manager-cli.js:536` 的 `refreshModelCatalogs()` 创建 `ModelRuntime`，显式传入 agent 目录内的凭据文件和模型文件路径，随后 `refresh({allowNetwork:true, force:true})`，超时 15 秒。没有单 provider CLI 选择参数。
2. `dist/core/model-runtime.js:79` 创建配置与 `FileModelsStore`，并给静态内置 provider 包装远端目录；`:590` 重载模型配置、刷新目录、再更新可用性快照。
3. `node_modules/@earendil-works/pi-ai/dist/models.js:180` 对可刷新的 provider 读取凭据，恢复缓存，再解析刷新凭据；`:237` 后的逻辑会刷新过期 OAuth 并保存；无可解析凭据时跳过联网。因此成功提示也不能单独证明 openai 实际获取了新目录。
4. `node_modules/@earendil-works/pi-coding-agent/dist/core/models-store.js:30` 默认缓存路径为 `<agent-dir>/models-store.json`，本机对应 `pi/models-store.json`，写入带锁。
5. `dist/core/remote-catalog-provider.js:57` 的请求地址为 `https://pi.dev/api/models/providers/openai?types=chat,image,classifier`；请求只需公开目录读取，不携带 provider 认证。`:50` 仅在远端 Last-Modified 晚于本地生成时间时将远端作为覆盖；正常刷新间隔 4 小时，强制刷新绕过新鲜度检查，支持 ETag/304。

故本机运行 `PI_CODING_AGENT_DIR=/Users/leshi.zhy/pi-config/pi node node_modules/@earendil-works/pi-coding-agent/dist/cli.js update --models` 可能写缓存和凭据，并访问不止 openai 的动态目录；不能作为“仅查询参数”的命令。本阶段没有执行它，也不建议为了绕过该问题临时注入假凭据。

### 无凭据替代路径

下一阶段仅需获取权威参数时，直接用不附带认证信息的 HTTP 客户端 GET 上述固定 pi.dev 公共目录，在内存中解析、验证 provider/model/type 并投影模型白名单字段即可。无需加载 `ModelRuntime`、查询模型可用性、访问私有网关或执行认证命令。建议命令形态：

```bash
node --input-type=module
```

在该 Node 进程内调用 `fetch('https://pi.dev/api/models/providers/openai?types=chat,image,classifier', {redirect:'error', signal:AbortSignal.timeout(15000)})`，检查 HTTP 成功、模型 ID 与类型，保留 Last-Modified/ETag 元信息，按安装版本 `remote-catalog-provider.js` 的解析及时间规则与 bundled 合并；只打印本报告列出的非敏感模型字段。此处为后续操作说明，本阶段未发出 HTTP 请求或写临时脚本。

公开 GET 能获取权威参数，但不会刷新本机 Pi 缓存。若下一阶段要求实际刷新内置 openai 缓存，需明确授权 `pi/models-store.json` 及锁/原子替换临时文件写路径，并选择经审阅的单 provider、无凭据持久化实现；不得把手工抓取数据误报为正式 CLI 刷新完成，也不得直接把原始 HTTP 响应覆盖整个 store。当前未发现公开文档提供“仅 openai、完全不读取凭据”的 CLI 选项。

## 参数权威来源与缓存时效

安装包静态元数据入口为 `node_modules/@earendil-works/pi-ai/dist/providers/openai.models.js`，它从 `dist/providers/data/openai.json` 生成 chat、image、classifier 模型；本次通过公开静态 API 读取 chat 模型，而非从名称猜测参数。

`getBuiltinModelDataGeneratedAt()` 实测返回 **2026-10-21T22:33:24.994Z**。通过只读内存脚本投影的本机 `pi/models-store.json` 中 openai 项：

- `checkedAt = 1792650332904`。
- `lastModified = 1792068059000`，早于 bundled 生成时间。
- 缓存内两目标模型的上述参数与 bundled 对应参数一致。

依据 `remote-catalog-provider.js:50`，该旧缓存不会覆盖新版 bundled。因此下文是本机安装版本基线，不是在线最新状态。最终迁移必须重新获取目录，记录时间并比较后再决定。

### 两模型的非敏感现状

JSON 路径精确限定为：

- `providers["codex-pool"].models[id="gpt-6.1-sol"]`。
- `providers["codex-pool"].models[id="gpt-6-astra"]`。

provider 级 API 为 `openai-responses`，无 provider 级 compat，无 modelOverrides；本机没有 openai provider 配置覆盖。两模型均 `reasoning=true`，输入为 `text,image`。

| 字段 | codex-pool Sol | codex-pool Astra | 内置 openai 同名模型基线 |
| --- | --- | --- | --- |
| name | GPT-6.1 Sol | GPT-6 Astra | 分别相同 |
| contextWindow | 700000 | 272000 | 两者均 272000 |
| maxTokens | 128000 | 128000 | 两者均 128000 |
| thinkingLevelMap | off=null；minimal=low；low/medium/high/xhigh/max 同名 | 缺失 | 两者均 off=null、minimal=null；low/medium/high/xhigh/max 同名 |
| samplingParams | 缺失 | 缺失 | 两者均缺失 |
| samplingParamsByThinkingLevel | off={}；其余每档有 reasoning.effort 与 summary=detailed，minimal 的 effort=low | 缺失 | 两者均缺失 |
| inputLimits | 缺失 | 缺失 | 两者均含下述输入限制 |
| promptCache | 缺失 | 缺失 | 两者均缺失 |
| compat | grammar/additional tools/tool search/mid-conversation system 四项 true | 缺失 | 两者均含这四项，并另有 strict、explicit prompt cache、mid-conversation effort 三项 true |

内置输入限制：`maxRequestBytes=536870912`；`images.maxPerRequest=1500`；`images.resize` 为宽 2000、高 2000、编码后大小 4718592、JPEG 质量 80。`docs/models.md` 明确 resize 会影响新图像编码，而部分请求硬限制目前只是描述元数据；不能声称新增这些字段就能拦截所有超限请求。

内置 compat 的完整字段名：`supportsStrictMode`、`supportsOpenAIGrammarTools`、`supportsAdditionalTools`、`supportsToolSearch`、`supportsMidConvoSystemMessages`、`supportsExplicitPromptCacheMode`、`supportsMidConvoEffort`。现有 Sol 缺少第一、第六、第七项；Astra 全部未显式配置。它们改变实际 wire 行为，不能因为内置 openai=true 就批量开启在私有网关上。

### 各 thinking 档位实际含义

档位是推理强度选择，不是固定上下文容量、固定输出 token 数或付费套餐。`getSupportedThinkingLevels()` 与 `clampThinkingLevel()` 的代码位于 `node_modules/@earendil-works/pi-ai/dist/models.js:693`。`null` 表示不支持；`xhigh`/`max` 需要明确非空映射；缺失的普通档位默认允许。折算先向更高可用档位找，找不到才向下。

以下为实际导入这两个纯函数、输入现有模型定义得到的输出，并结合 Responses 映射逻辑列出发送值；未发送网络请求：

| 请求档位 | 当前 Sol：有效 Pi 档位 → effort | 当前 Astra：有效 Pi 档位 → effort | 内置两模型：有效 Pi 档位 → effort |
| --- | --- | --- | --- |
| off | minimal → low | off → none | low → low |
| minimal | minimal → low | minimal → minimal | low → low |
| low | low → low | low → low | low → low |
| medium | medium → medium | medium → medium | medium → medium |
| high | high → high | high → high | high → high |
| xhigh | xhigh → xhigh | high → high | xhigh → xhigh |
| max | max → max | high → high | max → max |

当前 Sol 的 `summary=detailed` 在 samplingParams 合并时覆盖 Responses 默认 `summary=auto`。内置若启用 `supportsMidConvoEffort`，还可能通过 `configuration_update` 承载档位，表中 effort 是逻辑请求值，不保证所有传输场景都直接写入顶层 `reasoning.effort`。

调用链证据：`dist/api/openai-responses.js:200` 先折算档位；`:290` 生成 reasoning；`:312` 最后以 samplingParams 覆盖请求字段。`dist/api/simple-options.js:11` 的优先级为模型默认、有效档位覆盖、请求级覆盖，按顶层 key 合并；reasoning 对象可整体覆盖，而非深合并。这解释了为什么不能未经证明就删除 Sol 的 sampling 配置，也不能同时盲拷贝 mid-conversation effort 开关。

`thinkingBudgets` 的默认数字 1024/2048/8192/16384 属于其他需要预算转换的路径，不能据此为 OpenAI 档位编造固定 token 预算。两模型的最大输出元数据均为 128000；实际可用输出还受剩余上下文与 API 行为约束，`simple-options.js:5` 会按估计上下文减去 4096 安全余量再裁剪。

相关使用者：`pi/agents/delegate.md:5` 指向 codex-pool Astra，thinking=high；`pi/agents/reviewer.md:5` 指向同模型，thinking=xhigh。因此 reviewer 的名义 xhigh 与当前可用档位确有配置不一致风险。未启动真实 reviewer 验证，也未修改 agent 文件。

### context 与 cost tiers

以下价格单位均为美元/百万 token，当前 codex-pool 与 bundled 的价格定义相同；它们是 Pi 估算值，不证明网关实际结算价格。

| 模型 / 输入阈值 | input | output | cacheRead | cacheWrite |
| --- | ---: | ---: | ---: | ---: |
| Sol 基础 | 2 | 10 | 0.1 | 2.5 |
| Sol 总输入 >272000 | 4 | 15 | 0.2 | 5 |
| Astra 基础 | 10 | 50 | 1 | 12.5 |
| Astra 总输入 >272000 | 20 | 75 | 2 | 25 |

`dist/models.js:672` 将 usage.input、cacheRead、cacheWrite 相加，选择最高满足严格大于阈值的 tier，并对整次请求应用该档价格。价格 tier 不能证明模型允许更大上下文；即使内置 contextWindow=272000 仍存在上述 tier，也不能据此把上下文扩大为 700000。

## 精确迁移范围与建议取舍

后续配置写入只针对 `pi/models.json` 中上述两个模型对象的已审阅字段，使用带锁、原子替换及并发变化检测的方式。不能整体重建 provider，不能使用 skill 的 `remove-provider` 再添加：该命令会联动修改凭据，且容易丢失现有连接设置。现有 skill 的 `add-model` 也不足以表达完整 thinking、compat、cost tiers；应选可保留未知字段的定点更新方式，工具能力不足时先上报。

| 字段组 | 后续建议 | 当前可实施性 |
| --- | --- | --- |
| `id`、provider 标识、API、连接/认证相关字段 | 保留原值与两模型集合 | 无需迁移 |
| `name`、`reasoning`、`input`、`maxTokens` | 对比刷新后定义；仅有差异时同步 | 当前与 bundled 相同，无必要 diff |
| `cost`（含 tiers） | 对比刷新后定义；明确采用 Pi 目录估算值 | 当前相同，无必要 diff |
| Sol `contextWindow` | 700000 与基线 272000 冲突，优先取得新目录与网关上限证据 | 未决，不自动改大或改小 |
| Astra `contextWindow` | 当前 272000，跟随新目录比较 | 当前无需 diff |
| Astra `thinkingLevelMap` | 候选补入刷新后权威映射，恢复 xhigh/max 可选，禁用不受支持的 off/minimal | 需确认网关接受对应 effort；仅目录证据不能保证网关接受 |
| Sol `thinkingLevelMap`、`samplingParamsByThinkingLevel` | 保留现有 minimal→low 与 detailed 策略 | 无等价证据不得覆盖或删除 |
| `samplingParams` | 当前两模型均无值，不新增猜测参数 | 无必要 diff |
| `inputLimits` | 可作为新增候选逐项比较，区分编码行为与仅描述的限制 | 新目录与网关限制确认后再采用 |
| `compat` | 保留 Sol 现有四项；Astra 及其余新开关逐项验证 | 禁止全量复制内置值 |
| `promptCache` | 两模型基线均未提供，不虚构生命周期 | 当前无必要 diff |

不写 `pi/settings.json`、agent 定义或生产代码。当前本机 `enabledModels` 含 `codex-pool/gpt-6.1-sol`，保留 provider ID 可避免改模型选择引用；`enabledModels` 仍不得提交。已有 `src/provider-fallback/provider.ts:4` 文案提及 codex-pool→openai-codex，但本阶段没有把该文案当作活跃配置证明，也不改变 fallback 行为。

若另行决定把 provider 重命名为 openai、切换到 OpenAI 官方连接，或迁移到旧 `openai-codex` provider，将涉及 agent 引用、模型选择、认证归属和请求传输变化，超出已确认范围。`pi-ai/README.md` 已将 `openai-codex` 标为 legacy，不能仅因 codex-pool 名称包含 codex 就改协议为 `openai-codex-responses`。

## 后续写路径与停止条件

| 阶段 | 需要声明的写路径 / 副作用 |
| --- | --- |
| 本次诊断 | 仅 `docs/reports/pi-provider-update-diagnosis.md` |
| Git fetch + fast-forward | Git 对象与引用、FETCH_HEAD，以及已审阅提交涉及的受管文件；须在主会话授权范围执行 |
| 公开目录内存读取 | 无文件写入；只发公开 HTTP GET，不访问 provider 凭据 |
| 真正刷新目录缓存 | `pi/models-store.json` 及锁、同目录原子临时文件；不得写其他 provider 缓存或认证文件，除非另有授权 |
| 两模型参数迁移 | `pi/models.json` 及锁、同目录原子临时文件；本机忽略文件，不提交 |
| Pi 程序升级（若远端依赖变更要求） | `package.json`、`package-lock.json`、`node_modules/` 等，需根据实际 diff 单独确认范围 |

需要保留回滚材料时，模型配置可能混有敏感字段，不能输出整个文件或把完整备份放入 Git。本阶段未创建备份；后续备份位置与访问权限须在写路径中明确，并由安全脚本处理。遇到认证要求、权限失败、模型 ID 缺失、目录格式变化、远端参数与网关事实矛盾、写路径不足或并发配置改写，应停下相关操作报告，不猜测兼容开关。

未决事项：在线 origin/main 的新提交及风险；当前 pi.dev 目录值与 Last-Modified；Sol 700000 的网关权威依据；Astra 对 xhigh/max 及 off/minimal 的真实接受情况；新增 compat/inputLimits 的网关支持；是否需要实际持久化缓存。上述问题不阻塞本地诊断报告完成，但会限制后续可自动迁移的字段。

## 已执行验证与证据边界

- Git 状态、upstream、refspec、已有远端跟踪引用、ahead/behind、忽略规则及未完成操作标记均为本地只读检查；暂存列表为空。
- Node 公共静态 API 成功返回两模型定义与 bundled 生成时间；未创建 ModelRuntime，未使用 getAvailable/getAuth。
- 内存白名单脚本成功提取 codex-pool 定义及 openai 缓存时间；未输出 base URL、header、认证或 metadata 字段。
- 实际运行纯函数验证了 Sol `off→minimal` 与 Astra `xhigh/max→high`；这不是远端请求验收。
- 对刷新入口、缓存路径、时间覆盖规则、档位及采样合并路径完成源码核对。两次探索性 rg 使用了不存在的猜测路径，返回缺失文件错误；随后定位并读取真实 `package-manager-cli.js` 与 `model-runtime.js`，未依赖失败搜索得出结论。
- 未新增或修改测试，未运行真实业务验证；本阶段不声明拉取、在线刷新、网关兼容性或迁移已经完成。
