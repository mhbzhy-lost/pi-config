# pkg 命令完整参考

## a1 pkg — Aone 包管理

查询 Aone 包对象（Package）信息、查看包详情、绑定当前目录到包，管理包变更单（`appType=LIB`），并查询或重进包发布流水线。

---

## 包基础操作

### pkg list

列出包对象。不带查询参数时默认搜索 FOCUS（收藏）范围；带任意查询/过滤参数时自动切换到 ALL；`--favorites` 强制走 FOCUS；`--all` 与 `--favorites` 互斥。

- `-k, --keyword string` — 搜索关键词
- `--all` — 显式搜索 ALL 范围
- `--favorites` — 仅搜索收藏包（FOCUS 范围），与 `--all` 互斥
- `--subtype strings` — 按包子类型过滤，可重复传入或逗号分隔（如 `library`、`npm`、`rpm`）
- `--status strings` — 按状态过滤，可重复传入或逗号分隔（如 `ONLINE`、`OFFLINE`）
- `--product-line strings` — 按产品线名称 / 路径 / ID 过滤，可重复传入
- `--creator strings` — 按创建人花名 / 登录名过滤，可重复传入
- `--creator-id strings` — 按创建人工号过滤，可重复传入
- `--owner strings` — 按负责人花名 / 登录名 / 工号过滤，可重复传入
- `--select strings` — 限制返回字段，可重复传入
- `--asql string` — 透传给 app-center 的 ASQL 表达式
- `-f, --format string` — 输出格式：`plain`（默认）、`json`
- `-q, --quiet` — 仅输出包 ID

### pkg view \<pkg-name-or-id\>

查看单个包的详细信息。支持按包名或数字 ID 查询。

- `-f, --format string` — 输出格式：`plain`（默认）、`json`
- `-q, --quiet` — 仅输出包 ID

### pkg link [name-or-id]

绑定当前目录到 Aone 包对象。有参数时按 ID 或名称直接绑定；无参数时交互式搜索选择。

### pkg unlink [id]

移除当前目录与包的绑定。无参数时交互式选择要解绑的包。

- `--all` — 移除所有已绑定的包

---

## 包变更单管理（pkg cr）

### pkg cr list
列出包变更单。默认只显示与当前用户相关的 CR；用 `--all` 查看该包下全部 CR。
- `--pkg string` — 包名称或数字 ID（默认从 `a1 pkg link` 读取）
- `--status strings` — 状态筛选（可多次使用），如 `DEV`、`PREINTG`、`INTG`
- `--all` — 显示全部 CR，不只看我的
- `--page int` — 页码（默认 1）
- `--page-size int` — 每页数量（默认 20）
- `-f, --format string`, `-q, --quiet`

示例：
```bash
a1 pkg cr list
a1 pkg cr list --pkg 44008 --status DEV
a1 pkg cr list --pkg demo-lib --all --format json
```

### pkg cr create <description> (--branch <name> | --existing-branch <name>)
创建包变更单。**必须显式指定 `--branch` 或 `--existing-branch` 其一**（互斥，其中之一必填）。
- `--pkg string` — 包名称或数字 ID（默认从 `a1 pkg link` 读取）
- `--branch string` — 新建分支名后缀（无 `--existing-branch` 时必填）
- `--existing-branch string` — 复用的已有远程分支名（无 `--branch` 时必填）
- `--workitem-ids string` — 关联的 Aone 工作项 ID，多个用逗号分隔
- `--tester strings` — 测试人花名或工号，多个用逗号分隔或重复使用
- `--item-name string` — CR item 名称（默认使用包 code config 名称，其次包名）

包类只有一个 code config，`pkg cr create` **没有** `--code-module-id`。CLI 会自动从包的唯一 code config 填充 `commonCodeModuleId` 和 `codeModuleId`；如果缺失 code config，先重新执行 `a1 pkg link <pkg>` 或检查 app-center 包配置。

示例：
```bash
a1 pkg cr create "升级二方包实现" --branch feature/update-sdk
a1 pkg cr create "修复二方包发布问题" --existing-branch hotfix/release --pkg demo-lib
a1 pkg cr create "关联需求" --branch feature/req --workitem-ids 123,456 --tester 张三
```

### pkg cr mr <cr-id>
为包变更单提交代码评审/MR。
- `--assignees string` — 评审人工号，多个用逗号分隔
- `-f, --format string`, `-q, --quiet`

示例：
```bash
a1 pkg cr mr 33725175
a1 pkg cr mr 33725175 --assignees 12345,67890
```

### pkg cr submit <cr-id>
已废弃，仅用于兼容已有脚本。它只创建/加入流水线实例、不触发运行；新请求直接使用 `a1 cd-pipeline run <pipeline-id> --mvn <package-name-or-id> --cr-id <cr-id>` 提交并运行，不保留 submit-only 语义。

- `--pipeline-id int` — 发布页流水线定义 ID（必需）
- `--pkg string` — 包名称或数字 ID（默认从 `a1 pkg link` 读取）
- `-f, --format string` — 输出格式，支持 `json`
- `-q, --quiet` — 静默模式，优先仅输出 `pipelineInstId`

示例：
```bash
a1 cd-pipeline run 13018 --mvn 44008 --cr-id 33725175
a1 cd-pipeline run 13018 --mvn 44008 --cr-id 33725175 -f json
```

plain 和 JSON 输出都会在后端可获取时返回 `pipelineInstId`。`pipelineInstId` 是流水线引擎实例 ID；`mixFlowInstId` 是发布页流水线集成区后续 `a1 pkg deploy-intg preview/submit --flow-inst-id` 的入参。输出中的 URL 仅用于查看发布页，不作为 `deploy-intg` 入参。

---

## 包发布流水线（pkg pipeline）

`a1 pkg pipeline` 查询包对象绑定的发布流水线，并对包类流水线最新实例执行 REENTER。包 ID 默认从当前目录的 `a1 pkg link` 读取，未绑定时用 `--pkg <pkg-name-or-id>` 指定。

### pkg pipeline list

已废弃，Maven 包查询改用 `a1 cd-pipeline list --mvn <package-name-or-id>`。旧命令仍可执行；新命令输出流水线定义版本信息，不包含最近运行状态。

旧入口兼容行为（仅用于排查历史脚本）：列出包对象绑定的发布流水线定义、最新实例和当前状态。JSON 输出复用应用流水线结构，`appId` 在包场景下表示包 ID。

- `--pkg string` — 旧入口的包名称或数字 ID（默认从 `a1 pkg link` 读取）
- `-f, --format string` — 旧入口输出格式：`plain`（默认）、`json`
- `-q, --quiet` — 旧入口仅输出流水线 ID

新请求只生成以下替代用法：
```bash
a1 cd-pipeline list --mvn 43819
a1 cd-pipeline list --mvn demo-lib --format json
a1 cd-pipeline list --mvn demo-lib --quiet
```

### pkg pipeline reenter

已废弃，仅用于理解旧脚本；新请求不要生成该命令。重跑最新 Maven 包流水线实例使用 `a1 cd-pipeline run rerun --pipeline-id <id> --mvn <package-name-or-id>`，精确重跑使用 `a1 cd-pipeline run rerun <run-id>`。首次提交包 CR 使用 `a1 cd-pipeline run <pipeline-id> --mvn <package-name-or-id> --cr-id <cr-id>`。

### pkg cr close <cr-id>
关闭包变更单（不可逆）。
- `-y, --yes` — 跳过确认

### pkg cr quit <cr-id>
从包发布流水线中退出 CR。
- `--pipeline-instance-id int` — 流水线实例 ID（必需）
- `--pkg string` — 包名称或数字 ID（默认从 `a1 pkg link` 读取）

示例：
```bash
a1 pkg cr quit 33536885 --pipeline-instance-id 218496806
a1 pkg cr quit 33536885 --pipeline-instance-id 218496806 --pkg 44008
```

---

## CR 详情页二方包发布（pkg deploy-cr）

`a1 pkg deploy-cr` 用于 CR 详情页/单变更发布类流程里的 Aone 官方二方库发布流水线。主流程顺序固定为 **start-flow → preview-modules → submit**，后两步依赖前一步返回的 `crItemId`、`mixFlowInstId`。plain / JSON 输出会在后端可获取时返回 `pipelineInstId`；`mixFlowInstId` 仍用于现有 `--mix-flow-inst-id` 入参，`pipelineInstId` 是流水线引擎实例 ID，可用于发布页、流水线实例、构建日志等后续链路。已有发布记录阻塞重新提交时，使用 **status / quit / retry** 查询、释放或重试。

认证要求：需已 `a1 auth login`；`--operator` 默认从当前登录用户解析，工号会自动去掉前导零。输出支持 `-f json` / `--format json`，便于脚本解析。

### pkg deploy-cr start-flow

启动或复用二方库发布流水线实例。

- `--app-id int` — 应用或包对象 ID（必需）
- `--cr-id int` — 变更单 CR ID（必需）
- `--app-type string` — 绑定对象为 Aone 应用时传 `APP`；绑定对象为 Aone 包时传 `LIB`
- `--app-sub-type string` — 不传时后端默认：`APP`→`NORMAL`，`LIB`→`MAVEN`
- `--operator string` — 操作人工号（默认当前登录用户）
- `-f, --format string` — 输出格式：`plain`（默认）/ `json`

响应要点：

- `mixFlowInstId` — 后续 `submit --mix-flow-inst-id` 的入参。
- `pipelineInstId` — 流水线引擎实例 ID。
- `crItemId` — 后续 `preview-modules --cr-item-id` 和 `submit --cr-item-id` 的入参。
- `flowId` — 发布流水线定义 ID。
- `libPublishPageUrl` — 如果响应包含该字段，必须在继续 preview/submit 前向用户说明这是二方库发布/部署流水线 Web 详情页，可在浏览器打开查看。

示例：

```bash
a1 pkg deploy-cr start-flow --app-id=232285 --app-type=APP --cr-id=34096701
a1 pkg deploy-cr start-flow --app-id=43819 --app-type=LIB --cr-id=34096702 --format json
```

### pkg deploy-cr preview-modules

预览分支、候选 Maven 模块、默认 JDK/Maven 与可选列表。

- `--app-id int` — 应用或包对象 ID（必需）
- `--app-type string` — 绑定对象为 Aone 应用时传 `APP`；绑定对象为 Aone 包时传 `LIB`
- `--cr-id int` — 变更单 CR ID（必需）
- `--cr-item-id int` — 来自 start-flow 返回的 `crItemId`（必需）
- `--operator string` — 操作人工号（默认当前登录用户）
- `-f, --format string` — 输出格式：`plain`（默认）/ `json`

preview 返回字段与 submit 参数的推荐映射：

- `--modules`：取 `modules[].name`，多个模块用逗号分隔。
- `--jdk-version`：默认建议取 `defaultJdkVersion`；如果用户选择 `jdkOptions` 里的其它 JDK，传对应 `jdkOptions[].resource`。
- `--mvn-version`：默认建议取 `mvnVersion`；如果用户选择 `mvnOptions` 里的其它 Maven，传对应 `mvnOptions[].resource`。
- `--branch-url` / `--branch-revision`：用户需要覆盖预览分支时，分别取或覆盖 `branchUrl`、`branchRevision`。
- `--extra-args`：默认建议取 `extraArgs`；用户需要修改构建参数时再覆盖。

示例：

```bash
a1 pkg deploy-cr preview-modules \
  --app-id=232285 --app-type=APP --cr-id=34096701 --cr-item-id=29226921
a1 pkg deploy-cr preview-modules \
  --app-id=43819 --app-type=LIB --cr-id=34096702 --cr-item-id=29226922 --format json
```

### submit 前确认 modules / JDK / Maven

构造 `pkg deploy-cr submit` 前应先执行 `preview-modules`，并向用户摘要将要发布的模块、默认 JDK/Maven、可选资源和构建参数。

默认策略：

- 用户已明确确认时，按用户最终选择构造 `--modules`、`--jdk-version`、`--mvn-version` 等参数。
- 用户没有明确选择模块时，默认提交 preview 返回的全部 `modules[].name`。
- 用户没有明确选择 JDK 时，默认 `--jdk-version` 使用 `defaultJdkVersion`。
- 用户没有明确选择 Maven 时，默认 `--mvn-version` 使用 `mvnVersion`。
- 用户没有明确修改构建参数时，默认沿用 preview 的 `extraArgs`；执行前说明采用了默认全模块和默认构建参数。

### pkg deploy-cr submit

提交二方库发布单草稿，与 CR 详情页里的提交发布单组件一致。

plain 和 JSON 输出都会在后端可获取时返回 `pipelineInstId`；quiet 输出保持原有行为。

- `--app-id int` — 应用或包对象 ID（必需）
- `--app-type string` — 绑定对象为 Aone 应用时传 `APP`；绑定对象为 Aone 包时传 `LIB`
- `--cr-id int` — 变更单 CR ID（必需）
- `--cr-item-id int` — 来自 start-flow 返回的 `crItemId`（必需）
- `--mix-flow-inst-id int` — 来自 start-flow 返回的 `mixFlowInstId`（必需）
- `--modules string` — 逗号分隔模块短名，必须来自 preview 返回的 `modules[].name`
- `--branch-url string` — 覆盖分支 URL，不传时使用预览默认值
- `--branch-revision string` — 覆盖分支 revision，不传时使用预览默认值
- `--jdk-version string` — 建议传 preview 的 `defaultJdkVersion`；切换 JDK 时传 `jdkOptions[].resource`
- `--mvn-version string` — 建议传 preview 的 `mvnVersion`；切换 Maven 时传 `mvnOptions[].resource`
- `--extra-args string` — 覆盖 deploy 构建参数，不传时使用预览默认值
- `--description string` — 发布描述
- `--operator string` — 操作人工号（默认当前登录用户）
- `-f, --format string` — 输出格式：`plain`（默认）/ `json`

示例：

```bash
a1 pkg deploy-cr submit \
  --app-id=232285 --app-type=APP --cr-id=34096701 \
  --cr-item-id=29226921 --mix-flow-inst-id=222908369 \
  --modules=mod-a,mod-b \
  --jdk-version=ajdk11_xxx --mvn-version=maven3.9.2 \
  --description="release library" --format json
```

### pkg deploy-cr status

查询指定 `mixFlowInstId` 对应的二方库发布流水线状态。发布记录只是可选关联信息, 不存在时返回 `hasLibraryDeploy=false`。

- `--app-id int` — 应用或包对象 ID（必需）
- `--app-type string` — 绑定对象为 Aone 应用时传 `APP`；绑定对象为 Aone 包时传 `LIB`
- `--mix-flow-inst-id int` — 来自 start-flow 返回的 `mixFlowInstId`（必需）
- `--cr-id int` — 变更单 CR ID（可选上下文, 用于详情页链接和关联记录校验）
- `--operator string` — 操作人工号（默认当前登录用户）
- `-f, --format string` — 输出格式：`plain`（默认）/ `json`

输出字段中 `pipelineInstId` 是流水线引擎实例 ID；`flowStatus` 是 Mix 流水线主状态，取值如 `RUNNING`、`CANCEL`、`SUCCESS`、`FAIL`；`hasLibraryDeploy` 表示是否存在关联发布记录。只有 `hasLibraryDeploy=true` 时才会有 `deployStatus`、`libraryDeployId`、`gav` 等发布单字段。判断流水线能否退出以 `flowStatus` 为主，不能因为 `hasLibraryDeploy=false` 认为命令失败。

示例：
```bash
a1 pkg deploy-cr status --app-id=232285 --cr-id=34096701 --mix-flow-inst-id=222908369 --format json
```

### pkg deploy-cr quit

退出指定 `mixFlowInstId` 对应的二方库发布流水线，并释放后续重新提交能力。关联发布记录不存在时仍应按流水线维度退出；存在非 `SUCCESS` 发布记录时后端会同步释放该记录。`SUCCESS` 发布单不会被覆盖，但不阻断流水线级退出。

- `--app-id int` — 应用或包对象 ID（必需）
- `--app-type string` — 绑定对象为 Aone 应用时传 `APP`；绑定对象为 Aone 包时传 `LIB`
- `--mix-flow-inst-id int` — 来自 start-flow 返回的 `mixFlowInstId`（必需）
- `--cr-id int` — 变更单 CR ID（可选上下文, 用于详情页链接和关联记录校验）
- `--reason string` — 退出原因（可选）
- `--operator string` — 操作人工号（默认当前登录用户）
- `-f, --format string` — 输出格式：`plain`（默认）/ `json`

示例：
```bash
a1 pkg deploy-cr quit --app-id=232285 --cr-id=34096701 \
  --mix-flow-inst-id=222908369 --reason="rebuild" --format json
```

### pkg deploy-cr retry

复用发布页「重新部署」行为，对旧 `mixFlowInstId` 执行 Mix `REENTER` 操作，由 Mix 退出旧实例并创建新的二方库发布流水线实例。关联发布记录不存在时也可以继续重试；`SUCCESS` 发布单表示制品已完成发布，重试阶段默认拒绝覆盖。

`retry` 必填：

- `--app-id int`
- `--cr-id int`
- `--mix-flow-inst-id int`

`--cr-item-id`、`--modules`、JDK/Maven、分支和描述等 `submit` 参数不会参与 REENTER，保留为兼容参数。不要默认要求用户重新提供 `--cr-item-id` 和 `--modules`。

plain 输出会返回 `newMixFlowInstId` 和可获取时的 `newPipelineInstId`；JSON 输出字段为 `mixFlowInstId` 和 `pipelineInstId`。quiet 输出保持原有行为。

额外支持：

- `--reason string` — 兼容参数；REENTER 不使用

示例：
```bash
a1 pkg deploy-cr retry \
  --app-id=232285 --cr-id=34096701 --mix-flow-inst-id=222908369 \
  --reason="rebuild" --format json
```

Agent 遇到“二方包提交并发冲突”“当前流水线已存在二方库发布记录”“需要重新打包/重试/退出旧二方包发布记录”时，先执行 `pkg deploy-cr status` 查看 `flowStatus`、`hasLibraryDeploy` 和可选 `deployStatus`；只要旧流水线存在且需要重新部署，直接使用 `retry`，它会按发布页 REENTER 创建新流水线实例。构造 `retry` 时默认只传 `app-id`、`cr-id`、`mix-flow-inst-id`。不要因为 `hasLibraryDeploy=false` 判定失败，也不要使用 `a1 app cr unsubmit` 或 `a1 app pipeline quit/retry` 处理该类 CR 详情页二方库发布流水线。

---

## 发布页集成区二方包部署（pkg deploy-intg）

`a1 pkg deploy-intg` 用于在发布页流水线集成区填写并提交「二方库发布单」组件，适合包 CR 已进入发布流水线集成区、且需要支持多变更集成的场景。它不要放在 `artifact` 命令域下，也不要传发布页 URL；只传包和 `flowInstId`。submit 的 plain / JSON 输出会返回 `pipelineInstId`，对应当前发布页集成区流水线实例；quiet 输出仍只返回二方库发布单 ID。

常见顺序：

1. `a1 cd-pipeline run <pipeline-id> --mvn <package-name-or-id> --cr-id <cr-id> -f json` 提交并运行包 CR，拿到 `mixFlowInstId` 和 `runId`。
2. `a1 pkg deploy-intg preview --flow-inst-id <mixFlowInstId>` 预览模块、JDK/Maven 默认值和 deploy 参数。
3. `a1 pkg deploy-intg submit --flow-inst-id <mixFlowInstId> ...` 提交二方库发布单组件。

### pkg deploy-intg preview

预览发布流水线集成区可部署模块和默认构建参数。

- `--pkg string` — 包名称或数字 ID（默认从 `a1 pkg link` 读取）
- `--flow-inst-id int` — 发布页集成区流水线实例 ID（必需）
- `--operator string` — 操作人工号（默认当前登录用户）
- `--is-fl bool` — 是否 Snapshot 包发布流，默认 `false`；发布 SNAPSHOT 包时传 `true`，会影响 Mix 版本约束校验
- `-f, --format string` — 输出格式：`plain`（默认）/ `json`
- `-q, --quiet` — 仅输出模块名

示例：
```bash
a1 pkg deploy-intg preview --pkg 43819 --flow-inst-id 227403600
a1 pkg deploy-intg preview --pkg aone-demo-lib --flow-inst-id 227403600 --format json
a1 pkg deploy-intg preview --pkg 43819 --flow-inst-id 227403600 --is-fl
```

preview 返回字段与 submit 参数的推荐映射：

- `--modules`：取 `modules[].name`，多个模块用逗号分隔。
- `--jdk-version`：默认建议取 `defaultJdkVersion`；如果用户选择 `jdkOptions` 里的其它 JDK，传对应 `jdkOptions[].resource`。
- `--mvn-version`：默认建议取 `mvnVersion`；如果用户选择 `mvnOptions` 里的其它 Maven，传对应 `mvnOptions[].resource`。
- `--extra-args`：默认建议取 `extraArgs`；用户需要修改时再覆盖。

### pkg deploy-intg submit

提交发布流水线集成区二方包发布单。`--modules` 与 `--all-modules` 二选一；`--all-modules` 会自动执行一次 preview 并提交全部 `modules[].name`。

- `--pkg string` — 包名称或数字 ID（默认从 `a1 pkg link` 读取）
- `--flow-inst-id int` — 发布页集成区流水线实例 ID（必需）
- `--modules string` — 要发布的模块名，逗号分隔，对应 preview 返回的 `modules[].name`
- `--all-modules` — 自动预览并提交全部模块，与 `--modules` 互斥
- `--operator string` — 操作人工号（默认当前登录用户）
- `--branch-url string` — 覆盖集成区分支 URL，不传时使用集成区默认分支
- `--branch-revision string` — 覆盖集成区分支 revision，不传时使用集成区默认分支 revision
- `--jdk-version string` — JDK 版本/资源，建议传 preview 的 `defaultJdkVersion`；切换 JDK 时传 `jdkOptions[].resource`
- `--mvn-version string` — Maven 版本/资源，建议传 preview 的 `mvnVersion`；切换 Maven 时传 `mvnOptions[].resource`
- `--extra-args string` — 覆盖 deploy 构建参数，不传时使用后端默认值
- `--description string` — 发布描述
- `--is-fl bool` — 是否 Snapshot 包发布流，默认 `false`；发布 SNAPSHOT 包时传 `true`，会影响 Mix 版本约束校验
- `-f, --format string` — 输出格式：`plain`（默认）/ `json`
- `-q, --quiet` — 仅输出二方库发布单 ID

示例：
```bash
a1 pkg deploy-intg submit --pkg 43819 --flow-inst-id 227403600 \
  --modules demo-api,demo-core

a1 pkg deploy-intg submit --pkg 43819 --flow-inst-id 227403600 \
  --all-modules --jdk-version JDK11 --mvn-version maven3.6.0

a1 pkg deploy-intg submit --pkg 43819 --flow-inst-id 227403600 \
  --modules demo-api --extra-args "-DskipTests" --description "snapshot verify" --is-fl
```

Agent 构造 submit 前应先执行 preview 并向用户摘要模块、默认 JDK/Maven、可选资源和 extraArgs。若用户未明确选择，默认使用全部 `modules[].name`、`defaultJdkVersion`、`mvnVersion` 和 `extraArgs`；执行前说明采用了默认全模块和默认构建参数。
