---
name: a1
version: 0.35.0
files:
  - SKILL.md
  - references
  - package.json
description: 集团内部研发产品统一命令行客户端（a1 CLI）使用助手。用于操作 Aone/Code 等内部研发平台的代码仓库、分支和代码搜索，合并请求（MR/代码评审）及评论，AoneCI、构建日志和交付流水线，应用、CR、发布计划、Pages 与环境，Maven 制品与二方包，项目空间的需求、缺陷、任务、工作项及内容评审，CoCo 工作流，知识库与 CodeWiki，AoneFaaS，O2，TestHub 与质量报告，Devix 交付任务，Contextlab Skill，员工、活动事件、FAQ、反馈，以及 a1 安装更新（含 alpha）。当用户明确提到 a1、Aone、MR、CR、AoneCI、CodeWiki、FaaS、TestHub、Devix，或要求查询、创建、修改、关联、评审、提交、发布、部署、重跑上述内部研发对象时使用。即使未提及 a1，出现以下具体研发动作也应触发：查/创建/发布/导出工作流模板、启动或发起工作流、查工作流实例、查需求/缺陷/任务/工作项、查工作项关联钉群/入群链接、发起需求内容评审、催评审、查/管理用户组、创建/推进/查交付任务、查工作空间、加/删/同步 O2 成员、O2 灰度发布、创建/查测试用例与测试计划、回填测试结果、看计划通过率、Maven 二方包发布、查发布计划、生成/搜索/问答 CodeWiki、查 CI 构建与构建日志、重跑构建、给 a1 提反馈、更新或安装 a1 alpha。普通编程、通用 Git 托管、数据库、可观测或机器运维请求不使用。
---

# a1 CLI 使用指南

使用 a1 完成集团内部研发平台操作。把本文件当作决策入口；完整参数和领域细节按需读取 `references/`，不要一次加载全部参考文档。

## 工作流程

1. **识别意图。** 不确定命令域时先读 [意图路由](references/intent-mapping.md)，避免把名称相近但副作用不同的命令混用。
2. **逐一读取相关 reference。** 构造具体 flag 前必须读取当前请求涉及的领域文件；每个命令域只加载对应 reference，跨域闭环可以读取多份。reference 未覆盖时执行 `a1 <command> --help`。CLI 参数会演进，凭记忆猜 flag 容易触发错误操作。
3. **确认身份、上下文和目标。** 需要绑定资源的命令先执行 `a1 link status -f json`，必要时显式传 `--repo`、`--app`、`--project` 或包标识，防止在错误资源上操作。
4. **执行最小操作。** 查询可直接执行；写操作只在用户请求的资源范围内执行。删除、覆盖、正式发布和 FaaS 注册按对应安全规则处理。
5. **验证最终状态。** 创建或提交成功不等于流程完成；用 MR、CI、流水线或发布状态命令确认权威终态，再向用户报告结果和剩余门禁。

## 核心规则

- **⚠️ 构造命令前必须查阅完整参数。** 只要请求涉及指定描述、指派人、筛选条件、格式化输出等具体选项，就必须先读对应 reference（或 `a1 <command> --help`）确认真实 flag 再拼命令，禁止凭记忆猜测参数名。这是防止误触发错误操作的总闸门。
- **不要给枚举参数传空字符串。** `--status ""`、`--trigger-mr-type ""` 等会让服务端枚举反序列化失败；没有有效值时完全省略该参数。
- **修复评审意见后默认不 resolve。** 评论应由评审人确认后关闭；只有用户明确要求时才执行 `a1 repo mr comment resolve`。
- **从工作项进入开发并创建 MR 时关联工作项。** 创建 MR 必须带 `--work-items <工作项ID>`，让代码评审和需求保持可追溯。
- **工作项图片交给 CLI 上传。** 创建或更新工作项时，把本地图片写成 Markdown 图片语法放入 `--body`/`--body-file`；不要先转述图片内容替代原图。
- **知识库搜索后按需读取全文。** `a1 kbase search` 只返回摘要或片段；除非用户只要命中列表，继续用结果中的 `repo-id`、`page-id` 执行 `a1 kbase page view`，避免根据截断片段下结论。
- **流水线动作必须继续走 a1。** `supportedActions` 只说明允许的动作，不提供绕过 CLI 的权限；禁止根据调试信息直接重放后端 URL、headers 或 body。
- **FaaS 注册必须二次确认。** `a1 faas register` 会注册正式应用、绑定或创建仓库并可能推送代码。即使用户已说“发布到 Aone”，也要先展示并确认目标应用名、`--repo-group`、`--repo-project` 三项最终值。
- **已下线命令不要尝试。** `a1 claw` 没有替代命令，遇到相关需求直接说明当前不支持。
- **判断不该触发时明确声明边界。** 请求属于机器运维、可观测、通用 Git 托管或数据库等非 a1 领域时，直接回复“该操作属于 <对应工具> 领域，超出 a1 范围”，不要只反问澄清让用户困惑。
- **多步骤流程要连续推进。** 发现子命令后继续用 `--help` 探明必填参数并尝试下一步，缺少的资源 ID 优先用查询命令获取；不要执行完第一步就停下等待用户，除非命中写操作安全规则或确实缺少无法推断的输入。

## 认证与资源上下文

工作电脑通常已有 NCS；认证失败时再选择合适登录方式：

```bash
a1 auth login --buc
a1 auth login --ncs
a1 auth login --platform code
a1 auth whoami -f json
a1 link status -f json
```

- AOne 沙箱使用 AIT，AOne CI 使用 CIT；不要把个人交互式登录复制到自动化环境。
- MCP/Skill 默认复用 a1 登录。只有需要调整 CIAP/Bearer 优先级时，才读取 [Skill 与 MCP](references/skill-commands.md) 的认证章节。
- CI、离线或批量执行可设置 `A1_NO_UPDATE_CHECK=1`，避免后台升级检查影响时延和日志。
- 遥测开关用 `a1 telemetry status|enable|disable` 查看和切换；具体子命令 flag 以 `--help` 为准。

## Reference 路由

只读取与当前请求相关的文件：

| 场景 | 必读 reference | 选择边界 |
| --- | --- | --- |
| 不确定自然语言对应哪个命令 | [intent-mapping.md](references/intent-mapping.md) | 先选命令域，再读领域 reference |
| 仓库、分支、文件、MR、评论、搜索、tag | [repo-commands.md](references/repo-commands.md) | MR 最终状态以 `mr status/view` 为准 |
| AoneCI 流水线、Run、Job、模板 | [ci-commands.md](references/ci-commands.md) | CI Job 不等于 Aone Build Job |
| Aone Build Job、Step、日志、制品 | [build-commands.md](references/build-commands.md) | `--follow` 只用于仍在运行的 Step |
| 交付流水线查询、绑定、运行、重跑 | [cd-pipeline-commands.md](references/cd-pipeline-commands.md) | 应用/Maven/FaaS 对象参数互斥 |
| 应用、CR、发布阶段、部署单、任务动作 | [app-commands.md](references/app-commands.md) | 集成环境提交与发布流水线提交不同 |
| 发布计划 | [publish-plan-commands.md](references/publish-plan-commands.md) | Aone CR 与 O2 变更可同时提交 |
| Maven 包、包 CR、正式二方包发布 | [pkg-commands.md](references/pkg-commands.md) | 区分 CR、集成区和应用发布页流程 |
| 本地 Maven 制品上传 | [artifact-commands.md](references/artifact-commands.md) | Artlab 调试上传不是正式发布 |
| 项目、工作项、内容评审、CoCo、员工、用户组 | [project-commands.md](references/project-commands.md) | 工作项状态和工作流状态枚举不同 |
| 知识库、页面、CodeWiki | [kbase-commands.md](references/kbase-commands.md) | CodeWiki 页面不是 Aone Pages 站点 |
| Aone Pages 站点配置 | [pages-commands.md](references/pages-commands.md) | 部署站点内容改走 CI Pages 模板 |
| 应用环境、trait、项目环境、apre | [env-commands.md](references/env-commands.md) | 删除或部署前确认精确环境 ID |
| Contextlab Skill、MCP、Skill 发布 | [skill-commands.md](references/skill-commands.md) | `find` 与 `install` 使用相同环境 |
| Devix 交付任务和工作空间 | [devix-commands.md](references/devix-commands.md) | 交付任务不是项目工作项 |
| O2 应用、迭代、变更、发布、灰度 | [o2-commands.md](references/o2-commands.md) | 按应用和迭代上下文选命令 |
| AoneFaaS | [faas-commands.md](references/faas-commands.md) | `register` 前必须二次确认 |
| TestHub 用例、计划、用例库、执行回填 | [testcase-commands.md](references/testcase-commands.md) | 管理用例不走只读 quality 报告 |
| a1 安装，以及稳定版、beta、内部 alpha 更新 | [update-commands.md](references/update-commands.md) | alpha 必须显式指定 channel |
| 开放平台 CLI 工具管理 | [cli-commands.md](references/cli-commands.md) | 区分管理 CLI 工具和使用 a1 |
| 产品反馈 | [feedback-commands.md](references/feedback-commands.md) | assignee 必须属于目标反馈空间 |
| 质量报告、仓库/用户事件、FAQ | [intent-mapping.md](references/intent-mapping.md) | 定位命令后用对应 `--help` 核对 flag |

## 关键消歧

### 交付任务与项目工作项

“创建/发起/推进交付任务”使用 `a1 devix task ...`；“需求、缺陷、任务、工作项”使用 `a1 project workitem ...`。二者生命周期和归属空间不同，不能因都叫“任务”而互换。

### 测试用例管理与质量报告

增删改查用例、测试计划、用例库和执行回填使用 `a1 testcase`（别名 `tc`）；查看已有测试执行报告、覆盖率或扫描问题使用只读的 `a1 quality testcase|coverage|issue`。

### Pages 配置与内容部署

站点名和域名配置使用 `a1 pages view|create|update|delete`；构建并发布静态内容使用 `a1 ci` 的 Aone Pages 模板。只说“Pages”且动作不清楚时先确认是哪一种。

### CI、Build 与交付流水线

- `a1 ci` 管理 AoneCI 流水线、Run 和 CI Job。
- `a1 build job` 从 pipeline instance 下钻 Aone Build Job/Step 日志。
- `a1 cd-pipeline` 管理应用、Maven 包和 FaaS 的交付流水线运行。

这些对象的 ID 不通用；先判断用户给的是 run ID、pipeline instance ID 还是 pipeline ID。

### Maven 发布路径

- 本机 SNAPSHOT/调试上传到 Artlab：`a1 artifact mvn deploy`。
- 单 CR 正式发布：`a1 pkg deploy-cr`。
- 包 CR 提交到发布流水线：`a1 cd-pipeline run ... --mvn ... --cr-id ...`。
- 发布页集成区填写二方包组件：在上一条返回的 flow 上执行 `a1 pkg deploy-intg preview/submit`。

先确认用户要的是调试上传、正式单变更发布还是集成区发布，避免把制品传到错误通道。

## 常用闭环

- **仓库/MR：** 检查绑定与当前分支 → 读取 repo reference → 执行查询或变更 → 用 `a1 repo mr status/view` 核对合并、审批和 CI 门禁。
- **CI 失败：** `run get` → `job list --run` → `job log --run`；日志出现测试或扫描报告 UID 时，再进入 `quality testcase/issue`。
- **Build 失败：** `build job list --pipeline-instance-id` → `steps` → `log`；已结束任务用普通拉取或下载，不要强行 `--follow`。
- **发布卡住：** `status` 字段会误导，必须下钻排查——`pipeline status` 看整体（`status=running` 可能被节点 `extendedStatus` 阻塞，`status=waiting` 可能是正常等待也可能需人工介入）→ `cd-pipeline run get <run-id>` 查 stage/job/task 完整层级定位异常阶段 → `cd-pipeline run get <run-id> --stage-id <id>` 下钻指定阶段 → `app pipeline branch --instance-id <id>` 看 release 分支和合并 CR。
- **应用 CR 发布：** 创建 CR → 必要时提交代码评审 → 用 `cd-pipeline run --app --cr-id` 触发发布 → 等待权威终态。`submit-integration` 只用于明确的项目/联调环境。
- **Skill 安装/发布：** `find` 与 `install` 保持相同 `--env`；发布前校验 frontmatter，并先执行 `a1 skill publish --dry-run` 检查实际包内容。
- **FaaS：** 本地创建或导入 → 日常 deploy → 注册前二次确认 → 平台 publish → 持续查询 `STATUS_COMMAND`；只有流水线成功后才能声称访问链接可用。

## 输出与完成标准

- 需要解析字段或串联命令时使用 `-f json`；只取 ID 时使用 `-q`；面向人阅读时保留默认文本输出。
- 查询结果要说明资源、时间或分支范围；变更结果要说明实际修改对象和验证证据。
- 区分“命令已提交”“后台仍运行”“等待人工门禁”“已完成”四种状态，不把创建成功误报为最终完成。
