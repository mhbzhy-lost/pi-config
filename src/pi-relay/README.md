# pi-relay：公网远程控制（本机侧）

让手机在公网安全访问本机 pi 会话。拓扑与 Codex/Claude Code 远程控制同款：**本机出站加密长连接 → 自有 ECS 中继 → 手机浏览器**；家里零入站端口，数据面不使用 SSH 隧道。

**仓库分工**：中继服务端与共享协议在独立仓库 [pi-relay-server](https://github.com/mhbzhy-lost/pi-relay-server)（ECS git clone 部署、state 导出/导入迁移、CA/证书/token 管理均见该仓 README）；本目录是本机侧——agent、三态 ensure、设备批准 CLI、pi-shell 集成。protocol 经 pinned tag 的 git 依赖消费其编译产物（`pi-relay-server/protocol`），协议版本握手（PROTOCOL_VERSION，错配 close 4003）防漂移。

```
手机浏览器 ──HTTPS/WSS──▶ ECS 中继（pi-relay-server 仓）
                          ▲ 出站 WSS（pinned CA）
本机 agent（agent.ts）──TCP──▶ 127.0.0.1:7681 pi-web
   │ 可信设备列表权威：var/pi-relay/devices.json（仅 CLI 写，agent 只读）
```

## 三态开关（pi/settings.local.json，gitignored）

| `webExposure` | 语义 |
|---|---|
| 缺失 / `"off"` | 不启用任何外部控制（默认）。ensure 停掉已运行的 web/agent，含接管存量旧 nohup web |
| `"lan"` | 局域网共享（与旧行为一致）：pi-web 绑 0.0.0.0:7681，`PI_WEB_TOKEN` 可选 |
| `"public"` | **涵盖 lan**：pi-web 绑 0.0.0.0 + 强制内部 token（仅约束非回环直连），另起出站 agent；手机经中继公网入口访问（设备批准制，零 token） |

`PI_WEB_PORT`（默认 7681）与 `PI_LOCAL_SETTINGS_PATH` 全链路生效。每次 `pi()`（含 tmux 内）触发 ensure；配置非法/缺凭据中文告警但**不阻断 pi()**。ensure/停止动作入 `var/pi-relay/audit.log` 生命周期审计（配置路径/三态判定/调用方 cmdline/SIGKILL 升级）。

## 凭据注入（唯一注入点）

中继 init 打印注入材料，**用户本人**粘贴进本机 `pi/settings.local.json`：

```json
{
  "webExposure": "public",
  "webRelay": {
    "url": "wss://<ECS公网IP>:<端口>",
    "agentToken": "<init 输出>",
    "caFingerprint": "SHA256:AA:BB:…（init 输出）"
  }
}
```

- `agentToken`：本机 agent 与中继的机器鉴权 token，与设备凭据完全分离；多主机下每台 Mac 各持一份。
- 内部 LAN `web-token` 由 ensure 自动生成（`var/pi-relay/web-token`，0600），仅保护非回环直连；`status` 显示含 token 的局域网直连 URL。
- 设备凭据（Cookie secret）由中继配对时生成，本机只存 SHA256 哈希，中继不落盘。

## 启用与日常命令

```bash
node scripts/pi-relay.ts fetch-ca   # 下载中继 CA 并按注入指纹核对（不符拒存；自动建目录）
node scripts/pi-relay.ts ensure     # 按三态启动/停止 web + agent
node scripts/pi-relay.ts status     # exposure/进程/心跳/设备/URL
node scripts/pi-relay.ts stop       # 全停（等价 off 的一次性动作）
node scripts/pi-relay.ts devices                 # 待批准（码/UA/IP）+ 可信设备
node scripts/pi-relay.ts approve <配对码> [--name 名称]
node scripts/pi-relay.ts deny <配对码>
node scripts/pi-relay.ts revoke <设备id>         # 即时切断存量连接
```

## 多主机：多台 Mac 共用一个手机入口

单入口直接看**全部在线 Mac 的拍平会话列表**（主机名徽章、离线灰显），点哪条进哪条。

- 新 Mac 接入（推荐交互式）：`node scripts/pi-relay-join.ts`——git pull（可跳过）→ 注入材料 ssh 从 ECS 取回（仅读文件，绝不端口转发；默认远端路径 `pi-relay-server/init-output-agent2.txt`）或手工粘贴 → 校验合并 settings.local.json（保留已有字段、token 不回显、0600、写前确认）→ fetch-ca → ensure → status。
- ECS 侧新增 agent / 轮换 / 迁移：见 pi-relay-server 仓 README（`init --add-agent`、`--rotate-tokens`、`export-state`/`import-state`）。
- CA 相同：手机无需再装证书；已批准手机（含旧版 v1 Cookie）免重新配对（v1 自动映射迁移 id host-1）。
- 配对：多主机在线时 /pair 出主机选择页（批准权威在各 Mac，必须知道在哪台核对码）；批准后凭据合并进同一 Cookie（按主机键控，≤16 台）。
- 吊销按 Mac 独立生效；单 host 鉴权失败不计全局限流。
- 逐会话 LAN 直连：点同网段（192.168）Mac 的会话整页跳转其局域网地址（token/会话自动携带）；异网段走中继。多主机在线时根导航不 redirect；仅单主机在线且同网段保留旧 redirect。
- **CGNAT 误判逃生**：`https://<IP>:<端口>/?stay=1` → 所有会话强制走中继。
- 各 Mac 建议保持仓库同版本（页面/静态资源按配置顺序取第一个获批在线 agent）。

## 手机配对批准流程（零 token）

1. 手机访问中继入口 → 无 Cookie 跳转 `/pair` 配对页（6 位码；多主机先选主机）。
2. 本机核对手机屏幕上的码后 `approve <码>`；配对页自动获得 `HttpOnly; Secure; SameSite=Lax` Cookie（1 年）并跳转终端。
3. 配对 10 分钟过期；同 IP 每分钟 ≤5 次新建、全局 ≤8 槽位；鉴权失败同 IP >10/min 临时 429。
4. 中继重启不影响已批准设备（列表在本机）。

## 手机信任 CA（一次性）

访问 `https://<IP>:<端口>/ca.crt`，**核对指纹与 init 输出一致**后安装：iOS 需在 设置→通用→关于本机→证书信任设置 开启**完全信任**；Android 用系统信任库（设置→安全→加密与凭据→CA 证书）；鸿蒙把 `.crt` 改后缀 `.cer`/`.pem` 后从 加密和凭据→从存储设备安装。**爆炸半径警示**：信任该根 CA 后中继被攻破可对手机做任意域名 MITM；不用时删除描述文件/证书。

## 回环豁免边界（pi-web）

仅 public 模式由 ensure 设置 `PI_WEB_TRUST_LOOPBACK=1`：pi-web 对 127.0.0.1/::1 来源免 token（中继流量经 agent 从回环进入，设备鉴权已在边缘完成）。非回环 token 门禁不变；lan/off 回环无 token 仍 401。外部网络无法伪造回环源。

## teardown 与轮换

- 本机停用：`webExposure` 改 `"off"`（或 `stop`）→ web/agent 全停；ECS 中继进程需另行停止（见 pi-relay-server 仓）。
- 设备丢失：`revoke <id>`；agentToken 泄露：ECS `init --rotate-tokens` + 本机更新注入。
- 叶证书续签 / 中继迁移 / 回滚：见 pi-relay-server 仓 README。

## curl 配对演练（本地全程）

中继侧用 pi-relay-server 仓（staging 或 ECS）：

```bash
# pi-relay-server 仓目录：
node scripts/pi-relay-server.ts init --listen 127.0.0.1 --port 8443 --ip 127.0.0.1
nohup node scripts/pi-relay-server.ts start >>var/pi-relay/server.log 2>&1 &
# 本仓：把 init 输出 JSON 写入临时配置（勿动真实 settings.local.json），然后：
PI_LOCAL_SETTINGS_PATH=<临时配置> node scripts/pi-relay.ts fetch-ca
PI_LOCAL_SETTINGS_PATH=<临时配置> PI_WEB_PORT=17681 node scripts/pi-relay.ts ensure
CA=var/pi-relay/root-ca.crt; B=https://127.0.0.1:8443
curl -s --cacert $CA $B/relay-status
curl -s --cacert $CA -c jar.txt $B/pair | grep -o 'pair-id" content="[0-9a-f]*'
curl -s --cacert $CA $B/pair | grep -o '<div class="code">[0-9]*'
PI_LOCAL_SETTINGS_PATH=<临时配置> node scripts/pi-relay.ts approve <配对码>
curl -s --cacert $CA -b jar.txt -c jar.txt "$B/pair-status?id=<id>"
curl -s --cacert $CA -b jar.txt $B/api/sessions
```

**演练纪律**：ensure/devices 每 root 单例——双主机演练必须用隔离 root（拷贝 + 独立 TMUX_TMPDIR + env -u TMUX + 专用 tmux 会话），**严禁在真实 root 跑演练 ensure**（会停真实服务）。演练后临时配置改 off 再 ensure、停中继、清理产物。

## 安全说明与残余风险

- 未批准设备零能力（边缘拒绝）；批准人在回路；凭据最小化（手机持 secret、本机持哈希、中继内存短暂持有）。
- 日志纪律：agent/中继日志不含凭据材料；本机 audit.log 记录配对/批准/吊销与生命周期事件。
- 残余：已批准设备 = 完全终端控制权；ECS 被攻破可 MITM 已信任 CA 的手机并截取会话明文（中继终止 TLS，非端到端加密）；lan 直连 token 走 http 明文（既有语义）。

## 故障排查（本机侧）

| 现象 | 处理 |
|---|---|
| agent 日志「agentToken 与中继不一致」后退出（4001） | 核对 settings.local.json 与 init 输出；轮换后两侧同步 |
| agent 日志「协议版本与中继不匹配」后退出（4003） | 本仓 bump pi-relay-server 依赖或中继升级到对应 tag |
| 浏览器 503「本机离线」 | `status` 查 agent；`ensure` 重启；查 var/pi-relay/agent.log |
| fetch-ca 指纹不符 | 拒存是预期；核对 init 输出，谨防中间人 |
| 手机一直「等待批准」 | `devices` 看待批准；码 10 分钟过期需重新配对 |
| 进程异常停止溯源 | var/pi-relay/audit.log 生命周期审计（调用方 cmdline/停止目标/SIGKILL 升级） |
| 端口被陌生进程占用 | ensure 中文报错给 pid，手动处理后重试（绝不误杀） |

日志位置：`var/pi-relay/web.log`、`agent.log`、`audit.log`。中继侧排障见 pi-relay-server 仓 README。