# kbase 命令完整参考

## 目录

- [总览](#总览)
- [知识库搜索](#kbase-search)
- [知识库页面](#kbase-page--知识库页面上传与管理)
- [CodeWiki 管理](#kbase-codewiki--codewiki-管理)
- [常见判断](#常见判断)

## 总览

`a1 kbase` 管理知识库、知识库页面、CodeWiki 和文档检索。

常见对象不要混淆：

| 对象 | 命令 | 标识 |
|------|------|------|
| 普通知识库页面 | `a1 kbase page ...` | `repo-id` + `page-id`；省略 `repo-id` 时使用已绑定 kbase repo |
| CodeWiki 仓库 | `a1 kbase codewiki ...` | 多数写入/生成/搜索命令用 `--code-repo <group/project>` |
| CodeWiki 已生成页面 | `a1 kbase codewiki pages/view ...` | 使用知识库 `repo-id` + `page-id` |
| CodeWiki 目录 | `a1 kbase codewiki dir ...` | `--code-repo` + 目录 UUID |
| CodeWiki 批量上传 | `a1 kbase codewiki upload ...` | 本地目录路径（含 `.codewiki-manifest.json`） |
| Aone Pages 静态站点 | `a1 pages ...` | 站点配置；不是 kbase/CodeWiki 页面 |

全局标志：

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `-f, --format` | string | `plain` | 输出格式：`plain` / `json` |
| `-q, --quiet` | bool | `false` | 仅输出关键 ID，便于脚本串联 |
| `--verbose` | bool | `false` | 输出调试信息 |
| `--config` | string | `$HOME/.config/a1/config.yaml` | 指定配置文件 |
| `--no-update-check` | bool | `false` | 禁用后台升级检查 |

---

## kbase search

跨知识库搜索。

```bash
a1 kbase search <query> [flags]
```

| Flag | Type | Description |
|------|------|-------------|
| `<query>` | string | 必填，搜索词 |
| `--top` | int | 返回数量，默认 `10` |
| `--summary` | bool | 返回摘要 |
| `--mode` | string | 搜索模式 |
| `--score-threshold` | float | 最低相关度分数 |
| `--group-ids` | string | 知识组 ID，逗号分隔 |
| `--repo-ids` | string | 知识库 ID，逗号分隔 |
| `--page-ids` | string | 页面 ID，逗号分隔 |
| `--tags` | string | 标签，逗号分隔 |

示例：

```bash
a1 kbase search "发布回滚" --top 5 --summary
a1 kbase search "CodeWiki" --repo-ids 61293 --score-threshold 0.6
```

---

## kbase page — 知识库页面上传与管理

### page create

创建/上传知识库页面。`repo-id` 可省略；省略时使用 `a1 kbase repo link` 绑定的知识库。

```bash
a1 kbase page create [repo-id] <name> [flags]
```

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `[repo-id]` | int | | 可选，知识库 ID |
| `<name>` | string | | 必填，页面标题/文件名 |
| `--content` | string | | 页面内容；支持 `@file.md` 从文件读取 |
| `--file` | string | | 从本地文件读取内容 |
| `--parent` | string | | 父目录 UUID |
| `--wiki` | bool | `false` | 创建 AI 编译 wiki 页，存储到 `_wiki/`，`typeCode=kb_wiki` |
| `--metadata` | string | | wiki 元数据 JSON；需要与 `--wiki` 一起使用 |
| `--vectorize` | bool | `true` | 普通 Markdown 上传后请求异步向量化；可传 `--vectorize=false` 关闭 |

内容来源优先显式传参：`--file` / `--content` / stdin。普通 Markdown 的向量化是异步服务端任务，命令在页面保存成功后返回，不等待索引完成。

示例：

```bash
a1 kbase page create notes.md --file ./notes.md
a1 kbase page create 61293 guide.md --content "# Guide"
cat file.md | a1 kbase page create notes.md
a1 kbase page create compiled.md --wiki --file ./compiled.md --metadata '{"type":"concept"}'
a1 kbase page create notes.md --file ./notes.md --vectorize=false
```

### page update

更新页面内容和/或 wiki 元数据。`repo-id` 可省略；省略时使用已绑定 kbase repo。

```bash
a1 kbase page update [repo-id] <page-id> [flags]
```

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `[repo-id]` | int | | 可选，知识库 ID |
| `<page-id>` | string | | 必填，页面 ID |
| `--name` | string | | 页面标题/文件名；更新内容时通常需要给出 |
| `--content` | string | | 新内容；支持 `@file.md` 从文件读取 |
| `--file` | string | | 从本地文件读取新内容 |
| `--wiki` | bool | `false` | 指定更新 wiki 页 |
| `--metadata` | string | | wiki 元数据 JSON；需要与 `--wiki` 一起使用 |
| `--vectorize` | bool | `true` | 内容保存后请求异步向量化；可传 `--vectorize=false` 关闭 |

示例：

```bash
a1 kbase page update 61293 abc-123 --name "Title.md" --content "# New"
a1 kbase page update abc-123 --name "Title.md" --file ./updated.md
cat file.md | a1 kbase page update abc-123 --name "Title.md"
a1 kbase page update abc-123 --wiki --metadata '{"type":"concept","sources":[]}'
```

### page view

查看页面内容，可一次查看多个页面，多个页面之间用 `---` 分隔。

```bash
a1 kbase page view [repo-id] <page-id> [page-id...] [flags]
```

| Flag | Type | Description |
|------|------|-------------|
| `[repo-id]` | int | 可选，知识库 ID |
| `<page-id>...` | string | 必填，一个或多个页面 ID |
| `--outline` | bool | 只显示 Markdown 标题大纲 |
| `--heading` | string | 读取指定标题段落 |
| `--heading-path` | string | 读取 slash 分隔的标题路径 |
| `--self-only` | bool | 读取标题段落时排除嵌套子章节 |
| `--version` | int | 查看指定版本 |

示例：

```bash
a1 kbase page view 61293 abc-123
a1 kbase page view 61293 abc-123 def-456
a1 kbase page view 61293 abc-123 --outline
a1 kbase page view abc-123 --heading-path "架构/鉴权" --self-only
```

### page delete

删除知识库页面。

```bash
a1 kbase page delete [repo-id] <page-id>
```

示例：

```bash
a1 kbase page delete 61293 f506ffe2-fb46-4d22-9f36-2f7fd86346e2
a1 kbase page delete f506ffe2-fb46-4d22-9f36-2f7fd86346e2
```

### page versions

列出页面版本历史。

```bash
a1 kbase page versions [repo-id] <page-id>
```

---

## kbase codewiki — CodeWiki 管理

### codewiki list

列出 CodeWiki 仓库。

```bash
a1 kbase codewiki list [flags]
```

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--keyword` | string | | 搜索关键字 |
| `--page` | int | `1` | 页码 |
| `--per-page` | int | `20` | 每页数量 |

### codewiki generate

触发 CodeWiki 生成。

```bash
a1 kbase codewiki generate [flags]
```

| Flag | Type | Description |
|------|------|-------------|
| `--code-repo` | string | 代码仓库 group/project，必填 |
| `--branch` | string | 分支名 |
| `--target-path` | string | 目标路径，MonoRepo 场景使用 |
| `--skip-if-exists` | bool | 已存在时跳过 |

示例：

```bash
a1 kbase codewiki generate --code-repo aone/a1
a1 kbase codewiki generate --code-repo aone/a1 --branch develop --target-path services/api
a1 kbase codewiki generate --code-repo aone/a1 --skip-if-exists
```

### codewiki associate

把 CodeWiki 关联到已有知识库。

```bash
a1 kbase codewiki associate [flags]
```

| Flag | Type | Description |
|------|------|-------------|
| `--code-repo` | string | 代码仓库 group/project，必填 |
| `--repo` | int | 知识库 repo ID，必填 |
| `--branch` | string | 分支名 |
| `--target-path` | string | 目标路径，MonoRepo 场景使用 |

示例：

```bash
a1 kbase codewiki associate --code-repo aone/a1 --repo 36809
```

### codewiki status

查看 CodeWiki 生成状态。

```bash
a1 kbase codewiki status <code-repo> [flags]
```

| Flag | Type | Description |
|------|------|-------------|
| `<code-repo>` | string | 必填，代码仓库 group/project |
| `--branch` | string | 分支名 |
| `--target-path` | string | 目标路径 |

用 `-f json` 可获取 `repoID`，后续 `codewiki pages/view` 需要这个知识库 repo ID。

### codewiki pages

列出 CodeWiki 页面。

```bash
a1 kbase codewiki pages <repo-id>
```

| Flag | Type | Description |
|------|------|-------------|
| `<repo-id>` | int | 必填，CodeWiki 关联的知识库 repo ID |

### codewiki view

查看 CodeWiki 页面内容。

```bash
a1 kbase codewiki view <repo-id> <page-id>
```

| Flag | Type | Description |
|------|------|-------------|
| `<repo-id>` | int | 必填，CodeWiki 关联的知识库 repo ID |
| `<page-id>` | string | 必填，页面 ID |

### codewiki download

下载 CodeWiki 页面到本地。下载全部页面时按原始目录结构组织，不会扁平化。

```bash
a1 kbase codewiki download <group/project> [page-id] [flags]
```

| Flag | Type | Description |
|------|------|-------------|
| `<group/project>` | string | 必填，代码仓库 group/project |
| `[page-id]` | string | 可选，指定时只下载单页 |
| `-o, --output` | string | 全量下载时为输出目录；单页下载时可为文件路径 |
| `--branch` | string | 分支名 |
| `--target-path` | string | 目标路径，MonoRepo 场景使用 |

示例：

```bash
a1 kbase codewiki download aone/a1
a1 kbase codewiki download aone/a1 --output ./wiki
a1 kbase codewiki download aone/a1 page-001 --output ./p.md
```

### codewiki upload

将本地修改上传回远端 CodeWiki。命令通过 `codewiki download` 生成的 `.codewiki-manifest.json` 做增量 diff，检测新增和已修改的 `.md` 文件并推送到服务端。

```bash
a1 kbase codewiki upload <directory> [flags]
```

| Flag | Type | Description |
|------|------|-------------|
| `<directory>` | string | 必填，包含 `.codewiki-manifest.json` 的本地目录 |
| `--dry-run` | bool | 仅展示计划操作，不执行实际上传 |

支持的操作（首版）：
- 新文件（不在 manifest 中的 `.md`）→ 创建页面
- 已修改文件（内容 hash 变化）→ 更新页面

示例：

```bash
# 预览将要上传的变更
a1 kbase codewiki upload ./wiki-aone-a1 --dry-run

# 执行上传
a1 kbase codewiki upload ./wiki-aone-a1
```

### codewiki dir — 目录管理

管理 CodeWiki 中的目录结构（创建 / 删除）。通过 `--code-repo <group/project>` 定位 CodeWiki。

#### dir create

```bash
a1 kbase codewiki dir create --code-repo <group/project> --name <name> [flags]
```

| Flag | Type | Description |
|------|------|-------------|
| `--code-repo` | string | 必填，代码仓库 group/project |
| `--name` | string | 必填，目录名称 |
| `--parent-dir-uuid` | string | 父目录 UUID；不传则在 Wiki 根目录下创建 |
| `--branch` | string | 分支名 |
| `--target-path` | string | 目标路径，MonoRepo 场景使用 |

示例：

```bash
# 在 Wiki 根目录创建目录
a1 kbase codewiki dir create --code-repo aone/a1 --name guides

# 在指定父目录下创建嵌套目录
a1 kbase codewiki dir create --code-repo aone/a1 --name advanced --parent-dir-uuid abc123

# JSON 格式输出（返回 uuid）
a1 kbase codewiki dir create --code-repo aone/a1 --name guides -f json
```

#### dir delete

```bash
a1 kbase codewiki dir delete <uuid> --code-repo <group/project> [flags]
```

| Flag | Type | Description |
|------|------|-------------|
| `<uuid>` | string | 必填，目录 UUID |
| `--code-repo` | string | 必填，代码仓库 group/project |
| `--branch` | string | 分支名 |
| `--target-path` | string | 目标路径，MonoRepo 场景使用 |

示例：

```bash
a1 kbase codewiki dir delete abc123 --code-repo aone/a1
```

### codewiki search

跨一个或多个 CodeWiki 语义搜索。至少传一个 `--code-repo`，可重复。

```bash
a1 kbase codewiki search <query> [flags]
```

| Flag | Type | Description |
|------|------|-------------|
| `<query>` | string | 必填，查询文本 |
| `--code-repo` | strings | 代码仓库 group/project，可重复，至少一个 |
| `--top-k` | int | 最大结果数，服务端限制 1..10 |
| `--score-threshold` | float | rerank 分数下限，0..1 |
| `--instruction` | string | 传给 LLM 的指令 |
| `--rerank-instruction` | string | rerank 模型指令 |

示例：

```bash
a1 kbase codewiki search "how to deploy" --code-repo aone/a1
a1 kbase codewiki search "rollback" --code-repo aone/a1 --code-repo aone/aone-km-server --top-k 5 --score-threshold 0.6
```

### codewiki ask

提交 CodeWiki 深度分析任务。目标仓库用 `--code-repo <group/project>` 或 `--git-url <url>` 二选一。

```bash
a1 kbase codewiki ask <question> [flags]
a1 kbase codewiki ask submit <question> [flags]
a1 kbase codewiki ask status <task-no> [flags]
a1 kbase codewiki ask download <task-no> [flags]
```

`ask` 顶层命令默认提交任务后立即返回；传 `--wait` 才会阻塞等待。`ask submit` 只提交，不等待。

| Flag | Command | Type | Default | Description |
|------|---------|------|---------|-------------|
| `<question>` | `ask`, `ask submit` | string | | 必填，问题 |
| `--code-repo` | `ask`, `ask submit` | string | | Code 平台仓库简写；与 `--git-url` 互斥 |
| `--git-url` | `ask`, `ask submit` | string | | 原始 git URL；与 `--code-repo` 互斥 |
| `--branch` | `ask`, `ask submit` | string | | 分支名 |
| `--target-path` | `ask`, `ask submit` | string | | 目标路径，MonoRepo 场景使用 |
| `--wait` | `ask`, `ask status` | bool | `false` | 等待任务进入终态 |
| `--timeout` | `ask`, `ask status` | duration | `5m` | 等待超时时间 |
| `--poll-interval` | `ask`, `ask status` | duration | `5s` | 轮询间隔 |
| `<task-no>` | `ask status`, `ask download` | string | | 必填，任务号 |
| `-o, --output` | `ask download` | string | | 输出文件；不传则写 stdout |
| `--url-only` | `ask download` | bool | `false` | 只打印 OSS 预签名 URL，不下载内容 |

示例：

```bash
a1 kbase codewiki ask "where is auth handled" --code-repo aone/a1
a1 kbase codewiki ask "rollback strategy" --code-repo aone/a1 --wait --timeout 10m
a1 kbase codewiki ask submit "what is X" --git-url https://code.alibaba-inc.com/aone/a1.git
a1 kbase codewiki ask status <task-no> --wait
a1 kbase codewiki ask download <task-no> -o ./answer.json
a1 kbase codewiki ask download <task-no> --url-only
```

### codewiki page — 页面 CRUD / 内容上传

管理 CodeWiki 页面。通过 `--code-repo <group/project>` 定位 CodeWiki；多分支或 MonoRepo 场景用 `--branch` / `--target-path` 消歧。

#### page create

```bash
a1 kbase codewiki page create --code-repo <group/project> --name <name> [flags]
```

| Flag | Type | Description |
|------|------|-------------|
| `--code-repo` | string | 必填，代码仓库 group/project |
| `--name` | string | 必填，页面名称 |
| `--content` | string | 页面内容（Markdown）；与 `--content-file` 互斥 |
| `--content-file` | string | 从本地文件读取/上传页面内容；与 `--content` 互斥 |
| `--parent-dir-uuid` | string | 父目录 UUID；不传则创建在根目录 |
| `--branch` | string | 分支名 |
| `--target-path` | string | 目标路径，MonoRepo 场景使用 |

`create` 可以不传 `--content` / `--content-file`，此时创建空页。

示例：

```bash
a1 kbase codewiki page create --code-repo aone/a1 --name guide
a1 kbase codewiki page create --code-repo aone/a1 --name guide --content "# Title"
a1 kbase codewiki page create --code-repo aone/a1 --name guide --content-file ./guide.md
a1 kbase codewiki page create --code-repo aone/a1 --name guide --parent-dir-uuid <dir-uuid>
```

#### page update

```bash
a1 kbase codewiki page update <page-id> --code-repo <group/project> [flags]
```

| Flag | Type | Description |
|------|------|-------------|
| `<page-id>` | string | 必填，页面 ID |
| `--code-repo` | string | 必填，代码仓库 group/project |
| `--content` | string | 新页面内容（Markdown）；与 `--content-file` 互斥 |
| `--content-file` | string | 从本地文件读取/上传新内容；与 `--content` 互斥 |
| `--branch` | string | 分支名 |
| `--target-path` | string | 目标路径，MonoRepo 场景使用 |

`update` 必须提供 `--content` 或 `--content-file` 二选一。

示例：

```bash
a1 kbase codewiki page update wp-12345 --code-repo aone/a1 --content-file ./new.md
a1 kbase codewiki page update wp-12345 --code-repo aone/a1 --content "# new"
```

#### page delete

```bash
a1 kbase codewiki page delete <page-id> --code-repo <group/project> [flags]
```

| Flag | Type | Description |
|------|------|-------------|
| `<page-id>` | string | 必填，页面 ID |
| `--code-repo` | string | 必填，代码仓库 group/project |
| `--branch` | string | 分支名 |
| `--target-path` | string | 目标路径，MonoRepo 场景使用 |

示例：

```bash
a1 kbase codewiki page delete wp-12345 --code-repo aone/a1
```

---

## 常见判断

- 用户说”上传知识库文档/页面”时，优先使用 `a1 kbase page create/update --file`。
- 用户说”上传/更新 CodeWiki 页面内容”时，使用 `a1 kbase codewiki page create/update --content-file`。
- 用户说”批量上传本地 CodeWiki 修改”或”同步本地 Wiki 到远端”时，使用 `a1 kbase codewiki upload`（需先 download 建立 manifest）。
- 用户说”在 CodeWiki 里建目录/文件夹”时，使用 `a1 kbase codewiki dir create`。
- 用户说”删除 CodeWiki 目录”时，使用 `a1 kbase codewiki dir delete`。
- 用户说”部署 pages / 刷新 pages”时，不走 `a1 kbase`，按 `references/ci-commands.md` 的 Aone Pages 部署流水线处理。
- 用户说”创建/修改 pages 站点/域名”时，不走 `a1 kbase`，使用 `a1 pages` 并阅读 `references/pages-commands.md`。
