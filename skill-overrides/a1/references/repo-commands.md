# repo 命令完整参考

## a1 repo — 代码仓库管理

### 全局标志
- `--repo string` — 覆盖绑定的仓库（repoId 或 group/project 路径）
- `-v, --verbose` — 启用详细输出

---

## 仓库基础操作

### repo link [group/project | repo-id]
绑定当前目录到代码仓库。无参数时自动从 git remote 检测。

### repo unlink [id]
移除仓库绑定。
- `--all` — 移除所有绑定

### repo view [repo-path-or-id]
查看仓库详情。
- `-f, --format string` — 输出格式（plain/json）
- `-q, --quiet` — 仅输出 ID

### repo list
列出和搜索仓库。
- `-k, --keyword string` — 搜索关键词
- `--sort string` — 排序方式
- `--order-by string` — 排序字段
- `--page int` — 页码
- `--per-page int` — 每页数量

### repo open
在浏览器中打开仓库。
- `--mr int` — 打开指定 MR（拼接 `<repoUrl>/codereview/<mr-id>`）
- `--repo string` — 指定仓库（覆盖绑定仓库）

### repo create
创建新仓库。
- `-g, --group string` — 所属组（必需）
- `-n, --name string` — 仓库名称（必需）
- `-d, --description string` — 描述
- `--link` — 创建后自动缓存仓库元数据
- `--create-group` — 如果 group 不存在则自动创建

### repo security
检查仓库安全等级。

---

## 合并请求（repo mr）

> **重要：所有 MR 相关命令中的 ID 参数均为 MR ID（即合并请求的唯一标识），而非 iid。iid 参数已在代码平台废弃，请勿使用。**

### repo mr list
列出合并请求。使用 v5 search API，输出增强 9 列表格：ID, TITLE, AUTHOR, REPO, BRANCHES, STATE, CHECKS, COMMENTS, CHANGES。
- `--keyword string` — 搜索关键词
- `--mine string` — 筛选我的 MR：`created`（我创建的）/ `review`（需我评审的）
- `--state string` — 状态：opened / accepted / merged
- `--source string` — 源分支筛选（DSL: `source_branch:<branch>`）
- `--target string` — 目标分支筛选（DSL: `target_branch:<branch>`）
- `--order-by string` — 排序字段：updated_at / created_at
- `--sort string` — 排序方向：asc / desc
- `--page int` — 页码

> 无 repo 上下文且无 `--mine` 时报错退出。`--mine` 时 repo 上下文可选。

### repo mr view <mr-id>
查看 MR 详情。
- `--ci` — 显示关联 CI 状态（表格：RUN ID, NAME, STATE）
- `--files` — 显示变更文件列表
- `--work-items` — 显示关联工作项（ID, Subject, Assigned To, Link）
- `--cr` — 显示关联变更单（CR ID, Description, Link）

### repo mr create
创建合并请求。
- `--source string` — 源分支（必需）
- `--target string` — 目标分支（默认 default branch）
- `--title string` — 标题（必需）
- `--description string` — 描述
- `--assignees string` — 评审人姓名或工号（逗号分隔，CLI 自动解析为 user ID）。省略时自动填充仓库默认评审人
- `--no-default-reviewers` — 禁止自动填充仓库默认评审人（脚本场景使用）
- `--work-items string` — 关联 Aone 工作项 ID（逗号分隔）

### repo mr merge <mr-id>
合并 MR。
- `--merge-type string` — 合并类型
- `--message string` — 合并提交信息
- `--delete-branch` — 合并后删除源分支

### repo mr approve <mr-id>
批准 MR。

### repo mr diff <mr-id> [file-path]
查看 MR diff。可选指定文件路径只看单文件 diff。
- `-U, --context int` — diff 上下文行数

### repo mr remind <mr-id>
催促评审人。

### repo mr upvote <mr-id>
点赞 MR（或取消点赞）。
- `--undo` — 取消已有的点赞

### repo mr close <mr-id>
关闭 MR。

### repo mr reopen <mr-id>
重新打开已关闭的 MR。

### repo mr edit <mr-id>
编辑 MR。
- `--title string` — 新标题
- `--description string` — 新描述
- `--assignees strings` — 新指派人列表

### repo mr status [mr-id]
检查 MR 合并就绪状态（基于平台 `approve_check_result` 权威结论）。
- `--source string` — 源分支（不指定 mr-id 时按分支查找 MR）
- `--target string` — 目标分支（配合 `--source` 使用）
- `-f, --format string` — 输出格式：plain / json

> `<mr-id>` 或 `--source` 必须提供其一。check_type 包括：discussion, test, approver_number, code_owner, ai_comment, trybots 等。

### repo mr reviewers
列出当前仓库的推荐评审人候选，用于找到合适的 `--assignees`。
- 无位置参数，读取绑定仓库（或 `--repo` 覆盖）
- 支持 `-f json` / `-q`（quiet 只输出 ID）

---

## 分支管理（repo branch）

### repo branch list
列出仓库分支。
- `--keyword string` — 搜索关键词
- `--mine` — 只显示我的分支
- `--type string` — 类型：all / active / stale
- `--page int`, `--per-page int`

### repo branch create <name>
创建分支。
- `--from string` — 基于哪个分支/commit 创建

### repo branch delete <name>
删除分支。
- `-y, --yes` — 跳过确认

### repo branch merge
合并分支。
- `--source string` — 源分支
- `--target string` — 目标分支
- `--merge-type string` — 合并类型
- `--message string` — 合并提交信息
- `--author-name string`, `--author-email string`

### repo branch diff <branch> [file-path]
查看分支与默认分支的 diff。无 file-path 时列出变更文件列表；有 file-path 时显示该文件 diff。
- `--from string` — 对比基准分支（默认为仓库 default branch）

### repo branch commits [branch]
查看分支提交历史。
- `--path string` — 按文件路径筛选
- `--since string`, `--until string` — 时间范围
- `--page int`, `--per-page int`

---

## MR 评论（repo mr comment）

所有评论命令需要 `--mr <mr-id>` 标志。

### repo mr comment list
列出 MR 评论（自动过滤推送总结类自动评论）。
- `--mr int` — MR ID（必需）
- `--resolved` — 仅显示已解决的根级行内评论
- `--unresolved` — 仅显示未解决的根级行内评论
- `--sort string` — 按创建时间排序：asc / desc（默认 desc）

### repo mr comment create
添加评论。
- `--mr int` — MR ID（必需）
- `-m, --message string` — 评论内容
- `--file string` — 行级评论的文件路径
- `--line int` — 行级评论的行号
- `--reply-to int` — 回复某条评论

### repo mr comment resolve <comment-id>
解决评论。
- `--mr int` — MR ID（必需）

### repo mr comment emoji
给评论添加或移除表情反应。
- `--mr int` — MR ID（必需）
- `-c, --comment int` — 评论 ID（必需）
- `--add string` — 要添加的表情（如 "👍"），与 `--remove` 互斥
- `--remove int` — 要移除的表情 action ID，与 `--add` 互斥

> 表情信息会在 `comment list` 的 EMOJIS 列中以紧凑格式展示（如 "👍×3 🎉×1"）。

**可选表情列表**（与前端 UI 保持一致）：

| 名称 | 表情 |
|---|---|
| ok | 👌🏻 |
| +1 | 👍 |
| -1 | 👎 |
| smile | 😊 |
| tada | 🎉 |
| thinking_face | 😕 |
| heart | ❤️ |
| rocket | 🚀 |
| eyes | 👀 |

### repo mr comment label
管理评论上的标签关联（操作已有标签与评论的关联关系，不是标签定义）。
- `--mr int` — MR ID（必需）
- `-c, --comment int` — 评论 ID（`--set` 时必需）
- `--set string` — 要设置的标签 ID 列表（逗号分隔），与 `--remove-record` 互斥
- `--remove-record int` — 要移除的标签记录 ID，与 `--set` 互斥
- `--draft` — 目标是 draft 评论（配合 `--set` 使用）

> 标签信息会在 `comment list` 的 LABELS 列中展示（如 "bug,nit"）。

### repo mr comment ai list
列出 MR 上 AI 自动生成的评审评论（ID, STATUS, FILE, LINE, COMMENT）。
- `--mr int` — MR ID（必需）

### repo mr comment ai adopt / ignore / reject
操作 AI 评审评论：采纳（adopt）、忽略（ignore）、拒绝/误报（reject，别名 `false-positive`）。
- `<comment-id>` — AI 评论 ID（位置参数，必需）
- `--mr int` — MR ID（必需）

### repo mr comment ai trigger
触发 MR 的 AI 代码评审。需要仓库上下文（`--repo` 或已绑定仓库）+ MR ID。
- `--mr int` — MR ID（必需）
- `--model string` — 指定 AI 模型（可选，见 `ai models` 获取可用列表）

### repo mr comment ai status
查询 MR 的 AI 评审运行状态（NONE/RUNNING/SUCCEED/FAILED/CANCELED/TIMEOUT）。需要仓库上下文 + MR ID。
- `--mr int` — MR ID（必需）

### repo mr comment ai models
列出可用的 AI 评审模型（NAME, VALUE, INTERNAL）。使用 `--repo` 解析的 project ID 查询，`--mr` 为父命令语法要求，值不影响结果。
- `--mr int` — MR ID（父命令语法要求，值不影响结果）

---

## 仓库标签管理（repo label）

管理项目级评论标签定义。这些标签可通过 `a1 repo mr comment label` 关联到评论。

### repo label list
列出项目标签（ID, NAME, COLOR, SCOPE）。

### repo label create
创建标签。
- `-n, --name string` — 标签名称（必需，如 "bug", "nit", "suggestion"）
- `--color string` — 标签颜色（必需，hex 格式含 # 前缀，如 "#ff0000"）

### repo label delete <label-id>
删除标签。

---

## 文件操作（repo file）

> ⚠️ repo file 参数：只读命令（list/view/blame）历史上用 `--ref`，写入命令（create/edit/delete）历史上用 `--branch`。现两者已互通——`--ref` 与 `--branch` 在所有 file 子命令中等价可用，凭习惯任选其一即可；但写入命令**不要**同时传 `--ref` 和 `--branch`（互斥，会报错）。

### repo file list [dir-path]
列出仓库文件。无参数或 `/` 表示根目录。
- `--ref string` — 分支/commit/tag
- `--type string` — DIRECT（直接子项，默认）/ RECURSIVE（递归含层级）/ FLATTEN（递归扁平化）

### repo file view <file-path>
查看文件内容。
- `--ref string` — 分支/commit/tag
- `--start-line int`, `--end-line int` — 行范围

### repo file create <file-path>
创建文件。
- `--content string` — 文件内容
- `--branch string` — 目标分支
- `--message string` — 提交信息

### repo file edit <file-path>
编辑文件。
- `--content string` — 新内容
- `--branch string` — 目标分支
- `--message string` — 提交信息

### repo file delete <file-path>
删除文件。
- `--branch string` — 目标分支
- `--message string` — 提交信息

### repo file blame <file-path>
查看文件 blame 信息。
- `--ref string` — 分支/commit/tag
- `--start-line int`, `--end-line int` — 行范围

---

## 标签管理（repo tag）

### repo tag list
列出仓库标签。
- `-k, --keyword string` — 按标签名搜索（服务端子串匹配）
- `--page int` — 页码
- `--per-page int` — 每页数量

### repo tag view <tag-name>
查看标签详情（Name, Commit, Author, Date, Annotation, Release Description）。
- 含 `/` 的标签名（如 `release/1.0.0`）会自动 URL 编码

### repo tag create <tag-name>
创建标签。
- `--ref string` — 基于的引用（分支名/tag 名/commit SHA）（必需）
- `-m, --message string` — 注解信息（创建 annotated tag）
- `--description string` — Release 描述（未提供且 stdin 非 tty 时从 stdin 读取）

### repo tag delete <tag-name>
删除标签（破坏性操作，需确认）。
- `-y, --yes` — 跳过确认

---

## MR 工作项关联（repo mr workitem）

所有 workitem 命令需要 `--mr <mr-id>` 标志。

### repo mr workitem list
列出 MR 关联的工作项。
- `--mr int` — MR ID（必需）

### repo mr workitem add
关联工作项到 MR。
- `--mr int` — MR ID（必需）
- `--ids string` — 工作项 ID 列表（逗号分隔）

### repo mr workitem remove
取消关联工作项。
- `--mr int` — MR ID（必需）
- `--id int` — 要取消关联的工作项 ID

---

## MR 变更单关联（repo mr cr）

### repo mr cr list
列出 MR 关联的变更单。
- `--mr int` — MR ID（必需）

---

## 代码搜索（repo search）

### repo search <keyword>
搜索代码。`--repo` flag 继承自父命令，无需单独注册。
- `--global` — 全局搜索（不限当前仓库，覆盖 repo 上下文）
- `--lang string` — 语言筛选（如 Java, Go, Python）
- `-t, --type string` — 搜索类型：code / class / method
- `--page int`, `--per-page int`

---

## 全局 Flag 补充

### --verbose / -v（repo 级持久 flag）
启用详细输出：显示 HTTP 请求/响应日志和内部解析步骤，输出到 stderr。
- 与 `--quiet` 互斥，同时指定会报错退出
- `Private-Token` header 值在 verbose 输出中会被脱敏为 `[REDACTED]`
