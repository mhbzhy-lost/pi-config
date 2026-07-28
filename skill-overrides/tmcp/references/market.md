# TMCP 消费者侧(市场)

如果你不是要建 server,只想用别人发布好的:

## 端到端流程

```bash
# 1. 找 server
um tmcp market search --keyword <关键字>

# 2. 看详情(描述 / 接入要求 / 所属团队)
um tmcp market info -s <server-name>

# 3. 申请授权
um tmcp market request-access -s <server-name> --reason "..."

# —— 等管理员审批 ——

# 4. 申请通过后,用 client 验证可达
um tmcp client list-tool -s <server-name>

# 5. 试调用某个 tool
um tmcp client call-tool -s <server-name> --tool <tool-name> --input '{...}'

# 5a. 只想看 inputSchema 不真调
um tmcp client call-tool -s <server-name> --tool <tool-name> --describe
```

## --env 选择

`client list-tool` / `call-tool` 默认 `--env prod`。如果对方 server 你只有 daily/pre 的访问权,显式指定:

```bash
um tmcp client list-tool -s <name> --env daily
um tmcp client call-tool -s <name> --env pre --tool <T> --input '{...}'
```

env 不对会返回 404(server not found),即使授权已通过。

## Tenant 选择

server 注册在哪个 tenant 由生产者决定。如果不是默认的 ali-office:

```bash
um tmcp market info -s <name> --tenant ali-internet
um tmcp client list-tool -s <name> --tenant ali-internet
```

通过 `um tmcp tenants` 看当前 CLI 支持哪些 tenant。

## 常见问题

**搜不到 server** → 关键字太严,放宽;或者 server 没有发到 prod(只 daily/pre 不在市场公开)

**授权申请没回应** → 联系 server owner(`market info` 输出会显示);TMCP 平台不催办

**`client call-tool` 401/403** → 授权已批但本地 token 过期 → `um tmcp token` 刷新;参考 `troubleshooting.md` 的"Token 失效"节

**`client list-tool` 返回空** → server 已发布但没有 tool 暴露,或 tool 仅对特定 access level 可见 → 联系 owner 确认

## 不在此 reference 的内容

- **生产者侧(建 server / 发布)** → 见上一层 SKILL.md 的 Happy Path
- **manifest 范式** → 见 `manifest.md`
- **更深排错** → 见 `troubleshooting.md`
- **命令参数** → `um tmcp market --help` / `um tmcp client --help`
