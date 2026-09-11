# Token Switch DogFooding 上下文窗口被档位策略值压低

## 症状

`token-switcher/Qwen3.8-Max-DogFooding` 在 `pi/models.json` 中的 `contextWindow` 为 `200000`，导致 Pi 自动压缩阈值为：

```
200000 - 16384 (默认 reserveTokens) = 183616
```

而该模型实测可接受的输入上限为 **983616 tokens**。Pi 在真实容量的约 **20.3%** 处就开始压缩，用户损失约 80% 可用上下文。

## 数据来源分类

按 `AGENTS.md`「缺陷数据来源分类门禁」，本异常属于 **分类 1：预期 production 数据未被正确处理**。

证据：

- **实际入口**：`https://token-hub.alibaba-inc.com/portal/token-switch/providers/available`（Token Switch 认证后的 managed catalog sync 端点，POST）。这是合法的平台公开入口，不是手工拼接或绕过入口的注入。
- **权威身份**：`providers` 表中 `app_type='opencode'`、`name='Qwen3.8-Max-DogFooding'` 行，其 `meta` 列 JSON 路径 `$.managedCatalog.serverModelId` 为 `mode-24b28efaa85443a5bf7eac4de15190f5`，与 `providers.id` 一致。
- **事件/资源顺序**：`~/.token-switch/logs/token-switch.log:110` 记录认证后 `managed catalog sync ... added=18`，第 111 行记录后续 sync 为 unchanged。数值由 sync 写入，非手工录入。
- **与 production 事实的差异**：上游 catalog 字段 `contextWindowSize` 声明 `200000`，但服务端实际输入上限为 `983616`（上游错误消息 `Range of input length should be [1, 983616]`）。即 catalog 声明值与服务端强制值不一致。

不属于分类 2（测试制造数据）：数值来自真实上游 catalog，测试 fixture 只是复刻该形态。
不属于分类 3（来源未证实）：provenance 已由 DB 字段与实际转发日志双重核验。

## 首个偏离点

`pi/scripts/sync-token-switch-to-pi.ts` 的 `modelFromConfig()` 将上游 `limit.context` 直接写入 Pi 的 `contextWindow`：

```ts
contextWindow: limit.context
```

该语句隐含的设计假设是：**上游 `limit.context` 等于模型真实上下文能力**。这个假设是错的。

## 完整生成调用链

```
token-hub catalog (contextWindowSize: 200000)
  └─ POST /portal/token-switch/providers/available
       └─ Token Switch managed catalog sync
            └─ ~/.token-switch/token-switch.db
                 providers.meta.$.managedCatalog.contextWindow = 200000
                 └─ 写入 OpenCode live config ~/.config/opencode/opencode.json
                      provider.*.models.*.limit.context = 200000
                      └─ pi/scripts/sync-token-switch-to-pi.ts:62
                           modelFromConfig() → contextWindow: limit.context
                           └─ pi/models.json
                                token-switcher/Qwen3.8-Max-DogFooding.contextWindow = 200000
                                └─ Pi compaction.js:160
                                     contextTokens > contextWindow - reserveTokens
                                     → 阈值 183616
```

四层搬运，每一层都忠实传递，无一处篡改。偏离发生在最后一层的**语义误用**。

## 根因

`contextWindowSize` 是 **Token Hub 的档位策略值**，不是模型物理能力声明。

支撑证据：四个语义完全不同的 mode 恰好同值，只有旗舰档不同：

| mode | name | contextWindow | multiplier | description 摘要 |
|---|---|---:|---:|---|
| `mode-8c1e23a5…` | 基础 | 200000 | — | — |
| `mode-d61b5feee…` | Auto | 200000 | — | — |
| `mode-8a8dd030…` | 高级 | 200000 | 0.6 | 高可信模型，高性价比 |
| `mode-24b28efa…` | Qwen3.8-Max-DogFooding | 200000 | 0.0 | 高可信模型，内测，请错峰使用 |
| `mode-d98246c0…` | 旗舰 | 1000000 | 1.6 | 外部模型，multimodal |

若该字段为各模型物理能力，四个不同模型不可能精确同值。DogFooding 的 `multiplier: 0.0`（免费内测）与「请错峰使用」进一步表明 200000 是配套的资源管控值。

## 实测证据

请求参数要点：请求体 `model` 必须是 mode ID `mode-24b28efaa85443a5bf7eac4de15190f5`，而非可读名。发可读名会得到误导性的 `429 insufficient_quota / quota exhausted`。

| 目标 token | 字符数 | HTTP | 服务端 `usage.prompt_tokens` |
|---|---:|---:|---:|
| 190k（估） | 760,000 | 200 | 108,623 |
| 250k（估） | 1,000,000 | 200 | 142,910 |
| 500k（估） | 2,000,000 | 200 | 285,767 |
| 900k（估） | 3,600,000 | 200 | 514,339 |
| 校准后 ~900k | 6,300,000 | 200 | 900,053 |
| 950k | 6,650,000 | 200 | 950,052 |
| 1,000,000 | 7,000,000 | **400** | — |

400 响应携带上游业务错误：

```
Range of input length should be [1, 983616]
```

字符→token 校准：重复英文填充实测约 **7 chars/token**，不是常用的 4 chars/token。

`983616 = 1000000 - 16384`，推测平台标称 1M 窗口、预留 16384 给输出。这与旗舰档声明 `1000000` 一致。

## 排查过程中被推翻的错误结论

记录以免重犯：

1. **「200k 是 OpenCode 手填的客户端限额」** —— 错。它由 managed catalog sync 从上游写入。
2. **「429 是配额耗尽，无法实测」** —— 错。429 是请求体 `model` 参数用了可读名导致的路由错误，被上游包装成 `insufficient_quota`。配额实际正常。
3. **「旗舰档 1000000 可推断 DogFooding 支持 1M」** —— 无效推理。三个 mode 是不同模型（description 明确区分高可信内测 / 高可信性价比 / 外部模型），能力面也不同（旗舰 multimodal，DogFooding 仅 text）。
4. **「tokenhub-models skill 不存在」** —— 误判。实际位于 `~/.agents/skills/tokenhub-models/`，与会话注入的 `.pi/skills/` location 不一致。
5. **「上游是 tokenhub」最初未经核验** —— 结论实质正确，但当时只是转述二手信息，未核验 provenance。后续已由 `providers.meta.$.managedCatalog.baseUrl` 与实际转发日志双重证实。

## 修复

在 `pi/scripts/sync-token-switch-to-pi.ts` 引入按上游 `name` 键控的 `contextWindow` 覆盖表，覆盖值优先、回退到 `limit.context`：

```ts
const contextWindowOverrides: Record<string, number> = {
  "Qwen3.8-Max-DogFooding": 916384
};
```

取值推导：期望压缩阈值 `900000` + Pi 默认 `reserveTokens` `16384` = `916384`。相对上游硬上限 `983616` 保留 `83616` 余量。

选择固定值而非 `Math.max` floor 语义：固定值保证阈值恒为 900000，可预测；floor 语义在上游将来抬高 catalog 值时会漂移，若上游改为 `1000000`，阈值将变为 `983616`，正好贴着真实上限而无余量。

不采用的替代方案：

- **`modelOverrides`** —— 能覆盖 custom model 的 `contextWindow`（`provider-composer.js:290`），但同步脚本第 151 行以新生成的 provider 对象整体覆盖旧对象，生成对象不含 `modelOverrides`，下次同步即被删除。
- **改全局 `compaction.reserveTokens`** —— 影响所有模型，并把普通 compaction summary 输出上限从 `min(13107, maxTokens)` 抬高。
- **手改 `pi/models.json`** —— 同步产物，下次运行被覆盖。

Pi 的 `compaction` 配置只有 `enabled`、`reserveTokens`、`keepRecentTokens` 三个字段，不存在专门的阈值或触发比例配置项，因此只能通过 `contextWindow` 反推。

## 测试

`pi/tests/token-switch-sync.test.mjs` 新增用例 `applies the measured context window override only to Qwen3.8-Max-DogFooding`：

- 断言 DogFooding 生成值为 `916384`（手工推导的字面量，不复用被测代码逻辑）
- 断言同批次未被覆盖的 `高级` 仍采用 source 的 `limit.context = 200000`，证明覆盖按 name 精确作用域
- 连续运行两次同步并断言输出完全一致，证明覆盖能跨同步保留

RED 已观察：`200000 !== 916384`，失败原因是覆盖行为缺失，其余 20 项用例通过。

运行方式：`node --test pi/tests/token-switch-sync.test.mjs`

## 遗留问题

1. 根 `npm test` 的 glob 是 `test/**/*.test.mjs`，不包含 `pi/tests/`，该测试不在默认路径内，只能 focused 运行。
2. `tsconfig.json` 未包含 `pi/scripts/*.ts`，`tsc --noEmit` 不静态覆盖该同步脚本。
3. 会话注入的 `tokenhub-models` skill location 为 `/Users/leshi.zhy/pi-config/.pi/skills/tokenhub-models/SKILL.md`，实际文件在 `/Users/leshi.zhy/.agents/skills/tokenhub-models/SKILL.md`。注入 location 与安装位置不一致，会导致基于 location 的存在性判断误判。
4. `tokenhub-models` skill 的示例脚本假设 `/v1/models` 响应含 `name` 字段，实际响应无该字段，原样执行会 `KeyError`。
5. `models.json` 中该 model 声明 `reasoning: false`，但服务端实测在 `max_tokens: 8` 下返回 91 completion tokens（其中 79 reasoning）。经确认 Qwen 系列无法调节思考强度（`compat.supportsReasoningEffort: false`，本地 Qwen provider 用二态 `thinkingLevelMap` 表达），故 `reasoning: false` 属正确配置，不修改。残留影响是输出预算核算略有偏差，可接受。
6. 上游 catalog 的 `contextWindowSize` 与服务端强制上限不一致是平台侧问题。若 Token Hub 修正 catalog，应删除本地覆盖表。
