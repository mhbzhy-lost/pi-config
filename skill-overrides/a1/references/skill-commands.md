# a1 skill（Contextlab Skill）

`a1 skill` 用于从 Contextlab 技能仓库**搜索**、安装/列出/读取/卸载 Skill，以及在技能包目录执行发布。

## 子命令一览

| 子命令 | 说明 |
|--------|------|
| `a1 skill find [keyword]` | 搜索当前用户可见的技能（见下文「查找与安装」） |
| `a1 skill install <name> [name...]` | 按包名从 registry 安装到本地 skills 目录 |
| `a1 skill install-from-plugin <spec>` | 安装一个 Plugin 包中包含的**全部** Skill（见下文「从 Plugin 安装」） |
| `a1 skill list`（`ls`） | 列出已安装技能 |
| `a1 skill read <name>` | 打印已安装技能的 `SKILL.md` 全文 |
| `a1 skill uninstall <name>`（`un` / `remove` / `rm`） | 卸载 |
| `a1 skill publish` | 将**当前目录**作为技能包发布到 registry（见下文） |

**`a1 skill` 持久化 flag**（对 find/install/list/read/uninstall/publish 均生效，定义在 skill 父命令上）：

- `--env`：`local` / `daily` / `pre` / `prod`，选择 Contextlab / registry 基址；亦可用 `A1_SKILL_REPO_BASE_URL` 覆盖基址。

**find 专有 flag**：

- `--limit <n>`：每页条数，默认 20，最大 100
- `--offset <n>`：分页偏移，默认 0
- `--output json`：JSON 输出（含 `skills`、`count`、`total`、`offset`、`limit`）

**install / install-from-plugin / list / read / uninstall 共用 flag**：

- `--agent <id>`：目标 agent（省略时默认 `.agents/skills` 等，规则见 `a1 skill install --help`）
- `-g, --global`：使用全局 skills 目录
- `--location <path>`：显式指定 skills 目录
- `--output json`：JSON 输出（list/install 等支持）
- `--dry-run`：干跑

**install / install-from-plugin 专有**：

- `--skip-update`：安装成功后跳过自动 `a1`/`ncs` 更新（默认会尝试更新）

**publish 专有**：

- `--platform <code>`：发布为**归属平台**技能（非个人）；写入 `package.json` 的 `config.platform`，包名不加个人前缀
- `--dry-run`：`npm publish --dry-run`
- `--tag <dist-tag>`：默认 `latest`
- `--npm-loglevel <level>`：默认 `notice`

不确定具体 flag 时执行：`a1 skill --help`、`a1 skill find --help`、`a1 skill publish --help`。

---

## 认证（kit / MCP / Skill）

`a1 skill find` / `install` / `publish` 与 `a1 mcp call-tool` **多数情况下沿用 `a1 auth login` 的登录即可，无需设置 `A1_AUTH_PROVIDER`**。仅当默认认证不适用时，可通过 `A1_AUTH_PROVIDER` 调整 **CIAP 与 Bearer 的双向 fallback** 优先级（下表为访问 Contextlab registry / MCP 网关时的凭证解析顺序）。

### 行为概览

| 模式 | 顺序 |
|------|------|
| **默认**（未设置 / `authx` / `buc`） | CIAP 优先 → `AONE_MCP_TOKEN` / Code PAT fallback |
| **`private_token`** | Bearer 优先 → CIAP fallback |

### A1_AUTH_PROVIDER 可选值

| 值 | 说明 |
|----|------|
| **（未设置）** / `authx` / `default` | CIAP AuthX，失败或无 AIT/APT 时 fallback Bearer |
| `buc` | CIAP BUC 工号登录，失败时 fallback Bearer |
| `private_token` | Bearer 优先，无 Token 时 fallback CIAP |

```bash
# 默认：CIAP 优先，CIAP 不可用时自动尝试 AONE_MCP_TOKEN / Code PAT
export AONE_MCP_TOKEN=your-token

# Bearer 优先，无 Token 时 fallback CIAP
export A1_AUTH_PROVIDER=private_token

# BUC 工号（公共账号场景），失败时 fallback Bearer
export A1_AUTH_PROVIDER=buc

# MCP 单次调用（--auth-provider 优先于环境变量）
a1 mcp call-tool my-server::ping --auth-provider private_token
```

### Bearer Token 顺序（参与 fallback 时）

1. `AONE_MCP_TOKEN`
2. `a1 auth login` 的 Code private token

### publish（npm）

- **默认**：CIAP ticket exchange → Bearer fallback
- **`private_token`**：Bearer → CIAP ticket exchange

### 注意事项

- `--provider zetta` 的 MCP 网关**仅支持 CIAP**，不支持 Bearer。
- find / install 报 `unauthorized` 时：确认 CIAP 或 Bearer 至少一种可用。

---

## 查找与安装 Skill

### 查找（find）

`a1 skill find` 在 Contextlab 技能仓库中搜索**当前登录用户有权限看到**的技能，认证方式与 `install` / `publish` 相同（CIAP ↔ Bearer 双向 fallback，见上文 [认证](#认证kit--mcp--skill)）。

关键词会匹配技能的**包名**（`name`）、**展示名**（`displayName`）和**描述**（`description`）。省略 keyword 时返回可见技能列表（受 `--limit` / `--offset` 分页约束）。

```bash
a1 skill find 代码审查                    # 按关键词搜索
a1 skill find aone --env pre              # 指定环境（pre 环境 registry）
a1 skill find 代码 --limit 50 --offset 0  # 分页：第一页 50 条
a1 skill find 代码 --output json            # 脚本友好输出
```

**文本输出解读**：

- `Name: 展示名 (包名)` — 括号内是 npm 包名，**安装时用包名**（如 `aone-claw-aone`），不要用中文展示名。
- `Name: code-review-skill` — 无独立展示名时，整行即为包名。
- 带 scope 的包名需原样使用，例如 `@smart-skills/demo`。

**JSON 输出字段**（`--output json`）：

| 字段 | 说明 |
|------|------|
| `skills[].name` | **install 用的包名** |
| `skills[].displayName` | 展示名（可选） |
| `skills[].description` | 描述 |
| `skills[].version` | 当前版本 |
| `total` | 命中总数（用于翻页） |
| `offset` / `limit` | 当前分页参数 |

翻页示例：第一页 `--offset 0 --limit 20`，第二页 `--offset 20 --limit 20`，直到 `offset + count >= total`。

### 安装（install）

从 find 结果选定包名后，用 **相同的 `--env`** 安装到本地 skills 目录：

```bash
# 1. 搜索
a1 skill find 代码审查 --env pre

# 2. 安装（包名来自上一步 Name 行的括号内，或无括号时的整行 Name）
a1 skill install code-review-skill --env pre

# 带 scope 的包名需原样传入
a1 skill install @smart-skills/demo --env pre

# 一次安装多个
a1 skill install skill-a skill-b --env pre

# 安装指定版本号（suffix 须与 registry metadata 中 versions 的 key 一致）
a1 skill install codeva-workflow2skill@0.02 --env pre

# 安装 dist-tag（如 beta；先查 dist-tags，再解析到具体版本）
a1 skill install codeva-workflow2skill@beta --env pre

# 3. 确认
a1 skill list
a1 skill read code-review-skill
```

#### 指定版本或 dist-tag（`name@suffix`）

安装参数支持 npm 风格的 `@` 后缀。带 scope 的包名取**最后一个** `@` 作为分隔，例如 `@smart-skills/demo@beta`。

| 写法 | 含义 |
|------|------|
| `my-skill` | 安装 `dist-tags.latest` 指向的版本 |
| `my-skill@1.2.3` | 安装 `versions` 中键为 `1.2.3` 的版本 |
| `my-skill@beta` | 将 `beta` 视为 dist-tag：查 `dist-tags.beta` 再安装 |

解析顺序：若 `suffix` 在 `versions` 中能直接命中则当作版本号；否则查 `dist-tags[suffix]`。都不存在则安装失败。

**find → install 注意点**：

1. **`--env` 必须一致**：在 pre 搜到的技能，要用 `--env pre` 安装；否则可能从 prod registry 拉包失败或版本不一致。
2. **只用包名，不用展示名**：`a1 skill install 代码审查` 会失败；应使用 `code-review-skill` 等 registry 包名。
3. **认证共用**：find 与 install 走同一套 CIAP ↔ Bearer fallback；若 find 报 `unauthorized`，确认 CIAP 或 `AONE_MCP_TOKEN` / `a1 auth login` Code PAT 至少一种可用。
4. **安装位置**：默认写入当前项目 `.agents/skills`（或 `-g` 全局目录、`--agent` / `--location` 指定），与直接 install 规则相同。
5. **安装后更新**：install 成功后默认会尝试执行 `a1 update`；可 `--skip-update` 跳过。

脚本串联示例（取第一条结果的包名）：

```bash
PKG=$(a1 skill find 代码审查 --env pre --output json | jq -r '.skills[0].name')
a1 skill install "$PKG" --env pre
```

### 从 Plugin 安装（install-from-plugin）

从 Plugin registry（默认 `https://contextlab.alibaba-inc.com/plugin`）下载一个 Plugin 包，安装其 `skills/` 目录下的**全部** Skill；Plugin 的其它内容（`commands/`、`agents/`、plugin manifest）会被忽略。每个 Skill 的安装行为与 `a1 skill install` 完全一致（SKILL.md refs 注入、CLI/MCP 依赖文档生成），安装位置同样由 `--agent` / `-g` / `--location` 决定。

```bash
# 安装 plugin 内全部 skill（registry latest）
a1 skill install-from-plugin my-plugin

# 指定版本 / dist-tag（解析规则与 install 相同）
a1 skill install-from-plugin my-plugin@1.2.0
a1 skill install-from-plugin my-plugin@beta

# URL / 本地包
a1 skill install-from-plugin https://example.com/plugin.tgz
a1 skill install-from-plugin ./plugin-dir

# 预览将安装哪些 skill（仍会下载并校验 tarball，不写盘）
a1 skill install-from-plugin my-plugin --dry-run

# JSON 输出（installed / count / plugin 信息）
a1 skill install-from-plugin my-plugin --output json
```

**注意点**：

1. **完整性校验 fail-closed**：registry 安装按包元数据 `dist.integrity`（SRI）对 tarball 边下载边校验；`dist.integrity` 缺失或不可解析时直接报错拒装，环境变量 `A1_SKIP_SKILL_ARTIFACT_VERIFY=1` 可显式跳过（URL / 本地安装不校验）。
2. **并发与失败隔离**：plugin 内多个 skill 并发安装（上限 4）；单个 skill 失败不中断其它，错误聚合后统一非零退出。
3. **`--skip-update`** 同样适用：跳过安装成功后的 `a1`/`ncs` 自动更新。

---

## SKILL.md 与目录约定

- **最小结构**：`SKILL.md` 即可；可附带 `reference.md`、`examples.md` 等同目录 Markdown/资源。
- **Frontmatter 必填字段**：
  - `name`：技能包名（npm 包名），非空。
  - `description`：非空，说明做什么、何时触发。
  - **`version`**：semver 字符串；**发布前必须填写**，每次发新版要递增。
- **可选 `files`**：YAML 数组，列出要打进 npm 包的相对路径（例如 `["SKILL.md", "reference.md"]`）。不写则按 npm 默认规则打包。
- **可选 `cli`**：YAML 字符串数组，声明本技能依赖的 CLI（名称与开放平台 / cli-hub 的 `tool_name` 一致）。

### CLI 与 MCP 工具依赖（`install` 时生成说明文档）

`a1 skill install` 会根据依赖声明生成独立说明文件，并在 `SKILL.md` 末尾插入引用链接（拉取失败仅 `[warn][skill]`，**不阻断安装**）。

#### `cli` — frontmatter 中声明 CLI 依赖

```yaml
---
name: my-skill
description: 示例
version: 1.0.0
cli:
  - aone-cli
---
```

`install` 会请求开放平台 `GET /open-api/cli-tools/{cliName}/skill-usage`（无需登录鉴权），将**安装命令**（curl / PowerShell）与 **README** 写入 `CLI.md`（若技能包内已有同名 `CLI.md`，则写入 `a1-CLI.md` 以免覆盖作者文档）。`SKILL.md` 末尾会追加：

```markdown
## CLI 依赖

本技能正文（或目录内其它 `.md`）中依赖的 CLI 的安装与使用说明见 [CLI 安装与使用说明](CLI.md)。
```

#### tool 标签 — 正文中声明 MCP 工具依赖

在技能目录下任意 `.md` 文件正文中声明 Agent 需通过 `a1 mcp call-tool` 调用的 MCP 工具。写法为尖括号包裹的 tool 标签，标签体内写单个 `server::tool` token；可选 `provider` 属性（默认 `aone`，亦支持 `zetta`）。具体标签语法见 a1 官方文档 [skill install](https://a1.io.alibaba-inc.com/commands/skill/#install) 一节。

`install` 会扫描目录下所有 `.md` 中的 tool 标签，拉取对应 MCP 服务的工具列表，写入 `MCP_TOOL.md`（同名冲突时写入 `a1-MCP_TOOL.md`），包含「工具调用说明」与各工具的 `inputSchema`（失败仅 warn）。`SKILL.md` 末尾会追加：

```markdown
## MCP 工具

本技能正文（或目录内其它 `.md`）中声明了 tool 标签（server::tool 格式）；其调用方式与 inputSchema 见 [MCP 工具调用说明](MCP_TOOL.md)。
```

**严格识别**：标签内必须是 `server::tool` 单个 token（一个 `::`，无空格）。`provider` 可选，默认 `aone`，也支持 `zetta`。`::` 两侧有空格、出现多段 `::`、或标签内为纯说明文字等非 ref 内容时，不会被识别。

发布前请确认 frontmatter 中 `name`、`description`、`version` 及 tool 标签格式符合上文约定。

### 安装后调用 MCP：从 stdin 读取 JSON 参数

`MCP_TOOL.md` 中的说明会引导使用 `a1 mcp call-tool`。参数较大或含复杂转义时，可将 JSON 对象放在文件或管道，用 **`-`** 占位从 stdin 读取：

```bash
# 命令行直接传 JSON（适合短参数）
a1 mcp call-tool code::search_code '{"q":"keyword"}'

# 从文件经 stdin 传入（适合大参数）
cat args.json | a1 mcp call-tool ei-search-server::search_knowledge -

# 省略 json-args 时等价于 {}
a1 mcp call-tool my-server::ping
```

注意：每次只执行**一条** `a1 mcp call-tool`，不要用 `&&` / `;` 把多条 call-tool 串在同一 shell 命令里。

---

## 发布前注意

1. `a1 skill publish` 会根据 `SKILL.md` **临时生成** `package.json` 用于 `npm publish`；若目录里已有 `package.json`，发布结束后会**恢复**原始内容（无 `package.json` 时删除临时文件）。
2. **个人技能**（默认）：包名自动加登录名前缀，如 `yuexia-hy-my-skill`。
3. **平台技能**：使用 `a1 skill publish --platform <code>`，或预先在 `package.json` 写 `config.platform`；包名保持 `SKILL.md` 中的 `name`，临时 `package.json` 含 `"config": { "platform": "<code>" }`。`--platform` 优先级高于 `package.json`。
4. **platform 规则**：已发布为**平台技能**后，platform 不可修改（再次发布指定不同 platform 会**拦截并报错**）。再次发布平台技能时即使不传 `--platform`，也会自动沿用已有 platform。若技能此前以**个人技能**发布，后续加上 `--platform` 会按平台技能重新发布（包名去掉个人前缀）。
5. 本机需安装 **npm** 且在 `PATH` 中可调。
6. **认证**：CIAP ↔ Bearer 双向 fallback（详见上文 [认证](#认证kit--mcp--skill)）。
7. **Registry 环境**：由 `a1 skill --env` 决定（`local` | `daily` | `pre` | 默认 `prod`）。也可用 `A1_SKILL_REPO_BASE_URL` 覆盖整个 skill 仓库基址。

---

## 发布与安装示例

在技能包根目录执行发布：

```bash
cd path/to/your-skill              # 确保当前目录含 SKILL.md，且 frontmatter 含 version

a1 skill publish --dry-run         # 仅 npm publish --dry-run，不落盘发版
a1 skill publish                   # 发布个人技能（包名自动加前缀）
a1 skill publish --platform my-platform   # 发布到归属平台（非个人）
a1 skill publish --tag beta        # 指定 dist-tag
a1 skill publish --npm-loglevel verbose
a1 skill publish --env daily       # 推到日常 registry
a1 skill publish --platform my-platform --env pre --tag beta
```

他人查找并安装已发布的技能（完整流程见上文「查找与安装 Skill」）：

```bash
a1 skill find <keyword> [--env <env>]
a1 skill install <skill-name> [--env <env>]              # find 结果中的包名（latest）
a1 skill install <skill-name>@<version-or-tag> [--env <env>]  # 指定版本或 dist-tag
```

---

## 故障排查要点

- find 报未授权：确认 CIAP 或 Bearer（`AONE_MCP_TOKEN` / `a1 auth login` Code PAT）至少一种可用。
- find 有结果但 install 失败：确认用的是 **包名**（非展示名），且 `--env` 与 find 时一致；带 `@suffix` 时确认 registry 存在对应 **version** 或 **dist-tag**。
- install 后未见 `CLI.md` / `MCP_TOOL.md` 或 `SKILL.md` 引用：CLI 检查 frontmatter 是否声明 `cli`；MCP 检查各 `.md` 中 tool 标签是否为严格格式；拉取失败时终端会有 `[warn][skill]`，安装仍会成功。
- `publish failed: SKILL.md file is missing`：工作目录不对。
- `missing valid name` / `description` / `please specify version`：补全 frontmatter。
- `publish failed: cannot resolve login account for personal skill prefix`：个人技能发布需先 `a1 auth login`；或改用 `--platform` 发布为平台技能。
- `platform cannot be changed on republish`：技能已作为平台技能发布，再次发布时 platform 不可修改。
- `npm not found in PATH`：安装 Node/npm。
- `no registry token for skill publish`：确认 CIAP ticket exchange 或 Bearer 至少一种可用。

---

## 常用流程：发布 Contextlab Skill

```bash
cd my-skill                              # 1. 进入技能根目录（含 SKILL.md，frontmatter 含 version）
a1 skill publish --dry-run               # 2. 干跑确认包内容与 registry
a1 skill publish                         # 3a. 发布个人技能；新版本需已递增 version
a1 skill publish --platform <code>       # 3b. 发布到归属平台（非个人）
a1 skill publish [--env daily|pre|prod]    # 指定 registry 环境
```

## 常用流程：查找并安装 Skill

```bash
a1 skill find <keyword> [--env pre]           # 1. 搜索可见技能
a1 skill install <包名> [--env pre]            # 2. latest
a1 skill install <包名>@<version> [--env pre]  # 2b. 指定版本
a1 skill install <包名>@beta [--env pre]       # 2c. dist-tag
a1 skill list                                 # 3. 确认已安装
a1 skill read <包名>                           # 4. （可选）查看 SKILL.md（含对 CLI.md / MCP_TOOL.md 的引用）
```

安装声明了 `cli` / tool 标签的技能后，可 Read 同目录下的 `CLI.md`、`MCP_TOOL.md` 获取安装与调用说明；调用 MCP 时可用 `cat args.json | a1 mcp call-tool server::tool -` 传入大 JSON 参数。

## 已下线命令

`a1 claw` 已下线且没有替代命令。不要调用 `a1 claw`、`a1 claw chat` 或 `a1 claw chat reset`；遇到相关需求时，直接说明当前不支持。显式调用旧命令会返回：`a1 claw is no longer supported`。
