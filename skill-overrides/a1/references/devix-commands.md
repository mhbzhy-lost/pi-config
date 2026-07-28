# devix 命令完整参考

## a1 devix — Devix 平台

与 [Devix](https://devix.io.alibaba-inc.com/) 平台交互，当前支持交付任务（task）、AgentLoop 模型和工作空间（workspace）管理。

### ⚠️ 消歧："交付任务"≠"项目工作项"

- **`a1 devix task create`**：创建可由 AI Agent 推进交付的交付任务（有 agentloop 会话），用 `--workspace`（orgId）+ `--link-workitem`（关联 Aone 需求）
- **`a1 project workitem create`**：在 Aone 项目空间里创建普通工作项（需求/缺陷/任务），用 `--project`（projectId）+ `--category`

即使用户消息中包含 Aone 工作项链接或 projectId，只要意图是"创建交付任务"或"推进交付"，就走 `a1 devix task` 路径。Aone 工作项 ID 通过 `--link-workitem` 参数关联即可。

## `a1 devix workspace list`

查询当前用户所属的工作空间（组织）列表。**创建交付任务前必须先执行此命令获取有效的 workspace ID**，禁止猜测或使用工号作为 workspace ID。

```bash
a1 devix workspace list [--format json]
```

### 可选参数

| Flag | 类型 | 说明 |
|------|------|------|
| `--format` | string | 输出格式：`json` 输出完整 JSON（默认表格） |

### 输出（默认表格）

```
ID            TYPE        NAME
12345         personal    我的工作空间
67890         team        研发团队

Total: 2 workspace(s)

Use the ID value as --workspace when creating tasks:
  a1 devix task create --title "..." --workspace <ID>
```

### AI Agent 使用流程

1. 执行 `a1 devix workspace list` 获取用户所属工作空间
2. 若仅 1 个空间，直接使用其 ID
3. 若有多个空间，向用户展示列表并请用户选择
4. 将选择的 workspace ID 传给 `a1 devix task create --workspace <ID>`

---

## `a1 devix task create`

创建交付任务（工作项）。

```bash
a1 devix task create --title "..." --workspace <orgId> [flags]
```

### 必填参数

| Flag | 类型 | 说明 |
|------|------|------|
| `--title` | string | 任务标题 |
| `--workspace` | string | 工作空间（组织）ID；也可通过环境变量 `A1_DEVIX_DEFAULT_WORKSPACE` 或配置文件 `devix_default_workspace` 设置 |

### 可选参数

| Flag | 类型 | 说明 |
|------|------|------|
| `--creator` | string | 代理创建人 staffId（钉钉代理场景使用，不传则取当前登录用户） |
| `--collaborator` | string[] | 协作人 staffId（可重复指定多个，如 `--collaborator 326877 --collaborator 407544`） |
| `--description` | string | 任务描述 |
| `--link-workitem` | int[] | 关联的 Aone 工作项 ID（可重复或逗号分隔，如 `--link-workitem 111,222`）。自动导入关联工作项并将其 assignedTo/author 添加为协作人 |

### 示例

```bash
# 基本创建
a1 devix task create --title "实现用户登录功能" --workspace 12345

# 钉钉代理创建（传 creator 指定创建人身份）
a1 devix task create --title "修复支付bug" --workspace 12345 \
  --creator 407544 --collaborator 326877

# 关联 Aone 需求创建（自动添加需求的负责人/作者为协作人）
a1 devix task create --title "推进交付" --workspace 12345 \
  --link-workitem 29547112

# 关联多个 Aone 工作项
a1 devix task create --title "批量关联" --workspace 12345 \
  --link-workitem 111,222 --creator 407544
```

### 输出

```
Task created successfully.
UUID: <新任务UUID>
Title: <任务标题>
OperatorToken: <绑定了workItemId的scopedToken>
Auto-added collaborator: 326877 (from linked work item)
Linked 1 Aone work item(s): 29547112
```

---

## `a1 devix task start`

启动交付任务的 AgentLoop，并可在启动时传入初始消息、待克隆仓库、工作流和模型。AgentLoop 启动后，后续消息使用 `a1 devix task advance`。

```bash
a1 devix task start --task-id <UUID> [flags]
```

### 必填参数

| Flag | 类型 | 说明 |
|------|------|------|
| `--task-id` | string | 任务（工作项）UUID |

### 可选参数

| Flag | 类型 | 说明 |
|------|------|------|
| `--input` | string | AgentLoop 启动时接收的初始用户输入 |
| `--operator-token` | string | 钉钉代理场景使用的操作者令牌 |
| `--repo` | string[] | 启动前克隆的仓库，可重复指定。格式为 `group/repo` 或 `group/repo@branch`；同一仓库路径不能重复 |
| `--workflow` | string | 工作流位置。`group/repo` 使用 `.devix-agent/workflow.yaml`；`group/repo:file.yaml` 使用 `.devix-agent/` 下指定文件 |
| `--model` | string | AgentLoop 使用的模型 value；CLI 原样透传，模型可用性由 agent runtime 校验 |

### 仓库与工作流规则

- 只传 `--repo` 时，AgentLoop 会扫描克隆仓库中的工作流
- 只传 `--workflow` 时，会自动拉取工作流所在仓库
- 同时传 `--repo` 和 `--workflow` 时，工作流仓库必须包含在 `--repo` 中
- 使用 `a1 devix task models` 查询当前环境可用的模型 value，不要维护或猜测固定模型列表

### 示例

```bash
# 基本启动
a1 devix task start --task-id abc123-def456 --input "开始编码"

# 指定仓库及分支
a1 devix task start --task-id abc123-def456 --input "开始编码" \
  --repo group/repo@feature/branch

# 指定工作流和动态查询得到的模型 value
a1 devix task start --task-id abc123-def456 --input "开始编码" \
  --workflow group/repo:custom-workflow.yaml --model claude-opus-4-6
```

---

## `a1 devix task models`

查询当前 AgentLoop 运行环境返回的可用模型。模型集合可能随运行环境变化，应使用此命令动态查询。

```bash
a1 devix task models [--format json]
```

### 可选参数

| Flag | 类型 | 说明 |
|------|------|------|
| `--format` | string | 设置为 `json` 时输出完整 JSON；默认输出表格 |

### 输出字段

| 字段 | 说明 |
|------|------|
| `VALUE` | 传给 `a1 devix task start --model` 的模型值 |
| `LABEL` | 模型展示名称 |
| `INTERNAL` | 是否为内部模型 |
| `ENABLED` | 当前是否启用 |

### 示例

```bash
# 表格输出
a1 devix task models

# JSON 输出，适合自动化解析
a1 devix task models --format json
```

---

## `a1 devix task advance`

推进交付任务交付。将用户输入转发给任务关联的 agentloop 会话。

```bash
a1 devix task advance --task-id <UUID> [flags]
```

### 必填参数

| Flag | 类型 | 说明 |
|------|------|------|
| `--task-id` | string | 任务（工作项）UUID |

### 可选参数

| Flag | 类型 | 说明 |
|------|------|------|
| `--operator-token` | string | 操作者令牌（钉钉代理场景使用，优先使用 `create` 返回的 scopedToken，未经 create 时使用原始 operatorToken）。当调用者不是任务创建人时必须提供 |
| `--input` | string | 用户输入内容（转发给 agentloop）。不传则仅唤醒 agentloop |

### 示例

```bash
# 基本推进（当前登录用户即任务创建人）
a1 devix task advance --task-id abc123-def456 --input "开始编码"

# 钉钉代理推进（需要 operatorToken）
a1 devix task advance --task-id abc123-def456 \
  --operator-token "c3RhZmZJZDox..." --input "继续推进"

# 唤醒（不发送消息）
a1 devix task advance --task-id abc123-def456
```

### 输出

```
Task advanced successfully.
Task ID: <UUID>
Response: <agentloop 返回内容>
```

---

## `a1 devix task list`

列出交付任务列表，支持按创建人、任务状态筛选和分页查询。

```bash
a1 devix task list --workspace <orgId> [flags]
```

### 必填参数

| Flag | 类型 | 说明 |
|------|------|------|
| `--workspace` | string | 工作空间（组织）ID |

### 可选参数

| Flag | 类型 | 说明 |
|------|------|------|
| `--creator` | string | 按创建人 staffId 过滤 |
| `--status` | string | 按状态过滤：`in_progress`、`completed` 或 `cancelled` |
| `--page` | int | 页码，必须大于 0（默认 `1`） |
| `--page-size` | int | 每页任务数，范围 1-100（默认 `50`） |
| `--format` | string | 输出格式：`json` 输出包含 `success`、`data` 和 `total` 的完整 JSON（默认表格） |

### 示例

```bash
# 列出所有任务
a1 devix task list --workspace 12345

# 按创建人过滤
a1 devix task list --workspace 12345 --creator 407544

# 查询进行中的任务
a1 devix task list --workspace 12345 --status in_progress

# 查询第 2 页，每页 20 条
a1 devix task list --workspace 12345 --page 2 --page-size 20

# 组合筛选
a1 devix task list --workspace 12345 --creator 407544 \
  --status completed --page 1 --page-size 20

# JSON 格式输出（用于程序解析）
a1 devix task list --workspace 12345 --creator 407544 \
  --status in_progress --format json
```

### 输出（默认表格）

```
UUID                                  STATUS        CREATOR     TITLE
a1b2c3d4-e5f6-...                     in_progress   407544      实现用户登录功能
f7e8d9c0-b1a2-...                     completed     326877      修复支付bug

Page 1/1, total 2, page size 50
```

### JSON 字段

顶层分页响应：

| 字段 | 类型 | 说明 |
|------|------|------|
| `success` | boolean | 请求是否成功 |
| `data` | object[] | 当前页任务列表 |
| `total` | int | 符合条件的任务总数 |

`data` 中的任务字段：

| 字段 | 类型 | 说明 |
|------|------|------|
| `uuid` | string | 任务 UUID（用于 start/advance 的 --task-id） |
| `title` | string | 任务标题 |
| `status` | string | 任务状态：`in_progress`、`completed` 或 `cancelled` |
| `creator` | string | 创建人 staffId |
| `members` | string[] | 成员 staffId 列表 |
| `sourceAoneIssue` | object/null | 关联的 Aone 工作项信息 |

---

## 钉钉机器人场景

钉钉机器人场景下，参数来源：

- **creator**：从钉钉 getMessage 接口的 `userId` 字段获取（发消息的员工工号）
- **operatorToken**：从钉钉消息上下文的 `[operatorToken: ...]` 行提取（start/advance 时使用，create 不需要，30 分钟有效期）
- **collaborator**：从 `/bind` 机器人绑定关系获取（机器人所属组织的管理员工号）
- **workspace**：通过 `a1 devix workspace list` 查询用户所属工作空间获取 orgId；**禁止猜测或使用工号作为 workspace ID**

### 端到端流程示例

```bash
# 钉钉群内用户发送"帮我把需求 29547112 创建成交付任务"

# 1. 从钉钉消息上下文提取 userId 和 operatorToken
#    userId = "326877"
#    operatorToken = "c3RhZmZJZDox..."（start/advance 时使用）

# 1.5 查询用户所属的工作空间（获取正确的 workspace ID）
a1 devix workspace list
# → 若仅1个空间，直接使用其 ID；若多个，询问用户选择

# 2. 创建交付任务（create 不需要 operatorToken，信任 creator 身份）
a1 devix task create --title "推进需求29547112交付" --workspace 12345 \
  --creator 326877 --collaborator 407544 --link-workitem 29547112
# 响应中会返回一个绑定了 workItemId 的 scopedToken（OperatorToken: xxx）

# 3. 首次启动 AgentLoop（使用 create 返回的 scopedToken）
a1 devix task start --task-id <返回的UUID> \
  --operator-token "<create返回的OperatorToken>" --input "开始编码"

# 4. 后续用户发送模糊消息"继续推进"时，先查询用户任务列表
a1 devix task list --workspace 12345 --creator 326877 --status in_progress --format json
# → 若仅1个直接推进，多个则列出让用户选择；超过一页时继续使用 --page 查询
```

### Token 使用说明

- `create` 命令**不需要** `--operator-token`，创建工作项不是敏感操作，信任 creator 身份
- `create` 成功后会在输出中打印 `OperatorToken: <scopedToken>`，此 scopedToken 已绑定 workItemId
- `start`/`advance` 命令**必须**使用 `create` 返回的 scopedToken（不要使用原始 operatorToken）
- 如果用户推进的是之前创建的任务（本轮没有 create），使用原始 operatorToken 即可

---

## 任务路由（用户消息不含 task-id 时）

当用户消息不包含明确的 task-id 时，需要根据用户意图和上下文路由到正确的任务：

### 路由决策流程

```
用户发送消息
├── 意图：创建新任务（"帮我创建..."/"新建一个..."）
│   └── → a1 devix task create
├── 意图：推进已有任务（"继续推进"/"帮我跑测试"/"开始编码"）
│   ├── Step 1: 查询用户进行中的任务
│   │   └── a1 devix task list --workspace <orgId> --creator <staffId> --status in_progress --format json
│   ├── Step 2: 根据 data 和 total 判断查询结果
│   │   ├── 0 个 → 提示"暂无进行中的任务，需要创建新任务吗？"
│   │   ├── 1 个 → 自动选中该任务，直接推进
│   │   └── N 个 → 列出任务让用户选择
│   └── Step 3: 推进选中的任务
│       └── a1 devix task advance --task-id <UUID> --operator-token ... --input "..."
└── 意图：查看任务状态（"我的任务"/"任务列表"）
    └── → a1 devix task list --workspace <orgId> --creator <staffId>
```

### 用户选择交互示例

当用户有多个进行中任务时，机器人展示选择列表：

```
你有以下进行中的任务：
1. 实现用户登录功能 (workitema1b2c3...)
2. 修复支付超时bug (workitemd4e5f6...)
3. 优化查询性能 (workitemg7h8i9...)
请回复数字选择要推进的任务。
```

---

## 错误码表

| 场景 | 错误信息 | 说明 |
|------|----------|------|
| 非创建人推进且无 token | `只有创建人能推进交付` | 非创建人必须通过钉钉机器人获取 operatorToken |
| operatorToken 签名无效 | `operatorToken signature invalid` | token 被篡改或使用了错误的密钥 |
| operatorToken 过期 | `操作超时，请重新在群里发起` | token 有效期 30 分钟，过期后需重新触发钉钉消息获取新 token |
| token staffId 与创建人不匹配 | `只有创建人能推进交付` | token 中的 staffId 必须与任务创建人一致 |
| 灰度未开通 | `当前账号暂不支持推进交付功能` | 需要开通 WORKITEM_CLOUD_CLI_BINDING 灰度 |
| 无关联会话 | `执行环境异常，请稍后重试或联系管理员` | 任务未关联 CloudCLI 会话 |
| Pod 不可用 | `执行环境异常，请稍后重试或联系管理员` | 会话 Pod 不可用或 session 非活跃状态 |
| 工作项不存在 | `工作项不存在` | task-id 无效 |
| Aone 工作项已导入 | `Warning: Aone issue <id> was already imported` | 重复关联会返回告警但不阻断创建 |
