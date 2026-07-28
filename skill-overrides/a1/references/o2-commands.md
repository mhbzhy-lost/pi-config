# o2 命令完整参考

## a1 o2 — O2 前端应用管理

管理 O2 前端应用、迭代、变更和发布任务。

---

## 应用管理（o2 app）

### o2 app list

列出 O2 应用。默认列出当前用户的应用。

- `-k, --keyword string` — 按应用名搜索
- `--all` — 搜索所有应用（需配合 `--keyword`）
- `--page int` — 页码（从 0 开始，默认 0）
- `--page-size int` — 每页条数（默认 10）
- `-f, --format string`, `-q, --quiet`

### o2 app view [app-id-or-name]

查看应用详情。省略参数时使用已关联的 O2 应用。

- `-f, --format string`, `-q, --quiet`

### o2 app create

创建新的 O2 前端应用。

- `--group string` — **必填** 代码组（group/project）
- `--project string` — **必填** 代码项目名
- `--pubtype string` — 发布类型：assets（默认）、tnpm
- `--npm-name string` — npm 包名（tnpm 类型必填）
- `--generator-id int` — 脚手架生成器 ID
- `--generator-config string` — 脚手架生成器配置（JSON 字符串）

### o2 app update-conf [app-id-or-name]

更新应用配置。

- `--app string` — 应用 ID 或名称（默认从 o2 app link 读取）
- `--online-build string` — 在线构建开关：on 或 off
- `--tnpm-cdn string` — tnpm CDN 同步开关：on 或 off

### o2 app add-member [app-id-or-name]

添加应用成员。

- `--app string` — 应用 ID 或名称（默认从 o2 app link 读取）
- `--emp-id string` — **必填** 员工 ID
- `--role string` — 成员角色：developer（默认）、tester、code_reviewer
- `--git bool` — 同时添加代码仓库权限（默认 true）

### o2 app member [app-id-or-name]

列出应用成员及其角色。省略参数时使用已关联的 O2 应用。

- `--app string` — 应用 ID 或名称（默认从 o2 app link 读取）
- `-f, --format string`, `-q, --quiet`

### o2 app remove-member [app-id-or-name]

移除应用成员的角色。Owner 角色不可通过此命令移除。

- `--app string` — 应用 ID 或名称（默认从 o2 app link 读取）
- `--emp-id string` — **必填** 员工 ID
- `--role string` — **必填** 要移除的角色：developer、tester、code_reviewer

### o2 app sync-member [app-id-or-name]

将自己在 GitLab 上的权限同步到当前 O2 应用成员列表。省略参数时使用已关联的 O2 应用。

- `--app string` — 应用 ID 或名称（默认从 o2 app link 读取）

### o2 app link [name-or-id]

关联当前目录到 O2 应用。无参数时从 git remote 自动检测；交互式终端下支持搜索选择。

### o2 app unlink [id]

取消关联。

- `--all` — 移除所有关联

---

## 迭代管理（o2 iteration）

### o2 iteration list [app-id-or-name]

列出应用的迭代。

- `--app string` — 应用 ID 或名称（默认从 o2 app link 读取）
- `--status string` — 迭代状态：ongoing、done、abandoned
- `--name string` — 按迭代名称模糊搜索
- `--description string` — 按描述模糊搜索
- `--emp-id string` — 按创建人员工 ID 过滤
- `--version string` — 按版本号过滤
- `--envstep int` — 迭代阶段（4=灰度发布）
- `--order string` — 排序方向：asc 或 desc
- `--order-target string` — 排序字段：gmt_create 或 last_operate_time
- `--page int` — 页码（从 0 开始）
- `--page-size int` — 每页条数（默认 10）
- `-f, --format string`, `-q, --quiet`

### o2 iteration view <iteration-id>

查看迭代详情。

- `-f, --format string`, `-q, --quiet`

### o2 iteration create

创建新迭代。

- `--app string` — 应用 ID 或名称（默认从 o2 app link 读取）
- `--name string` — **必填** 迭代名称
- `--description string` — 迭代描述
- `--trunk string` — 主干分支名
- `--version string` — 版本号（不填则自动生成）

### o2 iteration abandon <iteration-id>

废弃迭代。

### o2 iteration add-change

创建变更并关联到迭代，或绑定已有变更到迭代。

- `--iteration-id int` — **必填** 迭代 ID
- `--branch string` — 分支名（type=new 时必填）
- `--trunk string` — 主干分支名（默认 master）
- `--branch-type string` — 分支类型：new（默认）或 exist
- `--type string` — 操作类型：new（新建变更，默认）或 exist（绑定已有）
- `--description string` — 变更描述
- `--aone-req-id int` — 关联 Aone 需求 ID
- `--branch-ids string` — 已有变更 ID，逗号分隔（type=exist 时使用）

### o2 iteration join

将当前 git 分支加入迭代。自动检测当前分支，若分支已存在对应变更则直接绑定，否则创建新变更。

- `--iteration-id int` — **必填** 迭代 ID
- `--trunk string` — 主干分支名（默认 master）
- `--description string` — 变更描述（默认使用分支名）
- `--aone-req-id int` — 关联 Aone 需求 ID

### o2 iteration exit

将当前 git 分支的变更从迭代中移除。

- `--iteration-id int` — 迭代 ID（默认从当前分支自动解析）

---

## 变更管理（o2 change）

### o2 change list

列出当前用户进行中的变更。

- `--page int` — 页码（从 0 开始）
- `--page-size int` — 每页条数（默认 10）
- `-f, --format string`, `-q, --quiet`

### o2 change view [change-id]

查看变更详情，包含代码评审和质量检查结果。省略 change-id 时从当前 git 分支自动检测。

- `--app string` — 应用 ID 或名称（默认从 o2 app link 读取）
- `-f, --format string`, `-q, --quiet`

### o2 change add

创建独立变更（不关联迭代）。

- `--app string` — 应用 ID 或名称（默认从 o2 app link 读取）
- `--branch string` — **必填** 分支名
- `--trunk string` — 主干分支名
- `--branch-type string` — 分支类型：new（默认）或 exist
- `--description string` — 变更描述
- `--aone-req-id int` — 关联 Aone 需求 ID

### o2 change create-cr

为变更创建代码评审（MR）。省略 `--branch-id` 和 `--iteration-id` 时从当前 git 分支自动检测。

- `--app string` — 应用 ID 或名称（默认从 o2 app link 读取）
- `--iteration-id int` — 迭代 ID（省略时自动检测）
- `--branch-id int` — 变更/分支 ID（省略时自动检测）
- `--assignee-ids string` — **必填** 评审人员工 ID，逗号分隔
- `--title string` — 评审标题（默认使用变更描述）
- `--description string` — 评审描述

---

## 发布任务（o2 task）

### o2 task view <task-id>

查看发布任务详情。

- `-f, --format string`, `-q, --quiet`

### o2 task result <task-id>

查看任务执行结果（构建产物和部署数据）。

- `-f, --format string`, `-q, --quiet`

### o2 task error-log <task-id>

查看任务的流水线错误日志。定位失败的 flownode 并输出其日志内容。

### o2 task watch <task-id>

轮询任务直到完成，实时显示进度。

- `-f, --format string`, `-q, --quiet`

### o2 task create

手动创建发布任务。

- `--iteration-id int` — **必填** 迭代 ID
- `--pub-env string` — 发布环境：daily（默认）、prepub、publish（亦接受别名 pre / prod 等）

---

## 快捷发布（o2 publish）

### o2 publish

创建发布任务并轮询直到完成。自动从当前 git 分支解析迭代。

- `--pub-env string` — 发布环境：daily（默认）、prepub、publish（亦接受别名 pre / prod 等）
- `--iteration-id int` — 迭代 ID（默认从当前分支自动解析）
- `--format / -f string` — 输出格式：table（默认）、json
- `--quiet / -q` — 仅输出任务 ID

别名：`o2 p`

使用 `--format json` 时，成功输出与 `o2 task result --format json` 结构一致（含 task、resources、link）；失败时输出 `{"error": "...", "taskId": <id>}`。

发布到 prod 环境前会自动检查 release checkpoint，若有 BLOCKED 或 FAIL 的检查点会中止发布。

发布前会验证指定的 pub-env 是否在迭代可用的发布环境列表中（grey 自动排除）；若获取环境列表失败则跳过验证继续发布。

---

## 灰度发布（o2 grey）

查看和管理灰度（canary）发布状态。迭代必须已进入灰度阶段（`envstep=4`）才可操作。

别名：`o2 g`

### o2 grey

查看灰度发布概览，包括阶段进度和已发布资源。

- `--app string` — 应用 ID 或名称（默认从 o2 app link 读取）
- `--iteration-id int` — 迭代 ID（默认从当前分支自动解析）
- `--format string` — 输出格式：json

### o2 grey next

推进灰度发布到下一阶段。

- `--app string` — 应用 ID 或名称
- `--iteration-id int` — 迭代 ID
- `--format string` — 输出格式：json

### o2 grey cancel

取消当前灰度发布。

- `--app string` — 应用 ID 或名称
- `--iteration-id int` — 迭代 ID
- `--format string` — 输出格式：json

---

## 应用创建工作流（o2 create-app）

三步工作流创建 O2 前端应用，与 `o2 app create`（脚手架创建）不同。

### o2 create-app pubtypes

列出支持通过 CLI 创建的发布类型（已按白名单过滤）。

- `-f, --format string`, `-q, --quiet`

### o2 create-app options <pub-type>

查询指定发布类型的创建选项（option key / title / tips / 可选值列表）。部分选项无 choices，仅提供 tips 提示用户输入。

| 参数         | 类型 | 必填 | 说明                                       |
| ------------ | ---- | ---- | ------------------------------------------ |
| `<pub-type>` | int  | 是   | 发布类型 ID，由 `create-app pubtypes` 获取 |

- `-f, --format string`, `-q, --quiet`

### o2 create-app generators

按数字发布类型 ID 查询可用脚手架列表。

- `--pub-type string` — **必填** 发布类型 ID
- `-f, --format string`, `-q, --quiet`

### o2 create-app generator

查询指定脚手架的原始 JSON Schema，用于构造 `--generator-data`。

- `--pub-type string` — **必填** 发布类型 ID
- `--id string` — **必填** generator ID
- `-f, --format string`, `-q, --quiet`

### o2 create-app submit

提交应用创建请求。

| 参数               | 类型   | 必填 | 说明                                                     |
| ------------------ | ------ | ---- | -------------------------------------------------------- |
| `--pub-type <id>`  | int    | 是   | 发布类型 ID（由 `create-app pubtypes` 获取）             |
| `--group <group>`  | string | 是   | 应用命名空间（代码组）                                   |
| `--project <name>` | string | 是   | 应用项目名                                               |
| `--options <json>` | string | 否   | 创建选项，JSON 对象格式（如 `'{"key":"value"}'`）       |
| `--generator-id <id>` | string | 否 | 可选脚手架 ID；需与 `--generator-data` 同时传入 |
| `--generator-data <json>` | string | 否 | 可选脚手架 JSON 数据；需与 `--generator-id` 同时传入 |
| `--members <ids>`  | string | 否   | 初始成员工号，逗号分隔（如 `123456,234567`）             |
| `--dry-run`        | bool   | 否   | 仅校验参数，不实际创建应用                               |

- `-f, --format string`, `-q, --quiet`

### 典型工作流

```bash
# 1. 查看支持的发布类型
a1 o2 create-app pubtypes

# 2. 查看某类型的创建选项（以 ID 5 为例）
a1 o2 create-app options 5

# 3. 如需固定脚手架，先查询脚手架与 schema
a1 o2 create-app generators --pub-type 5
a1 o2 create-app generator --pub-type 5 --id 6

# 4. 先 dry-run 校验
a1 o2 create-app submit --pub-type 5 --group my-group --project my-app --generator-id 6 --generator-data '{"npmName":"@ice/demo"}' --dry-run

# 5. 确认无误后正式提交（不传 generator 参数时由服务端选择默认脚手架）
a1 o2 create-app submit --pub-type 5 --group my-group --project my-app

# 6. 如需固定脚手架，再显式传入 generator 参数
a1 o2 create-app submit --pub-type 5 --group my-group --project my-app --generator-id 6 --generator-data '{"npmName":"@ice/demo"}'
```

---

## 应用关联（Link Context）

O2 应用使用独立的 link context（类型：`o2app`），与 `a1 app link` 的 Aone 应用关联互不影响。

```bash
a1 o2 app link              # 从 git remote 自动检测并关联
a1 o2 app link 504135       # 按 ID 关联
a1 o2 app link aone-km-fe   # 按名称关联
a1 o2 app unlink            # 取消当前关联
a1 link status              # 查看所有关联（含 O2 应用）
```

很多 o2 命令依赖已关联的 O2 应用上下文；未关联时需通过 `--app` 手动指定。

---

## 常见工作流

### 创建迭代并发布

```bash
a1 o2 app link                                    # 1. 关联应用
a1 o2 iteration create --name "Sprint 1"          # 2. 创建迭代
a1 o2 iteration join --iteration-id <id>          # 3. 当前分支加入迭代
a1 o2 publish                                     # 4. 发布到日常
a1 o2 publish --pub-env prepub                    # 5. 发布到预发
a1 o2 publish --pub-env publish                   # 6. 发布到生产
```

### 创建变更并发起代码评审

```bash
a1 o2 change add --branch feature/fix --description "Bug fix"     # 创建独立变更
a1 o2 change create-cr --assignee-ids "123456"                     # 发起 CR
```

### 排查发布失败

```bash
a1 o2 task view <task-id>                          # 查看任务状态
a1 o2 task error-log <task-id>                     # 查看错误日志
a1 o2 task result <task-id>                        # 查看执行结果
```

### 灰度发布流程

```bash
a1 o2 grey                                        # 1. 查看当前灰度状态和阶段
a1 o2 grey next                                   # 2. 推进到下一灰度阶段
a1 o2 grey cancel                                 # 3. 取消灰度发布（回滚）
```
