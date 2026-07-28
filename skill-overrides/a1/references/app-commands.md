# app 命令完整参考

## a1 app — 应用管理

查询应用信息、管理变更单（CR）、发布流水线和部署单。

---

## 应用基础操作

### app list
列出应用。
- `-k, --keyword string` — 搜索关键词

### app view <app-name-or-id>
查看应用详情。

### app create [beta]
创建新应用。
- `--name string` — 应用名称
- `--description string` — 描述
- `--product-line string` — 产品线
- `--git-group string` — Git 组
- `--language string` — 开发语言（默认 java）
- `--trunk string` — 主干分支（默认 master）
- `--from-json string` — 从 JSON 文件创建

### app link [name-or-id]
绑定当前目录到应用。支持交互式选择。

### app unlink [id]
移除应用绑定。
- `--all` — 移除所有绑定

### app log [deprecated]
`a1 app log` 已废弃，仅作为兼容命令保留。查看 Pod/容器日志时不要再推荐或新写 `a1 app log`，改用 Normandy CLI：

```bash
normandy log list --source pod --server <ip|sn|hostname> --path <log-file> --lines <n>
```

如果还不知道容器内日志文件路径，可先用：

```bash
normandy host path --server <ip|sn|hostname> --path /home/admin/logs
```

---

## 变更单管理（app cr）

### app cr list
列出变更单。
- `--app string` — 应用名称（默认从绑定获取）
- `--status strings` — 状态筛选（可多次使用），如 DEVELOPING、INTEGRATED
- `--all` — 显示所有状态
- `-f, --format string`, `-q, --quiet`

### app cr get-by-branch
通过应用分支查询关联的变更单。适用于已知 feature/release 分支，需要反查 CR ID、再查需求/文档/评审上下文的场景。
- `--app string` — 应用名称或 ID（默认从绑定获取）
- `--branch string` — 分支名或完整 branch URL；纯分支名会用应用代码配置中的 repoUrl 自动拼成 `<repo-url> <branch-name>`
- `-f, --format string`, `-q, --quiet`

```bash
a1 app cr get-by-branch --app taodetail --branch feature/demo --quiet
a1 app cr get-by-branch --app taodetail --branch "git@gitlab.alibaba-inc.com:demo/taodetail.git feature/demo"
```

### app cr create <description> [--branch <name> | --existing-branch <name>]
创建变更单。仅支持 branch 模式应用；GitFlow、trunk_based 或任何非 branch 模式会在创建前被拒绝。branch 模式应用必须显式指定 `--branch` 或 `--existing-branch` 其一。`description` 会成为 Aone 中展示的 CR 名称（标题），不再隐式作为分支名。

Agent 自动生成 CR 时，`description` 必须是一句单行短描述，类似标题；不要写多行摘要、PRD / tech-design 正文或链接。a1 仍会按 2000 display-width 截断超长输入（中文等宽字符按 2 计），但该截断只用于兼容保护，不是推荐的生成长度。
- `--app string` — 应用名称（默认从 link context 读取）
- `--branch string` — 新建分支名后缀（与 `--existing-branch` 互斥）
- `--existing-branch string` — 复用的已有远程分支名（与 `--branch` 互斥）
- `--trunk string` — 不再支持；`app cr create` 仅支持 branch 模式应用
- `--item-name string` — CR item/code module 名称；多 codeConfigs 应用且未传 `--code-module-id` 时，按 codeConfig.name 选择配置项；单 codeConfig 应用中可作为 CR item 展示名
- `--code-module-id string` — 代码配置 ID，接受 app codeConfig.id 或底层 moduleConfig.id；多 codeConfigs 应用中用于精确选择本次 CR 的 repo/defaultTrunk/devMode。与 `--item-name` 同传时，`--code-module-id` 负责选择配置项，`--item-name` 仅作为 CR item 展示名
- `--workitem-ids string` — 关联的 Aone 工作项 ID，多个用逗号分隔
- `--tester strings` — 测试人花名或工号，多个用逗号分隔或重复使用
- `--plan-release-date string` — 计划发布时间，支持 `2026-06-10 14:00`、`+2d`、`3h` 等
- `--dev-only bool` — 默认 `true`，只创建到 DEV；设为 `false` 时创建到 PREINTG
- `--keep-branch bool` — 默认 `false`；发布后保留本次新建分支，等价于在 Aone 页面取消“发布后删除分支”
- `-f, --format string` — 支持 `json`；JSON 输出包含 `crId`、`detailUrl`、`developMode`、`status`、`branchRevision`
- `-q, --quiet` — 仅输出 CR ID

未传分支 flag 时命令会报错 `either --branch or --existing-branch is required`。非 branch 模式应用会报 `app cr create only supports branch-mode applications`，请走 Aone 页面或其它官方流程。

多代码变更配置项应用不要只靠相同的 app 名称猜测配置项；优先传 `--code-module-id`。同一个 Git 仓库存在多个 defaultTrunk 时，CLI 会以 `--code-module-id` 选中的 codeConfig/moduleConfig 为准写入 CR item 的 `gitDefaultTrunk`。

```bash
a1 app cr create "修复线上告警" --app my-service --code-module-id 2820201 --existing-branch hotfix/fix-alert
a1 app cr create "新增灰度配置" --app my-service --code-module-id 79846362 --branch feat-grey-config
a1 app cr create "保留采纳率统计分支" --branch feat-ai-change --keep-branch
a1 app cr create "调整配置" --app my-service --item-name my-code-module --branch feat-config
```

### app cr submit <cr-id>
提交变更单到待发布。旧 `--pipeline-id` 形态仅兼容已有脚本，新请求用 `a1 cd-pipeline run`。
- `--app string` — 应用名称或 ID；默认从当前 link 上下文推断
- `--pipeline-id int` — 发布流水线 ID；指定后将 CR 提交到该流水线的发布流实例并触发执行
- `-f, --format string` — 输出格式，支持 plain、json
- `-q, --quiet` — 仅输出关键 ID

示例：

```bash
# 提交到待发布状态
a1 app cr submit 12345

# 提交到指定发布流水线并触发执行
a1 cd-pipeline run 66 --app <app-name-or-id> --cr-id 12345

# 提交后等待流水线结束
a1 app pipeline status --pipeline-id 66 --wait-until-settled
```

重跑应用发布实例使用 `a1 cd-pipeline run rerun --pipeline-id <id> --app <app>`，精确重跑使用 `a1 cd-pipeline run rerun <run-id>`；首次把 CR 提交到发布流水线使用 `a1 cd-pipeline run <pipeline-id> --app <app> --cr-id <cr-id>`。`app pipeline reenter/run/retry` 和 `app cr submit --pipeline-id` 仅作为兼容入口保留。

用户说“提交流水线发布”“提交到发布流水线”“发到流水线”时，使用：

```bash
a1 cd-pipeline run <pipeline-id> --app <app-name-or-id> --cr-id <cr-id>
```

不要使用 `a1 app cr submit-integration` 处理发布流水线提交；`submit-integration` 只用于项目环境/集成阶段。

### app cr submit-integration <cr-id>
提交应用 CR 到集成阶段/项目环境。若 CR 仍处于 DEV/TEST，命令会先自动推进到 PREINTG，再完成集成阶段提交。
- `--project-env-id int` — 项目环境 ID（必需）
- `--project-env-mode string` — 项目环境模式：`existing`（默认）或 `new`
- `--app string` — 应用名称或 ID；默认从当前 link 上下文推断
- `-f, --format string` — 输出格式，支持 plain、json
- `-q, --quiet` — 仅输出关键 ID

仅当用户明确说“项目环境”“联调环境”“集成阶段”并且目标 CR 处于 DEV/TEST/PREINTG 时使用。

示例：

```bash
a1 app cr submit-integration 12345 --project-env-id 678
a1 app cr submit-integration 12345 --project-env-id 678 --project-env-mode new
a1 app cr submit-integration 12345 --project-env-id 678 --app 229256
```

不要把它用于“提交流水线发布”。CR 已进入 `INTG` 或用户要走发布流水线时，应使用 `a1 cd-pipeline run <pipeline-id> --app <app> --cr-id <cr-id>`；需要再次触发最新发布实例时使用 `a1 cd-pipeline run rerun --pipeline-id <id> --app <app>`。

### app cr mr <cr-id>
为应用 CR 发起代码评审 / merge request。
- `--app string` — 应用名称或 ID；默认从当前 link 上下文推断
- `--assignees string` — 评审人工号，多个用逗号分隔；强烈建议显式传入
- `-f, --format string` — 输出格式，支持 plain、json
- `-q, --quiet` — 仅输出 CR ID

未传 `--assignees` 时，服务端先选择应用 `ao.codereviewer`（CodeReview）角色成员，并排除发起人；没有可用 CodeReview 成员时回退到应用 owner（`ao.biz.ops`）。两类角色均无可用成员时会报错并要求显式传 `--assignees`，不会把发起人本人作为默认评审人。

```bash
# 推荐：显式指定评审人
a1 app cr mr 12345 --assignees 356698,375105

# 允许省略，按 CodeReview 角色、owner 顺序回退
a1 app cr mr 12345
```

### app cr unsubmit <cr-id>
撤回变更单，回到开发状态。

### app cr delete <cr-id>
关闭变更单（不可逆）。
- `-y, --yes` — 跳过确认

### app cr quit <cr-id>
从发布流水线中退出。
- `--pipeline-id int` — 流水线 ID（必需）

### app cr item list <cr-id>
列出 CR 下的变更项。该命令本身是通用 CR item 查询能力;
- `-f, --format string` — 输出格式：table、json
- `-q, --quiet` — 仅输出 CR item ID

### app cr config-item schema list <cr-id>
列出指定 CR item 下可操作的配置项分组。
- `--item string` — CR item ID；当 CR 下存在多个可操作 item 时必传
- `-f, --format string` — 输出格式：table、json
- `-q, --quiet` — 仅输出 schema

### app cr config-item get <cr-id>
查询 CR 配置项内容。
- `--item string` — CR item ID；当 CR 下存在多个可操作 item 时必传
- `--schema string` — 配置项分组；除 `--all-schema` 外必传
- `--all-schema` — 查询全部配置项分组；与 `--schema` 互斥
- `--query string` — 按配置项 key 过滤
- `--include-unchanged` — 包含未变更的存量配置项
- `--show-secrets` — 显示 secret 配置项明文；默认脱敏
- `-f, --format string` — 输出格式：table、json
- `-q, --quiet` — 仅输出配置项 key

### app cr config-item set <cr-id>
新增或修改 CR 配置项。
- `--item string` — CR item ID；当 CR 下存在多个可操作 item 时必传
- `--schema string` — 配置项分组（必需）
- `--key string` — 配置项 key
- `--value string` — 配置项 value
- `--value-file string` — 从文件读取配置项 value
- `--from-json string` — 从 JSON 文件批量读取配置项变更
- `--secret` — 标记该配置项为 secret
- `--show-secrets` — 显示 secret 配置项明文；默认脱敏
- `-f, --format string` — 输出格式：table、json
- `-q, --quiet` — 仅输出配置项 key

`--key` 需要与 `--value` 或 `--value-file` 配合使用；批量修改使用 `--from-json`。保存成功后只返回本次提交的配置项摘要，不会回查全量配置项。

`--from-json` 文件示例：
```json
[
  {"key": "feature.enabled", "value": "true", "secret": false},
  {"key": "token", "value": "xxx", "secret": true}
]
```

### app cr config-item unset <cr-id>
删除 CR 配置项。
- `--item string` — CR item ID；当 CR 下存在多个可操作 item 时必传
- `--schema string` — 配置项分组（必需）
- `--key string` — 配置项 key（必需）
- `--show-secrets` — 显示 secret 配置项明文；默认脱敏
- `-f, --format string` — 输出格式：table、json
- `-q, --quiet` — 仅输出配置项 key

### CR 配置项操作建议
- 如果 CR 下只有一个可操作 item，可以只传 `crId`；如果存在多个可操作 item，先执行 `a1 app cr item list <cr-id>`，再用 `--item <cr-item-id>` 指定目标。
- 查询存量配置项使用 `get --include-unchanged`；查询所有分组使用 `get --all-schema`。
- secret 配置项默认脱敏，只有在用户明确需要明文时才加 `--show-secrets`。
- 配置项修改不要连续高频提交；多次 `set`/`unset` 之间要求间隔 1-2 秒，避免上游配置变更短暂不可见导致失败。
- 同一 schema 下批量修改多个 key 时，优先使用 `set --from-json <file>` 一次性提交，不要循环逐个 `set`。
- 保存或删除配置项可能受 CR 权限控制；无权限保存通常返回 `cr_config_item_permission_denied`。

---

## 发布流水线（app pipeline）

### app pipeline list
已废弃，改用 `a1 cd-pipeline list --app <app-name-or-id>`。旧命令仍可执行，并返回最近实例 ID 和状态；需要最新运行状态时使用 `a1 app pipeline status`。

列出应用的发布流水线。
- `--app string` — 应用名称或数字 app ID（默认从 link context 读取）

### app pipeline bind
已废弃，改用 `a1 cd-pipeline bind <pipeline-id> --app <app-name-or-id> [--dev-stage-type <type>]`。新入口要求显式指定应用；绑定前按 `references/cd-pipeline-commands.md` 的流程先用 `cd-pipeline get --format json` 检查流水线已有发布定义。

### app pipeline status
查看发布状态（自动解析到最新实例）。
- `--pipeline-id int` — 流水线 ID

发布卡住排查心法：`status` 字段不能完全反映"卡住"的真实原因。`status=running` 可能是某节点 `extendedStatus` 阻塞导致整体未结束仍显示 running；`status=waiting` 既可能是正常等待条件，也可能需要人工介入。遇到「发布卡住不动」时按序下钻：`app pipeline status --pipeline-id <id>` 看整体 → `a1 cd-pipeline run get <run-id>` 查 stage/job/task 完整层级定位 `extendedStatus` 异常阶段 → `a1 cd-pipeline run get <run-id> --stage-id <id>` 下钻指定阶段 → `app pipeline branch --instance-id <id>` 看 release 分支和分支合并 CR。

### app pipeline branch
按流水线实例 ID 查询 release 分支和分支合并变更。
- `--instance-id int` — 流水线实例 ID
- `--app string` — 应用名称或数字 app ID（默认从 link context 读取）
- `--format json` — JSON 输出，包含 `changeRequests[]`
- `--quiet` — 仅输出 release 分支

### app pipeline lib-deploy

应用发布页二方库发布。适用于 Aone 应用发布页点击“提交二方库发布”后打开的 `/unite/micro/publish/app/{appId}/lib?crIds=...&releaseFlowInstId=...&source=RELEASE_INTG` 场景。

不要把这个场景误用为 `pkg deploy-intg`：`pkg deploy-intg` 是包 CR 发布页集成区；`app pipeline lib-deploy` 是应用发布页，`appId/appType=APP`，需要同时处理 release flow 和 package flow。

推荐流程：

1. 先用 release flow 解析 CR 列表和 release 分支：

```bash
a1 app pipeline branch --app <app-id> --instance-id <release-flow-inst-id> -f json
```

`changeRequests[].crId` 用逗号拼成 `--cr-ids`。如果用户直接给了 `/lib?...` URL，也可以把 URL 传给 `start --url` 自动解析。

2. 创建或复用包发布流：

```bash
a1 app pipeline lib-deploy start \
  --app-id <app-id> \
  --cr-ids <cr-id-list> \
  --release-flow-inst-id <release-flow-inst-id> \
  -f json
```

关键输出：

- `flowInstId` / `releaseFlowInstId` — 应用发布页 release flow，用于 `preview`
- `packageFlowInstId` — 二方库包发布流，用于 `submit`
- `pipelineInstId` — 二方库包发布流的流水线引擎实例 ID，等同于 `packageFlowInstId`
- `reused` — 是否复用活跃包发布流；需要重新实测时可传 `--force-new`

3. 预览模块、默认 JDK/Maven 和可选资源：

```bash
a1 app pipeline lib-deploy preview \
  --app-id <app-id> \
  --flow-inst-id <release-flow-inst-id> \
  -f json
```

构造 submit 前必须先看 preview：

- 发布模块取 `modules[].name`
- 排除模块时由 Agent 自己从 `modules[].name` 里删掉对应项，例如“发布除了 pom 的其他模块”就是去掉 `pom.xml`
- 默认 JDK 取 `defaultJdkVersion`；切换 JDK 取 `jdkOptions[].resource`，例如 JDK8 通常是 `ajdk_8.16.20`
- 默认 Maven 取 `mvnVersion`；切换 Maven 取 `mvnOptions[].resource`，例如 `maven3.9.2`
- 服务端返回的 Maven resource 可能带首尾空格；传参时应使用 trim 后的值

4. 提交页面组件：

```bash
a1 app pipeline lib-deploy submit \
  --app-id <app-id> \
  --flow-inst-id <release-flow-inst-id> \
  --package-flow-inst-id <package-flow-inst-id> \
  --cr-ids <cr-id-list> \
  --modules <module-a,module-b> \
  --jdk-version <jdk-resource> \
  --mvn-version <maven-resource> \
  -f json
```

submit 注意事项：

- `--flow-inst-id` 仍然传 release flow，不是 package flow；它用于提交前按页面逻辑重新 preview release 分支和模块
- `--package-flow-inst-id` 传 `start` 返回的包发布流；真正提交发布单组件使用它
- plain 和 JSON 输出中的 `pipelineInstId` 等同于 `packageFlowInstId`；quiet 输出保持原有行为
- `--cr-ids` 必填，来自页面 URL 或 `app pipeline branch` 的 `changeRequests[].crId`
- `--modules` 和 `--all-modules` 二选一；指定模块时必须使用 preview 返回的 `modules[].name`
- `--app-name` 通常不用传，CLI 会按 `--app-id` 查询；查询失败时再手动指定
- 返回 `libraryDeployId` 表示发布单已创建；可用 `app pipeline status --instance-id <package-flow-inst-id>` 做一次状态确认

示例：发布除了 `pom.xml` 外的其他模块，指定 Maven 3.9.2 和 JDK8：

```bash
a1 app pipeline lib-deploy submit \
  --app-id 332450 \
  --flow-inst-id 229744261 \
  --package-flow-inst-id 229757727 \
  --cr-ids 34780361 \
  --modules aone-coop-agentor-service-api,aone-coop-agentor-service-dal,aone-coop-agentor-service-service,aone-coop-agentor-service-start \
  --jdk-version ajdk_8.16.20 \
  --mvn-version maven3.9.2 \
  -f json
```

### app pipeline reenter
已废弃，仅用于理解旧脚本。新请求使用 `a1 cd-pipeline run rerun --pipeline-id <id> --app <app>`；精确重跑使用 `a1 cd-pipeline run rerun <run-id>`。需要部署指定 CR 分支时使用 `a1 cd-pipeline run <pipeline-id> --app <app> --cr-id <cr-id>`。

### app pipeline run / retry
已废弃，仅用于理解旧脚本；新请求不要生成这些命令。需要再次触发实例时使用 `a1 cd-pipeline run rerun`；需要部署指定 CR 分支时使用 `a1 cd-pipeline run <pipeline-id> --app <app> --cr-id <cr-id>`。

### app pipeline instance list
列出流水线实例。
- `--pipeline-id int` — 流水线 ID

### app pipeline stage list
已废弃，新请求使用 `a1 cd-pipeline run get <run-id>`；需要单个阶段时添加 `--stage-id <id>`。旧命令会自动解析最新实例。
- `--pipeline-id int` — 流水线 ID

### app pipeline stage status
已废弃，新请求使用 `a1 cd-pipeline run get <run-id> --stage-id <id>`。
- `--stage-id int` — 阶段 ID

### 深层嵌套命令

stage/job 查询已迁移到 `a1 cd-pipeline run get`。以下旧命令仅用于兼容；task 组件详情和动态动作暂未迁移：

```
a1 cd-pipeline run get <run-id> --stage-id <id>    # 阶段及其 job/task
a1 cd-pipeline run get <run-id> --job-id <id>      # job 及其 task
app pipeline stage job task list --job-inst-id <id>  # job 内任务列表
app pipeline stage job task status --task-inst-id <id>  # 任务状态
```

还支持动态组件语法（COMPONENT_SIGN 即组件标识，如 BUILD、CR_PUBLISH_RELEASE 等）：
```
app pipeline stage job task <COMPONENT_SIGN> status  # 按组件名查状态
app pipeline stage job task <COMPONENT_SIGN> log     # 按组件名查日志
```

### app pipeline stage job task list
列出 job 内的任务。
- `--job-inst-id int` — Job 实例 ID（**必填**）；别名 `--job-id`
- `--instance-id int` — 流水线实例 ID（可选，跳过应用绑定解析）

### app pipeline stage job task status [ACTION] [PARAM=VALUE ...]
查看任务状态，或执行任务支持的动作。
- `--task-id int` — 任务实例 ID（**必填**）；别名 `--task-inst-id`

不带 ACTION 时显示任务当前状态、组件数据和支持的动作列表（`supportedActions`）。
带 ACTION 时执行该动作；额外参数以 `KEY=VALUE` 形式跟在 ACTION 后面。

安全边界：普通输出、`--format json` 和 `--verbose` 只保留状态、动作名称、参数 schema、必要说明和安全的 `a1` 后续命令，不返回后端 URL、host/path/query、method、headers、原始请求体。Agent **不得**尝试还原或直调后端接口，必须继续使用 `a1 app pipeline ... task status <ACTION>` 执行动作。

#### 部署任务常见动作（supportedActions）

动作列表由服务端动态返回，以下为部署组件（CR_PUBLISH_RELEASE 等）常见的内置动作：

| 动作代码 | 说明 | 示例 |
|---------|------|------|
| `deploy-order-list` | 查看当前部署任务关联的发布单列表 | `task status --task-id <ID> deploy-order-list` |
| `view-diagnosis` | 查看自动失败的启动诊断详情（lastStartupActionDiagnosisErrors） | `task status --task-id <ID> view-diagnosis` |
| `finish` | 批量关闭当前部署任务关联的所有发布单 | `task status --task-id <ID> finish` |
| `resume` | 批量恢复当前部署任务关联的所有发布单 | `task status --task-id <ID> resume` |
| `log` | 查看构建日志（CI 组件，cli 类型，显示可执行的日志命令） | `task status --task-id <ID> log` |
| `skip` | 跳过部署 | `task status --task-id <ID> skip` |

参数自动填充规则：`deployIdList`、`flowComponentInstId`、`flowInstId` 等参数会从组件数据中自动提取，通常无需手动传。
如需指定某个发布单 ID，可显式传 `deploy-id-list=<ID>`（kebab-case 自动转 camelCase）。

#### 发布单操作典型工作流

```bash
# 1. 查看流水线状态，找到阶段 / job / task ID
a1 app pipeline status --pipeline-id 66

# 2. 查看阶段列表
a1 app pipeline stage list --pipeline-id 66

# 3. 查看阶段内的 job 列表
a1 app pipeline stage job list --stage-id <stage-id>

# 4. 查看 job 内的 task 列表
a1 app pipeline stage job task list --job-inst-id <job-inst-id>

# 5. 查看 task 状态和支持的动作
a1 app pipeline stage job task status --task-id <task-id>

# 6. 查看该 task 关联的发布单列表
a1 app pipeline stage job task status --task-id <task-id> deploy-order-list

# 7. 查看部署失败诊断
a1 app pipeline stage job task status --task-id <task-id> view-diagnosis

# 8. 批量恢复发布单（发布暂停后继续）
a1 app pipeline stage job task status --task-id <task-id> resume

# 9. 批量关闭发布单
a1 app pipeline stage job task status --task-id <task-id> finish
```

也可以用组件名快捷访问（无需知道 task-id）：
```bash
a1 app pipeline stage job task CR_PUBLISH_RELEASE status    # 查看发布组件状态
a1 app pipeline stage job task CR_PUBLISH_RELEASE deploy-order-list  # 查看发布单
a1 app pipeline stage job task BUILD log                     # 查看构建日志
```

---

## 部署单（app deploy-order）

### app deploy-order list
列出部署单。
- `--pipeline-id int` — 发布流水线 ID
- `--app string` — 应用名称或数字 app ID（默认从 link context 读取）

### app deploy-order get <deploy-order-id>
查看部署单详情。
- `--app string` — 应用名称或数字 app ID（默认从 link context 读取）

### app deploy-order cr <deploy-order-id>
查看部署单关联的变更单。
- `--app string` — 应用名称或数字 app ID（默认从 link context 读取）

### app deploy-order batch list <deploy-order-id>
列出部署批次。
- `--app string` — 应用名称或数字 app ID（默认从 link context 读取）

### app deploy-order batch hosts <deploy-order-id>
查看部署批次主机详情。
- `--app string` — 应用名称或数字 app ID（默认从 link context 读取）
- `--batch-num int` — 批次号
