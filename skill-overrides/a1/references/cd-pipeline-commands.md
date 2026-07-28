# cd-pipeline 命令参考

`a1 cd-pipeline` 是交付流水线统一入口。当前实现 `list/get/bind/vars/run`，其中 `run` 支持 CR 提交运行、运行详情和重跑。

所有命令支持：

- `-f, --format table|json` — 输出格式，默认 `table`；兼容根命令的 `plain`
- `-q, --quiet` — 只输出必要标识

`--format json` 与 `--quiet` 互斥。`get/bind/vars/run` 都只接受正整数流水线 ID，不接受流水线 URL。

## cd-pipeline list

列出当前用户管理的独立交付流水线，或列出指定对象绑定的流水线。默认管理列表仅包含 `CODE/OTHER`，不包含 `CHANGE_REQUEST` 和 `AONE_CI`。

```bash
a1 cd-pipeline list
a1 cd-pipeline list --app <app-name-or-id>
a1 cd-pipeline list --mvn <package-name-or-id>
a1 cd-pipeline list --faas <faas-app-name-or-id>
```

对象参数：

- `--app string` — Aone 应用名称或 ID
- `--mvn string` — Maven 包名称或 ID；解析后的包类型必须是 Maven/library
- `--faas string` — FaaS 对应的 Aone 应用名称或 ID

三个对象参数最多指定一个；互相组合会在发起网络请求前报错。当前只有应用、Maven 包和 FaaS 支持查询绑定流水线，因此不提供 `--pypi`、`--rpm`。quiet 模式逐行输出流水线 ID。

## cd-pipeline get

查询流水线基本信息、最新版本、当前上架版本及已发布定义列表。

```bash
a1 cd-pipeline get <pipeline-id>
a1 cd-pipeline get <pipeline-id> --format json
```

quiet 模式只输出流水线 ID。
`<pipeline-id>` 只接受正整数，不接受流水线 URL。

## cd-pipeline bind

将已有流水线绑定到应用。

绑定前先查询目标流水线：

```bash
a1 cd-pipeline get <pipeline-id> --format json
```

确认返回的 `pipeline.id` 是目标流水线，且 `pipeline.definitionList` 非空（通常同时表现为 `pipeline.latestVersion > 0`）。若 `definitionList` 为空或 `latestVersion=0`，停止绑定并提示用户先发布流水线定义；不要在上游以 HTTP 502 暴露该失败时盲目重试。已发布定义不要求处于上架状态。

检查通过后再绑定：

```bash
a1 cd-pipeline bind <pipeline-id> --app <app-name-or-id>
a1 cd-pipeline bind <pipeline-id> --app <app-name-or-id> --dev-stage-type changeRequest
```

参数：

- `--app string` — 应用名称或 ID，必填
- `--dev-stage-type string` — 可选的开发阶段类型

`<pipeline-id>` 只接受正整数，不接受流水线 URL。该命令只支持应用绑定，不接受 `--mvn/--faas`。重复绑定同一流水线时复用既有绑定。quiet 模式输出流水线 ID。

## cd-pipeline vars

列出流水线对当前调用方可见的自定义全局变量。

```bash
a1 cd-pipeline vars <pipeline-id>
a1 cd-pipeline vars <pipeline-id> --format json
```

`<pipeline-id>` 只接受正整数，不接受流水线 URL。表格输出会将加密变量的默认值显示为 `***`；JSON 输出保持服务端返回结构。quiet 模式逐行输出变量名。

## cd-pipeline run

```bash
a1 cd-pipeline run <pipeline-id>
a1 cd-pipeline run <pipeline-id> --param key=value --param other=value
a1 cd-pipeline run <pipeline-id> --app <app-name-or-id> --cr-id <cr-id>
a1 cd-pipeline run <pipeline-id> --mvn <package-name-or-id> --cr-id <cr-id>
a1 cd-pipeline run <pipeline-id> --faas <faas-app-name-or-id> --cr-id <cr-id>
a1 cd-pipeline run <pipeline-id> --wait-until-settled
```

`--param key=value` 可重复；不支持 `--params-file`。

命令在触发前查询流水线 `sourceType`：

- `CODE/OTHER`：按独立流水线运行。
- `CHANGE_REQUEST`：必须同时提供 `--cr-id` 和 `--app/--mvn/--faas` 之一；CLI 提交 CR 后创建并启动对应运行。
- 其他 `sourceType`：当前不支持 `run`，直接报错。

`--app`、`--mvn`、`--faas` 两两互斥；对象参数与 `--cr-id` 必须同时出现。`--mvn` 只接受 Maven/library 包，不支持 PyPI、RPM。

## cd-pipeline run get

```bash
a1 cd-pipeline run get <run-id>
a1 cd-pipeline run get <run-id> --stage-id <stage-id>
a1 cd-pipeline run get <run-id> --job-id <job-id>
```

返回 run → stage → job → task 完整层级。`--stage-id` 与 `--job-id` 互斥，且必须属于该 run。

## cd-pipeline run rerun

```bash
a1 cd-pipeline run rerun <run-id>
a1 cd-pipeline run rerun --pipeline-id <pipeline-id> --app <app-name-or-id>
a1 cd-pipeline run rerun --pipeline-id <pipeline-id> --mvn <package-name-or-id>
a1 cd-pipeline run rerun --pipeline-id <pipeline-id> --faas <faas-app-name-or-id>
```

- `<run-id>` 与 `--pipeline-id/--app/--mvn/--faas` 互斥。
- 最新实例模式要求 `--pipeline-id`，并且 `--app/--mvn/--faas` 必须且只能提供一个。
- `run` 与 `run rerun` 均支持重复 `--param`。
- `--interval/--timeout` 依赖 `--wait-until-settled`；等待模式与 `--format json/--quiet` 互斥。

## 其他流水线操作

尚未迁移的流水线操作使用以下命令：

| 操作 | 命令 |
|---|---|
| 查询应用流水线状态 | `a1 app pipeline status` |
| 查询应用流水线实例 | `a1 app pipeline instance` |
| 提交到待发布但不选择流水线 | `a1 app cr submit <cr-id>` |
| 查询 task 组件详情和执行动态动作 | `a1 app pipeline stage job task status` |

以下旧入口仅用于兼容已有脚本，执行时会输出替代命令：

| 旧命令 | 替代命令 | 差异 |
|---|---|---|
| `a1 app pipeline list [--app <app>]` | `a1 cd-pipeline list --app <app>` | 新入口要求显式应用，输出定义信息；最新运行状态使用 `app pipeline status` |
| `a1 app pipeline bind --pipeline-id <id>` | `a1 cd-pipeline bind <id> --app <app>` | 新入口要求显式应用 |
| `a1 pkg pipeline list [--pkg <pkg>]` | `a1 cd-pipeline list --mvn <mvn>` | 新入口仅支持 Maven 包查询，输出定义信息 |
| `a1 pipeline vars <id>` | `a1 cd-pipeline vars <id>` | 新入口支持 quiet，并遮蔽表格中的加密默认值 |
| `a1 pipeline run <id>` | `a1 cd-pipeline run <id>` | 新入口不支持 `--params-file` |
| `a1 app pipeline reenter/run/retry --pipeline-id <id>` | `a1 cd-pipeline run rerun --pipeline-id <id> --app <app>` | 新入口要求显式应用，也支持按 `run-id` 精确重跑 |
| `a1 pkg pipeline reenter --pipeline-id <id>` | `a1 cd-pipeline run rerun --pipeline-id <id> --mvn <mvn>` | 新入口要求显式 Maven 包，也支持按 `run-id` 精确重跑 |
| `a1 app pipeline stage list/status` | `a1 cd-pipeline run get <run-id> [--stage-id <id>]` | 新入口固定查询指定运行 |
| `a1 app pipeline stage job list/status` | `a1 cd-pipeline run get <run-id> --stage-id/--job-id <id>` | 新入口返回完整子树 |
| `a1 app cr submit <cr-id> --pipeline-id <id>` | `a1 cd-pipeline run <id> --app <app> --cr-id <cr-id>` | 不带 pipeline ID 的待发布提交保留 |
| `a1 pkg cr submit` | `a1 cd-pipeline run <id> --mvn <mvn> --cr-id <cr-id>` | 不保留 submit-only 语义 |
