# testcase 命令完整参考

## a1 testcase — 测试用例管理（TestHub）

把「测试用例」作为一级交付对象：用例本体的 CRUD 是根级动词，测试计划（plan）、用例库（library）、目录（folder）是子对象。别名 `a1 tc`。底层走 Aone TestHub MCP，复用 a1 登录态（kit MCP 网关，provider=aone），无需为 testhub 单独授权。

> ⚠️ 不要与 `a1 quality testcase` 混淆：`a1 quality testcase` 查的是**质量平台的测试用例执行报告/结果**；`a1 testcase` 管的是**用例本体与测试计划的增删改查、执行回填**。管理用例/计划用 `a1 testcase`，看质量报告用 `a1 quality`。

```bash
a1 testcase <subcommand> [flags]
a1 tc <subcommand> [flags]          # 别名
```

### 全局约定（所有子命令通用）

| 约定 | 说明 |
|------|------|
| 位置参数 `<id>` | 对象自身 ID 走位置参数（`get 123`、`plan get 1991180`、`library get 178477`、`folder get 5269`） |
| `--library` | 用例/目录的所属用例库作用域。用例（case）、目录（folder）的 ID 仅在库内唯一，故这些命令须带 `--library`；用例库、计划的 ID 全局唯一 |
| `--from-url` | 从 TestHub 链接解析 libraryId/folderId/planId/caseId，代替位置参数与 `--library` |
| `-f, --format` | 输出格式：plain 或 json（json 适合 agent 解析） |
| `--env` | kit 运行环境：local\|daily\|pre\|prod（覆盖 AONE_KIT_ENV） |
| 更新默认 patch | `update` 只发显式传入的字段，未传字段保持不变；`--replace` 才全量覆盖（未传字段会被置空） |
| 多 ID 自动批量 | `1,2,3` 或空格分隔，自动路由到对应 batch 工具 |
| `--yes` | 删除 / 归档等危险操作需显式确认 |

---

## 用例本体（根级动词）

以下动词也可通过隐藏别名组 `a1 testcase case <verb>` 调用（等价）。

### testcase create

在指定用例库和文件夹下新建用例。

```bash
a1 testcase create --library 178477 --folder 5269 --name 登录-异常密码 --priority P1
a1 testcase create --library 178477 --folder 5269 --name xxx --type AUTOMATION --precondition ... --step ... --expected ...
```

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--library` | int | — | 用例库 ID（必填） |
| `--folder` | int | — | 目标文件夹 ID（必填） |
| `--name` | string | — | 用例名称（必填） |
| `--priority` | string | P2 | 优先级 P0\|P1\|P2\|P3 |
| `--type` | string | MANUAL | 类型 MANUAL\|AUTOMATION |
| `--content-type` | string | TEXT | 内容类型 TEXT\|STEPS |
| `--precondition` / `--step` / `--expected` / `--description` | string | — | 前置条件 / 测试步骤 / 预期结果 / 描述 |

---

### testcase get \<case-id\>

查看用例详情。

```bash
a1 testcase get 123 --library 178477
a1 testcase get --from-url "<用例链接>"
```

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--library` | int | — | 用例库 ID（必填，或用 --from-url） |

---

### testcase list

搜索用例。默认省略步骤内容以减小体积。

```bash
a1 testcase list --library 178477 --priority P0 --all
a1 testcase list --library 178477 --folder 5269 --type AUTOMATION
a1 testcase list --library 178477 --ids-only
```

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--library` | int | — | 用例库 ID（必填） |
| `--folder` | int | — | 按文件夹过滤 |
| `--priority` | string | — | 优先级 P0\|P1\|P2\|P3 |
| `--type` | string | — | 类型 MANUAL\|AUTOMATION |
| `--name` | string | — | 按名称搜索 |
| `--all` | bool | false | 自动翻页获取全部 |
| `--with-step` | bool | false | 返回完整步骤内容 |
| `--ids-only` | bool | false | 仅返回用例 ID 列表（getTestCaseIds） |
| `--page` / `--page-size` | int | 1 / 50 | 分页 |

---

### testcase update \<case-id...\>

修改用例。**默认增量 patch**（只发你传的字段，无需先读整条用例，最省上下文）；多 ID 走批量（仅标签/优先级/类型）；`--replace` 全量覆盖。

```bash
a1 testcase update 123 --library 178477 --priority P0        # 增量（推荐）
a1 testcase update 1,2,3 --library 178477 --type AUTOMATION   # 多 ID 批量
a1 testcase update 123 --library 178477 --replace --name ... --type ... --content-type ... --folder ...
```

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--library` | int | — | 用例库 ID（必填） |
| `--name` / `--priority` / `--type` / `--content-type` / `--precondition` / `--step` / `--expected` / `--description` | string | — | 要更新的字段 |
| `--folder` | int | — | 文件夹 ID（--replace 时必填） |
| `--replace` | bool | false | 全量覆盖（updateTestCase，未传字段被置空） |

---

### testcase delete / restore / archive \<case-id...\>

`delete` 软删（可 restore 恢复）；`restore` 恢复软删；`archive` 永久删除（**须先 delete 软删**，且需 `--yes`）。

```bash
a1 testcase delete 1,2,3 --library 178477
a1 testcase delete 1,2,3 --library 178477 --force    # 用例若已关联计划，先解除关联再删
a1 testcase restore 1,2,3 --library 178477
a1 testcase archive 1,2,3 --library 178477 --yes
```

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--library` | int | — | 用例库 ID（必填） |
| `--force` | bool | false | （delete）用例已关联测试计划时，先解除关联再删除 |
| `--yes` | bool | false | （archive）确认永久删除 |

---

### testcase move / copy \<case-id...\>

移动 / 复制用例到指定库和文件夹。

```bash
a1 testcase move 1,2,3 --library 178477 --to-folder 6000
a1 testcase copy 1,2,3 --library 178477 --to-folder 6000 --to-library 200000
```

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--library` | int | — | 源用例库 ID（必填） |
| `--to-folder` | int | — | 目标文件夹 ID（必填） |
| `--to-library` | int | 同源库 | 目标用例库 ID |

---

### testcase tag / untag / tags \<case-id\>

按**标签名**打标签 / 去标签（自动 getOrCreateTag，不存在则创建）；`tags` 查看用例的标签。

```bash
a1 testcase tag 123 --library 178477 --tag 冒烟,回归
a1 testcase untag 123 --library 178477 --tag 回归
a1 testcase tags 123 --library 178477
```

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--library` | int | — | 用例库 ID（必填） |
| `--tag` | string | — | 标签名，可逗号分隔多个（tag/untag 必填） |

---

### testcase link / unlink / links \<case-id...\>

用例关联 / 解除关联 Aone 工作项（需求/缺陷）；`links` 查用例关联的工作项。

```bash
a1 testcase link 123 --library 178477 --issue 80500662 --issue-type BUG
a1 testcase unlink 123 --library 178477 --issue 80500662
a1 testcase links 123 --library 178477 --issue-type BUG
```

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--library` | int | — | 用例库 ID（必填） |
| `--issue` | string | — | 工作项 ID，逗号分隔（link/unlink 必填） |
| `--issue-type` | string | BUG | 工作项类型 REQUIREMENT\|BUG |

---

### testcase history \<case-id\> \[show\|restore\]

用例操作/版本历史；`show` 看某历史版本快照，`restore` 恢复到指定版本。

```bash
a1 testcase history 123 --library 178477
a1 testcase history show 123 --library 178477 --snapshot 456
a1 testcase history restore 123 --library 178477 --snapshot 456
```

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--library` | int | — | 用例库 ID（必填） |
| `--snapshot` | int | — | 历史版本(快照) ID（show/restore 必填） |

---

### testcase records \<case-id\>

用例跨计划测试记录：该用例在各测试计划内的最新状态、测试时间、执行人。

```bash
a1 testcase records 123 --library 178477
```

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--library` | int | — | 用例库 ID（必填） |

---

## a1 testcase plan — 测试计划

测试计划的 CRUD + 关联 + 执行回填 + 指派/备注 + 工作项 + 报告 + 成员。**执行结果 / 指派 / 备注是计划级操作，须先 `plan associate` 把用例关联进计划。**

```bash
a1 testcase plan <subcommand> [flags]
```

### plan create / update / delete / copy / get / list

```bash
a1 testcase plan list --project 2147831
a1 testcase plan get 1991180
a1 testcase plan create --name 登录回归 --start 2026-07-01T00:00:00+08:00 --end 2026-07-10T00:00:00+08:00 --admin 368136
a1 testcase plan update 1991180 --status DEPRECATED        # 默认 patch；--replace 全量
a1 testcase plan delete 1991180 --yes                      # 须先结束计划（--status DEPRECATED）
```

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--name` | string | — | 计划名称（create/copy 必填） |
| `--start` / `--end` | string | — | 起止时间，**ISO-8601**（如 2026-07-01T00:00:00+08:00；create/copy 必填） |
| `--admin` | string | — | 管理员工号，逗号分隔（create/copy 必填） |
| `--project` / `--sprint` | int | — | 关联项目 / 迭代 ID |
| `--status` | string | — | 状态，仅 COMPLETED\|DEPRECATED |
| `--replace` | bool | false | 全量覆盖更新 |
| `--yes` | bool | false | 确认删除 |

### plan associate / disassociate / create-case

```bash
a1 testcase plan associate 1991180 --library 178477 --case 1,2,3     # 关联用例
a1 testcase plan associate 1991180 --library 178477 --folder 5269    # 关联整个目录
a1 testcase plan disassociate 1991180 --library 178477 --case 3
a1 testcase plan create-case 1991180 --library 178477 --folder 5269 --name 新用例   # 建并关联
```

### plan record / executions（执行结果）

`record` 回填执行结果（PASS/FAIL/HOLD/CLOSE，单条 submitTestCaseExecution / 多条 batchUpdateTestResults）；`executions` 查某用例执行历史。

```bash
a1 testcase plan record 1991180 --library 178477 --case 123 --status PASS
a1 testcase plan record 1991180 --library 178477 --case 1,2,3 --status FAIL --description "报错500"
a1 testcase plan executions 1991180 --library 178477 --case 123
```

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--library` | int | — | 用例库 ID（必填） |
| `--case` | string | — | 用例 ID，单或逗号分隔（必填） |
| `--status` | string | — | 结果 PASS\|FAIL\|HOLD\|CLOSE（record 必填） |
| `--description` | string | — | 执行描述 |

### plan assign / note

```bash
a1 testcase plan assign 1991180 --library 178477 --case 123 --to 368136
a1 testcase plan note 1991180 --library 178477 --case 123 --note "需复测"
```

### plan link / unlink / links / issue-cases（计划级工作项）

```bash
a1 testcase plan link 1991180 --case 123 --issue 80500662 --issue-type BUG
a1 testcase plan unlink 1991180 --library 178477 --case 123 --issue 80500662
a1 testcase plan links 1991180 [--library 178477 --case 123] --issue-type BUG
a1 testcase plan issue-cases 1991180 --issue-type BUG      # 按工作项反查用例
```

### plan report / cases / libraries / folders / export

```bash
a1 testcase plan report 1991180                            # 通过率 / 各状态数
a1 testcase plan cases 1991180 [--ids-only]                # 计划关联用例
a1 testcase plan libraries 1991180                         # 计划关联用例库
a1 testcase plan folders 1991180                           # 计划关联目录
a1 testcase plan export 1991180 --library 178477 --case 1,2,3   # 导出为 Excel（含结果）
```

### plan member

```bash
a1 testcase plan member list 1991180
a1 testcase plan member add 1991180 --users 368136 --role MEMBER
a1 testcase plan member remove 1991180 --user 368136
a1 testcase plan member role 1991180 --user 368136 --role ADMIN
```

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--users` | string | — | 工号列表，逗号分隔（add 必填） |
| `--user` | string | — | 工号（remove/role 必填） |
| `--role` | string | MEMBER | 访问级别 ADMIN\|MEMBER\|VIEWER |
| `--user-type` | string | EMPLOYEE | 成员类型 EMPLOYEE\|PROJECT |

---

## a1 testcase library — 用例库

```bash
a1 testcase library list [--project 2147831] [--product <id>] [--name <kw>] [--all]
a1 testcase library get 178477
a1 testcase library create --name 交易核心用例库 --publicity TEAM_PUBLIC
a1 testcase library update 178477 --name 新名               # 默认 patch；--replace 全量
a1 testcase library delete 178477 --yes
a1 testcase library add-project 178477 --project 2147831    # 关联所属项目（身份边界）
a1 testcase library member list|add|remove|role 178477 ...  # 同 plan member
```

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--name` | string | — | 用例库名称（create 必填） |
| `--publicity` | string | TEAM_PUBLIC | 公开度 PUBLIC\|TEAM_PUBLIC\|PRIVATE |
| `--product` | int | — | 关联产品 ID |
| `--project` | string | — | （add-project）项目 ID 列表，逗号分隔 |
| `--replace` | bool | false | 全量覆盖更新（需同时提供 --name 与 --publicity） |
| `--yes` | bool | false | 确认删除 |

---

## a1 testcase folder — 目录

```bash
a1 testcase folder list --library 178477 [--parent 0]
a1 testcase folder get 5269 --library 178477
a1 testcase folder create --library 178477 --name 登录模块 [--parent 0]
a1 testcase folder update 5269 --library 178477 --name 登录与鉴权
a1 testcase folder move 5269 --library 178477 --to 6000
a1 testcase folder copy 5269 --library 178477 --to-library 200000
a1 testcase folder delete 5269 --library 178477 --yes
a1 testcase folder report 5269 --library 178477 --plan 1991180   # 文件夹维度报告，须带 --plan
```

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--library` | int | — | 用例库 ID（必填） |
| `--name` | string | — | 名称（create/update 必填） |
| `--parent` | int | 0 | 父文件夹 ID |
| `--to` | int | — | （move）目标父文件夹 ID |
| `--to-library` | int | — | （copy）目标用例库 ID |
| `--plan` | int | — | （report）所属测试计划 ID（必填） |
| `--yes` | bool | false | 确认删除 |

---

## 导入导出 / 逃生舱

```bash
a1 testcase export --library 178477 --case 1,2,3 --format excel   # excel|xmind
a1 testcase import --library 178477 --folder 5269 --file cases.xlsx
a1 testcase upload ./attach.png [--image]                        # 上传附件/图片，返回 assetId

a1 testcase call <mcpTool> '<json>'    # 直连任意底层 MCP 工具，覆盖全部能力
a1 testcase tools                      # 列出全部 MCP 工具
```

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--library` | int | — | 用例库 ID（export/import 必填） |
| `--case` | string | — | （export）用例 ID，逗号分隔（必填） |
| `--folder` | int | — | （import）目标文件夹 ID（必填） |
| `--file` | string | — | （import）本地 Excel/XMind 文件路径 |
| `--format` | string | excel | 格式 excel\|xmind |
| `--image` | bool | false | （upload）作为图片上传 |
