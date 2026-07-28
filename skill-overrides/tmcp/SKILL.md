---
name: tmcp
description: 此 skill 在用户提到 TMCP / MCP 平台 / um tmcp / HSF 接入 MCP / tace / TMCP server / 创建 MCP / 新建 MCP / 做一个 MCP / 上线 MCP / 发布 MCP / 修改 MCP / 改 MCP / 编辑 MCP / 更新 MCP / 删 MCP / 下线 MCP / 转 MCP / 转成 MCP / 改造成 MCP / HSF 转 MCP / OpenAPI 转 MCP / 工具创建发布 / 发布工单 / TMCP 市场 / 申请 server 访问,或使用 manifest / apply / diff / export / 声明式 / IaC / 批量管理 TMCP 工具 / AI 拼接 TMCP 工具配置 / 写 tool 或 server config,或报告 TMCP 调用失败 / um tmcp 报错 / token 失效 / server not found / publish 卡住 / apply 异常 / SSL 证书 / stdio 启动失败 / HSF 或 OpenAPI 解析失败等任何 TMCP 相关场景时启用。提供平台概念、CLI 顶层结构、端到端 happy path、工单管理、环境与 tenant 使用规范;深度细节(manifest 范式 / config 陷阱 / 排错决策树 / 市场消费流程)在 references/ 按需 Read。
version: 0.3.0
---

# TMCP 端到端 skill

## 前置

### 安装 CLI

```bash
tnpm i -g @ali/ultima@latest
```

安装完成后验证:

```bash
um --version   # 期望 >= 0.2.65
```

| 低于版本 | 不可用功能 |
|---------|-----------|
| 0.2.65 | Pro Tool partial update 可能被后端快照中的 nullable/递归 mapping 拦截;Pro manifest update 不保证 service schema 无损 round-trip |
| 0.2.58 | `rateLimit` 结构化字段(需手写 `policyConfigs[]`) |

`um < 0.2.65` 时先升级,不要通过手工删除后端字段绕过校验:

```bash
tnpm i -g @ali/ultima@latest
```

### 看到 `command not found: um`

按顺序排查:

1. **确认 Node 20+ 已安装** — `node --version`。推荐 https://nodejs.org 官方安装包,**不推荐 nvm**(nvm 是 shell 函数,非交互 Bash 不 source nvm.sh,检测不到 node)。
2. **确认 npm global bin 在 PATH 上** — `npm prefix -g` 查全局路径,确认该路径下的 `bin/` 在 `$PATH` 中。
3. **重新安装** — `tnpm i -g @ali/ultima@latest`
4. **仍失败** — 让用户在自己的 Terminal 跑 `which um` 确认安装位置,必要时手动加 PATH。

### 登录(BUC SSO)

`um login` 需要浏览器交互,AI 环境无法自动完成。

**铁律 1:跑任何 `um xxx` 之前(除 `um whoami` 本身),先静默跑一次 `um whoami`**

- 退码 0 且输出非空 → 已登录,直接执行原命令
- 失败 → 走 login 流程

**铁律 2:发现未登录时,只跑一次 `um login`,然后停下来等用户确认**

- `um login` 会弹浏览器让用户完成 BUC SSO
- 接受用户任何肯定确认:**『登录完成』『好了』『done』『ok』『可以了』『登上了』** 都算
- 用户确认后,**先跑 `um whoami` 验证**:
  - 返 email → 登录成功,继续原任务
  - 失败 → 再等 30s 重试一次(OAuth callback 可能慢);仍失败让用户 `tail /tmp/um-login-*.log`

**铁律 3:绝对禁止**

- 在等用户确认期间循环 `um whoami` 或循环 `um login`
- 自动 `sleep` / `wait` 等 OAuth 完成 — `um login` 会 block 到 callback,在 AI Bash 里会超时被 kill,必须让用户在自己 Terminal 完成

**铁律 4:用户在 login pending 期间发起新需求**

- 先静默 `um whoami`
- 成功 → 直接执行新需求
- 失败 → 答复"登录还没完成,完成后回复一声继续"

### 看到 401 / 403 / `token expired`

`um whoami` 返回 email 不代表 token 还活着。用 `um tmcp token show` active probe;过期了走上面的登录流程。

## 平台是什么

TMCP 是阿里淘天的 MCP(Model Context Protocol)平台,CLI 是 `um tmcp`。

分两层:

- **控制平面(tace)** — 工具 / Server / 版本 / 发布的管理 API
- **运行时(tmcp)** — 实际 MCP 服务调用入口

## CLI 顶层结构

```
um tmcp
├── token         # 获取 / 缓存 / show 状态
├── tenants       # 列出可用 tenant(含 Session Type 列)
├── doctor        # 一键环境健康检查(CLI / BUC / token / 网络)
├── dev           # 资源开发管理(生产者侧)
│   ├── workspace # 业务空间 CRUD
│   ├── tool      # tool CRUD + revision
│   ├── server    # server CRUD
│   ├── publish   # 发布流程(daily/pre/prod + 工单管理)
│   ├── manifest  # 声明式 IaC(apply / diff / export)
│   └── assistant # 工具创建助手(from-hsf / from-openapi / gen-schema)
├── market        # MCP 市场(消费者侧:发现 / 申请别人的 server)
├── client        # MCP 协议客户端(list-tool / call-tool)
├── skill         # 给 SKILL 维护者一键补齐 MCP 工具说明,见 S7
└── schema        # 面向 AI 的 JSON Schema 契约
```

具体子命令查 `um tmcp <group> --help`,不在此处复读。

## 概念模型

```
Workspace(业务空间,组织单位)
  ├── Tool(单个工具配置)
  │     └── Revision(工具的版本)
  └── Server(一组 Tool 的发布单元,= MCP server)
        └── 发布工单(Ticket)
              └── daily / pre / prod 三环境推进
```

**Manifest** 是上述对象的声明式描述(IaC),通过 `dev manifest apply / diff / export` 同步。

### Ticket 是什么

TMCP 发布是 **ticket-based**:每次执行 `publish daily/pre/prod` 创建一个工单(Ticket),按状态机自动推进。

工单生命周期(简化):

```
created → started → ... → TestComplete (⏸ 等待人工验证)
                              ↓ action --action test-complete
                          audit / skip-audit
                              ↓
                          released ✓
```

- **ticket-id**:`publish daily/pre/prod` 输出会给;也可 `dev publish status -w <ws> -s <server>` 查最新、`dev publish list -w <ws>` 查历史
- 中途异常可 `cancel`(取消)或 `redeploy`(取消旧的 + 创建新的)
- 完整状态机详见 `um tmcp dev publish --help`

## Tenant

TMCP 有 2 个面向用户的 tenant:

- **ali-office**(默认)— 内网办公,Session 用 `BucSession`
- **ali-internet** — 集团互联网域,Session 用 `TbSession`

大多数命令省略 `--tenant` 即可(默认 ali-office)。互联网域场景显式 `--tenant ali-internet`。

随时通过 `um tmcp tenants` 查看当前 CLI 支持的 tenant 列表(含环境归属和推荐 Session Type)。

## 三套环境

| 环境 | 用途 |
|------|------|
| **daily** | 日常开发联调 |
| **pre** | 预发验证 |
| **prod** | 线上正式 |

三个环境**基础流程一致**:自动推进到 TestComplete 步骤暂停,等用户验证后手动 `dev publish action <ticket> -w <ws> --action test-complete --env <env>` 继续(ticket 从 publish 输出获取,或 `dev publish status` 查最新)。

差异:

- **daily / pre** — 安全审核可手动跳过(`dev publish action <ticket> --action skip-audit --env <env>`),适合联调/演练
- **prod** — 安全审核**强校验**,必须走 `--action audit`;另多两步:ReleaseVersion 配置(设版本号)+ Changefree 审批

> ⚠ **提交安全审核的前置条件**:server 引用的**所有 tool** 都必须补齐**安全审核表单**(含请求样例、响应样例等字段)。daily/pre 走 skip-audit 可跳过此检查;prod 走 audit 时表单不全会被拒。建议在 daily 阶段就把表单填好,避免到 prod 才发现要补。详见 `references/config-pitfalls.md` 的「安全审核表单」节。

完整环境差异与状态机见 `um tmcp dev publish --help` 顶部说明。

## 生产者侧端到端流程

**一次性准备**(workspace 不存在时):

```
um tmcp dev workspace create --name <id> --title <显示名>
```

**迭代主流程**(每次发版重复):

```
编辑 manifest  →  dev manifest diff  →  dev manifest apply
                                              ↓
                                     dev publish daily
                                              ↓
                          人工验证 → action ... --action test-complete --env daily
                                              ↓
                                     dev publish pre
                                              ↓
                          人工验证 → action ... --action test-complete --env pre
                                              ↓
                                     dev publish prod
                                              ↓
                          人工验证 → action ... --action test-complete --env prod
                                              ↓
                  action ... --action audit --env prod
                       (安全审核;tool 的审核表单需提前填齐,否则被拒)
                                              ↓
                       ReleaseVersion 配置 + Changefree 审批
                                              ↓
                                         released ✓
```

每个 `action ...` 是 `um tmcp dev publish action <ticket> -w <ws>`。`<ticket>` 从上一步 publish 输出获取,或 `dev publish status -w <ws> -s <server>` 查最新。

**写之前先看**:
- manifest 详细范式 → `references/manifest.md`
- tool/server config 写法陷阱(含安全审核表单) → `references/config-pitfalls.md`

### 工单管理子流程

发布出问题时的 4 个常用动作:

| 想做什么 | 命令 |
|---------|------|
| 看当前发布到哪一步了 | `dev publish status -w <ws> -s <server>` |
| 持续盯到终态 | `dev publish status ... --watch [--interval 30]` |
| 取消当前工单 | `dev publish cancel -w <ws> -s <server>` |
| 取消旧的 + 重新发布 | `dev publish redeploy -w <ws> -s <server>` |

## 路由表(按场景按需 Read 细节)

| 你要做什么 | 看哪个 |
|-----------|-------|
| 写 / 编辑 manifest,批量改造,IaC 范式 | `references/manifest.md` |
| 写 tool / server config(无论用 manifest 还是单命令) | `references/config-pitfalls.md` |
| `um tmcp` 报错 / 调不通 / publish 卡住 / SSL / stdio 失败 | `references/troubleshooting.md` |
| 申请别人发布的 server(消费者) | `references/market.md` |

## 常见场景速查

### S1. 我有 HSF 接口,想做成 MCP 工具上线

```
1. 确保 workspace 存在(dev workspace list / create)
2. 用稳健链路从 HSF 生成 tool config:
   dev assistant from-hsf -w <ws> --interface X --method Y --dry-run     # 预览
   dev assistant from-hsf -w <ws> --interface X --method Y \
     --save-config ./tools --save-only                                    # 落盘不创建
   vim ./tools/<tool>.json                                                # 改 app-name / 补 schema
                                                                          # ← 先看 references/config-pitfalls.md
3. 创建 tool: dev tool create -w <ws> --config ./tools/<tool>.json
4. 创建 server 引用该 tool: dev server create -w <ws> --config <server-config>
5. 发布 daily → 验证 → test-complete → pre → prod(见 happy path step 4)
```

完整 from-hsf 三档保护机制(`--dry-run` / `--save-config` / `--save-only`)见 `dev assistant from-hsf --help` 推荐工作流段。

### S2. 一次改多个 tool / server(批量改造)

走 manifest 流程:`export → 本地编辑 → diff → apply`。详见 `references/manifest.md`。

### S3. 控制台手改了 server,想同步回 manifest

```
um tmcp dev manifest export -w <ws> -o manifest.json
git diff manifest.json     # 看变化是否符合预期
git commit                 # 配置即代码
```

### S4. 用户报告"server 调不通"

按 troubleshooting 顺序:

```
1. um tmcp doctor                                    # 一键体检
2. um tmcp token show [--tenant X]                   # 查 token 状态 / domain
3. um tmcp client list-tool -s <server>              # 验证 server 可达 + 列工具
4. um tmcp client call-tool -s <server> --tool <T> --describe   # 看 inputSchema
5. 仍不行 → 见 references/troubleshooting.md
```

### S5. 发布看起来没有进展

```
1. um tmcp dev publish status -w <ws> -s <server>    # 看卡在哪一步
2. 卡在 TestComplete → action --action test-complete --env <env>(验证后才能继续)
3. 想取消 → dev publish cancel
4. 想重发 → dev publish redeploy
```

### S6. 调用别人发布的 server(消费者)

见 `references/market.md`。

### S7. 我在维护一个 SKILL,想自动补齐"如何调用 MCP 工具"章节

```
um tmcp skill enhance <skill-name>                  # 直接修改原 SKILL
um tmcp skill enhance <skill-name> --dry-run        # 预览不改
um tmcp skill enhance <skill-name> --output <new>   # 输出到新文件,不动原 SKILL
```

适合场景:SKILL 业务逻辑已写好,但还没把要调的 MCP 工具的 inputSchema / 调用示例 / 错误处理写进去 —— 让 CLI 自动抓取并追加。常用 flag:

- `--match-strategy directory|metadata` — 按目录名查(默认)或先目录名再 SKILL.md 的 name 字段
- `--agent <name>` — 默认 `openclaw`,需要时换
- `--force` — 强制重新生成(已有内容会被覆盖)

完整选项 `um tmcp skill enhance --help`。

## 工作原则

1. **先看再改** — 任何变更前先 `dev server get` / `dev manifest export` 拿现状
2. **写第一份 tool/server config 前必读 `--help` 顶部「⚠ 关键约束(必读)」** — `dev tool create --help` / `dev server create --help` 顶部各有一节,列出 4 大易踩坑。读完再写,第一次基本不会被 schema 拒绝。速查见 `references/config-pitfalls.md`
3. **prod 变更前先在 daily/pre 验证** — daily/pre 流程是 prod 的子集,便于演练(prod 多 ReleaseVersion 配置 + 审批两步)
4. **生产发布前明确确认** — Claude 应主动暂停:"我要发布 X 到 prod,确认继续?"
5. **失败先 `um tmcp doctor`** — 一键查 CLI / BUC / token / 网络,绝大多数环境问题它会直接指出
6. **doctor 没问题再深挖** — 触发 `references/troubleshooting.md` 决策树,不要重试模糊命令
7. **删 Server 前先看 `productionStatus`,必要时先走下线** — `um tmcp dev server delete <name> -w <ws>` 不会自动下线;若 `dev server get` 返回的 `productionStatus` 非空(已上过 prod),通常需先 `um tmcp dev publish offline <name> -w <ws>`(注意:offline 在 `publish` 子命令组下,不在 `server` 下)再执行 delete。被后端以「必须先下线」拒绝时见 `references/troubleshooting.md`

## 不在此 skill 的内容

- **单命令 flag 细节** → 直接 `um tmcp <path> --help`
- **字段定义** → 直接 `um tmcp schema --kind <X>`
