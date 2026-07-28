# build 命令完整参考

## a1 build job — 构建 Job 与日志

`a1 build job` 用于查询 Aone Build 产生的构建 Job、Step 和日志。它和 `a1 ci job` 不是同一个概念：

- `ci job`：AoneCI 流水线里的 job，需要 `--run <run-id>`。
- `build job`：Aone Build 的构建 Job，当前支持按 `--pipeline-instance-id` 查询。

### build job list

按 pipeline instance id 查询关联的构建 Job 列表。

```bash
a1 build job list --pipeline-instance-id <pipeline-instance-id>
a1 build job list --pipeline-instance-id <pipeline-instance-id> --include-artifacts -f json
a1 build job list --pipeline-instance-id <pipeline-instance-id> -f json
```

Flags:
- `--pipeline-instance-id int` — pipeline instance id，当前支持的构建 Job 查询维度之一。
- `--include-artifacts bool` — 附带构建制品引用；JSON 输出包含 `artifacts` 和 `artifactWarnings`。
- `-f, --format string` — 输出格式：plain、json。
- `-q, --quiet` — 仅输出关键 ID。

说明：
- 不要求用户提供底层 `mixFlowInstId`。CLI/a1-server 会把用户侧的 `pipelineInstanceId` 转给构建服务处理。
- 如果需要继续查日志，先从返回结果里拿到 `jobId`，再执行 `build job steps` 和 `build job log`。

### build job get <job-id>

查看构建 Job 详情。

```bash
a1 build job get <job-id>
a1 build job get <job-id> --include-artifacts
a1 build job get <job-id> -f json
```

Flags:
- `--include-artifacts bool` — 附带构建制品引用；JSON 输出包含 `artifacts` 和 `artifactWarnings`。
- `-f, --format string` — 输出格式：plain、json。
- `-q, --quiet` — 仅输出关键 ID。

### build job steps <job-id>

列出构建 Job 可查询的日志 Step。

```bash
a1 build job steps <job-id>
a1 build job steps <job-id> -f json
```

Flags:
- `-f, --format string` — 输出格式：plain、json。
- `-q, --quiet` — 仅输出 Step 名称。

### build job log <job-id>

查询构建 Job 某个 Step 的日志。

```bash
a1 build job log <job-id> --step <step-name>
a1 build job log <job-id> --step build-package --offset 0 --limit 500 -f json
a1 build job log <job-id> --step build-package --follow
a1 build job log <job-id> --step build-package --download build-package.log
```

Flags:
- `-s, --step string` — Step 名称。先用 `a1 build job steps <job-id>` 查询可用值。
- `--offset int` — 日志偏移量，使用上一次 JSON 响应里的 `nextOffset` 做增量查询。
- `--limit int` — 本次最多拉取的日志行数，默认 `500`。
- `--follow` — 轮询并流式输出新增日志，直到 Step 结束。
- `--download string` — 下载完整 Step 日志到指定文件。
- `-f, --format string` — 输出格式：plain、json。

日志语义：
- `--limit` 是行数，不是字节数。
- `nextOffset` 是下一次增量查询应传入的 offset；返回 `-1` 时通常表示当前查询已经到达终点。
- JSON 输出里的 `finished` 表示当前日志查询是否到终点；运行中的 Step 可能暂时没有新日志，但不代表构建结束。
- JSON 输出里的 `stepRunning` / `stepStatus` 用于判断 Step 状态；脚本化轮询不要只看本次是否返回日志内容。
- `--follow` 只适合 Step 已经在运行的场景。第一次请求如果 Step 不在运行中，命令会提示不支持 follow；已结束任务应使用普通 `log` 或 `--download`。
- follow 开始后，结束条件按 `finished=true` 且 `stepRunning=false` 判断，避免“日志暂时读到最新”被误判为结束。

推荐排查顺序：

```bash
a1 build job list --pipeline-instance-id <pipeline-instance-id>
a1 build job get <job-id>
a1 build job steps <job-id>
a1 build job log <job-id> --step <step-name>
```
