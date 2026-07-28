# pages 命令完整参考

## a1 pages — Aone Pages 站点管理

管理代码仓库的 Aone Pages 静态站点配置（**不是部署内容**——部署走 `a1 ci`，模板 `10014197`，详见 `ci-commands.md` 示例 5）。

一个 repo 至多一个站点。站点通过 `https://<site-name>.io.alibaba-inc.com` 访问，可绑定自定义域名。

### 全局标志（所有子命令共享）
- `--repo string` — 覆盖绑定的仓库（repoId 或 group/project 路径，默认走当前 git 仓库）
- `-f, --format string` — 输出格式 `plain` / `json`
- `-q, --quiet` — 仅输出 siteName，**无尾随换行**（机器友好，便于 `$(a1 pages view -q)` 或 `^\S+$` 之类的严格正则匹配；这是 pages 命令与 a1 其它命令 quiet 模式的差异）
- `-v, --verbose` — 显示 HTTP 请求/响应详情

### 鉴权约束
- 调用者必须对目标 repo **至少有 MASTER 角色**，否则报 `permission denied: managing pages requires MASTER role on the repo`
- 未登录时报 `not authenticated; run 'a1 auth login'`

---

## pages view

查看当前 repo 的 pages 站点配置。

```bash
a1 pages view [--repo <id-or-path>] [--format json] [--quiet]
```

- 返回 siteName、URL、domains、createAt、updateAt
- 未配置时输出：`No pages site configured for this repo. Use 'a1 pages create' to create one.`
- `--format json` 时未配置返回 `null`，`--quiet` 时未配置无输出

## pages create

新建 pages 站点。

```bash
a1 pages create --site-name <name> [--domain <d>]...
```

- `--site-name string` — **必填**。全局唯一，正则 `^[a-z0-9-]{1,64}$`，首尾不能是 `-`
- `--domain string`（可重复） — 自定义域名，重复 flag 加多个：`--domain a.com --domain b.com`

**siteName 冲突**报 `site name is already taken (must be globally unique across Aone Code)`；**domain 冲突**报 `domain is already bound to another pages site (must be globally unique)`。

CLI 端会对每个 `--domain` 做归一化（lowercase + trim + 去端口 + 去 trailing dot + 去重）再发请求。

## pages update

修改 pages 站点。**智能合并**——只覆盖用户指定的字段，其它保持不变（内部 GET + merge + PUT）。

```bash
a1 pages update [--site-name <name>] [--domain <d>]... [--clear-domains]
```

- `--site-name string` — 改名（可选）
- `--domain string`（可重复） — 整体替换自定义域名列表
- `--clear-domains` — 显式清空所有自定义域名

**互斥约束**：
- `--clear-domains` 与 `--domain` 不能同时用，报 `flags --clear-domains and --domain cannot be used together`
- 全空报 `nothing to update; specify --site-name, --domain, or --clear-domains`
- 未配置 pages 的 repo 上执行 update 报 `no pages site configured for this repo; use 'a1 pages create' instead`

## pages delete

删除 pages 站点。

```bash
a1 pages delete [-y]
```

- `-y, --yes` — 跳过确认提示
- **幂等**：未配置 pages 的 repo 上执行 delete 也返回成功（后端 `removeSite` 是 no-op）

---

## 与「部署 Aone Pages」的区分

| 场景 | 命令 |
|------|------|
| **管理站点配置**（建/查/改/删 siteName 和 domains） | `a1 pages <view\|create\|update\|delete>` |
| **部署网站内容到 OSS**（构建 + 推 OSS） | `a1 ci` 创建流水线（模板 `10014197`），详见 `ci-commands.md` 示例 5 |

用户说 `部署 pages` / `刷新 pages` / `deploy pages` → 走 `a1 ci`。
用户说 `查 pages` / `创建 pages 站点` / `改 pages 域名` → 走 `a1 pages`。
仅出现「pages」名词（如 `/a1 pages`）无明确动词时先反问"是想管理站点配置还是部署内容？"。
