# pi-relay：公网远程控制中继

利用自有阿里云 ECS（仅公网 IP、无域名）作中继，让手机在公网安全访问本机 pi 会话。拓扑与 Codex/Claude Code 的远程控制同款：**本机出站加密长连接 → 云端中继 → 手机客户端**，家里不开任何入站端口；数据面不使用 SSH 隧道（内网穿透不合规）。

```
手机浏览器 ──HTTPS/WSS(TLS，默认443可自定义)──▶ ECS 中继（server.ts，字节透明反向代理，多 agent）
   │ 首连 /pair 配对页 + 6 位码          │ 设备鉴权/配对/会话列表经控制连接往返对应 Mac
   │ 批准后 HttpOnly Secure Cookie       │ /api/sessions 拍平合并全部获批在线主机
Mac-A agent ──出站 WSS（pinned CA）──▶   │
Mac-B agent ──出站 WSS（pinned CA）──▶   ▼
   各 Mac：agent（agent.ts）──TCP──▶ 127.0.0.1:7681 pi-web
   │ 可信设备列表权威：各 Mac 本机 var/pi-relay/devices.json（仅 CLI 写）
```

## 三态开关（pi/settings.local.json，gitignored）

| `webExposure` | 语义 |
|---|---|
| 缺失 / `"off"` | 不启用任何外部控制（默认）。ensure 会停掉已运行的 web/agent，含接管存量旧 nohup web |
| `"lan"` | 局域网共享（与旧行为一致）：pi-web 绑 0.0.0.0:7681，`PI_WEB_TOKEN` 可选 |
| `"public"` | **涵盖 lan**：pi-web 绑 0.0.0.0 + 强制内部 token（仅约束非回环直连），另起出站 agent；手机经 `https://<ECS_IP>:<端口>/` 访问（设备批准制，零 token），局域网直连仍可用 |

`PI_WEB_PORT`（默认 7681）与 `PI_LOCAL_SETTINGS_PATH` 全链路生效。每次 `pi()`（含 tmux 内）都会触发 ensure；配置非法/缺凭据时中文告警但**不阻断 pi()**。

## 凭据注入（唯一注入点）

ECS 侧 `init` 生成并打印注入材料，用户粘贴进本机 `pi/settings.local.json`：

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

- `url` 端口必须与 ECS `init --port` 一致（默认 443 可省略）；非 443 时安全组放行对应端口。
- `agentToken`：本机 agent 与中继之间的机器鉴权 token，与设备凭据完全分离。
- 内部 LAN `web-token` 由 ensure 自动生成（`var/pi-relay/web-token`，0600），用户无需感知；`status` 可显示含 token 的局域网直连 URL。
- 设备凭据（Cookie 中的 secret）由中继配对时生成，本机只存 SHA256 哈希，中继不落盘。

## 多主机：多台 Mac 共用一个手机入口

单入口直接看到**全部在线 Mac 的拍平会话列表**（每条带主机名徽章，离线主机灰显），点哪条进哪条，无需先选主机。

接入新 Mac（推荐交互式一条龙）：

```bash
# ECS 侧（经 skill 包装器或手工）：新增 agent，保留 CA/既有 agent
node scripts/pi-relay-server.ts init --add-agent --label mac-b
# 重启中继进程（配置 start 时加载一次，不热加载）
# 新 Mac 上（仓库根目录，交互式终端）：
node scripts/pi-relay-join.ts
```

join 工具引导完成：git pull（可跳过）→ 注入材料取回（ssh 从 ECS 读文件，或手工粘贴 JSON）→ 校验并合并进本机 pi/settings.local.json（保留已有字段，agentToken 不回显，写入 0600）→ fetch-ca → ensure → status。ssh 仅文件读取，绝不使用端口转发；取回失败可改手工粘贴。

手工等价步骤：把 init 打印的注入 JSON 写入新 Mac 的 pi/settings.local.json（url/CA 指纹与既有相同，仅 agentToken 不同），然后 `node scripts/pi-relay.ts fetch-ca && node scripts/pi-relay.ts ensure`。

- CA 相同：手机无需再装证书；已批准手机（含旧版 v1 Cookie）免重新配对（v1 自动映射到迁移 id host-1）。
- 配对：多主机在线时 /pair 出主机选择页（批准权威在各 Mac，必须知道在哪台核对配对码）；批准后凭据合并进同一个 Cookie（同源单 Cookie，按主机键控，≤16 台）。
- 吊销按 Mac 独立生效：revoke 只切断该 Mac 的通道与访问，不波及其他主机；单 host 鉴权失败不计全局限流。
- 逐会话 LAN 直连：点同网段（192.168）Mac 的会话时整页跳转其局域网地址（token/会话自动携带）；异网段会话走中继。多主机在线时根导航不再 redirect（保留聚合视图）；仅单主机在线且同网段时保留旧 redirect。
- **CGNAT 误判逃生**：访问 `https://<IP>:<端口>/?stay=1` → 所有会话强制走中继（s.lan 全部置空）。
- 各 Mac 建议保持仓库同版本（页面/静态资源按配置顺序取第一个获批在线 agent，版本漂移可能不一致）。
- 主机名暴露面：/pair 选择页与 /relay-status 对未鉴权请求可见主机名/在线态（无会话名）；私有部署可接受。
- 回滚注记：v2 Cookie 对旧版中继不可解析，旧二进制读不了 agents 数组配置；回滚需恢复旧 server-config（单 agentToken）且手机重新配对。

## ECS 部署

部署 bundle 不含任何凭据（证书/token 均在 ECS 侧生成）：

```bash
node scripts/pi-relay.ts bundle   # 产出 var/pi-relay/relay-bundle.tar.gz（自包含 ws 依赖）
```

**上传与远端执行通道**：agent 操作杭州服务器一律经 `aliyun-hangzhou-server` skill 的受控包装器（`server_access.py run` 的 stdin 透传上传 tarball、`run` 执行解包/init/启动；写操作需用户当轮明确授权）。用户本人也可手工 scp/ssh（pem）执行等价步骤——**仅文件传输与远程命令，绝不使用 -R/-L/-D 等端口转发**。

ECS 前置：Node ≥ 22.19（nodejs.org 官方二进制）、系统 openssl/tar；安全组仅放行中继端口（SSH 22 建议限源 IP）。

**先选空闲端口**：`ss -tln` 查看已占用端口再定 `--port`。443/8443 常被既有服务占用（含仅绑 127.0.0.1 的监听，同样会导致 `EADDRINUSE`）。换端口只需重跑 `init --port <新端口>`（幂等，保留 agentToken/CA），再重启进程；本机 `webRelay.url` 与安全组同步改。

```bash
# ECS 侧（解包后）
node scripts/pi-relay-server.ts init --ip <ECS公网IP> [--port <端口>]  # 生成 CA/叶证书/首个 agent，打印注入材料
node scripts/pi-relay-server.ts init --add-agent [--label <名>]        # 新增一台 Mac 的 agent（保留 CA/既有），重启中继生效
node scripts/pi-relay-server.ts start                     # 前台运行
node scripts/pi-relay-server.ts renew-cert                # 叶证书续签（398 天，保留 CA，手机无需重新信任）
node scripts/pi-relay-server.ts init --rotate-tokens      # 轮换全部 agent token（保留 CA/id）；重启中继后逐台 Mac 更新注入值
```

守护方式二选一：

```ini
# systemd unit（/etc/systemd/system/pi-relay.service）
[Unit]
Description=pi-relay
After=network.target
[Service]
WorkingDirectory=/home/<user>/pi-relay
ExecStart=/usr/local/bin/node scripts/pi-relay-server.ts start
Restart=always
[Install]
WantedBy=multi-user.target
```

或 `nohup node scripts/pi-relay-server.ts start >>var/pi-relay/server.log 2>&1 &`。

本机启用：

```bash
node scripts/pi-relay.ts fetch-ca   # 下载中继 CA 并按注入指纹核对（不符拒存）
node scripts/pi-relay.ts ensure     # 启动 web + agent
node scripts/pi-relay.ts status     # 查看 exposure/进程/设备/URL
```

## 手机配对批准流程（零 token）

1. 手机浏览器访问 `https://<ECS_IP>:<端口>/`（首次需信任 CA，见下节）→ 自动跳转 `/pair` 配对页，显示 6 位配对码。
2. 本机终端查看并核对手机屏幕上的配对码：

```bash
node scripts/pi-relay.ts devices                 # 待批准（配对码/UA/来源IP/时间）+ 可信设备（最近活跃）
node scripts/pi-relay.ts approve <配对码> --name 我的手机
node scripts/pi-relay.ts deny <配对码>           # 拒绝
node scripts/pi-relay.ts revoke <设备id>         # 吊销：存量连接即时切断，再次访问需重新配对
```

3. 批准后配对页自动获得 `HttpOnly; Secure; SameSite=Lax` Cookie（1 年）并跳转终端页；之后免 token。
4. 配对请求 10 分钟过期；同一 IP 每分钟最多 5 次新建、全局最多 8 个待批准槽位；鉴权失败同 IP 每分钟 >10 次临时 429。
5. 中继重启：已持 Cookie 设备不受影响（列表在本机）；配对中途的设备需重新配对。

## 手机信任 CA（一次性）

1. 手机浏览器访问 `https://<ECS_IP>:<端口>/ca.crt`（首次忽略证书告警）下载根 CA。
2. **核对指纹**与 init 输出一致（防中间人），按系统安装：
   - **iOS**：安装描述文件后，设置→通用→关于本机→证书信任设置 开启**完全信任**（最后一步必须做）。
   - **Android（Chrome）**：设置→安全→加密与凭据→安装证书→CA 证书，用系统信任库；Firefox 用独立库需另装。
   - **鸿蒙 / HarmonyOS**：文件选择器可能不认 `.crt` 后缀——先在文件管理里把 `ca.crt` **重命名为 `ca.cer` 或 `ca.pem`**（内容本就是 PEM 文本，改后缀即可；注意浏览器下载可能追加了 `.txt` 等后缀）。然后 设置→隐私和安全→更多安全设置→加密和凭据→从存储设备安装→**CA 证书**（旧版 EMUI：设置→安全→更多安全设置→加密和凭据→从 SD 卡安装）。安装时的「网络可能被监控」警告是装任何用户 CA 的标准提示。
3. **爆炸半径警示**：信任该根 CA 后，ECS 被攻破可对手机做**任意域名**的 MITM。不用时请删除描述文件/证书。

## 同局域网 redirect（192.168 收窄）

public 模式下，已批准设备经公网入口访问时，若中继检测到浏览器来源 IP 与本机 agent 的 NAT 出口 IP 相同（同一 WiFi），且本机存在 **192.168.0.0/16** 网卡地址（优选默认路由网卡、排除 utun/bridge 等虚拟接口），顶层导航会 302 至 `http://192.168.x.x:7681/?token=<内部token>`——token 自动携带，用户零感知，链路降为局域网直连。

- 仅 `192.168.x.x` 触发；`10.x`/`172.x` 企业网段一律走公网链路。
- `/api/*`、`/ws`、静态资源永不重定向。
- `?stay=1` 强制留在公网入口（CGNAT 共享出口误判时的逃生门）；多主机下同时使聚合列表所有 s.lan=null，逐会话直连也被抑制。

## 回环豁免边界（pi-web）

仅 public 模式由 ensure 设置 `PI_WEB_TRUST_LOOPBACK=1`：pi-web 对 **127.0.0.1/::1** 来源免 token（中继流量经 agent 从回环进入，设备鉴权已在边缘完成）。非回环（局域网直连）token 门禁不变；lan/off 模式回环无 token 仍 401。回环连接只能来自本机进程，外部网络无法伪造 127.0.0.1 源。

## teardown 与轮换

- 本机停用：`webExposure` 改 `"off"`（或 `node scripts/pi-relay.ts stop`）→ web/agent 全停。
- ECS 中继进程需手动停止（off 只停本机；中继对浏览器回 503）；建议手机删除 CA 描述文件。
- 设备丢失：`revoke <id>` 即时切断；怀疑 agentToken 泄露：ECS `init --rotate-tokens` + 本机更新注入值。
- 叶证书 398 天到期前 `renew-cert`（保留 CA，手机无感）。

## curl 配对演练（本地全程，无需 ECS）

```bash
node scripts/pi-relay-server.ts init --listen 127.0.0.1 --port 8443 --ip 127.0.0.1
nohup node scripts/pi-relay-server.ts start >>var/pi-relay/server.log 2>&1 &
# 把 init 输出的 JSON 写入临时配置（勿动真实 settings.local.json），然后：
PI_LOCAL_SETTINGS_PATH=<临时配置> node scripts/pi-relay.ts fetch-ca
PI_LOCAL_SETTINGS_PATH=<临时配置> PI_WEB_PORT=17681 node scripts/pi-relay.ts ensure
CA=var/pi-relay/root-ca.crt; B=https://127.0.0.1:8443
curl -s --cacert $CA $B/relay-status                          # agentOnline:true
curl -s --cacert $CA -c jar.txt $B/pair | grep -o 'pair-id" content="[0-9a-f]*'   # 提取 id
curl -s --cacert $CA $B/pair | grep -o '<div class="code">[0-9]*'                # 提取配对码
PI_LOCAL_SETTINGS_PATH=<临时配置> node scripts/pi-relay.ts approve <配对码>
curl -s --cacert $CA -b jar.txt -c jar.txt "$B/pair-status?id=<id>"              # approved + Set-Cookie
curl -s --cacert $CA -b jar.txt $B/api/sessions                                  # 200
```

演练后把临时配置改 `off` 再 ensure、停中继进程、清理 `var/pi-relay/` 演练产物。

## 安全说明与残余风险

- 未批准设备零能力：无 Cookie 请求在边缘被拒，字节不到达本机；配对页仅暴露 6 位码与 UA。
- 批准人在回路：approve 只在本机 CLI；配对码人机核对防误批。
- 凭据最小化：手机持 secret，本机持哈希，中继内存短暂持 secret（配对期）；ECS 磁盘无设备凭据。
- 吊销即时且不可复活：devices.json 唯一写者 CLI + 锁协议 + 原子写；目录 watch 推送切断存量通道；控制连接任何原因关闭即清名下全部通道。
- 日志纪律：中继/agent 日志不含任何凭据材料（token/secret/Cookie/配对码/URL query）；本机 `var/pi-relay/audit.log` 记录配对/批准/吊销事件供事后核对。
- 残余风险：① 已批准设备即完全终端控制权，丢失须 revoke；② ECS 被攻破可 MITM 已信任 CA 的手机并截取会话明文（中继终止 TLS，非端到端加密；浏览器↔agent E2EE 留演进）；③ 局域网直连 token 走 http 明文（lan 既有语义）；④ 配对槽位可被分布式 IP 占满 10 分钟（私有场景可接受）。

## 故障排查

| 现象 | 处理 |
|---|---|
| agent 日志「agentToken 与中继不一致」后退出 | 核对 settings.local.json 与 ECS init 输出；轮换后两侧同步 |
| 浏览器 503「本机离线」 | `status` 查 agent；`ensure` 重启；查 `var/pi-relay/agent.log` |
| fetch-ca 指纹不符 | 拒绝保存是预期行为；核对 init 输出，谨防中间人 |
| 手机一直转圈「等待批准」 | 本机 `devices` 查看待批准；配对码 10 分钟过期需重新配对 |
| 端口被陌生进程占用 | ensure 中文报错并给出 pid，手动处理后重试（绝不误杀） |
| 手机 Chrome 报 -324（ERR_EMPTY_RESPONSE） | 多半是用了 `http://` 访问 TLS 端口，或漏写 `:端口` 落到 443 的既有服务；确认完整地址为 `https://<IP>:<端口>/` |
| ECS 启动报 EADDRINUSE | `ss -tln` 查占用（含 127.0.0.1 监听）；换空闲端口重跑 `init --port`（保留凭据）再启动 |
| 验证中继是否真的在监听 | 必须同时满足：`ss -tln` 有 `0.0.0.0:<端口>`（不是 127.0.0.1）、`pgrep -f "[p]i-relay-server.ts"` 存活（防自匹配写法）、日志有「中继已启动」；仅 grep 端口号会把别人的回环监听误判为中继 |

日志位置：`var/pi-relay/web.log`、`agent.log`、`audit.log`；ECS 侧 `var/pi-relay/server.log`（nohup 方式）。