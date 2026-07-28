# env 命令完整参考

## 目录

- [应用环境管理](#a1-env--应用环境管理)
- [自定义环境级别名称](#a1-env-level-custom-name--应用自定义环境级别名称)
- [环境特性管理](#a1-env-trait--环境特性管理)
- [SPE 环境验证](#a1-env-spe--spe-环境验证管理)
- [项目环境管理](#a1-env-project--项目环境管理)
- [项目环境操作](#项目环境操作)
- [应用运行环境管理](#应用运行环境管理env-project-apre)

## a1 env — 应用环境管理

管理应用环境（env-center 中的环境）。支持查询列表、查看详情和创建环境。应用可通过 `--app-id`、`--app-name` 或已关联的应用上下文（`a1 app link`）指定。

```bash
a1 env <subcommand> [flags]
```

---

### env list

查询应用环境列表。

```bash
a1 env list --app-id 229256
a1 env list --app-name my-app
a1 env list --app-name my-app --type online
a1 env list --app-id 229256 --name beta --env-level production
a1 env list --app-id 229256 --page 2 --page-size 50
a1 env list --format json
```

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--app-id` | int64 | — | 应用 ID |
| `--app-name` | string | — | 应用名称 |
| `--name` | string | — | 按环境名称过滤 |
| `--type` | string | — | 按类型过滤（testing, online） |
| `--env-level` | string | — | 按环境级别过滤（如 production, beta） |
| `--page` | int | 1 | 页码 |
| `--page-size` | int | 20 | 每页条数 |
| `-f, --format` | string | table | 输出格式：table 或 json |
| `-q, --quiet` | bool | false | 仅输出环境 ID |

---

### env get \<env-id\>

查看应用环境详情。

```bash
a1 env get 12345
a1 env get 12345 --format json
a1 env get 12345 --quiet
```

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `-f, --format` | string | table | 输出格式：table 或 json |
| `-q, --quiet` | bool | false | 仅输出 ID |

---

### env create

创建应用环境。必填字段（name、type、sign）可通过 flag 或配置文件提供；使用配置文件时，flag 会覆盖文件中的值。

```bash
# 通过 flag 创建
a1 env create --app-name my-app --name "beta发布3" --type online --sign beta
a1 env create --app-id 229256 --name "beta发布3" --type online --sign beta

# 通过配置文件创建
a1 env create --file env.yaml
a1 env create --file env.yaml --name "override-name" --sign production

# 从 stdin 读取
cat env.json | a1 env create --file -

# 试运行（仅打印请求 JSON，不实际创建）
a1 env create --app-id 229256 --name "test" --type testing --sign beta --dry-run
```

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--file` | string | — | 配置文件路径（YAML/JSON），`-` 表示从 stdin 读取 |
| `--app-id` | int64 | — | 应用 ID |
| `--app-name` | string | — | 应用名称 |
| `-n, --name` | string | — | 环境名称（不使用 --file 时必填） |
| `--type` | string | — | 环境类型：testing 或 online（不使用 --file 时必填） |
| `--sign` | string | — | 环境级别，如 beta、production（不使用 --file 时必填） |
| `--traffic-route-label` | string | — | 流量隔离标签 |
| `--env-key` | string | — | 环境 key |
| `--dry-run` | bool | false | 仅打印请求 JSON，不实际创建 |
| `-f, --format` | string | table | 输出格式：table 或 json |
| `-q, --quiet` | bool | false | 仅输出创建后的环境 ID |

---

## a1 env level-custom-name — 应用自定义环境级别名称

管理应用的自定义环境级别展示名称。允许应用为标准环境级别（如 daily、beta、production 等）设置自定义的展示名称，设置后在环境列表中 `envSignVal` 将展示为自定义名称。

```bash
a1 env level-custom-name <subcommand> [flags]
```

---

### level-custom-name list

查询应用的所有自定义环境级别名称，返回 envLevelName → customName 的映射。

```bash
a1 env level-custom-name list --app-id 229256
a1 env level-custom-name list --app-name my-app
a1 env level-custom-name list --app-id 229256 --format json
```

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--app-id` | int64 | — | 应用 ID |
| `--app-name` | string | — | 应用名称 |
| `-f, --format` | string | table | 输出格式：table 或 json |

---

### level-custom-name get

查询应用某个环境级别的自定义名称。

```bash
a1 env level-custom-name get --app-id 229256 --env-level-name daily
a1 env level-custom-name get --app-name my-app --env-level-name beta
```

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--app-id` | int64 | — | 应用 ID |
| `--app-name` | string | — | 应用名称 |
| `--env-level-name` | string | — | **必填** 环境级别名称（如 daily、beta、production） |
| `-f, --format` | string | table | 输出格式：table 或 json |

---

### level-custom-name set

设置或更新应用的自定义环境级别名称。如果该环境级别已有自定义名称则更新，否则新增。

```bash
a1 env level-custom-name set --app-id 229256 --env-level-name daily --custom-name "日常联调"
a1 env level-custom-name set --app-name my-app --env-level-name beta --custom-name "预发验证"
```

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--app-id` | int64 | — | 应用 ID |
| `--app-name` | string | — | 应用名称 |
| `--env-level-name` | string | — | **必填** 环境级别名称（如 daily、beta、production） |
| `--custom-name` | string | — | **必填** 自定义展示名称 |
| `-f, --format` | string | table | 输出格式：table 或 json |

---

### level-custom-name delete

删除应用的自定义环境级别名称，恢复为默认展示名称。默认需要交互确认。

```bash
a1 env level-custom-name delete --app-id 229256 --env-level-name daily
a1 env level-custom-name delete --app-name my-app --env-level-name beta --yes
```

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--app-id` | int64 | — | 应用 ID |
| `--app-name` | string | — | 应用名称 |
| `--env-level-name` | string | — | **必填** 环境级别名称（如 daily、beta、production） |
| `-y, --yes` | bool | false | 跳过确认提示 |

---

## a1 env trait — 环境特性管理

管理应用或环境的特性（trait）。特性是可配置的功能（如流量路由、资源隔离、JVM 参数等），通过唯一的 traitKey 标识。所有子命令支持通过 `--app-id`、`--app-name`（应用维度）或 `--env-id`（环境维度）指定目标资源。未指定时使用 `a1 app link` 关联上下文。

```bash
a1 env trait <subcommand> [flags]
```

---

### trait list

查询已导入的特性实例列表。

```bash
a1 env trait list --app-id 101880
a1 env trait list --app-name normandy-test-app4
a1 env trait list --env-id 708227
a1 env trait list --app-id 101880 --format json
```

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--app-id` | int64 | — | 应用 ID |
| `--app-name` | string | — | 应用名称 |
| `--env-id` | int64 | — | 环境 ID |
| `-f, --format` | string | table | 输出格式：table 或 json |
| `-q, --quiet` | bool | false | 仅输出 ID |

---

### trait list-definitions

查询当前应用或环境可用的特性定义列表（含 jsonSchema），用于了解可以创建哪些特性及其配置格式。

```bash
a1 env trait list-definitions --app-id 101880
a1 env trait list-definitions --env-id 708227
a1 env trait list-definitions --app-name my-app --format json
```

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--app-id` | int64 | — | 应用 ID |
| `--app-name` | string | — | 应用名称 |
| `--env-id` | int64 | — | 环境 ID |
| `-f, --format` | string | table | 输出格式：table 或 json |
| `-q, --quiet` | bool | false | 仅输出 ID |

---

### trait get

查询单个特性实例的详细信息。

```bash
a1 env trait get --app-id 101880 --trait-key java-options
a1 env trait get --env-id 708227 --trait-key fsfuse --format json
```

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--trait-key` | string | — | **必填** 特性 Key |
| `--app-id` | int64 | — | 应用 ID |
| `--app-name` | string | — | 应用名称 |
| `--env-id` | int64 | — | 环境 ID |
| `-f, --format` | string | table | 输出格式：table 或 json |
| `-q, --quiet` | bool | false | 仅输出 ID |

---

### trait create

创建特性。`--form-data` 接受 JSON 字符串，格式需符合对应特性的 jsonSchema 定义（可通过 `list-definitions` 查询）。creator 由 CLI 自动注入。

```bash
a1 env trait create --app-id 101880 --trait-key java-options --form-data '{"javaOptions":"-Xms512m -Xmx1024m"}'
a1 env trait create --env-id 708227 --trait-key java-options --form-data '{"javaOptions":"-Xms512m"}'
a1 env trait create --app-name my-app --trait-key time-zone --form-data '{"timezone":"Asia/Shanghai"}'
```

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--trait-key` | string | — | **必填** 特性 Key |
| `--version` | string | 0.0.1 | 特性版本 |
| `--form-data` | string | {} | 特性配置内容（JSON） |
| `--app-id` | int64 | — | 应用 ID |
| `--app-name` | string | — | 应用名称 |
| `--env-id` | int64 | — | 环境 ID |
| `-f, --format` | string | table | 输出格式：table 或 json |
| `-q, --quiet` | bool | false | 仅输出 ID |

---

### trait delete

删除特性。modifier 由 CLI 自动注入。

```bash
a1 env trait delete --app-id 101880 --trait-key java-options
a1 env trait delete --env-id 708227 --trait-key fsfuse
a1 env trait delete --app-name my-app --trait-key java-options
```

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--trait-key` | string | — | **必填** 特性 Key |
| `--app-id` | int64 | — | 应用 ID |
| `--app-name` | string | — | 应用名称 |
| `--env-id` | int64 | — | 环境 ID |
| `-f, --format` | string | table | 输出格式：table 或 json |

---

## a1 env spe — SPE 环境验证管理

管理 SPE（安全生产环境）发布验证操作。

```bash
a1 env spe <subcommand> [flags]
```

---

### env spe complete-verify \<flow-inst-id\>

完成 SPE 发布验证。将指定流水线实例的验证卡点标记为完成，前提是所有验证指标已通过（状态为 PASS）。

```bash
a1 env spe complete-verify 3091299196
a1 env spe complete-verify 3091299196 --env-level spe
```

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--env-level` | string | spe | 环境级别 |

**前置条件：**
- 流水线实例对应的验证卡点必须存在
- 当前用户必须拥有该应用的验证权限
- 卡点状态必须为 PASS（所有 BLOCK 级别指标已通过或跳过）

**执行逻辑：**
1. 校验卡点存在性和用户权限
2. 如果状态已是 FINISH，幂等返回
3. 如果状态不是 PASS，返回错误
4. 调用流水线 continueFlow 继续发布流程
5. 更新卡点状态为 FINISH 并发送验证完成消息

---

## a1 env project — 项目环境管理

管理项目环境（联调环境）。支持创建、查询、查看详情、删除，以及管理环境下的应用运行环境（apre）。

```bash
a1 env project <subcommand> [flags]
```

---

## 项目环境操作

### env project list

查询项目环境列表。

```bash
a1 env project list
a1 env project list -k "my-env"
a1 env project list -s PRE
a1 env project list --app-id 229256
a1 env project list --cr-id 33706784
a1 env project list --format json
```

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `-k, --keyword` | string | — | 搜索关键词（匹配名称或流量标签） |
| `-s, --stage` | string | ALL | 按阶段过滤（DEV, PRE）；不传等价于 ALL |
| `--app-id` | int64 | — | 按应用 ID 过滤 |
| `--cr-id` | string | — | 按变更单 ID 过滤 |
| `--page` | int | 1 | 页码 |
| `--page-size` | int | 20 | 每页条数 |
| `-f, --format` | string | table | 输出格式：table 或 json |
| `-q, --quiet` | bool | false | 仅输出环境 ID |

---

### env project get \<env-id\> / view \<env-id\>

查看项目环境详情（含关联应用列表）。`view` 为 `get` 的别名命令。

```bash
a1 env project get 12345
a1 env project get 12345 --format json
a1 env project view 12345
```

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `-f, --format` | string | table | 输出格式：table 或 json |
| `-q, --quiet` | bool | false | 仅输出 ID |

---

### env project create

从 YAML 或 JSON 配置文件创建项目环境。文件格式自动检测：以 `{` 开头为 JSON，否则为 YAML。

```bash
# 从 YAML 文件创建
a1 env project create --file env.yaml

# 覆盖名称和阶段
a1 env project create --file env.yaml --name "my-env" --stage PRE

# 从 stdin 读取
cat env.yaml | a1 env project create --file -
```

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--file` | string | — | **必填** 配置文件路径（YAML/JSON），`-` 表示从 stdin 读取 |
| `-n, --name` | string | — | 覆盖配置中的环境名称 |
| `-s, --stage` | string | — | 覆盖配置中的阶段（DEV, PRE, PROD） |
| `-f, --format` | string | table | 输出格式：table 或 json |
| `-q, --quiet` | bool | false | 仅输出创建后的环境 ID |

**项目环境配置字段**（`env.yaml` 顶层字段）

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `name` | string | 是 | 项目环境名称 |
| `stage` | string | 否 | 阶段：DEV / PRE / PROD（默认 DEV） |
| `description` | string | 否 | 环境描述 |
| `baseEnv` | string | 否 | 路由兜底环境 |
| `trafficRouteLabel` | string | 否 | 流量隔离标签 |
| `members` | string[] | 否 | 环境成员列表（工号） |
| `labels` | string[] | 否 | 环境标签（如 `PERSONAL`） |
| `iteration` | string | 否 | 迭代/变更标识 |
| `autoDeployStrategy` | string | 否 | 环境级自动部署策略 |
| `cron` | string | 否 | 环境级 cron 表达式 |
| `appRunningEnvList` | object[] | 否 | 应用运行环境列表，见下方字段说明 |

**appRunningEnvList 配置字段**（同适用于 `apre create` 的 YAML 项）

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `appName` | string | 是 | 应用名称 |
| `sourceType` | string | 否 | 代码来源：`CHANGE_REQUEST` / `BRANCH` |
| `changeRequestId` | string | 否 | 变更单 ID（sourceType=CHANGE_REQUEST 时使用） |
| `branch` | string | 否 | 分支名（sourceType=BRANCH 时使用） |
| `image` | string | 否 | 镜像地址 |
| `replicas` | string | 否 | 副本数 |
| `envSchema` | string | 否 | 配置模式（如 `project`） |
| `bindDomainName` | string | 否 | 绑定域名 |
| `autoDeploy` | bool | 否 | 是否随环境自动部署 |
| `region` | string | 否 | 地域 |
| `az` | string | 否 | 可用区 |
| `machineSpecId` | string | 否 | 机器规格 ID |

**最小化 YAML 示例（env.yaml）：**
```yaml
name: my-env
stage: PRE
appRunningEnvList:
  - appName: my-app
    sourceType: CHANGE_REQUEST
    changeRequestId: "12345"
    envSchema: project
```

---

### env project delete \<env-id\>

释放并删除项目环境。

```bash
a1 env project delete 12345
a1 env project delete 12345 --yes
```

| Flag | Type | Description |
|------|------|-------------|
| `-y, --yes` | bool | 跳过确认提示 |

---

## 应用运行环境管理（env project apre）

管理项目环境下的应用运行环境（App Running Environment）。

### apre list \<env-id\>

列出项目环境中的所有应用运行环境。

```bash
a1 env project apre list 12345
a1 env project apre list 12345 --format json
a1 env project apre list 12345 --quiet      # 仅输出 apre ID
```

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `-f, --format` | string | table | 输出格式：table 或 json |
| `-q, --quiet` | bool | false | 仅输出 apre ID |

---

### apre create \<env-id\>

向已有项目环境中批量添加应用运行环境（YAML 或 JSON 文件，格式同 `appRunningEnvList`）。

```bash
a1 env project apre create 12345 --file apres.yaml
cat apres.yaml | a1 env project apre create 12345 --file -
```

| Flag | Type | Description |
|------|------|-------------|
| `--file` | string | **必填** 配置文件路径（YAML/JSON），`-` 表示 stdin |

`apres.yaml` 格式（数组）：
```yaml
- appName: my-app
  sourceType: CHANGE_REQUEST
  changeRequestId: "33706784"
  envSchema: project
```

---

### apre delete \<apre-id\>

删除一个应用运行环境。

```bash
a1 env project apre delete 67890
a1 env project apre delete 67890 --yes
```

| Flag | Type | Description |
|------|------|-------------|
| `-y, --yes` | bool | 跳过确认提示 |

---

### apre deploy \<apre-id\>

触发应用运行环境的部署，成功后返回流水线 ID。

```bash
a1 env project apre deploy 67890
a1 env project apre deploy 67890 --format json
a1 env project apre deploy 67890 --quiet    # 仅输出流水线 ID
```

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `-f, --format` | string | table | 输出格式：table 或 json |
| `-q, --quiet` | bool | false | 仅输出流水线 ID |

---

### apre machines \<apre-id\>

查询应用运行环境分配的机器/实例列表。

```bash
a1 env project apre machines 67890
a1 env project apre machines 67890 --format json
```

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `-f, --format` | string | table | 输出格式：table 或 json |
| `-q, --quiet` | bool | false | 仅输出 IP 列表 |

---

### apre update-cr \<apre-id\>

替换 apre 关联的变更单列表（**全量替换**语义，至少传一个 CR ID）。

> 仅支持 `sourceType=CHANGE_REQUEST` 的 apre；传入 CR 会覆盖原有绑定。

```bash
# 绑定单个 CR
a1 env project apre update-cr 67890 --cr-id 33706784

# 绑定多个 CR（重复 flag 或逗号分隔）
a1 env project apre update-cr 67890 --cr-id 33706784 --cr-id 33706785
a1 env project apre update-cr 67890 --cr-id 33706784,33706785
```

| Flag | Type | Description |
|------|------|-------------|
| `--cr-id` | stringSlice | **必填**，至少一个变更单 ID（可重复传或逗号分隔） |
