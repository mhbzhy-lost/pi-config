# Tool / Server Config 关键陷阱

> 写 tool / server config 之前(无论用 `dev tool create` 单命令还是 manifest),**先读这一页**。
> CLI 把会被 strict schema 拒绝的硬约束都集中在这里。

写之前的源头入口:

```bash
um tmcp dev tool create --help    # 顶部「⚠ 关键约束(必读)」节
um tmcp dev server create --help  # 顶部「⚠ 关键约束(必读)」节
```

本文件是这两节的速查 + 速记关键词。详细论述以 `--help` 输出为准。

## 速记关键词

agent 看到任何一个就该跳过来对一遍,或回去读对应 `--help`:

- **HTTP tool 顶层 properties** → 只能 `query` / `pathVariable` / `header` / `requestBody`,业务字段嵌进去
- **HSF tool 顶层 properties** → 按 `arg0` / `arg1` / ... 排,严格对齐 `methodParamTypes` 顺序
- **Session 字段** → ali-office 用 `BucSession`,ali-internet 用 `TbSession`,可省(= NoSession)
- **Server `auth` 字段** → 必填,公开 server 也要显式 `"needAuthority": false`
- **入口过滤** → `accessControl: { type: "ConditionExpression", exprs: [...] }`,与 `accessLevel` 独立可叠加
- **集群限流** → `rateLimit: { threshold, window }`,window 全大写 `SECOND` / `MINUTE`

## HTTP Tool 的 4-key 约束

HTTP tool 的 input schema 顶层 properties **只能是** 4 个固定 key:

```json
{
  "type": "object",
  "properties": {
    "query":        { ... },   // URL query string
    "pathVariable": { ... },   // URL path 变量
    "header":       { ... },   // HTTP header
    "requestBody":  { ... }    // request body
  }
}
```

业务字段**嵌在这四个里面**,不要平铺到顶层。否则 strict schema 直接拒绝。

## HSF Tool 的 arg 排序

HSF tool 的 input schema 顶层 properties 必须按 `arg0` / `arg1` / `arg2` / ... 命名,顺序对齐 `methodParamTypes`:

```json
{
  "methodParamTypes": ["java.lang.String", "com.example.Req"],
  "inputSchema": {
    "type": "object",
    "properties": {
      "arg0": { "type": "string" },           // 对齐 String
      "arg1": { ... Req 的 schema ... }       // 对齐 Req
    }
  }
}
```

顺序乱了 → HSF 调用参数错位,运行时报类型不匹配。

## Session 选型

| Tenant | Session 字段 |
|--------|-------------|
| ali-office(内网办公,默认) | `BucSession` |
| ali-internet(集团互联网域) | `TbSession` |
| 不需要用户身份 | 省略(等价 `NoSession`) |

`BucSession` 和 `TbSession` 不可混用。tenant 决定 session 类型,**不是 server 的选择**。

**HSF tool 不要配 BucSession** — `BucSession` 依赖 HTTP cookie/header 透传用户身份,HSF 走内部 RPC 没有 HTTP 上下文,配了也不生效。HSF tool 应省略 session(= `NoSession`)或使用其他认证方式。

## Server auth 必填

`auth` 字段是 `dev server create` 的必填项。**公开 server 也要显式声明**,且 `auth.type` 必须是 `ACCESS_TOKEN` 或 `BUC_SSO_TOKEN`:

```json
{
  "auth": {
    "type": "ACCESS_TOKEN",
    "needAuthority": false   // 公开,但仍需显式声明
  }
}
```

不写 `auth` / 写 `null` → schema 拒绝。`type` 填错或漏填 → CLI 0.2.51+ 和后端均会拒绝。

需要授权的:

```json
{
  "auth": {
    "type": "ACCESS_TOKEN",
    "needAuthority": true,
    "accessLevel": "..."     // 见下
  }
}
```

## rateLimit 集群限流

Tool 级别的集群限流策略。在 tool config 中用结构化字段 `rateLimit` 声明:

```json
{
  "rateLimit": {
    "threshold": 10,
    "window": "MINUTE"
  }
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `threshold` | int (>0) | 窗口内最大调用次数 |
| `window` | enum | `SECOND` 或 `MINUTE` |

CLI 自动转为后端 wire form `{ name: "RATE_LIMIT", enable: true, configs: { threshold, window } }`，读取时反向折叠回结构化字段。

常见错误:
- 把限流写在 `policyConfigs[]` 数组里(旧写法可用但不推荐,CLI 0.2.58+ 优先识别 `rateLimit` 字段)
- `window` 大小写写错(必须全大写 `SECOND` / `MINUTE`)
- `threshold` 传 0 或负数(schema 会拒绝)

## accessLevel vs accessControl

两个独立机制,**可以叠加**:

| 字段 | 控制什么 |
|------|---------|
| `accessLevel` | 粗粒度等级(BU / Team / Owner 等) |
| `accessControl` | 细粒度表达式,如 `userId in [...]` 或 `dept startsWith ...` |

写法:

```json
{
  "accessLevel": "BU",
  "accessControl": {
    "type": "ConditionExpression",
    "exprs": [
      "userId in ['12345', '67890']"
    ]
  }
}
```

两者都过才放行。常见错误:把入口过滤逻辑塞进 `accessLevel`(它不是表达式字段)。

## 安全审核表单(prod 发布的前置)

**所有 tool 都必须补齐安全审核表单**,否则提交 prod 安全审核(`dev publish action <ticket> --action audit --env prod`)时会被拒。

- daily / pre 走 `--action skip-audit` 可跳过此检查,所以问题往往到 prod 才暴露
- 推荐**在 daily 阶段就把表单填好**,避免发布链路走到一半被卡

表单的具体字段以 `um tmcp schema --kind tool --example` 输出和 `um tmcp dev tool create --help` 为准(本文不复读字段定义,避免与 CLI 不同步)。

通常包含:
- 请求样例(request example)—— 真实可调通的 input payload
- 响应样例(response example)—— 对应的 output 形态
- 工具用途 / 数据敏感性说明(便于审核同学判断)

补完后:
- 单命令场景:`dev tool update -w <ws> --name <tool> --config <patched.json>`
- manifest 场景:编辑 manifest 中对应 tool 节,跑 `dev manifest apply`

## 检查清单(写完 config 自查)

- [ ] HTTP tool:顶层 properties 只有 query/pathVariable/header/requestBody?
- [ ] HSF tool:arg0/arg1/... 命名对齐 methodParamTypes?
- [ ] Session 字段与 tenant 匹配(office→Buc / internet→Tb / 省略)?HSF tool 不配 BucSession?
- [ ] Server 的 auth 字段已显式声明(含公开 server 的 `needAuthority: false`)?
- [ ] Server 的 `auth.type` 是 `ACCESS_TOKEN` 或 `BUC_SSO_TOKEN`(不能漏,不能填其他值)?
- [ ] 入口过滤用 `accessControl.exprs`,不是塞进 `accessLevel`?
- [ ] 限流用 `rateLimit: { threshold, window }`,window 全大写?不要手写 `policyConfigs[]`?
- [ ] **每个 tool 都补齐了安全审核表单(含请求样例 + 响应样例等)?** —— prod 必须,daily/pre 可暂缓但建议同步补齐

全过再 `dev tool create` / `dev server create` / `dev manifest apply`,第一次基本不会被 strict schema 拒绝。

## 不在此 reference 的内容

- **manifest 范式** → 见 `manifest.md`
- **报错排查** → 见 `troubleshooting.md`
- **完整字段定义** → `um tmcp schema --kind tool|server --example`
- **Pro 模式参数映射规则** → `um tmcp schema --kind tool --mode pro --example`
