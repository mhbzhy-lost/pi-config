# TMCP 排错决策树

> **第一步永远先跑 `um tmcp doctor`** —— 一键检查 CLI 版本 / BUC 登录 / token 缓存 / 网络可达,多数常见问题它会直接指出。
>
> 跑完 doctor 还定位不到,再加 `--debug` 看详细日志,或 `tail -f ~/.um/logs/$(date +%Y-%m-%d).log`。
> CLI error message 通常已说明根因和下一步建议,**先看 error 完整内容**。

## `command not found: um` / um 没装

**症状**:任何 `um tmcp` 命令在 shell 层就失败,连 `doctor` 都跑不起来。

**修复**:跑一键 setup 脚本(幂等):

```bash
bash ${CLAUDE_PLUGIN_ROOT}/skills/tmcp/scripts/setup.sh
```

脚本会按需安装 um、引导 BUC 登录、获取 TMCP token。完成后重跑原命令。

如只想诊断不修复:

```bash
bash ${CLAUDE_PLUGIN_ROOT}/skills/tmcp/scripts/check-prereqs.sh
```

## um < 0.2.65 / Pro Tool partial update 在提交前校验失败

**症状**:`dev tool update --config/--stdin` 更新 Pro Tool 时,CLI 在发请求前报多项 schema 错误。常见字段包括 nullable mapping、递归 `subMappings`、`serviceInputSchema` / `serviceOutputSchema` 或旧快照中的 `targetClusters`。

**根因**:旧版 CLI 会先 GET 完整后端快照,再把 partial update 合并到快照并用公开配置 schema 做 strict 校验。后端派生字段和旧版扩展字段因此可能阻断任何更新;旧版 Pro manifest update 也不能保证完整 service schema 快照无损写回。

**修复**:

```bash
tnpm i -g @ali/ultima@latest
um --version  # 必须 >= 0.2.65
```

升级后继续使用原 manifest,无需迁移。Pro manifest 的公开形态没有增加 `service*Schema` 字段;不要把后端派生 schema 手工写进 manifest,也不要为通过校验删除未知字段。`0.2.65+` 会从同一次 Tool GET 中提取可信 wire 字段,在公开配置 strict 校验通过后恢复到完整更新请求。

## 401 / 403 — Token 失效

**症状**:除 `token` 外任何 `um tmcp` 命令返回未授权。

**根因**:本地 token 过期 / 被后台清理 / tenant 不匹配。

**修复**:

```bash
um tmcp token                       # 重新获取(默认 ali-office)
um tmcp token --tenant ali-internet # 或互联网域
# 仍失败:
um login                            # BUC 重登
um tmcp token
```

或直接跑 `bash ${CLAUDE_PLUGIN_ROOT}/skills/tmcp/scripts/setup.sh` 一键修。

## "server not found" / 404

**症状**:`client list-tool` / `client call-tool` 报 server 不存在,但控制台看得到。

**根因**:客户端连接的 MCP 运行时 URL 与 token 颁发的不一致。

**检查**(token 缓存是权威源):

```bash
um tmcp token show                       # 默认 tenant 的 domain / identity / 剩余有效期
um tmcp token show --tenant ali-internet # 换 tenant
```

如果是已知 server 但 `--env` 不对,运行时找不到也会 404。`client list-tool` / `call-tool` 默认 `--env prod`,daily/pre 上的 server 需要 `--env daily/pre` 指定。

## "Tool 不存在" / inputSchema 拿不到

**根因**:

1. tool 已创建但没加入 server → `dev server get <name>` 看 tools 列表
2. tool 加入了 server 但 server 没发布 → `dev publish status` 看是否完成
3. tool 名拼错

**省事的拿 schema 方法**:

```bash
um tmcp client call-tool --server X --tool Y --describe
# 不真调,只打印 inputSchema
```

## Publish 卡住 / 长时间没进展

**症状**:`dev publish daily/pre/prod` 跑完显示"等待 TestComplete",没有进一步推进。

**根因**:这是**正常行为**。三环境都会自动暂停到 TestComplete 步骤,等待人工验证后手动继续。

**继续推进**:

```bash
# 验证 server 工作正常后:
um tmcp dev publish action <ticket-id> -w <ws> --action test-complete --env <env>
```

如果忘了 ticket-id:`um tmcp dev publish status -w <ws> -s <server>` 拿;
想盯着工单跑完可加 `--watch [--interval <seconds>]` 持续轮询直到终态。

## Apply 改动出乎意料 / 删了东西

**症状**:`dev manifest apply` 之后控制台某些 tool/server 不见了。

**根因**:执行时加了 `--prune`,manifest 又没列出那些对象 → 被当作"应删除"清理掉。

**预防**:

1. 加 `--prune` 前必跑 `dev manifest diff --prune` 看清"会删什么"
2. 半人工管理(控制台 + manifest 混用)的 workspace 永远不要 `--prune`
3. 第一次对 workspace 启用 manifest 管理时不要 `--prune`,先 `export` 建立完整 manifest

**已删除的恢复**:从 git 历史拿回旧 manifest,去掉 `--prune` 重新 apply。

## auth.type 验证失败(CLI 0.2.51+ / 后端)

**症状**:`dev manifest apply` 或 `dev server create/update` 报 `auth.type` 不合法,或后端返回 AUTHENTICATION policy 缺失。

**根因**:server config 的 `auth.type` 字段缺失或值不在允许范围。CLI 0.2.51 起前端校验,后端同步加了拦截。

**修复**:在 server config 的 `auth` 对象中补上 `type` 字段,只允许两个值:

```json
{
  "auth": {
    "type": "ACCESS_TOKEN",       // 或 "BUC_SSO_TOKEN"
    "needAuthority": false
  }
}
```

详见 `config-pitfalls.md` 的「Server auth 必填」节。

## Manifest 校验失败 / `apply` / `diff` 报字段错误

**症状**:

```
错误: manifest 校验失败 (schema):
  /apiVersion: Invalid input: expected "tmcp/v1"
  /tools: Invalid input: expected array, received undefined
```

**根因**:本地 manifest 不符合 schema。

**修复**:CLI error 已提示运行:

```bash
um tmcp schema --kind manifest --example
```

按 example 对齐结构,本地用 ajv 校验后再提交。

## SSL 错误(自签证书)

**症状**:`unable to verify the first certificate` / `self signed certificate`。

**修复**(**仅本地调试**):

```bash
NODE_TLS_REJECT_UNAUTHORIZED=0 um tmcp <subcommand>
```

生产 / CI 环境应配置系统证书链或 JVM trust store。

## stdio MCP 启动失败

**症状**:`client call-tool --type stdio` 工具列表为空或卡住。

**排查清单**:

1. 命令存在:`which node` / `which python`
2. 用**绝对路径**:`--command /usr/local/bin/node --cmd-args "/abs/server.js"`
3. 多参数分别传:`--cmd-args "-y" "@org/pkg"`(不是单字符串)
4. 确认 server 真支持 stdio MCP(不是仅 HTTP)

## HSF 接口解析失败

**症状**:`dev assistant from-hsf` 报 `未找到 HSF 服务 X(version=*)`。

**排查顺序**:

1. **拼写**:interface 全限定名(包名 + 类名,区分大小写)
2. **环境**:`--env` 是否对应接口实际部署环境
3. **版本与分组**:`--hsf-version` / `--group` 一致(默认 group=HSF)
4. **真实存在**:通过 HSF OPS 平台核对接口已发布

## OpenAPI 解析失败

**修复优先级**:

1. 先用 `--openapi-file` 试本地下载的 swagger.json,排除网络
2. 大文档可能超时,分拆 operations 或 `--operation-id` 指定单个
3. URL 需可达 + 返回标准 OpenAPI 3.x(Swagger 2.x 可能要先转换)

## Prod audit 被拒:安全审核表单未补齐

**症状**:`dev publish action <ticket> --action audit --env prod` 被拒,提示某 tool 的安全审核表单不完整(常见缺项:请求样例 / 响应样例)。

**根因**:tool 的安全审核表单没填好。daily/pre 走 skip-audit 时不检查,所以问题到 prod 才暴露。

**修复**:

1. 找出表单不全的 tool(错误信息通常会列出)
2. 补齐表单(具体字段见 `um tmcp schema --kind tool --example` 和 `dev tool create --help`)
3. 应用变更:
   - 单命令:`um tmcp dev tool update -w <ws> --name <tool> --config <patched.json>`
   - manifest:编辑后 `dev manifest apply -f <manifest.json>`
4. 重发 prod:`dev publish redeploy -w <ws> -s <server>`,新工单跑到 audit 步骤再 `--action audit`

**预防**:下次在 daily 阶段就把表单填全,详见 `config-pitfalls.md` 的「安全审核表单」节。

## Auto-release-version 给了奇怪的版本号

**症状**:`dev publish auto-release-version --server X` 给了一个看起来不对的版本。

**当前行为**:CLI 对不存在的 server 也返回 `1.0.0`,但会打一行 ⚠ 警告"可能是首次发布,也可能名称拼写有误"。

**修复**:
- 在脚本/CI 里加 `--strict`,server 不存在直接非零退出,避免拿到假版本号继续往下跑
- 先 `dev server list -w <ws>` 确认 server 存在;版本可疑时手动 `--version serverName:semver` 显式指定

## 通用诊断

```bash
um tmcp doctor                      # CLI / BUC / token / 网络 一键检查(优先跑)
um --debug tmcp <subcommand>        # 详细日志
tail -f ~/.um/logs/$(date +%Y-%m-%d).log
```

## 不在此 reference 的内容

- **happy path / 概念** → 见上一层 SKILL.md
- **manifest 范式** → 见 `manifest.md`
- **tool/server config 写法陷阱** → 见 `config-pitfalls.md`
- **命令参数** → `um tmcp <path> --help`
