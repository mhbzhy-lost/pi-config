# project / staff 命令完整参考

## 目录

- [项目空间与全局标志](#a1-project--项目空间管理)
- [项目基础操作](#项目基础操作)
- [项目绑定资产](#项目绑定资产project-asset)
- [项目成员管理](#项目成员管理project-member)
- [工作项管理](#工作项管理project-workitem)
- [工作项创建与更新流程](#工作项创建更新标准流程)
- [CoCo 工作流](#coco-工作流project-workflow)
- [工作项附件](#工作项附件--附件管理)
- [视图管理](#视图管理project-view)
- [用户组管理](#用户组管理project-usergroup)
- [员工查询与公共账号同步](#staff-list)

## a1 project — 项目空间管理

### 全局标志
- `-f, --format string` — 输出格式
- `-q, --quiet` — 仅输出 ID

---

## 项目基础操作

### project list
列出项目。
- `-k, --keyword string` — 搜索关键词
- `--project-set` — 列出项目集

### project get [project-id]
查看项目详情（含创建人 Creator 字段）。省略 `project-id` 时使用当前目录已绑定的项目空间（`a1 project link`）。

### project link [keyword-or-id]
绑定当前目录到项目空间。

### project unlink [id]
移除项目绑定。
- `--all` — 移除所有绑定

---

## 项目绑定资产（project asset）

### project asset list

列出项目下由 CoCo 来源绑定的全部研发资产，主要用于 AI Agent 和自动化脚本快速建立项目上下文。命令会在内部自动翻页，调用方不需要也不能传分页参数；任意中间页失败时不会输出部分结果。

```bash
a1 project asset list --project 2155669
a1 project asset list --project 2155669 --type repo
a1 project asset list --type app --name a1
a1 project asset list --format json
a1 project asset list --quiet
```

参数：

- `--project string` — 项目空间 ID；省略时使用当前目录已绑定的项目
- `--type string` — 单一资产类型；支持下表的友好类型或后端枚举原值，匹配不区分大小写
- `--name string` — 资产名称前缀；和 `--type` 同时提供时按 AND 语义过滤
- `--format json` / `-f json` — 输出保留后端完整字段的 JSON 数组，推荐 Agent 和脚本使用
- `--quiet` / `-q` — 每行只输出一个资产对象 ID

资产类型：

| 友好类型 | 后端枚举 | 说明 |
| --- | --- | --- |
| `app` | `AONE_APPLICATION` | Aone 应用 |
| `package` | `AONE_PACKAGE` | Aone 包 |
| `o2-app` | `O2_APPLICATION` | O2 应用 |
| `repo` | `CODE_REPOSITORY` | 代码仓库 |
| `kbase-repo` | `KBASE_KNOWLEDGE_REPO` | KBase 知识库 |
| `kbase-group` | `KBASE_KNOWLEDGE_GROUP` | KBase 知识组 |

输出：

- 默认：`TYPE ID NAME` 表格，类型使用友好名称，顺序保持绑定记录 ID 升序
- JSON：完整对象数组，字段包括 `id`、`akProjectId`、`objectName`、`objectId`、`objectType`、`source`、`creator`、`createdAt`
- quiet：每行一个 `objectId`
- 空结果：默认模式向 stderr 输出 `No project assets found`；JSON 输出 `[]`；quiet 不输出内容；三种模式均成功退出

常见错误：

- 非法 `--type`：请求发出前失败并列出合法友好类型
- 未传 `--project` 且当前目录未关联项目：提示传项目 ID 或先关联项目
- 权限、网络或上游错误：非零退出，且不输出已经获取的部分资产
- 后端尚未支持分页并重复返回同一满页：非零退出，避免无限循环或重复数据

---

## 项目成员管理（project member）

查看和管理项目空间成员。`project-id` 统一通过 `--project` 指定；省略时使用当前目录已绑定的项目空间（`a1 project link`）。`add` / `remove` 会修改真实项目成员，执行前确认项目、工号和角色。

### project member list
列出项目成员及角色信息。
- `--project string` — 项目空间 ID（默认从 `a1 project link` 读取）
- `--status string` — 成员状态：`active` 在职成员，`inactive` 离职成员；不传则不过滤
- `--page int` — 页码（默认 1）
- `--page-size int` — 每页数量（默认 20，最大 1000）
- `--format string` — 输出格式：`json`
- `--quiet` — 仅输出成员工号，每行一个

```bash
a1 project member list
a1 project member list --project 2045948
a1 project member list --project 2045948 --status inactive
a1 project member list --project 2045948 --page 2 --page-size 100 --format json
```

### project member add <staff-id> [staff-id...]
添加项目成员。默认添加为参与人，可通过 `--role admin` 添加为管理员。员工工号支持多个参数或逗号分隔。
- `--project string` — 项目空间 ID（默认从 `a1 project link` 读取）
- `--role string` — 成员角色：`member` 参与人（默认），`admin` 管理员

```bash
a1 project member add AI264
a1 project member add AI264 --project 2166768
a1 project member add 542977 --project 2166768 --role admin
a1 project member add 001234 005678 --project 2166768
a1 project member add 001234,005678 --project 2166768
```

### project member remove <staff-id> [staff-id...]
移除项目成员的指定角色。默认移除参与人角色，可通过 `--role admin` 移除管理员角色。员工工号支持多个参数或逗号分隔。
- `--project string` — 项目空间 ID（默认从 `a1 project link` 读取）
- `--role string` — 成员角色：`member` 参与人（默认），`admin` 管理员

```bash
a1 project member remove AI264
a1 project member remove AI264 --project 2166768
a1 project member remove 542977 --project 2166768 --role admin
a1 project member remove 001234 005678 --project 2166768
a1 project member remove 001234,005678 --project 2166768
```

---

## 工作项管理（project workitem）

> **字段发现原则**：本节所有过滤字段、可写字段 flag 及字段别名均**由代码字段注册表驱动**。文档仅描述语法契约和典型用法；**具体字段清单以查询为准**：
> - 项目下所有字段及 CLI 别名：`a1 project workitem field list --project <id> --scope project`
> - 特定类型字段详情：`a1 project workitem field list --project <id> --type <type>`
> - 字段候选值：`a1 project workitem field options <field> --project <id> --type <type>`
> - 状态枚举：`a1 project workitem field options status --project <id> --type <type>`，也支持中文字段名 `状态`
> - 工作项命令完整 flag 列表：`a1 project workitem <list|create|update|get> --help`
> - 内容评审创建完整 flag 列表：`a1 project workitem review create --help`

### project workitem list
列出工作项。未指定 `--project` 且未关联项目时，查询个人空间（跨项目）。所有系统字段 flag 均支持名称解析。

- `--project string` — 项目 ID（不指定则查个人空间）
- `--view string` — 应用已保存视图的过滤/列/排序设置查询；显式 `--filter`/`--columns`/`--sort` 优先于视图默认值
- `--category string` — 类别（逗号分隔）：`req`（需求）/ `bug`（缺陷）/ `task`（任务）/ `risk`（风险）/ `nodeflownode`（节点）/ `plugintask`；中文别名 `需求/缺陷/任务/风险/节点` 亦可；省略列出默认集合。**默认排除 PluginTask**；如需包含请显式 `--category plugintask`（替代已移除的 `--all`）
- `--filter string` — 过滤表达式，支持布尔组合（AND/OR/NOT）和比较操作符（`=`, `!=`, `~`, `!~`, `>`, `>=`, `<`, `<=`, `=[a,b]` 范围）
- `--cfs strings` — 自定义字段过滤 key=value（显示名或数字 ID），可重复
- `--scope string` — 查询范围：`personal`/`project`/`team`/`all`/`collect`/`associate`/`child`（**注意**：与 `project workitem field list --scope` 语义不同，后者枚举值仅为 `project`/`personal`）
- `--sort string` — 排序，格式 field:dir（如 gmtCreate:desc,priority:asc）
- `--columns strings` — 显示列，默认自动选择。列名支持三种写法：英文标识符（`id`,`title`,`status`,`priority`）、CLI 别名（`assignee`,`created`,`modified`）、中文显示名（`标题`,`状态`,`指派给`,`优先级`）。自定义字段可直接传入数字 ID（如 `100604`），表头自动渲染为字段中文名
- `--page int` — 页码（默认 1）
- `--page-size int` — 每页数量（默认 25）

**输出行为（空结果）：**
- 默认：向 stderr 输出 `No workitems found`
- `--format json`：向 stdout 输出 `[]`（便于脚本/Agent 解析）
- `--quiet`：完全静默，无任何输出

**过滤字段 flag 按字段注册表自动生成**，通过 `a1 project workitem list --help` 查看完整列表。按类型分组的行为约定：
- **列表类字段**（status, type, sprint, module, version, tag, priority, severity 及 user 类字段等）接受逗号分隔多值，语义为 OR（如 `--priority urgent,high`、`--module 前端,后端`）
- **文本/日期类字段**（title, description, created, modified 等）保持原始值不拆分
- **user 类字段**（assignee, creator, tracker, participant, verifier, operator, commentator, closer 等）接受**花名、账号、工号、邮箱**
- 字段与 CLI 别名对应关系见 `field list --scope project` 输出的 **ALIASES** 列

**--filter 表达式语法：**
- 比较操作符：`=`（等于）、`!=`（不等于）、`~`（包含）、`!~`（不包含）、`>`、`>=`、`<`、`<=`、`=[a,b]`（范围）
- 引号支持：值可用双引号或单引号包围（如 `subject~"登录"` → 按"登录"查询，引号被自动去除），适用于包含特殊字符的场景
- 空值判断：`field=""` 或 `field=null`（为空）、`field!=""` 或 `field!=null`（不为空）
- 多值：`status=Open,Reopen,Fixed`
- 布尔组合：`AND`、`OR`、`NOT`、`()`（优先级：NOT > AND > OR）
- 字段别名（反直觉或带命名空间的常见别名；**完整别名列表见 `field list --scope project` 输出的 ALIASES 列**）：
  - `assignee → assignedTo`、`type → workitemType`、`severity → seriousLevel`、`title → subject`、`id → identifier`
  - `created → gmtCreate`、`modified → gmtModified`、`archived → logicalStatus`
  - `tracker → workitem.tracker`、`participant → ak.issue.member`、`verifier → workitem.verifier`
  - `related-space → relatedSpace`、`closer → closedBy`、`space → spaceIdentifier`
- 自定义字段：支持显示名称（如 `计划开始日期>=2026-01-01`），自动解析为数字 ID
- 示例：`--filter 'status=Open AND priority=urgent'`、`--filter 'operator=八鹤'`、`--filter 'NOT status=Closed'`、`--filter 'created>=2026-01-01'`、`--filter 'archived=正常'`、`--filter 'subject~"登录"'`

> **`--filter` vs `--cfs`**：`--cfs` 仅支持 `=` 操作符，`--filter` 支持全部操作符和布尔组合。建议优先使用 `--filter`。

### project workitem get <id>
查看工作项详情。`Req` 默认额外显示最新评审状态，JSON 在顶层 `review` 返回完整评审信息。评审查询失败时仅输出警告并继续；`--quiet` 跳过评审及其他扩展查询。其他工作项类型不查询评审。

> 若 `aione.alibaba-inc.com` 附件无法下载，将域名替换为 `project.aone.alibaba-inc.com` 后重试。

```bash
a1 project workitem get 83952725
a1 project workitem get 83952725 --format json
```

### project workitem review create <id>

为 `Req` 工作项发起内容评审。该命令与代码仓库的 MR/CR 评审不同；创建前会查询工作项详情和当前评审信息，仅当 `canMakeReview=true` 时才发送创建请求。

- `--reviewer stringArray` — 必填，评审人员工 ID；可重复传入，也可使用逗号分隔。CLI 会去除空白和重复值并保留首次出现的顺序。
- `--theme string` — 必填，评审主题；去除首尾空白后不能为空。
- `--end-date string` — 可选，评审截止日期；去除首尾空白后原样传递给评审接口。
- `--format json` — 输出包含 `workitemIdentifier`、`theme`、可选 `endDate`、`reviewerIds` 和 `created` 的 JSON 结果。

```bash
a1 project workitem review create 83952725 --reviewer 542977 --theme "接口方案评审"
a1 project workitem review create 83952725 --reviewer 542977,407544 --theme "内容评审"
a1 project workitem review create 83952725 --reviewer 542977 --reviewer 407544 \
  --theme "内容评审" --end-date "2026-07-31" --format json
```

创建前会校验工作项 ID、主题和评审人非空，并确认工作项类型为 `Req`、存在项目空间 ID、当前允许发起评审。评审人参数当前只按员工 ID 传递，不会查询员工目录验证工号是否真实存在；需要避免把花名、账号或邮箱误当成员工 ID。

### project workitem create
创建工作项。

> **可写字段 flag 由代码自动生成**：从字段注册表自动注册，与 update 命令一致。使用 `--help` 查看完整列表。

- `--project string` — 项目 ID（覆盖已绑定项目）
- `--category string` — 类别：**仅 `req` / `bug` / `task`**；其他类型（risk/nodeflownode/plugintask 等）请使用 `--type`。提供 `--type` 时 `--category` 可省略
- `--type string` — 工作项类型标识符或名称（如 '故事(STO)'），设置后可省略 --category
- `--body string` — 描述内容（Markdown 格式，本地图片自动上传图床）
- `--body-file string` — 从文件读取描述内容（Markdown 格式，本地图片自动上传图床）
- `--relation stringArray` — 创建时添加关联（格式: `<type>:<target>`，可重复）。类型: parent, sub, relate, blocks, blocked-by, duplicate, change, cr, tc, doc（doc 的 target 为 URL）
- `--cfs stringArray` — 自定义字段 key=value（可重复）。key 为字段标识符或显示名称，value 格式取决于字段类型
- `--attachment stringArray` — 本地文件路径（可重复，创建前自动上传）

**可写字段 flag 由字段注册表自动生成**，通过 `a1 project workitem create --help` 查看完整列表。常用字段（及其 CLI 别名）：
- `--title`（必填）、`--assignee`（alias `--owner`）、`--status`、`--priority`、`--severity`
- `--sprint`（aliases `--iteration`/`--milestone`）、`--module`（alias `--component`）、`--version`、`--tag`（alias `--label`）
- `--tracker`（aliases `--watcher`/`--follower`）、`--participant`（aliases `--member`/`--collaborator`）、`--verifier`（alias `--reviewer`）、`--related-space`（alias `--related-project`）
- 人员类字段输入：**花名、账号、工号、邮箱**（自动解析为 staffID）
- 枚举类字段（priority/severity 等）接受**英文标识符、中文别名或数字 ID**；具体候选值用 `field options <field> --type <type>` 查询

**--cfs 使用说明：**
- key 可以是字段的数字标识符（如 79）或显示名称（如 "计划开始日期"）
- value 格式取决于字段类型：
  - date 字段：`79=2024-01-01`
  - list/option 字段：`priority=medium` 或 `priority=中`（显示名或标识符均可）
  - multiList 字段：`100604=高,中`（逗号分隔多个值）
  - bool 字段：`160=是` 或 `160=否`
  - dynamic 字段：`141538=81369177`（按前缀搜索匹配）
  - input/string 字段：`123=文本内容`
  - int 字段：`101426=5`
  - float 字段：`100338=75.5`
- 使用 `a1 project workitem field list --type <type>` 查看可用字段及其类型
- 使用 `a1 project workitem field options <field> --type <type>` 查看字段可选值

### project workitem update <id>
更新工作项。支持更新系统字段、自定义字段、状态和描述。

**手动注册 flags：**
- `--body string` — 更新描述内容（Markdown 格式，本地图片自动上传图床）
- `--body-file string` — 从文件读取描述内容（Markdown 格式，本地图片自动上传图床）
- `--cfs stringArray` — 自定义字段 key=value（可重复，格式同 create 的 --cfs）

**可写字段 flag 由字段注册表自动生成**（与 create 命令同源），通过 `a1 project workitem update --help` 查看完整列表。常用字段与别名与 create 一致：`--title`、`--assignee`、`--status`、`--priority`、`--severity`、`--sprint`、`--module`、`--version`、`--tag`、`--tracker`、`--participant`、`--verifier`、`--related-space` 等。输入格式（人员字段支持花名/账号/工号/邮箱，枚举字段支持标识符/中文别名/数字 ID）也与 create 一致。

**输出：**
- `--format json` — JSON 格式输出变更摘要
- `--quiet` — 安静模式

### project workitem status <id>
变更工作项状态。
- `--to string` — 目标状态名称

> 注意：也可以使用 `a1 project workitem update <id> --status "目标状态"` 来更新状态。

### project workitem type list
列出项目可用的工作项类型。
- `--project string` — 项目 ID（覆盖已绑定项目）
- `--category string` — 按类别筛选：req / bug / task

### project workitem field list
列出工作项类型的所有字段定义（系统字段和自定义字段）。
- `--project string` — 项目 ID（覆盖已绑定项目）
- `--type string` — 工作项类型：接受数字标识符、类型名（如 `STO`）或显示名（如 `故事(STO)`）；不带 `--scope` 时必填
- `--scope string` — 列出所有字段（跨类型）：`project`（项目下全部字段）或 `personal`（个人空间字段）。**注意**：此处的 `--scope` 语义与 `project workitem list --scope` 不同（后者枚举值更广：personal/project/team/all/collect/associate/child），不要混淆

使用 `--scope project` 时自动列出项目下所有类型的全部字段，输出包含 **ALIASES** 列，显示每个字段对应的 CLI flag 名称。不带 `--scope` 时需指定 `--type`，输出包含格式、类名、类型、是否必填等详细信息。

### project workitem field options <field>
查看特定字段的可选值。根据字段类型自动路由到正确的 API：
- sprint/module/version/tag → 资源搜索 API
- user 字段 → 用户搜索 API
- space 字段 → 空间搜索 API
- product/business → 专用 fieldOption API
- status/状态 字段 → 工作项状态枚举 API（必须指定 `--type`）
- dynamic 字段 → dynamicOptions API
- 其他 → getOptions API
- `--project string` — 项目 ID（覆盖已绑定项目）
- `--type string` — 工作项类型：接受数字标识符、类型名或显示名（自定义字段必填）
- `--query string` — 搜索过滤（用于搜索类字段如 sprint、module、user 等）

### project workitem comment create <id>
添加工作项评论，支持 @mention 自动解析、内联图片上传和回复已有评论。
- `-m, --message string` — 评论内容
  - `@花名` 自动解析为 `@花名(工号)` 格式，后端识别后触发钉钉通知
  - `![alt](本地图片路径)` 自动上传到图床并替换为托管 URL
- `--reply-to int` — 要回复的父评论 ID（从 comment list 输出中获取）

```bash
a1 project workitem comment create 80500194 -m "评论内容"
a1 project workitem comment create 80500194 -m "@八鹤 请看一下这个问题"
a1 project workitem comment create 80500194 -m "截图 ![bug](./screenshot.png)"
a1 project workitem comment create 80500194 -m "回复内容" --reply-to 119474898
```

### project workitem comment list <id>
列出工作项评论（按时间正序，最老在上）。输出格式：`id #序号 评论人 时间`，回复评论会显示 `↪ Reply to #序号`。

```bash
a1 project workitem comment list 80500194
a1 project workitem comment list 80500194 --format json
```

### project workitem activity <id>

查看工作项的变更动态（活动日志/时间线）。展示谁在什么时候把什么字段从什么值改成了什么值。

- `--sort string` — 排序方式：`desc`（默认，最新在前）或 `asc`（最旧在前）
- `--limit int` — 最多显示条数（默认 50，设为 0 显示全部）
- `-f, --format json` — JSON 格式输出

```bash
a1 project workitem activity 81887072
a1 project workitem activity 81887072 --sort asc
a1 project workitem activity 81887072 --limit 10
a1 project workitem activity 81887072 --format json
```

---

## 工作项创建/更新标准流程

### 创建工作项标准流程

创建工作项时，尤其是涉及自定义字段时，**必须**按以下步骤确保字段值合法，否则 API 可能因必填字段缺失或值不合法而拒绝请求：

```bash
# 步骤 1: 确认工作项类型
a1 project workitem type list --project <id> --category req
# → 选择合适的 type identifier（如 "9"、"故事(STO)"）

# 步骤 2: 获取字段定义，识别必填字段
a1 project workitem field list --project <id> --type <type>
# → 查看 REQUIRED 列为 true 的字段——这些必须提供值
# → 查看 FORMAT 列了解字段类型（date/list/multiList/bool/dynamic 等）

# 步骤 3: 查询候选值（对 list/multiList/bool/dynamic/sprint/module/user 等选项类字段）
a1 project workitem field options <field> --project <id> --type <type>
a1 project workitem field options <field> --project <id> --type <type> --query "关键词"
a1 project workitem field options status --project <id> --type <type>  # 查询状态枚举；也支持“状态”
# → 从返回结果中选择正确的 identifier 作为 --cfs 的值

# 步骤 4: 构造创建命令，确保所有必填字段都有合法值
a1 project workitem create --project <id> --type <type> --title "标题" \
  --cfs <fieldId>=<value> --cfs <fieldId>=<value>
```

> **注意**：标题（subject）和项目 ID 总是必填。如果自定义必填字段未提供值，创建请求会被 API 拒绝。

### 更新工作项标准流程

更新工作项的自定义字段时，同样建议先查字段定义和候选值，以确保传入的值合法：

```bash
# 步骤 1: 查看字段定义（可省略如果已经知道字段标识符和类型）
a1 project workitem field list --project <id> --type <type>

# 步骤 2: 如需确认可选值
a1 project workitem field options <field> --project <id> --type <type>
a1 project workitem field options 状态 --project <id> --type <type>  # 查询状态枚举

# 步骤 3: 执行更新
a1 project workitem update <id> --cfs <fieldId>=<value> --title "新标题"
```

> 更新时只需提供要修改的字段，不需要提供所有字段。未提供的字段保持不变。

### project workitem delete <id>
删除普通工作项（不可恢复）。命令会先查询工作项属性；如果目标是节点流节点（`NodeflowNode`），则拒绝普通删除并提示使用 `project workitem node delete`，避免只删除关联工作项、在 Aone UI 中遗留无法继续定位的节点。
- `-y, --yes` — 跳过确认提示
- `--quiet` — 静默模式，仅输出 ID
- `--format json` — JSON 格式输出

```bash
a1 project workitem delete 80928250          # 交互式确认
a1 project workitem delete 80928250 --yes    # 跳过确认
a1 project workitem delete 80928250 --format json
```

### project workitem node
节点流工作项节点的管理命令组，作为后续节点流能力的统一入口。

#### project workitem node delete <workitem-id>
通过节点关联的工作项 ID 删除节点流节点（不可恢复）。命令会先检查节点是否存在以及是否包含未完成的子工作项；检查通过后再删除节点及其关联数据。

- `-y, --yes` — 跳过确认提示；非交互环境必须指定
- `--quiet` — 仅输出已删除节点关联的工作项 ID
- `--format json` — 输出包含 `id`、`kind`、`deleted` 的 JSON

```bash
a1 project workitem node delete 80928250          # 交互式确认
a1 project workitem node delete 80928250 --yes    # 跳过确认
a1 project workitem node delete 80928250 --yes --format json
```

> 节点流节点必须直接使用 `node delete`。不要先执行普通 `workitem delete`：关联工作项被删除后，后端将无法再通过该工作项 ID 定位节点。

### project workitem relation add <id> <type>:<target>
给工作项添加关联。关联格式为 `<type>:<target>`，type 支持以下值：

| 类型 | 说明 | target 格式 |
|------|------|-------------|
| parent | 父工作项 | 工作项 ID |
| sub | 子工作项 | 工作项 ID |
| relate | 关联 | 工作项 ID |
| blocks | 前置阻塞 | 工作项 ID |
| blocked-by | 被阻塞 | 工作项 ID |
| duplicate | 重复 | 工作项 ID |
| change | 变更 | 变更 ID（仅支持 Aone Change） |
| cr | 代码评审 | CR ID |
| tc | 测试用例 | 用例 ID |
| doc | 文档/链接 | URL |

```bash
a1 project workitem relation add 80994397 parent:80994398
a1 project workitem relation add 80994397 relate:80994399
a1 project workitem relation add 80994397 change:CR12345
a1 project workitem relation add 80994397 doc:https://yuque.alibaba-inc.com/xxx/doc
```

### project workitem relation remove <id> <type>:<target>
移除工作项的关联。type 和 target 格式同 add。

```bash
a1 project workitem relation remove 80994397 relate:80994399
a1 project workitem relation remove 80994397 doc:https://yuque.alibaba-inc.com/xxx/doc
```

### project workitem relation list <id> [--category workitem|dev|doc|asset|group]
列出工作项的所有关联，按类别分组展示。

**类别**：
- `workitem`：关联工作项（父项、子项、关联、阻塞、被阻塞、重复）
- `dev`：关联研发事项（Code Review、测试用例、变更）
- `doc`：关联文档（语雀、钉钉、其他链接、Done）
- `asset`：关联资产（Aone 应用、Aone 包、O2 应用、代码仓库、KBase 知识库、KBase 知识组）
- `group`：关联钉群（群名称、状态、入群链接）

不指定 `--category` 时展示所有类别。资产的普通输出展示类型、ID 和名称；JSON 输出在现有字段之外增加规范化的 `asset` 数组；quiet 模式每行输出一个资产对象 ID。未知资产分类会回退为原始 `objectCategory`，不会被丢弃。

钉群状态 `1` 显示为“正常”，状态 `2` 显示为“已解散”；没有入群链接时显示 `-`。JSON 输出使用 `group` 数组并保留原始数值状态，quiet 模式只输出实际存在的 `groupUrl`。默认查询全部类别时，钉群接口失败仅输出 warning 并继续展示其他关联；显式指定 `--category group` 时，接口失败会返回非零错误。

```bash
a1 project workitem relation list 81240965
a1 project workitem relation list 81240965 --category workitem
a1 project workitem relation list 81240965 --category dev
a1 project workitem relation list 81240965 --category doc
a1 project workitem relation list 81240965 --category asset
a1 project workitem relation list 81240965 --category group
a1 project workitem relation list 81240965 --format json
```

### 工作项描述中的本地图片（自动上传）

`create --body` / `update --body` / `--body-file` 支持在描述中使用 Markdown 图片语法引用本地图片文件，CLI 会自动上传到图床并替换为托管 URL。

**格式**：标准的 Markdown 图片语法 `![alt](path)`，path 为本地文件路径。

**支持格式**：png, jpg, jpeg, gif, bmp, webp

**路径解析**：
- 绝对路径：`/Users/me/screenshot.png`
- 相对路径：基于 `--body-file` 文件所在目录解析（`--body` 直接传入时基于当前工作目录）

**示例**：
```bash
# 在描述中嵌入单张本地图片
a1 project workitem create --title "UI bug" --body '## 复现截图\n\n![screenshot](/tmp/bug.png)' --category bug --project 123

# 使用 --body-file，文件中可引用相对路径图片
a1 project workitem update 81460160 --body-file ./description.md
# description.md 内容示例：
# ## 问题说明
# ...
# ![复现步骤](./images/step1.png)
# ![结果](./images/result.png)
```

> **Agent 使用提示**：当用户提供截图或本地图片文件、且意图是创建/更新工作项描述时，应将图片路径以 `![描述](/path/to/image.png)` 写入 `--body`，而不是分析图片内容。CLI 负责处理上传和 URL 替换。

## CoCo 工作流（project workflow）

`project workflow` 与 `project workitem` 平级，负责查询、创建、发布、导出工作流模板，以及启动和查询 CoCo 工作流实例。命令不会持续轮询实例状态；仍不提供模板在线编辑、归档、恢复、删除，或实例暂停、恢复、取消、审批、重跑操作。

所有子命令都继承 `a1 project` 的输出标志：

- `--format json`：输出稳定 JSON，成功数据不会混入说明文字。
- `--quiet`：只输出便于脚本继续处理的关键标识。

### project workflow template list

按项目查询全部可见工作流模板，包括项目模板及自动合并的官方已发布模板。

- `--project string`：项目 ID；省略时使用当前已绑定项目。
- `--status string`：可选的单状态过滤，仅允许 `draft`、`published`、`archived`。值会执行 trim 和小写化；未知值及逗号拼接的多状态在请求前失败。
- `--mine`：保留当前用户创建的项目模板，同时保留官方模板。仅使用该参数时才解析当前用户工号；解析失败会明确报错。
- `--official`：仅保留官方模板。
- `--status`、`--mine`、`--official` 按 AND 组合。`--mine` 与 `--official` 同时使用时最终只保留官方模板。
- status 由 CoCo 服务端过滤；mine/official 由 CLI 对返回列表本地过滤，不改变服务端 `updated_at DESC` 顺序。
- 不支持 `--keyword`、多状态或分页。模板写操作使用下列独立子命令。

```bash
a1 project workflow template list --project 2155669
a1 project workflow template list --status published
a1 project workflow template list --mine --format json
a1 project workflow template list --status published --mine --official
a1 project workflow template list --official --quiet
```

输出：

- 默认：`ID | Name | Status | Version | Official | Created By | Updated At` 表格，模板 ID 完整输出；空列表提示 `No workflow templates found`。
- JSON：稳定返回 `{"items": [...]}`，每项保留 CoCo 模板完整 snake_case 字段与 nodes；空列表为 `{"items": []}`。
- quiet：每行一个模板 ID；空列表不输出内容。
- 空列表在三种模式下均成功退出；CoCo 的 401/403/404/5xx 错误保持非零失败，不伪装为空列表。

### project workflow template create

从便携 JSON 文件创建模板草稿。项目解析沿用现有规则，可通过 `--project` 指定；省略时使用当前目录绑定的项目。

- `--project string`：目标项目 ID；省略时使用当前目录绑定的项目。
- `--file string`：必填，便携模板 JSON 文件路径。
- `--skip-role-provision`：只创建草稿，不查询、创建或克隆角色，也不回写角色 ID。用于调用方明确自行处理角色的场景。
- `--format json`：输出创建结果、角色落地动作、未解析角色和 `partial` 状态。
- `--quiet`：仅输出草稿模板 ID。

```bash
a1 project workflow template create --project 2155669 --file ./workflow-template.json
a1 project workflow template create --project 2155669 --file ./workflow-template.json --format json
a1 project workflow template create --project 2155669 --file ./workflow-template.json --skip-role-provision
```

默认流程先校验本地 JSON，再创建草稿；随后列出目标项目角色，对缺失引用执行角色落地，将克隆角色的新 ID 回写到模板。若草稿创建后的角色查询、落地或回写失败，草稿不会回滚：命令会输出草稿 ID 和部分成功说明，并以非零状态退出。收到这种结果后先人工检查草稿及角色，再决定是否发布。

便携 JSON 顶层格式固定如下；顶层未知字段会拒绝，`nodes` 内未知字段会保留以兼容新版本节点能力：

```json
{
  "schemaVersion": 1,
  "kind": "coco.workflow.template",
  "name": "研发交付流程",
  "description": "编码、测试和发布",
  "roleNames": {
    "role-coding": "编码 Agent"
  },
  "nodes": []
}
```

`schemaVersion`、`kind`、`name`、`description`、`nodes` 必填；当前仅支持 `schemaVersion: 1` 和 `kind: "coco.workflow.template"`。`roleNames` 可选，仅用于提升导出文件可读性，创建时以节点中的 `roleId` 引用为准。输入必须是完整对象，不能直接传裸 `nodes` 数组。

### project workflow template publish <template-id>

发布指定项目中的模板草稿。

- `<template-id>`：必填，待发布模板 ID。
- `--project string`：模板所属项目 ID；省略时使用当前目录绑定的项目。
- `--format json`：输出发布后的完整模板对象。
- `--quiet`：仅输出模板 ID。

```bash
a1 project workflow template publish wt-123 --project 2155669
a1 project workflow template publish wt-123 --project 2155669 --format json
```

发布会修改真实模板状态。对 `create` 返回部分成功的草稿，不应直接发布；先确认角色已正确落地、节点中没有悬空角色引用。

### project workflow template export <template-id>

读取当前模板详情并输出可再次用于 `create` 的便携 JSON。

- `<template-id>`：必填，待导出模板 ID。
- `--project string`：模板所属项目 ID；省略时使用当前目录绑定的项目。
- `--output string`：可选，写入指定文件；拒绝覆盖已有文件，并通过同目录临时文件原子落盘。
- 未传 `--output` 时 stdout 只包含格式化 JSON，可安全重定向或交给其他程序解析。

```bash
a1 project workflow template export wt-123 --project 2155669
a1 project workflow template export wt-123 --project 2155669 --output ./workflow-template.json
```

导出会尽力查询项目角色并补充 `roleNames`。角色查询失败不影响模板主体导出，警告只写 stderr，stdout/输出文件仍保持纯 JSON。导出的是模板当前版本，不包含来源项目、模板 ID、创建人等环境绑定元数据。

### project workflow start <workitem-id>

从指定工作项启动一个工作流实例。

- `<workitem-id>`：必填，Aone 工作项 ID。
- `--template-id string`：必填，已发布的 CoCo 工作流模板 ID。
- 不提供 `--project`。命令会先读取工作项详情，以其中的 `spaceIdentifier` 作为唯一项目来源。
- 启动请求会冻结工作项 ID、标题、状态、状态阶段 ID、负责人和描述；读取工作项失败或项目为空时不会发起启动请求。
- POST 启动请求不会自动重试。重试前先用项目列表检查是否已经产生相同工作项与模板的实例。

```bash
a1 project workflow start 84198737 --template-id tpl-1
a1 project workflow start 84198737 --template-id tpl-1 --format json
a1 project workflow start 84198737 --template-id tpl-1 --quiet
```

输出：

- 默认：可直接打开的实例 URL，以及实例 ID、状态、项目、工作项、模板及版本、发起人和发起时间。
- JSON：顶层 `url` 字段，以及完整 `instance`、`stages`、`gate_runs` 对象。
- quiet：仅实例 ID。

实例 URL 根据响应中的项目 ID 和实例 ID 动态生成，格式为 `https://project.aone.alibaba-inc.com/coco/projects/<project-id>/workflows/instances/<instance-id>`。

### project workflow list

列出项目范围内最新的工作流实例。

- `--project string`：项目 ID；省略时使用当前已绑定项目。
- `--started-by string`：可选，按发起人工号过滤。
- `--status stringSlice`：可选，按实例状态过滤；可重复传入或使用逗号分隔多个值，匹配不区分大小写。
- 不接收工作项位置参数。需要定位某工作项时，使用 JSON 输出后按 `workitem_id` 过滤。
- 当前常见状态为 `running`、`paused`、`succeeded`、`failed`、`cancelled`。状态过滤作用于服务端返回的项目最新 200 条实例，本期没有分页标志。

```bash
a1 project workflow list --project 2155669
a1 project workflow list --project 2155669 --started-by 368136
a1 project workflow list --project 2155669 --status running
a1 project workflow list --status running,paused
a1 project workflow list --status failed --status cancelled --format json
a1 project workflow list --project 2155669 --format json
a1 project workflow list --quiet
```

输出：

- 默认：完整实例 ID（不截断）、状态、项目、工作项、模板、发起人和发起时间表格；空列表提示 `No workflow instances found`。
- JSON：`{"items": [...]}`；空列表稳定返回 `{"items": []}`。
- quiet：每行一个实例 ID。

### project workflow get <instance-id>

查询单个工作流实例的完整详情。

- `<instance-id>`：必填，CoCo 工作流实例 ID。

```bash
a1 project workflow get <instance-id>
a1 project workflow get <instance-id> --format json
a1 project workflow get <instance-id> --quiet
```

输出：

- 默认：实例概要、阶段列表和迭代门禁列表。
- JSON：完整 `instance`、`stages`、`gate_runs` 对象，保留 CoCo 字段名。
- quiet：实例 ID 与状态摘要。

常见错误：

- 工作项或实例不存在：返回包含 `NOT_FOUND` 的错误并以非零状态退出。
- a1-server 未配置 `coco` authInfo：返回不支持或配置缺失错误，不回退到浏览器 Cookie 或直连 CoCo。
- CoCo 返回 401/403：保留身份或权限错误，不转换成伪成功结果。
- 模板不存在、不可启动或结构无效：保留 CoCo 返回的错误码与说明。
- 网络超时：返回统一网络错误；启动命令不会因超时自动重试。

### project workitem attachment — 附件管理

管理工作项的附件，支持列表、上传、下载和删除。

### attachment list
列出工作项的附件。
```bash
a1 project workitem attachment list <id>
```

### attachment upload
上传文件作为工作项附件。
```bash
a1 project workitem attachment upload <id> <file-path> [--project <id>]
```

### attachment download
下载工作项附件。
```bash
a1 project workitem attachment download <id> <attachment-id> [-o <output-path>]
```
- `-o, --output string` — 输出文件路径（默认输出到 stdout）

### attachment delete
删除工作项附件（不可逆）。
```bash
a1 project workitem attachment delete <id> <attachment-id>
```

---

## 视图管理（project view）

管理工作项视图（保存的过滤/列/排序/分组配置）。完整 flag 用 `a1 project view <子命令> --help` 查看。

- `a1 project view list` — 列出视图
- `a1 project view get <view-id>` — 查看视图详情
- `a1 project view create --name "..."` — 创建视图
- `a1 project view update <view-id>` — 更新视图（读-改-写，未指定字段保持不变）
- `a1 project view delete <view-id>` — 删除视图

视图作用域：指定 `--project` 或已关联项目 → 项目空间；均未指定 → 个人空间；可用 `--scope personal/project` 强制切换。

---


## 用户组管理（project usergroup）

管理用户组（团队）。成员和管理员用逗号分隔的工号（staffId）指定。

- `a1 project usergroup list` — 列出我管理的用户组（含成员/管理员花名）
- `a1 project usergroup get <group-id>` — 查看用户组成员列表
- `a1 project usergroup create --name "..." --members <staffIds> --admins <staffIds>` — 创建用户组
- `a1 project usergroup update <group-id> [--name "..."] [--members <staffIds>] [--admins <staffIds>]` — 编辑用户组（只更新指定字段）
- `a1 project usergroup delete <group-id> [--yes]` — 删除用户组
- `a1 project usergroup search <query>` — 按名称搜索用户组

---
### staff list
按关键词搜索员工。
- `--query string` — 搜索关键词（姓名、工号等）

### staff get <employee-id>
查看员工详情。

### staff sync <worker-id>
同步单个公共账号（WORKER 账号）到 ACP 和 Aone BUC。

- `<worker-id>` — 公共账号 ID，格式为 `WORKER_` 加数字，例如 `WORKER_1772248954028`
- 当前只支持一次同步一个公共账号
- 命令会并行调用 ACP 同步和 Aone BUC 同步；两个端点都成功时整体成功
- 支持 `--format json` 输出结构化结果，支持 `--quiet` 只输出成功的 worker ID

示例：

```bash
a1 staff sync WORKER_1772248954028
a1 staff sync worker_1772248954028 --format json
```
