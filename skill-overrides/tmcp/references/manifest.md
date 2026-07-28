# TMCP Manifest 范式

## 何时用 manifest

| 用 manifest | 用单命令 |
|------------|---------|
| 多 tool / 多 server 一起改 | 单个 tool 改一行 |
| 团队协作 / 版本管控 | 一次性 quick test |
| 跨 workspace 迁移 | 临时调试 |
| AI 批量生成 / 编辑工具 | 已知精确字段、改一处 |
| 需要 dry-run / 审查 | 简单 create-tool |

**心智模型**:单命令是 `kubectl create/edit`,manifest 是 `kubectl apply`。能用 apply 优先 apply,整体更可观察、可回滚。

## Schema 是契约

CLI 把所有 input/output 形态都暴露为 JSON Schema,是 AI 消费的权威源。

```bash
um tmcp schema --list                       # 所有 kind
um tmcp schema --kind manifest              # 拿 manifest 的 schema
um tmcp schema --kind manifest --example    # 含一个最小可解析示例
um tmcp schema --kind tool --mode pro       # tool 有 easy/pro 两 mode
```

**15 种 kind 分两类**:
- **input**:session / auth / access-control / rate-limit / tool / server / workspace / manifest
- **output**:*-detail / *-list-item / publish-ticket / revision-detail / workspace-detail

写 manifest 时优先读 input 类的 schema;解析命令返回时读 output 类。

## 推荐 AI 编辑工作流

```
1. um tmcp schema --kind manifest > /tmp/schema.json
2. um tmcp dev manifest export -w <ws> -o /tmp/current.json  # 拿现状(已是 manifest 形态)
3. AI 基于 schema 编辑 /tmp/current.json
   - 用 ajv 本地校验(不通过别提交)
4. um tmcp dev manifest diff -f /tmp/current.json    # 预览变更
5. um tmcp dev manifest apply -f /tmp/current.json   # 执行
6. um tmcp dev publish daily -w <ws> -s <server>     # 发布到环境
       ↓ 验证后
   um tmcp dev publish action <ticket> -w <ws> --action test-complete --env daily
       ↓ 重复 publish pre → publish prod
```

**关于 `manifest export` 的 revision 行为**:默认导出的 manifest 不固定 revisionId(`apply` 时取 latest),适合"始终跟随最新版本"场景。CI / 回滚 / 版本控制场景加 `--pin-revisions` 保留具体 revisionId。详见 `dev manifest export --help`。

**`gen-schema --merge-into` sugar**(拼新 tool 时):

```bash
um tmcp dev assistant gen-schema --from-hsf --interface X --method Y \
  --merge-into /tmp/tool-config.json
# → 直接把生成的 schema patch 到 tool config 文件的对应字段
```

具体 flag 见 `um tmcp dev assistant gen-schema --help` 的"AI 调用建议"段。

## --prune 必须谨慎

**默认行为**:`dev manifest apply` 不删除 manifest 未列出的线上 tool/server(安全默认)。

**`--prune` 开关**:删除 manifest 中未列出的对象。

**使用规则**:

1. **加 `--prune` 之前必跑 `dev manifest diff --prune`** —— 看清要删什么再决策
2. **第一次对某 workspace 启用 manifest 管理时不要加 prune** —— 此时本地 manifest 不一定是真实全集
3. **CI/自动化场景**:把 manifest 当唯一真相源时才用 prune;半人工管理(控制台和 manifest 混用)禁用 prune

## Tool 的两种 mode

| Mode | 何时用 | 给什么 |
|------|--------|--------|
| **easy** | 后端字段能 1:1 对应到 MCP 工具参数 | 不写 `invocationConfig`,后端从 schema 自动 derive paramMappings |
| **pro** | 需要参数重命名、嵌套展开、响应解包等显式映射 | 自己写 `invocationConfig.paramMappings` / `resultMappings` |

**判断捷径**:先按 easy 写,如果 schema 表达不出后端真实参数形态再升级 pro。

Pro 模式映射规则(targetType / sourceType / JSONPath / subMappings 等)见:

```bash
um tmcp schema --kind tool --mode pro --example
```

不复读规则正文。

## Apply 的常见反模式

| 反模式 | 替代 |
|-------|------|
| `apply` 之前不 `diff` | 永远先 diff |
| 误开 `--prune` 删除控制台手动建的 tool | 半人工管理禁用 prune |
| 把 manifest 文件存在临时目录、改完不入 git | manifest 是配置即代码,应版本化 |
| 用 `apply` 改 tool 的单个小字段 | `dev tool update` / `dev server update` 自动 fetch + merge + 注入乐观锁 changeId,传**部分字段**就够了,不用全量 |
| AI 凭印象拼 manifest,不用 schema 约束 | 先 `schema --kind manifest`,本地 ajv 校验后再提交 |
| 不知道 workspace 启用了什么发布模式就直接 apply | 首次接入新 workspace 先 `dev publish check-flow -w <ws>` 了解约束(如跳过审批 / 强制 test-complete)|

## 写 tool / server config 之前

**第一步永远是读 `config-pitfalls.md`** —— HTTP 4-key / HSF arg 排序 / Session 选型 / Server auth / accessControl 五大易踩坑都在那里。CLI 把 strict schema 会拒绝的硬约束都集中讲了。

或直接读源头:`um tmcp dev tool create --help` / `um tmcp dev server create --help` 顶部「⚠ 关键约束(必读)」节。

## 不在此 reference 的内容

- **平台概念 / happy path 骨架 / 环境对照** → 见上一层 SKILL.md
- **apply / diff 失败排错** → 见 `troubleshooting.md`
- **tool/server config 写法陷阱** → 见 `config-pitfalls.md`
- **单命令 flag 细节** → `um tmcp <cmd> --help`
- **字段字典** → `um tmcp schema --kind <X>`
- **Pro 模式映射规则** → `um tmcp schema --kind tool --mode pro --example`
