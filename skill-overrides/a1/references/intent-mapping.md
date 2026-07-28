# 自然语言意图路由

本文件只负责把用户意图路由到正确的 a1 命令域。选定命令后，必须再读取对应领域 reference 获取完整 flag；不要只凭本表执行高风险写操作。

## 目录

- [仓库与代码评审](#仓库与代码评审)
- [CI、构建与交付流水线](#ci构建与交付流水线)
- [应用、CR、发布计划与包](#应用cr发布计划与包)
- [项目、工作项与工作流](#项目工作项与工作流)
- [知识、环境与其他研发对象](#知识环境与其他研发对象)
- [容易混淆的意图](#容易混淆的意图)

## 仓库与代码评审

详细参数读取 [repo-commands.md](repo-commands.md)。

| 用户意图 | 命令入口 |
| --- | --- |
| 查仓库、分支、提交、tag | `a1 repo ...` |
| 搜当前仓库或全局代码 | `a1 repo search ...` |
| 查我的 MR 或待我评审的 MR | `a1 repo mr list --mine ...` |
| 查 MR 详情、diff、文件、工作项、CR | `a1 repo mr view|diff ...` |
| 创建、编辑、合并、关闭、重开 MR | `a1 repo mr create|edit|merge|close|reopen ...` |
| 查审批和可合并状态 | `a1 repo mr status ...` |
| 催评审或查询推荐评审人 | `a1 repo mr remind|reviewers ...` |
| 添加、回复、查看 MR 评论 | `a1 repo mr comment create|list ...` |
| 查看、触发或处理 AI 评审 | `a1 repo mr comment ai ...` |
| 管理仓库文件和标签 | `a1 repo file ...` / `a1 repo tag ...` |

## CI、构建与交付流水线

分别读取 [ci-commands.md](ci-commands.md)、[build-commands.md](build-commands.md) 和 [cd-pipeline-commands.md](cd-pipeline-commands.md)。

| 用户意图 | 命令入口 |
| --- | --- |
| 查或触发 AoneCI 流水线 | `a1 ci pipeline ...` |
| 查 CI Run、Job、日志 | `a1 ci run ...` / `a1 ci job ...` |
| 只重跑失败 CI Job | `a1 ci run rerun-failed-jobs <run-id>` |
| 重跑整个 CI Run | `a1 ci run rerun <run-id>` |
| 创建或更新 CI 任务 | `a1 ci pipeline create|update ...` |
| 查 Aone Build Job、Step、日志、制品 | `a1 build job ...` |
| 查应用/Maven/FaaS 绑定的交付流水线 | `a1 cd-pipeline list ...` |
| 查交付流水线详情或变量 | `a1 cd-pipeline get|vars ...` |
| 运行或重跑交付流水线 | `a1 cd-pipeline run ...` |
| 下钻交付运行的 stage/job/task | `a1 cd-pipeline run get ...` |
| 查发布流水线最新整体状态 | `a1 app pipeline status ...` |
| 诊断或操作发布任务组件 | `a1 app pipeline stage job task status ...` |

## 应用、CR、发布计划与包

分别读取 [app-commands.md](app-commands.md)、[publish-plan-commands.md](publish-plan-commands.md)、[pkg-commands.md](pkg-commands.md) 和 [artifact-commands.md](artifact-commands.md)。

| 用户意图 | 命令入口 |
| --- | --- |
| 查应用、CR、部署单 | `a1 app ...` |
| 创建应用 CR | `a1 app cr create ...` |
| 为应用 CR 创建代码评审 | `a1 app cr mr ...` |
| 将应用 CR 提交到待发布 | `a1 app cr submit ...` |
| 将应用 CR 提交项目/联调环境 | `a1 app cr submit-integration ...` |
| 提交应用 CR 并运行发布流水线 | `a1 cd-pipeline run ... --app ... --cr-id ...` |
| 查、创建发布计划 | `a1 publish-plan list|get|create ...` |
| 把 Aone CR/O2 变更加入发布计划 | `a1 publish-plan submit ...` |
| 查包、包 CR、包绑定 | `a1 pkg ...` |
| 提交 Maven CR 并运行流水线 | `a1 cd-pipeline run ... --mvn ... --cr-id ...` |
| 单 CR 正式发布 Maven 二方包 | `a1 pkg deploy-cr ...` |
| 填写发布页集成区二方包组件 | `a1 pkg deploy-intg preview|submit ...` |
| 本地 SNAPSHOT/调试上传 Artlab | `a1 artifact mvn deploy ...` |

## 项目、工作项与工作流

详细参数读取 [project-commands.md](project-commands.md)；Devix 交付任务读取 [devix-commands.md](devix-commands.md)。

| 用户意图 | 命令入口 |
| --- | --- |
| 查项目、项目成员、项目资产 | `a1 project get|member|asset ...` |
| 查、创建、更新、删除工作项 | `a1 project workitem ...` |
| 查工作项动态、评论、附件 | `a1 project workitem activity|comment|attachment ...` |
| 查字段定义和可选值 | `a1 project workitem field ...` |
| 发起 Req 内容评审 | `a1 project workitem review create ...` |
| 管理工作项关联 | `a1 project workitem relation ...` |
| 查或管理工作项视图 | `a1 project view ...` |
| 查、创建、发布、导出 CoCo 模板 | `a1 project workflow template ...` |
| 启动或查询 CoCo 工作流实例 | `a1 project workflow start|list|get ...` |
| 查员工或同步公共账号 | `a1 staff ...` |
| 管理项目用户组 | `a1 project usergroup ...` |
| 创建、启动、推进 Devix 交付任务 | `a1 devix task create|start|advance ...` |
| 查 Devix 工作空间或 AgentLoop 模型 | `a1 devix workspace ...` / `a1 devix task models ...` |

## 知识、环境与其他研发对象

| 用户意图 | 命令入口 | 详细 reference |
| --- | --- | --- |
| 搜知识库、查看或维护页面 | `a1 kbase ...` | [kbase-commands.md](kbase-commands.md) |
| 生成、搜索、问答或维护 CodeWiki | `a1 kbase codewiki ...` | [kbase-commands.md](kbase-commands.md) |
| 管理 Aone Pages 站点配置 | `a1 pages ...` | [pages-commands.md](pages-commands.md) |
| 部署 Aone Pages 内容 | `a1 ci ...` | [ci-commands.md](ci-commands.md) |
| 查或管理应用/项目环境、trait、apre | `a1 env ...` | [env-commands.md](env-commands.md) |
| 创建、导入、部署、注册或发布 FaaS | `a1 faas ...` | [faas-commands.md](faas-commands.md) |
| 管理 O2 应用、迭代、变更、发布、灰度 | `a1 o2 ...` | [o2-commands.md](o2-commands.md) |
| 管理 TestHub 用例、计划、用例库 | `a1 testcase ...` | [testcase-commands.md](testcase-commands.md) |
| 查看测试报告、覆盖率、扫描问题 | `a1 quality ...` | 先看 `a1 quality --help` |
| 搜索、安装、发布 Contextlab Skill | `a1 skill ...` | [skill-commands.md](skill-commands.md) |
| 管理开放平台 CLI 工具 | `a1 cli ...` | [cli-commands.md](cli-commands.md) |
| 安装 a1，或更新稳定版/内部 alpha | 安装脚本或 `a1 update ...` | [update-commands.md](update-commands.md) |
| 查仓库或用户活动事件 | `a1 events repo|user ...` | 先看 `a1 events --help` |
| 查 a1 内置 FAQ | `a1 faq|grep|search ...` | 先看 `a1 faq --help` |
| 给产品提反馈或查反馈 | `a1 feedback ...` | [feedback-commands.md](feedback-commands.md) |

## 容易混淆的意图

| 用户说法 | 正确选择 | 不要误用 |
| --- | --- | --- |
| 创建/启动/推进“交付任务” | `a1 devix task` | `a1 project workitem create --category task` |
| 管理测试用例或测试计划 | `a1 testcase` | `a1 quality testcase` |
| 查看测试执行报告 | `a1 quality testcase` | `a1 testcase` CRUD |
| 管理 Pages 站点名或域名 | `a1 pages` | CI 部署命令 |
| 构建并部署 Pages 内容 | `a1 ci` Pages 模板 | `a1 pages create/update` |
| 日常调试上传 Maven 制品 | `a1 artifact mvn deploy` | 正式 `pkg deploy-cr` |
| 正式发布单个 Maven CR | `a1 pkg deploy-cr` | 本地 artifact 上传 |
| 提交应用 CR 到发布流水线 | `a1 cd-pipeline run --app --cr-id` | `submit-integration` |
| 提交应用 CR 到联调/项目环境 | `a1 app cr submit-integration` | 交付流水线 run |
| 查看 CI Job | `a1 ci job` | `a1 build job` |
| 查看 Aone Build Step 日志 | `a1 build job` | `a1 ci job` |
