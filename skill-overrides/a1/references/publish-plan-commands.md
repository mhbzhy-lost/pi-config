# publish-plan 命令完整参考

## 发布计划（publish-plan）

`publish-plan` 是顶层命令，不属于 `app` 命令组。

### publish-plan list

默认查询当前用户参与的进行中发布计划。

- `--all` — 查询所有可见发布计划
- `--keyword string` — 按名称关键词过滤
- `--status string` — `ONGOING` 或 `ARCHIVED`，默认 `ONGOING`
- `--sort string` — `gmtCreate` 或 `planReleaseDate`
- `--order string` — `ASC` 或 `DESC`
- `--page-start int` — 从 0 开始的结果偏移量
- `--page-size int` — 返回数量，默认 10
- `-f, --format string` — table、json
- `-q, --quiet` — 仅输出发布计划 ID

### publish-plan get <publish-plan-id>

查询发布计划详情；`-f json` 返回完整详情，`-q` 仅输出 ID。

### publish-plan create <name>

创建简化发布计划。当前用户默认同时作为负责人和测试负责人，计划发布时间默认 7 天后。

- `--description string` — 发布计划描述
- `--deadline string` — 变更登记截止时间
- `--plan-release-date string` — 计划发布时间
- `-f, --format string` — table、json
- `-q, --quiet` — 仅输出新发布计划 ID

时间支持 `YYYY-MM-DD`、`YYYY-MM-DD HH:mm`、RFC3339、`+2d`、`3h`。

### publish-plan submit <publish-plan-id>

将一个或多个 Aone 应用 CR、O2 变更加入发布计划。CLI 会先查询变更详情并自动携带 `appId/appType`。

- `--cr-ids string` — 逗号分隔的 Aone 应用 CR ID
- `--o2-change-ids string` — 逗号分隔的 O2 变更 ID
- `--description string` — 写入发布计划条目的备注
- `-f, --format string` — table、json
- `-q, --quiet` — 仅输出发布计划 ID

```bash
a1 publish-plan list --all --status ARCHIVED
a1 publish-plan get 12345 -f json
a1 publish-plan create "July release" --plan-release-date "2026-07-28 18:00"
a1 publish-plan submit 12345 --cr-ids 33706784,33706785
a1 publish-plan submit 12345 --o2-change-ids 22740008,22740009
a1 publish-plan submit 12345 --cr-ids 33706784 --o2-change-ids 22740008
```

`--cr-ids` 与 `--o2-change-ids` 至少传一个，可同时传。自定义任务当前不支持。
