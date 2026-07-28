# ci 命令完整参考

## 目录

- [总览与全局标志](#a1-ci--cicd-流水线管理)
- [流水线管理](#流水线管理ci-pipeline)
- [构建运行](#构建运行ci-run)
- [Job 管理](#job-管理ci-job)
- [制品管理](#制品管理ci-artifact)
- [变量管理](#变量管理ci-variable)
- [密钥管理](#密钥管理ci-secret)
- [模板管理](#模板管理ci-template)
- [组件管理](#组件管理ci-component)
- [YAML 验证](#yaml-验证ci-yaml)

## a1 ci — CI/CD 流水线管理

操作 AoneCI 流水线，需要绑定仓库。

### 全局标志
- `--repo string` — 覆盖绑定的仓库（repoId 或 group/project 路径）

---

## 流水线管理（ci pipeline）

### ci pipeline list
列出项目流水线。
- `--name string` — 按名称筛选
- `--status stringSlice` — 按状态筛选（可用值：`NORMAL`（别名 `ACTIVE`） / `DISABLED` / `DELETED`，可逗号分隔传多个）
- `--template-id int` — 按模板 ID 筛选
- `--all` — 同时包含已删除的流水线
- `--page int`, `--per-page int`

### ci pipeline get <pipeline-id>
查看流水线详情。

### ci pipeline create
基于模板创建流水线。
- `--template-id int` — 模板 ID（必填，按语言选择推荐模板）
- `--name string` — 流水线名称
- `--template-version string` — 模板版本（可选，不传则使用模板的默认版本）
- `--param stringArray` — 模板参数，格式 `key=value`，可重复传入
- `--notification stringArray` — 通知配置，格式 `type=<type>,<key>=<value>`，可重复传入
- `--default-branch string` — 代码触发器默认分支
- `--allow-uses stringArray` — 允许复用触发器的仓库范围（glob，可重复）
- `--strategy-type string` — 执行策略：`RUN_IMMEDIATELY` / `RUN_AFTER_COMPLETION` / `CANCEL_AND_RUN`
- `--strategy-fast-fail string` — 快速失败：`true` / `false`
- `--strategy-concurrency-group string` — 并发组名称
- `--strategy-concurrency-parallelism int` — 并发上限
- `--strategy-concurrency-cancel-in-progress string` — 是否取消进行中的同组任务：`true` / `false`
- `--trigger-push-branch stringArray` — push 触发分支，可重复
- `--trigger-push-branch-ignore stringArray` — 忽略的 push 分支，可重复
- `--trigger-push-path stringArray` — push 触发路径，可重复
- `--trigger-push-path-ignore stringArray` — 忽略的 push 路径，可重复
- `--trigger-push-tag stringArray` — push 触发 Tag，可重复
- `--trigger-push-tag-ignore stringArray` — 忽略的 push Tag，可重复
- `--trigger-mr-branch stringArray` — MR 源分支，可重复
- `--trigger-mr-branch-ignore stringArray` — 忽略的 MR 源分支，可重复
- `--trigger-mr-target-branch stringArray` — MR 目标分支，可重复
- `--trigger-mr-target-branch-ignore stringArray` — 忽略的 MR 目标分支，可重复
- `--trigger-mr-path stringArray` — MR 触发路径，可重复
- `--trigger-mr-path-ignore stringArray` — 忽略的 MR 触发路径，可重复
- `--trigger-mr-type stringArray` — MR 事件类型，小写：`opened` / `closed` / `reopened` / `accepted` / `merged`。**⚠️ 重要**：
  - **不传时默认为 `opened`**（创建评审或提交更新）
  - **禁止传空字符串 `""`**，会导致服务端 Jackson JSON 解析失败：`Cannot coerce empty String to MergeRequest$Type`
  - 不存在 `SYNCHRONIZE` 类型（CLI 帮助与单测使用的值只有上述五种）
- `--trigger-schedule stringArray` — 定时触发，格式 `cron=<expr>,always=<true|false>,branches=<comma-separated>`
- `--from-json string` — 从 JSON 文件传入完整请求体（高级用法）

#### 创建 CI 任务指导

当用户的需求是“帮我给这个仓库创建一个 Java 单元测试 CI 任务，并指定触发条件”这类描述时，通常要同时处理四件事：仓库定位、**选择模板**（`--template-id` 与必要的 `--param`）、流水线名称等基础信息、触发器配置。

推荐策略：
- 标准语言任务（如 Java 单元测试、代码扫描），即使要指定 `push`、`merge_request`、`schedule` 等常见触发器，也必须优先走模板方式创建。
- **镜像构建**类需求（构建/推送容器镜像等）同样必须走模板创建，使用镜像构建模板 ID `10004545`；勿默认改用 YAML 新建或 `--from-json`。命令与常用 `--param` 见「示例 5」，其余以 `a1 ci template get 10004545` 为准。
- 创建标准 CI 任务时，不要提供 YAML 新建方案，也不要把 `ci yaml` 校验或 `--from-json` 当作默认实现路径。
- 如果仓库里已经有相近的模板流水线，不要默认深挖历史运行记录、历史 YAML 或触发明细来自作主张判断；只需要向用户确认是“新建”“保留原有”还是“恢复旧流水线”。
- 如果用户没有明确确认，默认按“新建”处理。
- 当前 `a1 ci pipeline create` 已经直接暴露常见触发器 flag，应优先使用这些 flag；不要编造不存在的 `--triggers` 参数。
- 创建时以 `--template-id` 为准；不同语言或镜像构建场景优先使用下面表格里的推荐模板 ID。

推荐步骤：
1. 确认仓库已绑定；如果没有绑定，在命令中显式带 `--repo <group/project>`.
2. 如果用户没有明确指定语言，在当前工作目录执行 `ls -la`，按下面的规则检测仓库语言类型：

   | 检测文件 | 语言类型 |
   | --- | --- |
   | `pom.xml` | Java |
   | `build.gradle` / `build.gradle.kts` | Java |
   | `go.mod` | Golang |
   | `package.json` | Node.js |
   | `CMakeLists.txt`，或 `Makefile` 且仓库里有 `.c` / `.cpp` 文件 | C/C++ |
   | `requirements.txt` / `setup.py` / `pyproject.toml` | Python |

   若用户**明确要求**镜像构建（构建并推送 Docker 镜像等），不依赖上表做语言推断，直接选用镜像构建模板 `10004545`。不要仅因仓库根目录存在 `Dockerfile` 就自动当作镜像构建任务（仓库可能仍需要语言类单测/扫描）。

3. 根据语言或场景选择推荐模板 ID：

   | 语言/场景 | 模板名称 | 模板 ID |
   | --- | --- | --- |
   | Java | Java单元测试 | `10004530` |
   | Java | Java代码缺陷扫描 | `10004543` |
   | Golang | Golang单元测试 | `10004625` |
   | Golang | Golang代码扫描 | `10006247` |
   | C/C++ | C/C++单元测试 | `10004720` |
   | C/C++ | C/C++代码扫描 | `10006246` |
   | Node.js | Nodejs单元测试 | `10004637` |
   | 镜像构建 | 镜像构建模板 | `10004545` |

4. Java 项目在创建前必须先补齐 CI 配置信息：

   4.1 优先读取代码库根目录下的 `*.release` 文件：
   ```bash
   cat *.release 2>/dev/null || echo "no release file"
   ```

   重点读取：
   - `java.jdk`：JDK 版本
   - `maven.version`：Maven 版本

   4.2 如果没有 `*.release`，再从 `pom.xml` 分析：
   - 优先查 `<java.version>`
   - 其次查 `<maven.compiler.source>`
   - 如果都没有，默认使用 `JDK 11`、`Maven 3.9`

5. 如果查到相近流水线，只询问用户要“新建”“保留原有”还是“恢复旧流水线”；不要继续深挖历史运行记录来替用户做决定。
6. 如果用户要求“单独新增一条”任务，或者没有明确确认处理旧任务的方式，默认按“新建”执行。
7. 必要时先用 `a1 ci template get <template-id>` 看模板详情；如果模板参数不明确，再根据模板 README 或用户补充信息确定 `--param` 名称。
8. 按推荐模板 ID 创建，并直接带上对应的触发器 flags。
9. 创建后用 `a1 ci pipeline list --repo <group/project> --name "<pipeline-name>"` 找到流水线 ID，再用 `a1 ci pipeline get <pipeline-id> -f json` 验证触发器与模板参数。

（上文步骤 4 仅适用于 Java 语言模板；选用镜像构建模板 `10004545` 时跳过步骤 4，按步骤 7、8 结合模板参数与触发器创建。）

下面的触发器示例基于语雀《触发流水线》和《Aone CI 语法 Syntax》。

#### 模板优先原则

如果用户说的是“创建 Java 单元测试 / 代码扫描 / Golang 单测 / **镜像构建**”这类标准任务，必须先找模板，再走模板创建。不要一上来就新写一份 YAML。

更合适的执行思路是：
- 如果用户没说语言，先在仓库根目录执行 `ls -la`，按文件特征判断语言；若用户明确要镜像构建，直接用模板 `10004545`。
- 再根据语言或场景直接选推荐模板 ID；不要把“先 `template list` 再猜模板”当成唯一入口。
- 如果发现相近流水线，不要默认去看它的历史 run、历史 YAML 或触发方式来判断“是不是用户真正想要的那条”。
- 这时只给用户三个明确选项：`新建` / `保留原有` / `恢复旧流水线`。
- 有推荐模板 ID 时，直接使用对应 `--template-id` 创建。
- 如果用户要求指定触发器，先把目标触发条件描述清楚，再映射到 `--trigger-push-*` / `--trigger-mr-*` / `--trigger-schedule`。
- 即使用户要求“独立新增”一条任务，也仍然是模板新建，不是 YAML 新建。
- 创建标准任务时，不要提供 YAML 方案作为备选。
- 如果没有拿到用户进一步确认，默认执行 `新建`。

#### 示例 1：指定分支 push 触发 Java 单元测试

用户意图：`帮我给这个仓库创建一个 Java 单元测试 CI 任务，希望 feature/xx 分支代码提交时触发`

推荐方式：
- 使用 Java 单元测试推荐模板 `10004530` 创建。
- 触发器映射为：`--trigger-push-branch 'feature/xx'`。
- 创建前先按上面的 Java 检测步骤拿到 JDK / Maven 版本。
- 如果希望手工触发时默认也是这个分支，可以额外带 `--default-branch feature/xx`。

命令骨架：
```bash
ls -la
cat *.release 2>/dev/null || echo "no release file"

a1 ci pipeline create \
  --repo <group/project> \
  --template-id 10004530 \
  --name "Java单元测试" \
  --trigger-push-branch 'feature/xx'
```

如模板要求额外参数，再根据 `*.release` / `pom.xml` 解析出的版本补充对应的 `--param`。

#### 示例 2：CR 触发 Java 单元测试

用户意图：`帮我创建一个 Java 单元测试任务，希望提 CR 或更新 CR 时触发`

推荐方式：
- 使用 Java 单元测试推荐模板 `10004530` 创建。
- 触发器映射为：`--trigger-mr-target-branch master --trigger-mr-type opened`（MR 新提交通常由源分支的 push 事件联动，不要写 `SYNCHRONIZE` — CLI 源码并不接受该值）。

命令骨架：
```bash
a1 ci pipeline create \
  --repo <group/project> \
  --template-id 10004530 \
  --name "Java单元测试" \
  --trigger-mr-target-branch master \
  --trigger-mr-type opened
```

说明：
- `merge_request.target-branches` 匹配的是 CR 的目标分支，CR 场景优先使用它。
- CLI 源码的 `--trigger-mr-type` 只接受 `opened` / `closed` / `reopened` / `accepted` / `merged`，**不存在 `SYNCHRONIZE`**。
- **不传时默认为 `opened`**，传空字符串 `""` 会报错，所以要么传有效值，要么完全不传。
- 如果希望"CR 创建"之外还要覆盖"源分支后续有新提交"，建议同时加一条 push 触发（`--trigger-push-branch 'feature/**'` 这类），由 push 事件覆盖更新场景。
- 如果还希望 CR 被重新打开时也触发，再追加 `--trigger-mr-type reopened`。
- 不建议只配 `merge_request.branches`；文档说明在某些命令行创建/更新 CR 的场景下，来源不是分支名而是 commit ID，可能导致 `branches` 不匹配。

#### 示例 3：定时触发 Java 单元测试

用户意图：`帮我创建一个 Java 单元测试任务，每天凌晨 2 点跑一次`

推荐方式：
- 使用 Java 单元测试推荐模板 `10004530` 创建。
- 触发器映射为 `--trigger-schedule 'cron=0 2 * * *,always=true,branches=master'` 这类格式。

命令骨架：
```bash
a1 ci pipeline create \
  --repo <group/project> \
  --template-id 10004530 \
  --name "Java单元测试" \
  --trigger-schedule 'cron=0 2 * * *,always=true,branches=master'
```

说明：
- `schedule` 目前只在仓库默认分支上的配置生效，非默认分支里的定时配置不会生效。
- `cron` 只支持 5 段，不支持秒。
- 定时任务最小间隔为 10 分钟。
- `schedule.branches` 必须写明确分支名，不支持通配符。
- `always: true` 表示即使 commit 没变化，也持续按计划触发；默认情况下，相同 commit 只会运行一次。

#### 示例 4：同时支持 push 和 CR 触发

用户意图：`帮我建一个 Java 单元测试任务，feature/** 分支 push 触发，提到 master 的 CR 也触发`

推荐方式：
- 使用 Java 单元测试推荐模板 `10004530` 创建。
- 触发器映射为同时传入 `--trigger-push-branch 'feature/**'`、`--trigger-mr-target-branch master`、`--trigger-mr-type opened`（CR 后续更新由 push 触发覆盖；不存在 `SYNCHRONIZE`）。
- 不要因为需要组合触发器，就退回到 YAML 新建方案。

命令骨架：
```bash
a1 ci pipeline create \
  --repo <group/project> \
  --template-id 10004530 \
  --name "Java单元测试" \
  --trigger-push-branch 'feature/**' \
  --trigger-mr-target-branch master \
  --trigger-mr-type opened
```

#### 示例 5：部署 Aone Pages

用户意图：用户只要表达"把这个站点发到 Aone Pages"的语义，都按本示例走。常见说法：`部署 pages` / `更新 pages` / `刷新 pages` / `重新发一版 pages` / `deploy pages` / `部署 Aone Pages` / `刚改完，帮我 deploy 一下` 等。**命中"pages" + "部署/更新/发布/deploy"任一组合就走这条**，不要因为没说"CI 任务"而改成手动跑或写 YAML。

执行顺序：先查重 → 再检查本地代码 → 推导 `build-website-command` / `deploy-dir` → 再创建。

**步骤 1：查重**（避免重复挂任务、同一个 commit 被多次部署）

```bash
a1 ci pipeline list --repo <group/project> --template-id 10014197 --status NORMAL
```

- 有 `NORMAL` 流水线 → **不创建**，把 id/name 反馈给用户，让用户决定复用、`a1 ci pipeline update` 改造、还是禁用旧任务。
- 没有或仅 `DISABLED` → 进入步骤 2。

**步骤 2：本地代码检查**（仅在"开发完立刻部署看效果"语境下需要）

CI 只部署远端 commit，本地有未提交改动或已 commit 未 push，部署的都是上一个远端版本。两类问题要分开判断——`git status --porcelain` **只看工作区，看不出"已 commit 未 push"**，必须再跑一条 `rev-list`：

```bash
git status --porcelain                                  # 输出非空 = 有未提交/未跟踪改动
git rev-list --count @{u}..HEAD 2>/dev/null || echo NA  # >0 = 已 commit 未 push；NA = 没设 upstream（按未 push 处理）
```

**步骤 3：推导 `build-website-command` 与 `deploy-dir`**

模板默认假设是 npm 项目、产物落在 `build/`（典型 CRA / Webpack / Docusaurus）：
- `build-website-command` 默认：`npm install --registry=https://registry.anpm.alibaba-inc.com` 然后 `npm run build`
- `deploy-dir` 默认：`build/`

仓库不匹配这套默认时按需显式覆写——`deploy-dir` 跟仓库实际产物目录不一致就传，`build-website-command` 不是 `npm run build` 就传。构建逻辑再特殊也走 `--param build-website-command='...'`，**不要回去写自定义 YAML 或 `--from-json`**——模板已经把 build 抽成参数，传命令就够；标准 CI 任务一律走模板，不要新增 YAML 流水线。

判定顺序（命中第一个就停）：

1. **非 Node 静态站点工具链**：

   | 特征文件 | build-website-command | deploy-dir |
   | --- | --- | --- |
   | `config.toml` + `themes/`（Hugo） | `hugo --minify` | `public` |
   | `_config.yml` + `Gemfile`（Jekyll） | `bundle install && bundle exec jekyll build` | `_site` |
   | `mkdocs.yml`（Mkdocs） | `pip install -r requirements.txt && mkdocs build` | `site` |

2. **纯静态文件**（无 `package.json` 也无上面任一配置，仓库就是 HTML/CSS/JS）——看仓库布局二选一：

   **模式 A：deployable 集中在干净子目录**（`public/` / `dist/` / `docs/`，其他都是源码或工具）——跳过构建，把 `deploy-dir` 指过去：
   ```
   --param build-website-command=':' \
   --param deploy-dir=public
   ```

   **模式 B：deployable 散在仓库根**（跟 README、构建脚本、`.gitignore` 等源码文件混在一起，例如 `juven.xuxb/juven-news` 这种纯 HTML 周报：根目录有 `build.py` / `sources.yaml` / `templates/` 这类不该发的内容，要发的是 `index.html` / `digest-*.html` / `style.css`）——用 mkdir+cp 把要发的挑到 `build/`，`deploy-dir` 保持默认即可：
   ```
   --param 'build-website-command=mkdir -p build && cp index.html digest-*.html style.css build/'
   ```
   文件列表按仓库实际情况列举，支持 glob；先 `a1 repo file list .` 或本地 `ls -A` 看清楚再写。

   **不要无脑 `--param deploy-dir=.`**——会把 `.git/`、`.gitignore`、README、构建脚本等也部署到 Pages，几乎都不是想要的。

3. **Node.js 项目**——读 `package.json` 和框架配置：
   ```bash
   jq '.scripts' package.json
   ls vite.config.* next.config.* astro.config.* docusaurus.config.* 2>/dev/null
   ```
   - **deploy-dir 看产物目录**：Vite / Astro → `dist`；Next.js 静态导出 → `out`；VitePress → `docs/.vitepress/dist`；VuePress → `docs/.vuepress/dist`；Docusaurus → `build`（与默认一致，可不传）。配置文件里显式改过 `outDir` / `build.outDir` 的，以配置为准。
   - **build-website-command 看脚本名**：脚本就叫 `build` → 模板默认值能跑通，可不传；脚本叫别的（`docs:build` / `pages:build` 之类）必须显式写出来：
     ```
     --param 'build-website-command=npm install --registry=https://registry.anpm.alibaba-inc.com
     npm run docs:build'
     ```

4. **特征都对不上**——停下问用户："构建命令是什么？产物在哪个目录？"**不要凭感觉填 `npm run build`**——那只是模板默认值，传了等于没传。

**步骤 4：创建**

```bash
a1 ci pipeline create \
  --repo <group/project> \
  --template-id 10014197 \
  --name "部署Aone Pages" \
  --param site-name=<站点名> \
  --param build-website-command='<步骤 3 推导，与默认一致可省略>' \
  --param deploy-dir=<步骤 3 推导，默认 build/，非默认必传> \
  --trigger-push-branch '**' \
  --trigger-mr-target-branch '**' \
  --trigger-mr-type opened
```

关键点：
- `'**'` 是"所有分支"的写法，不要替换成具体分支名。`production-branch`（默认 `master`）部署正式版本，其他分支/CR 走预览版本。
- 仓库默认分支不是 `master` → **创建时**追加 `--param production-branch=<仓库默认分支>`，否则正式版本不会发布。默认分支用 `git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's@^refs/remotes/origin/@@'` 拿；**不要用 `git branch --show-current`**（那是当前分支，不是仓库默认分支）。**触发已有流水线时不要再传**——沿用创建时的配置；用户主动说"默认分支变了"才走 `a1 ci pipeline update <id> --param production-branch=<分支名>` 改。
- `site-name`（**默认必带**）：正式访问域名 `<site-name>.io.alibaba-inc.com` 的 site 标识。命名规则：小写字母 / 数字 / 连字符，长度 1-64，不以连字符开头或结尾。用户没指定时取仓库名小写化作默认值——合规就直接用；不合规（含大写、下划线、点等）就停下来问，不要偷偷转字符。
- **CI 当前不支持更新 `site-name`**：`pipeline update --param site-name` 或同项目新流水线传新名都不会生效，仍部署到原站点。如需调整，请到 code 仓库的"设置 → Pages"页面更改。

**部署完成后：拿预览地址**

run 终态为 `SUCCESS` 后，访问地址**只在部署 job 的 summary 里**，写成 markdown 链接（形如 `[网站地址](https://preview-<run-id>.io.alibaba-inc.com)`）。**不在 `a1 ci run get` 输出里，也不在 `a1 ci run log` / `a1 ci job log` 日志里**——不要去 grep 日志，没用。

```bash
a1 ci job list --run <run-id>             # 找出部署 job 的 id（通常只有一个）
a1 ci job summary <job-id> --run <run-id> # 输出含 [网站地址](<url>)，从中提取 URL
```

- 不要凭 run-id 拼 URL——以 summary 里的 markdown 链接为唯一可信源；正式版本（`production-branch` 触发的 run）和预览版本（其他分支/CR）的域名形态不同。
- 如果 summary 里没有 `[网站地址]` 这类链接，说明 job 还在跑或失败了；先用 `a1 ci run get <run-id>` 确认终态。

#### 示例 5：创建镜像构建任务

用户意图：`给仓库加一条镜像构建流水线，Dockerfile 在仓库根目录`

推荐方式：
- 使用镜像构建模板 `10004545`。
- 用 `--param` 传入 `dockerfile_path`、`image_repo_name` 等；缺参或键名不确定时先执行 `a1 ci template get 10004545`。

命令骨架：
```bash
a1 ci pipeline create \
  --repo <group/project> \
  --template-id 10004545 \
  --name "镜像构建" \
  --param dockerfile_path=Dockerfile \
  --param image_repo_name=<app_name>
```

说明：`image_repo_name` 是产出镜像的 repo name，通常使用应用名。

#### 触发器编写注意事项

- 不要编造 `--triggers` 之类的总开关；直接使用 `ci pipeline create` 已暴露的 `--trigger-*` flags。
- `--trigger-push-branch`、`--trigger-push-tag`、`--trigger-push-path`、`--trigger-mr-branch`、`--trigger-mr-target-branch`、`--trigger-mr-path` 都支持重复传入。
- push / MR 的分支、Tag、路径匹配支持 glob；使用通配符时，最好写成英文单引号包裹的字符串。
- `*` 只匹配当前路径层级；如果要匹配子路径，使用 `**`。
- 同时定义 `branches` 和 `paths` 时，需要两个条件同时满足才会触发。
- `branches` 和 `branches-ignore`、`tags` 和 `tags-ignore`、`paths` 和 `paths-ignore` 不能同时配置；`merge_request` 下对应的 `target-branches` 和 `target-branches-ignore` 也一样。
- `--default-branch` 不是触发条件本身，而是代码触发器默认分支；只有在你希望默认运行分支显式偏离仓库默认分支时才需要设置。
- 任何流水线都支持 UI 手工触发；如果只需要手工触发或 API 触发，可以不写 `triggers`。
- `push` 触发下，如果 HEAD commit message 包含 `[skip ci]` 或 `[ci skip]`，本次 push 会跳过触发。

### ci pipeline update <pipeline-id>
更新流水线。支持的 flag 与 `ci pipeline create` 基本一致，未提供的字段保持当前配置不变。
- `--name string` — 新名称
- `--template-version string` — 模板版本
- `--default-branch string` — 代码触发器默认分支
- `--strategy-type string` — 执行策略：`RUN_IMMEDIATELY` / `RUN_AFTER_COMPLETION` / `CANCEL_AND_RUN`
- `--strategy-fast-fail string` — 快速失败：`true` / `false`
- `--strategy-concurrency-group string` — 并发组名称
- `--strategy-concurrency-parallelism int` — 并发上限
- `--strategy-concurrency-cancel-in-progress string` — 是否取消进行中的同组任务：`true` / `false`
- `--param stringArray` — 模板参数，格式 `key=value`，可重复
- `--notification stringArray` — 通知配置（提供任一 `--notification` 会整体替换现有通知配置）
- `--allow-uses stringArray` — 允许复用触发器的仓库范围
- `--trigger-push-branch / --trigger-push-branch-ignore / --trigger-push-path / --trigger-push-path-ignore / --trigger-push-tag / --trigger-push-tag-ignore stringArray` — push 触发器
- `--trigger-mr-branch / --trigger-mr-branch-ignore / --trigger-mr-target-branch / --trigger-mr-target-branch-ignore / --trigger-mr-path / --trigger-mr-path-ignore stringArray` — MR 触发器
- `--trigger-mr-type stringArray` — MR 事件类型（源码帮助文本：`opened` / `closed` / `reopened` / `accepted` / `merged`）
- `--trigger-schedule stringArray` — 定时触发
- `--from-json string` — 从 JSON 文件传入完整请求体（覆盖上述所有 flag）

说明：
- 触发器/策略 flag 会与当前配置合并；只在对应维度有 flag 时才覆盖该维度。
- **没有 `--body` / `--body-file` 参数**；早期文档中的这两个 flag 已不存在。

### ci pipeline delete <pipeline-id>
删除流水线。
- `-y, --yes` — 跳过确认

### ci pipeline enable <pipeline-id>
启用流水线。

### ci pipeline disable <pipeline-id>
禁用流水线。

### ci pipeline restore <pipeline-id>
恢复已删除的流水线。

### ci pipeline run <pipeline-id>
触发流水线运行。
- `-b, --branch string` — 分支
- `-t, --tag string` — Tag
- `--param stringArray` — 参数（KEY=VALUE 格式，可多次使用）
- `--params-file string` — 参数文件（JSON 格式）
- `--watch` — 触发后等待完成

说明：
- 分支、Tag、Commit 本质上是三选一的运行入口；CLI 当前直接暴露了 `--branch` 和 `--tag`，通常优先使用 `--branch`。
- 如果都不指定，模板任务通常会回退到创建任务时设置的默认分支。

### ci pipeline get-by-path
通过代码文件 URL 查找流水线。
- `--code-file-url string` — 代码文件 URL

### ci pipeline auto-disable <pipeline-id> <enable|disable>
配置流水线自动禁用策略。

---

## 构建运行（ci run）

### ci run list
列出流水线运行记录。
- `--pipeline int` — 流水线 ID
- `--branch string` — 分支筛选
- `--tag string` — Tag 筛选
- `--commit string` — Commit 筛选
- `--status string` — 状态筛选。CLI 严格校验，只接受：`SUCCESS` / `FAILED` / `RUNNING` / `WAITING` / `CANCELED` / `SKIPPED` / `PENDING`（其他值命令会直接拒绝）
- `--trigger-mode string` — 触发方式。CLI 严格校验，只接受：`PUSH` / `MR` / `USED` / `UNKNOWN` / `API` / `MANUAL` / `FLOW` / `SCHEDULE`（其他值会被直接拒绝）。**代码评审（CR）触发对应 `MR`**，筛 CR 触发的运行用 `--trigger-mode MR`
- `--trigger-by string` — 触发人
- `--with-params` — 显示运行参数
- `--page int`, `--per-page int`

### ci run get [id]
查看运行详情。不指定 ID 时默认当前分支最新运行。

### ci run yaml <id>
查看运行的 YAML 定义。

### ci run cancel <id>
取消运行。

### ci run delete <id>
删除运行。
- `-y, --yes` — 跳过确认

### ci run rerun <id>
重新运行。
- `--latest-params` — 使用最新参数
- `--hold-time int` — 启动前的保持时间（毫秒）
- `--watch` — 等待完成

### ci run rerun-failed-jobs <id>
只重跑失败的 job。
- `--watch` — 重跑后等待完成（轮询 run 状态直到终态）

### ci run rerun-failed-cases <id>
只重跑失败的测试用例。

### ci run attempts <id>
列出运行的所有重试记录。

### ci run log [run-id]
查看运行日志。不指定 ID 时默认当前分支最新运行。
- `--all` — 显示所有 job 日志
- `--job string` — 指定 job 名称
- `--step string` — 指定步骤名称

### 排查测试用例失败与代码扫描问题

当 CI 任务状态为 `failed` 时，通过 `a1 ci run log` 或 `a1 ci job log` 查看日志，根据日志中的关键字判断失败类型：

- **测试用例失败**——日志中包含 `TEST_CASE` 关键字
- **代码扫描问题**——日志中包含 `issue summary` 关键字

这两类失败的共同特征是：CI 日志只有摘要信息，没有具体的失败用例或问题详情。需要通过 `a1 quality` 从质量平台获取详情。

**获取详情：**

1. 查看 CI 日志，识别失败类型并提取报告 uid：
   ```bash
   a1 ci run log <run-id>                 # 查看 run 日志
   a1 ci job log <job-id> --run <run-id>  # 或查看具体 job 日志（--run 必填）
   # 在输出中找 report uid（uuid 格式）
   ```

2. 根据失败类型查询详情：
   ```bash
   # 测试用例失败：
   a1 quality testcase <uid>              # 完整用例列表（含失败原因）
   a1 quality testcase <uid> --summary    # 摘要：passed/failed 数量
   a1 quality testcase <uid> -f json      # JSON 格式，便于解析

   # 代码扫描问题：
   a1 quality issue                       # 当前仓库+分支的扫描问题
   a1 quality issue --severity critical,blocker  # 按严重级别筛选
   a1 quality issue -f json               # JSON 格式，便于解析
   ```

3. 如果日志中没有找到 uid，也可以直接查当前仓库+分支的最新报告：
   ```bash
   a1 quality testcase                    # 最新测试报告
   a1 quality testcase --branch <branch>  # 指定分支
   a1 quality issue                       # 最新扫描问题
   ```

---

## Job 管理（ci job）

### ci job list
列出运行中的 job。
- `--run int` — 运行 ID（默认当前分支最新）
- `--status string` — 按状态筛选（`SUCCESS` / `FAILED` / `RUNNING` / `WAITING` / `CANCELED` / `SKIPPED` / `PENDING`）

### ci job get <job-id>
查看 job 详情。
- `--run int` — 运行 ID（必填）

### ci job summary <job-id>
查看 job 摘要。
- `--run int` — 运行 ID（必填）

### ci job log <job-id>
查看 job 日志。
- `--run int` — 运行 ID（必填）
- `-s, --step string` — 指定步骤
- `--follow` — 实时跟踪日志输出
- `--download string` — 下载日志到文件
- `--no-fold` — 展示原始日志，不折叠 group
- `--group string` — 只展示指定 log group 的内容

**Job 还在跑时必须加 `--follow`**：不加 `--follow` 是一次性拉取，运行中的 job 经常会出现 `context deadline exceeded`。命令检测到 Job 仍在运行（非 SUCCESS/FAILED/CANCELLED/ERROR 状态）时，会在错误后追加 `hint: job is still running ... retry with --follow ...` 提示——看到这行提示就直接重跑加上 `--follow`，由命令轮询日志直到 Job 结束。

---

## 制品管理（ci artifact）

### ci artifact list
列出运行的制品。
- `--run int` — 运行 ID（必填）
- `--bytes` — 显示原始字节数，不做人类可读转换

### ci artifact get <name>
查看制品详情。
- `--run int` — 运行 ID（必填）
- `--bytes` — 显示原始字节数，不做人类可读转换

### ci artifact download <name>
下载制品。
- `--run int` — 运行 ID（必填）
- `-o, --output string` — 输出路径（默认标准输出）

---

## 变量管理（ci variable）

### ci variable list
列出项目变量。无额外 flag（CLI 会一次性拉取后客户端过滤 `NORMAL` / `VARIABLE` 类型）。

### ci variable get <name>
查看变量详情。

### ci variable create <name>
创建变量。
- `-v, --value string` — 变量值（必填）

### ci variable update <name>
更新变量。
- `-v, --value string` — 新值（必填）

### ci variable delete <name>
删除变量。
- `-y, --yes` — 跳过确认

---

## 密钥管理（ci secret）

### ci secret list
列出项目密钥。

### ci secret get <name>
查看密钥详情。

### ci secret create <name>
创建密钥。
- `-v, --value string` — 密钥值
- `--value-stdin` — 从标准输入读取

### ci secret update <name>
更新密钥。
- `-v, --value string` — 新值
- `--value-stdin` — 从标准输入读取

### ci secret delete <name>
删除密钥。
- `-y, --yes` — 跳过确认

---

## 模板管理（ci template）

### ci template list
列出可用模板。
- `--name string` — 按名称筛选
- `--category string` — 按分类筛选
- `--language string` — 按语言筛选
- `--official` — 只显示官方模板
- `--page int`, `--per-page int`

### ci template get <id>
查看模板详情。

### ci template readme <id>
查看指定模板的 README（接受模板 ID 作为位置参数，CLI 内部再根据该模板解析 code URL 并拉取 README）。

---

## 组件管理（ci component）

查询、查看 CI 组件（Step / Job / Composite 等）。显示名使用 `SCRIPT`，后端实际类型为 `RUNNER`，CLI 会自动转换。

### ci component list
检索组件。
- `--keyword string` — 关键字搜索（指定后默认不再按 kind 过滤）
- `--kinds string` — kind 过滤，逗号分隔：`SCRIPT` / `SERVICE` / `COMPOSITE`；使用 `ALL` 不过滤；未指定且无关键字时默认 `SCRIPT,COMPOSITE`
- `--scene string` — 查询场景：`ALL_ONSHELF`（默认，所有上架组件）或 `MY_COMPONENTS`（自己的组件）
- `--page int`, `--per-page int` — 分页（`per-page` 最大 100）

### ci component get <uses>
根据标识查看组件。`uses` 支持：
- `component-name` — 上架版本
- `component-name@1.0.0` — 指定语义化版本
- `component-name@<branch|tag|commit>` — 指定 git ref

### ci component readme <uses>
查看组件 README。`uses` 格式同 `ci component get`。

---

## YAML 验证（ci yaml）

### ci yaml lint <file>
验证 CI 配置 YAML 文件。
- `--ref string` — 引用分支
- `--repo string` — 仓库

说明：
- 该校验会结合仓库与引用分支上下文做校验；校验分支相关触发器、组件可用性或引用内容时，优先同时带上 `--repo` 和 `--ref`。
- 校验失败时，后端会返回 `ERROR` / `WARN` / `INFO` 级别的问题以及对应位置，适合在创建前先做一次静态检查。
