# a1 faas（AoneFaaS 一期命令）

`a1 faas` 面向函数应用的本地创建、本地构建/快发、平台标准发布和可观测查询。

## 核心规则

- 构造 FaaS 命令前优先使用本文件；不确定 flag 时再执行 `a1 faas <cmd> --help`。
- `--app-name` 多数命令可省略，默认从当前目录或父目录的 `f.yml.service` 读取。
- `create` / `import` 创建本地函数应用时会重写 `f.yml.service`，命名规则为 `<X-App-Key>-faas-<8位随机串>`；随机串只含数字和小写字母。`X-App-Key` 来自 `AONE_FAAS_APP_KEY`（兼容 `A1_AONEFAAS_APP_KEY`），未设置时为 `a1-client`。
- 一期把“本地快发”和“平台标准发布”拆开：
  - `a1 faas deploy [dir]`：本地构建 `code.zip` 并快速发布到日常环境。
  - `a1 faas publish <env>`：平台侧标准 CD，创建/复用 Aone CR 后提交流水线。
- 新注册 Aone 正式应用只能在完成下方强制二次确认后执行 `a1 faas register --app-name <new-name> --repo-group <group> [--repo-project <project>] [--old-app-name <old-name>]`。
- `register` 必须显式提供目标新应用名和 repo group；repo project 省略时默认等于新应用名。旧 FaaS 应用名优先取 `--old-app-name`，省略时自动读取 `<dir>/f.yml.service`。无 git origin 时，使用上述仓库坐标创建新 Code project。
- 本地 FaaS 目录无 `.git` 时，只读取 `f.yml`；不要执行 `git remote/branch/status`、`a1 link status`、`a1 app/repo list` 或同类项目搜索。目标应用名、repo group/project 缺失时直接询问用户，不得从同类项目或历史上下文推断。

### 注册 Aone 正式应用前的强制二次确认

`a1 faas register` 会产生不可逆或跨系统副作用：创建/注册 Aone 正式应用、绑定（必要时创建）Code project，并可能推送本地代码。因此，agent **在任何情况下都不得直接执行 register**，包括：

- 用户只说“发布到 Aone”，而发布发现当前 FaaS 应用尚未注册；
- `--app-name`、`--repo-group` 或 `--repo-project` 可以从本地配置、git remote 或历史上下文推导；
- 已经查到名称相近的同类测试应用，或可以按惯例猜出仓库。

遇到未注册错误后，可以继续执行查询类命令收集信息，但必须在 `register` 前停住，并向用户展示**待执行的最终参数**：

```text
检测到当前 FaaS 应用尚未注册为 Aone 正式应用。注册将创建/绑定 Aone 应用和 Code 仓库，并可能推送本地代码。

AONE_APP_NAME  <目标 Aone 应用名>
REPO_GROUP    <--repo-group 的值>
REPO_PROJECT  <--repo-project 的值>

请确认以上三项后再注册。请回复“确认注册”或明确修改项。
```

若无法得到明确的应用名、repo group 或 repo project，直接向用户询问，不得用同类项目替代。得到用户明确确认后，使用已确认的三项执行显式命令；旧应用名默认从当前 `f.yml.service` 读取：

```bash
a1 faas register <dir> \
  --app-name <new-name> \
  --repo-group <group> \
  --repo-project <project>
```

确认只授权注册及仓库绑定，不等于确认任意其他应用、仓库或发布环境；如果后续参数发生变化，必须重新确认。注册成功后再继续原先的发布流程。

## 子命令一览

| 分类 | 命令 | 说明 |
|---|---|---|
| 函数应用 CRUD | `a1 faas create <template-name> [dir]` | 通过模板创建本地函数应用，`dir` 默认 `.` |
| 函数应用 CRUD | `a1 faas get --app-name <name>` | 查询函数应用详情，包含函数列表；`--app-name` 默认读 `f.yml.service` |
| 函数应用 CRUD | `a1 faas import [dir]` | 适配本地项目并生成函数应用配置，`dir` 默认 `.` |
| 函数应用 CRUD | `a1 faas template list` | 列出可用函数应用模板 |
| 函数应用 CRUD | `a1 faas template get <template-name>` | 查看指定模板 |
| 本地 CICD | `a1 faas build [dir]` | 执行本地构建，生成 `code.zip` |
| 本地 CICD | `a1 faas deploy [dir]` | 将本地 `code.zip` 快速发布到日常环境 |
| 本地 CICD | 二次确认后执行 `a1 faas register --app-name <new-name> --repo-group <group> [--repo-project <project>] [--old-app-name <old-name>]` | 注册为 Aone 正式应用 |
| 平台发布 | `a1 faas publish <env>` | 发布到指定环境；走 Aone CR + CD pipeline |
| 可观测 | `a1 faas logs` | 查询函数日志 |
| 可观测 | `a1 faas health` | 检查函数健康状态，plain 输出只返回 `true` 或 `false` |
| 可观测 | `a1 faas metrics` | 查询函数监控指标 |

## 函数应用 CRUD

### create

```bash
a1 faas create <template-name> [dir]
a1 faas create nextjs
a1 faas create python ./demo-faas
```

常用 flag：
- `--package <name>`：覆盖模板 npm 包。
- `--version <semver|dist-tag>`：覆盖模板版本，默认 `latest`。

行为：
- `dir` 省略时为 `.`。
- 从平台模板 API 解析模板；失败时 fallback 到内置 npm 包名。
- 复制模板后会重写 `f.yml.service`，格式为 `<X-App-Key>-faas-<8位数字/小写字母随机串>`。
- 生成项目后调用 `/api/v1/open-api/app/create` 创建 FaaS 壳应用（不传 `forkFromApp`）；构建由后续 `a1 faas build` 或 `a1 faas deploy` 负责。
- 检测到已有项目标志文件或目录（如 `package.json`、`go.mod`、`src/`）时跳过脚手架；`README`、`LICENSE` 等普通文档文件不会阻止脚手架继续执行。

### get

```bash
a1 faas get
a1 faas get --app-name my-faas-app
a1 faas get --app-name my-faas-app -f json
```

行为：
- `--app-name` 默认读 `f.yml.service`。
- 输出应用基础信息，并包含函数列表。
- plain 输出会包含 `FUNCTION ...` 行；JSON 输出包含 `functions` 字段。

### import

```bash
a1 faas import
a1 faas import ./existing-project
```

行为：
- 适配已有项目，生成或补齐 `build.sh`、`bootstrap`、`f.yml`。
- 完成适配后调用 `/api/v1/open-api/app/create` 创建 FaaS 壳应用（不传 `forkFromApp`）。
- 公开 `import` 会重写 `f.yml.service`，格式为 `<X-App-Key>-faas-<8位数字/小写字母随机串>`；用于给本地函数应用生成新的服务身份。
- `import` 会输出 FaaS 独立知识库引用：`KBASE_REPO_ID`、`KBASE_QUERY`、`KBASE_SEARCH_COMMAND`；`KBASE_QUERY` 使用检测到的项目具体框架（如 `nextjs`、`maven`），没有具体框架时使用语言（如 `nodejs`、`python`）；plain 输出也会把该查询作为第一条 `NEXT_COMMAND`，用于 agent 在 build/deploy 前读取框架/语言适配知识。
- Agent 执行 `a1 faas import` 后，若输出第一条 `NEXT_COMMAND a1 kbase search ... --repo-ids 136427`，必须先执行该查询；搜索结果只是命中结果/摘要/片段，取得相关命中的 `repo-id` 和 `page-id` 后，必须继续执行 `a1 kbase page view <repo-id> <page-id>` 获取页面全文。根据全文检查并按需修改 `build.sh`、`bootstrap`、`f.yml` 或项目配置；不要直接跳到后续 build/deploy。只有用户明确只需要命中列表/摘要时，才可停在 search 结果。
- CLI 自身不把知识库内容落盘到项目，也不在 FaaS 包内复制 kbase API 读取逻辑；知识库消费由 agent 通过 `a1 kbase search` 定位页面，再通过 `a1 kbase page view <repo-id> <page-id>` 获取相关页面全文。
- `dir` 省略时为 `.`。

### template

```bash
a1 faas template list
a1 faas template list -f json
a1 faas template get nextjs
a1 faas template get python -f json
```

## 函数应用本地 CICD

### build

```bash
a1 faas build
a1 faas build ./myapp
```

行为：
- 默认执行 `[dir]/build.sh`，每次按当前源码重新生成产物。
- 解析 `PACKAGED <abs-code-zip> <bytes> bytes`。
- 校验 `code.zip` 不超过 2 GB。
- 多函数项目读取 `built-functions/meta.json` 和 `built-functions/archives/<fn>.zip`。

### deploy

```bash
a1 faas deploy
a1 faas deploy ./myapp
a1 faas deploy ./myapp --app-name my-faas-app
```

行为：
- 首次模板发布和已有项目发布都执行一次本地 `build.sh`。
- 上传并发布 `code.zip` 到日常环境。
- 要求目标 FaaS 壳应用已经由 `create` / `import` 创建；deploy 不做模板匹配或 `/app/create`。
- 默认会做平台健康检查；需要跳过时使用 `--skip-verify`。
- 未使用 `--skip-verify` 时，`deploy` 已经完成一次平台健康检查；plain 输出中的 `[verify] ready ... healthStatus=SUCCESS` 或 JSON 结果中的验证成功状态就是该次检查的结果。
- `deploy` 默认验证成功后不要再执行 `a1 faas health`；否则会对同一个应用重复探测。只有使用了 `--skip-verify`、验证未执行/失败，或用户明确要求独立健康检查时，才执行 `health`。
- 发布成功后 plain 输出包含：
  - `APP_NAME`
  - `ENV`
  - `CODE_ZIP`
  - `ACCESS_URL`
  - `PLATFORM_APP_URL`（如识别到平台应用）

常用 flag：
- `--app-name <name>`：默认读 `f.yml.service`。
- `--env <env>`：快发环境，默认 `daily`。
- `--tenant-id <id>`：默认 `1775`。
- `--region <region>`：默认 `skill`。
- `--skip-verify`：跳过健康检查。

### register

```bash
# 以下命令仅在展示并获得注册入参二次确认后执行
a1 faas register --app-name my-faas-app --repo-group my-group
a1 faas register --app-name my-faas-app --repo-group my-group --repo-project my-faas-app
a1 faas register ./myapp --app-name my-faas-app --old-app-name old-faas-app --repo-group my-group --repo-project my-faas-app
```

关键 flag：
- `--app-name`：目标新 Aone/FaaS 应用名，必填。
- `--old-app-name`：旧 FaaS 应用名（fork source）；默认读取 `<dir>/f.yml.service`。
- `--repo-group`：目标 Code 仓库 group，必填。
- `--repo-project`：目标 Code 仓库 project，可选；默认取目标 `--app-name`。

行为：
- 将旧 FaaS 函数应用 fork 为目标新应用，并注册为 Aone 正式应用。
- 仓库坐标以 `--repo-group` / `--repo-project` 为准；无 git origin 时创建新仓库 project 并推送本地代码。
- `--old-app-name` 显式值优先于 `<dir>/f.yml.service`；适用于 f.yml 已被部分流程改写、仍需指定原 fork source 的重试场景。
- 平台侧成功后才改写/提交 `f.yml.service`，目标值为显式传入的 `--app-name`。

## 函数应用平台发布

### publish

```bash
a1 faas publish <env>
a1 faas publish pre --pipeline-id 10007423 --existing-branch feature/x
a1 faas publish prod --cr-id 34508139 --pipeline-name 正式
a1 faas publish pre --app-name my-faas-app --branch faas-pre-fix
```

行为：
- 解析应用：`--app-id` > `--app-name` > `f.yml.service`。
- 如果解析到的应用未注册为 Aone 正式应用，先按“注册 Aone 正式应用前的强制二次确认”停住；没有用户明确确认时不得调用 `a1 faas register`，也不得继续创建 CR 或发布。
- 如果未传 `--cr-id`，会创建 Aone CR。
- 创建 CR 时分支选择优先级：
  1. `--branch <name>`：创建新分支 CR。
  2. `--existing-branch <name>`：复用已有远程分支。
  3. `--trunk <name>`：trunk_based 应用走主干变更。
  4. 当前 git 分支：当当前分支不是 `master/main` 时，默认作为 `--existing-branch` 使用。
  5. trunk_based 应用默认主干。
- 流水线选择优先级：
  1. `--pipeline-id`
  2. `--pipeline-name`
  3. `<env>` 对绑定名称的匹配（如 `daily/日常`、`pre/预发`、`prod/正式`）
  4. 只有一个绑定时直接使用
- 提交成功后输出 `STATUS_COMMAND a1 app pipeline status --pipeline-id <id> --wait-until-settled`，并按发布环境输出预期 `ACCESS_URL`：
  - 日常（`daily`/`日常`）：`https://<应用名>.fn.taobao.net`
  - 预发（`pre`/`预发`）：`https://<应用名>.pre-fn.alibaba-inc.com`
  - 线上（`prod`/`online`/`线上`/`正式`）：`https://<应用名>.fn.alibaba-inc.com`
- `ACCESS_URL` 在 CR 成功提交到流水线后即可返回，但只有继续执行 `STATUS_COMMAND` 且流水线 `status=success` 后，才能认定发布完成、链接可访问。

常用 flag：
- `--app-name <name>` / `--app-id <id>`
- `--dir <dir>`：默认 `.`，用于找 `f.yml` 和当前 git 分支。
- `--cr-id <id>`：复用已有 CR。
- `--message <text>`：创建 CR 时的描述。
- `--branch <name>` / `--existing-branch <name>` / `--trunk <name>`：三者互斥。
- `--pipeline-id <id>` / `--pipeline-name <name>`
- `--code-module-id <id>` / `--item-name <name>`：多代码配置应用选择 CR item。
- `--plan-release-date <date>`：默认 7 天后；支持 `YYYY-MM-DD`、`YYYY-MM-DD HH:mm`、`+2d`、`3h`。

发布完成判定：
- `a1 faas publish <env>` 只表示 CR 已提交到发布流水线。
- 需要等待终态时继续执行输出里的 `STATUS_COMMAND`。
- `status=success` 才是平台发布完成；`failed/waiting/running` 都不能当作成功。

## 函数可观测

### logs

```bash
a1 faas logs --app-name my-faas-app --function-name index --env daily
a1 faas logs --app-name my-faas-app --function-name index --env pre --content "ERROR" --since-mins 30 --limit 100
```

flag：
- `--app-name`：默认读 `f.yml.service`。
- `--function-name`：未传时尽量从平台函数列表取第一个函数，失败 fallback `index`。
- `--env`：默认 `daily`。
- `--content`：日志内容过滤；旧 `--query` 是废弃别名。
- `--since-mins`：默认 `5`。
- `--limit`：返回数量上限。

历史日志 alias 仅用于兼容旧脚本；新任务使用 `logs`。

### health

```bash
a1 faas health
a1 faas health --app-name my-faas-app --function-name index --env daily
```

行为：
- plain 输出只返回 `true` 或 `false`，适合脚本判断。
- JSON 输出包含健康检查详情。
- `--app-name` 默认读 `f.yml.service`；`--function-name` 默认解析平台首个函数，失败 fallback `index`；`--env` 默认 `daily`。

### metrics

```bash
a1 faas metrics --app-name my-faas-app --function-name index --env daily --metric qps --since-mins 30
a1 faas metrics --metric rt
a1 faas metrics --metric error_rate
a1 faas metrics --metric memory
a1 faas metrics --metric cpu
a1 faas metrics --metric container_count
```

支持指标：
- `qps`
- `rt`
- `error_rate`
- `memory`
- `cpu`
- `container_count`

旧别名 `error`、`count` 仍可兼容，但新任务使用上面的公开名称。

## 默认值

| 字段 | 默认值 |
|---|---|
| `dir` | `.` |
| `--app-name` | `<dir>/f.yml` 的 `service` |
| `env` | `daily`（本地快发和可观测） |
| 函数名 | 平台首个函数，失败 fallback `index` |
| runtime | `custom.debian10` |
| tenantId | `1775` |
| build 产物 | `code.zip` |
| 单包大小限制 | 2 GB |

## 平台链接与成功回复

- AoneFaaS 平台链接格式：`https://cd.faas.alibaba-inc.com/unite/micro/app/<aoneAppId>`。
- `deploy` 本地快发成功后，最终回复必须明确列出 `ACCESS_URL`（可访问地址）和 `PLATFORM_APP_URL`（如有）。
- `publish <env>` 平台发布提交成功后，最终回复必须列出：
  - `CR_ID`
  - `PIPELINE_ID`
  - `DETAIL_URL`（如有）
  - `ACCESS_URL`（按环境推导；流水线成功后才可认定已可访问）
  - `PLATFORM_APP_URL`
  - 下一步 `STATUS_COMMAND`
- CLI 的命令组合提示使用结构化输出：
  - plain：`NEXT_COMMAND <command>`
  - JSON：`nextCommands: []`
- 不要把“CR 已提交到流水线”说成“发布已完成”；只有流水线状态 `success` 才是完成。

## 本地发布完整操作

已有项目：

```bash
a1 faas import .
a1 faas deploy .
# deploy 默认已完成平台健康检查；仅在需要独立检查时执行：
# a1 faas health
# deploy/health 失败时再执行：
# a1 faas logs --since-mins 30
```

需要单独检查构建产物时，再执行 `a1 faas build .`。该产物不会被 `deploy`
复用；之后执行 `deploy` 仍会按当前源码重新构建一次。

模板项目：

```bash
a1 faas template list
a1 faas create nextjs ./my-faas
a1 faas deploy ./my-faas
```

Agent 规则：
- 用户说“本地发布/日常快发/先发到 daily 验证”，优先直接执行 `a1 faas deploy [dir]`；不需要手工拼底层上传命令。
- 若项目尚未适配，先执行 `a1 faas import [dir]`；若是新项目，先 `template list` 再 `create`。
- `import` 输出的 `NEXT_COMMAND` 若包含 `a1 kbase search <框架或语言> --repo-ids 136427`，先执行该知识库查询，从相关命中取得 `repo-id`、`page-id`，再执行 `a1 kbase page view <repo-id> <page-id>` 获取全文；基于全文完成必要修复适配后，才继续 `a1 faas build` / `deploy`。
- `deploy` 成功后必须向用户列出 `ACCESS_URL`；如有 `PLATFORM_APP_URL` 也列出。
- `deploy` 未使用 `--skip-verify` 且输出 `[verify] ready ... healthStatus=SUCCESS`（或 JSON 验证成功）时，健康检查已经完成，不要再执行 `a1 faas health`，也不要因为通用的 `NEXT_COMMAND` 规则重复探测；直接回复发布结果即可。
- `deploy` 使用 `--skip-verify` 时，才按用户需求执行 `health`；deploy 或验证失败时优先执行 `a1 faas logs --since-mins 30`。`NEXT_COMMAND` 是后续动作提示，但不能覆盖 deploy 已完成验证的去重规则。

## 常见错误与处理

| 错误信号 | Agent 行动 |
|---|---|
| `--app-name not provided and could not load f.yml` | 让用户进入项目目录，或显式传 `--app-name` |
| `function application "... " is not registered as an Aone application` | 只读读取 `f.yml` 并展示目标 Aone 应用名、`--repo-group`、`--repo-project`，向用户二次确认；`--old-app-name` 和 Git 地址内部解析，不单独展示；确认后才执行显式 `a1 faas register`，不得从同类应用或历史上下文自动推断 |
| `creating a CR requires --branch, --existing-branch, or --trunk` | 当前分支是 `master/main` 或无法解析；让用户显式传发布分支 |
| `multiple pipeline bindings; specify --pipeline-id or --pipeline-name` | 去 Aone 页面确认目标环境，再重跑 `publish` |
| `build.sh: exit status N` | 读 stderr，修复构建后重跑 `a1 faas build` 或 `deploy` |
| `code.zip exceeds ...` | 缩减构建产物或排除无关文件 |
| `health` 返回 `false` | 用 `a1 faas logs --since-mins 30` 排查启动/运行错误 |
| `aonefaas_permission_denied` | 将当前工号加入 Aone 应用 appops、O2 应用成员，或统一身份 `alifaas-${appName}` 的 developer |

不确定具体 flag 时执行：`a1 faas <cmd> --help`。
