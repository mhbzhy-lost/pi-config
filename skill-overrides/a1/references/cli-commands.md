# cli 命令完整参考

## a1 cli — 开放平台 CLI 工具集管理

用于管理开放平台上的 CLI 工具：创建、查询、发布、安装下载、收藏、设置、变更日志与稳定版本操作。

---

## 基础查询与创建

### cli list
列出 CLI 工具。
- `--page int` — 页码（默认 1）
- `--page-size int` — 每页数量（默认 20）
- `--keyword string` — 关键词搜索
- `--platform-code string` — 平台 code 过滤
- `--platform-codes string` — 多平台过滤（逗号分隔）
- `--order-by string` — 排序（如 usage、timestamp、trend）
- `--favorites` — 仅我收藏
- `--owner string` — 按 owner 工号过滤
- `--tags string` — tag 过滤（逗号分隔）
- `--status string` — 状态过滤
- `--scope string` — 范围过滤（如 public）
- `--code string` — 按精确 code 过滤
- `--my-related` — 仅/优先与我相关
- `--recent-days int` — 最近天数过滤
- `--fields string` — quiet 模式字段（如 `cliName,displayName,owner`）
- `-f, --format string`, `-q, --quiet`

### cli get <cli-name>
查看 CLI 详情。
- `--readme` — 同时展示 README
- `--open-page` — 打开开放平台详情页
- `-f, --format string`, `-q, --quiet`

### cli create <cli-name>
创建 CLI（完整流程）。
- `--platform-code string` — 平台 code（必填）
- `--display-name string` — 显示名
- `--description string` — 描述
- `--scope string` — 范围（public/private）
- `--git-create-mode string` — Git 创建模式（如 bind_existing）
- `--group string` — 仓库 group
- `--project string` — 仓库 project
- 以及创建流程相关 flags（按 `a1 cli create --help` 为准）
- `-f, --format string`, `-q, --quiet`

### cli create-step <step> <cli-name>
执行创建流程中的单个步骤（适合失败后定点重试）。
- 支持步骤以 `a1 cli create-step --help` 为准
- 常与创建相关 flags组合使用
- `-f, --format string`, `-q, --quiet`

---

## 发布与版本流转

### cli publish <cli-name>
触发 CLI 发布。
- `--version string` — 指定发布版本
- `--stable bool` — 是否 stable 通道（默认 true）
- `--version-note string` — 版本说明
- `--wait` — 等待发布结束
- `--poll-interval duration` — 轮询间隔（默认 15s）
- `--timeout duration` — 等待超时（默认 30m，0 表示无限）
- `--open-browser bool` — 自动打开流水线页面（默认 true）
- `-f, --format string`, `-q, --quiet`

### cli status <cli-name>
查看最新发布状态。
- `-f, --format string`, `-q, --quiet`

### cli publish-records <cli-name>
查看发布记录。
- `--page int`、`--page-size int`
- `--status string` — 按发布状态过滤
- `--publish-mode string` — 按发布模式过滤
- `--env string` — 按环境过滤
- `-f, --format string`, `-q, --quiet`

### cli next-version <cli-name>
预览下一个可发布版本。
- `--channel string` — `stable|beta`（默认 stable）
- `--append-beta-suffix` — beta 通道追加后缀
- `-f, --format string`, `-q, --quiet`

### cli validate-config <cli-name>
校验发布配置文件（如 pipeline 配置）。
- `-f, --format string`, `-q, --quiet`

### cli fix-config <cli-name>
自动修复发布配置问题。
- `-f, --format string`, `-q, --quiet`

### cli promote <cli-name>
将 beta 版本提升为 stable。
- `--beta-version string` — 待提升版本（必填）
- `--stable-version string` — 目标 stable 版本（可选）
- `-f, --format string`, `-q, --quiet`

### cli rollback <cli-name>
回滚 stable 版本。
- `--target-version string` — 回滚目标版本（必填）
- `--note string` — 回滚说明
- `-f, --format string`, `-q, --quiet`

---

## 收藏、安装与下载

### cli favorite add <cli-name>
收藏 CLI。

约束：
- 仅当 CLI 满足 **已注册 + 已启用 + 公开范围 public** 才可收藏

### cli favorite rm <cli-name>
取消收藏。
- 支持别名：`remove`、`del`

### cli artifacts <cli-name>
查看指定版本产物列表。
- `--version string` — 版本（必填）

### cli download <cli-name>
获取下载地址并可选自动打开浏览器。
- `--channel string` — 通道（默认 stable）
- `--version string` — 指定版本
- `--os string` — 目标 OS（支持 windows/linux/darwin，macos 别名可用）
- `--arch string` — 目标架构（amd64/arm64）
- `--open-browser bool` — 自动打开浏览器（默认 true）
- `--print-url` — 总是输出下载 URL

### cli install <cli-name>
执行安装脚本（或仅打印安装命令）。
- `--channel string` — 通道（默认 stable）
- `--version string` — 指定版本
- `--print-only` — 仅打印安装命令，不执行

---

## 设置管理

### cli settings set <cli-name>
更新 CLI 基础设置。
- `--display-name string`
- `--description string`
- `--platform-code string`
- `--icon-url string`
- `--scope string`（public/private）

至少传一个设置字段。

### cli settings managers add <cli-name>
增加管理员。
- `--emp-ids string` — 工号列表（逗号分隔，必填）

### cli settings managers rm <cli-name>
移除管理员。
- `--emp-ids string` — 工号列表（逗号分隔，必填）
- 别名：`remove`、`del`

### cli settings tags <cli-name>
设置或查看 tags。
- `--tags string` — 逗号分隔；不传时读取当前 tags

---

## 变更日志（changelog）

### cli changelog list <cli-name>
列出版本日志。
- `--channel string` — stable|beta
- `--version string` — 精确版本过滤
- `--latest-stable` — 仅最新 stable
- `--with-note-only` — 仅包含 note 的版本
- `--limit int` — 限制返回行数
- `-f, --format string`, `-q, --quiet`

### cli changelog get <cli-name>
查看指定版本日志。
- `--version string` — 版本（必填）
- `--channel string` — 通道（默认 stable）
- `-f, --format string`, `-q, --quiet`

### cli changelog set <cli-name>
设置指定版本日志。
- `--version string` — 版本（必填）
- `--channel string` — 通道（默认 stable）
- `--note string` — 日志内容（必填）

---

## 常见工作流

```bash
# 1) 查询并查看详情
a1 cli list --keyword my-cli --page 1 --page-size 10
a1 cli get my-cli --readme

# 2) 触发发布并等待
a1 cli publish my-cli --version 1.0.0-beta.1 --stable=false --wait --poll-interval 15s --timeout 30m
a1 cli status my-cli
a1 cli publish-records my-cli --page 1 --page-size 10

# 3) 安装与下载（建议脚本中禁用自动开浏览器）
a1 cli install my-cli --print-only
a1 cli download my-cli --open-browser=false --print-url

# 4) 维护设置与 changelog
a1 cli settings set my-cli --description "updated by a1 skill"
a1 cli settings tags my-cli --tags devops,tooling
a1 cli changelog set my-cli --version 1.0.0-beta.1 --channel beta --note "release note"
```

## 注意事项

- 写操作命令（create/publish/settings/changelog set/promote/rollback）有真实副作用，执行前应二次确认。
- `download` 若未显式指定 `--os/--arch`，会按本机自动推断；脚本场景建议显式传参或使用 `--print-url`。
- 生产与预发环境差异可能导致查询/发布结果不一致，必要时显式设置 `AONE_ENV`、`A1_ENV`、`A1_SERVER_BASE_URL`。
- 参数细节以 `a1 cli <subcommand> --help` 为准，避免因版本差异导致 flag 漂移。
