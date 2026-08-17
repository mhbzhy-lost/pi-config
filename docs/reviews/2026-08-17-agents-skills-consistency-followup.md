# AGENTS 与 Skill 一致性跟进复审

**日期：** 2026-08-17
**结论：** 8 组中 6 组已关闭、2 组部分关闭；当前实际发现 18 个 Skill，Pi loader 为 0 diagnostics。
**边界：** 以当前工作树为权威；未读取真实 `.env`、`auth.json`、token、cookie、证书或服务器秘密；未调用或运行 Goal Engine，也未运行 Goal Engine 测试、派发子代理、commit、push 或 stage。

## 1. 八组采纳结果

### 1. TDD 触发、最小门禁、豁免与 bug 文档：**已关闭**

- 高风险触发已覆盖 production code、configuration、Skill behavior、feature、bugfix、refactor、behavior change，以及先实现和仅手测症状：`skill-overrides/test-driven-development/SKILL.md:1-3`。
- AGENTS 只保留首次逻辑修改前加载 TDD 的最小路由，流程和豁免留在 Skill：`pi/AGENTS.md:23-33`。
- 三类豁免先判定，Iron Law 与 No exceptions 都明确只约束非豁免变更：`skill-overrides/test-driven-development/SKILL.md:18-22,36,40-50`。
- bug 文档仅适用于 bug/issue/incident，且统一为 `docs/bugs/<日期>-<摘要>.md`；非 bug 变更不得创建伪 bug 文档：`pi/AGENTS.md:23-29`；`skill-overrides/test-driven-development/SKILL.md:24-26`。

### 2. writing-plans / writing-skills / 提问能力：**已关闭**

- `writing-plans` 的宽 description 只含加载触发词，不承诺产出计划；正文仍要求用户明确授权，复杂、多步骤、沉默均不算授权：`skill-overrides/writing-plans/SKILL.md:1-3,12-18`。
- 未授权提交/推送已删除；计划与 Skill 部署都只在用户明确授权时提交：`skill-overrides/writing-plans/SKILL.md:10,154`；`skill-overrides/writing-skills/SKILL.md:668-671`。
- fresh-context 压力测试显式依赖 `subagent-dispatch`，且 RED/GREEN 两侧均写明通过该 Skill 执行：`skill-overrides/writing-skills/SKILL.md:18-20,560-573`。
- 具体“提问工具”假设已改为能力描述并要求结束当前轮次：`skill-overrides/writing-plans/SKILL.md:167-175`；`skill-overrides/using-goal-engine/SKILL.md:67-70`。

### 3. subagent ABI 与依赖声明：**已关闭**

- workspace 调用已使用真实 ABI：`subagent({action:"workspace_status",...})` 与 `subagent({action:"workspace_disposition",...})`，见 `skill-overrides/subagent-dispatch/SKILL.md:12-16`。
- `using-goal-engine` 显式声明 `subagent-dispatch` 为 REQUIRED SUB-SKILL：`skill-overrides/using-goal-engine/SKILL.md:8-10`。
- Playwright 在 headed 手动登录条件下显式依赖 `browser-auth-session`，后者反向把 Playwright 声明为 REQUIRED SUB-SKILL；条件边界闭合且不形成无条件循环：`skill-overrides/playwright/SKILL.md:38-46`；`skill-overrides/browser-auth-session/SKILL.md:10-14`。
- 防复发测试直接核对 ABI、Goal 依赖与 Playwright 条件依赖：`test/skill-dependency-abi.test.mjs:11-38`。

### 4. 配置根变量与 external review：**已关闭**

- Shell 从脚本位置计算仓库根，实际导出 `PI_CONFIG_HOME=<repo>` 与 `PI_CODING_AGENT_DIR=<repo>/pi`：`scripts/pi-shell.zsh:1-7`。
- external review description 与独立/外部/跨模型评审触发一致；正文明确前者是项目自定义仓库根、后者是 Pi 配置子目录：`skill-overrides/external-llm-review/SKILL.md:1-3,38-49`。
- 集成测试直接 source shell 并断言两个路径及 reviewer 路径：`test/external-review-config-home.test.mjs:9-26`；本次该测试通过。

### 5. manage-providers 安全闭环：**部分关闭**

已关闭部分：

- description 与正文把自动处理范围限制为非敏感定义；真实凭据只允许由人类经 `/dev/tty` 无回显输入，不进入 prompt、argv、环境变量或普通 stdin 文本：`.pi/skills/manage-providers/SKILL.md:1-10,29-40`；`.pi/skills/manage-providers/manage-providers.py:236-258`。
- 参数解析错误不回显被拒参数：`.pi/skills/manage-providers/manage-providers.py:18-21`。`auth.json` 使用同目录临时文件、fsync、原子替换并固定 `0600`：`:32-60,102-108`。
- `models.json` 的更新位于锁内并原子写：`:63-99,111-115`。provider 删除要求名称完全匹配，并在 models 更新失败后恢复 auth：`:181-203`；本次纯临时目录故障注入验证回滚成功。
- 六类明确禁止的 header 名与常见凭据形态会被拒绝，header 值错误不回显值：`:15,118-129,149-160`；`test/manage-providers-security.test.mjs:16-71` 的 4 项均通过。

仍未关闭：

1. 敏感 header **名称会被错误消息原样回显**：`.pi/skills/manage-providers/manage-providers.py:156-159,283-285`。临时假值探针得到 `value-redacted: true`、`header-name-echoed: true`，未满足“名和值均不回显”。
2. `remove-model` 没有 `--confirm`，与“删除操作要求名称匹配确认”的修复目标不完整：`.pi/skills/manage-providers/SKILL.md:29-34`；`.pi/skills/manage-providers/manage-providers.py:222-233,269-275`。现有测试只覆盖 provider 删除确认：`test/manage-providers-security.test.mjs:60-71`。

### 6. 清单删除、自动发现与个人 Skill：**部分关闭**

已关闭部分：

- 当前工作树中 `skills.list` 与 `skills.local.list` 都不存在；防复发测试明确断言二者缺失：`test/skill-list.test.mjs:11-15`。
- 共享 Skill 集合由 `skill-overrides` 非隐藏直接子目录自动枚举、排序并逐项 fail-closed 校验：`scripts/lib/skill-whitelist.mjs:64-96`；自动新增目录测试见 `test/skill-list.test.mjs:17-35,71-75`。
- sync 与 Doctor 都消费 `discoverManagedSkills()`，生产代码不再维护固定名称数组：`scripts/sync-skills.mjs:6-13`；`scripts/doctor.mjs:10,166-190`。
- Extension 独立扫描 `~/.agents/skills` 和项目 `.pi/skills` / `.agents/skills`：`scripts/lib/skill-whitelist-extension.mjs:30-52`。个人 Skill 继续直接位于 `~/.agents/skills`，sync 只警告指向本仓的陈旧软链，不改个人目录：`skill-overrides/README.md:3-5`；`scripts/sync-skills.mjs:45-58`。

仍未关闭：

1. 活动 Doctor 测试仍复制旧 10 项固定名称；`inspectConfiguration accepts additional valid local skills` 还保留失效的 global/local 分类，计算 `issues` 后没有断言：`test/doctor.test.mjs:165-172,213-231`。生产发现已自动化，但“活动测试不维护固定清单”尚未完全兑现。
2. 三个核心 Skill 目录仍为未跟踪文件，`git ls-files` 无输出而 `git status` 显示 `??`：`skill-overrides/test-driven-development/`、`skill-overrides/writing-plans/`、`skill-overrides/writing-skills/`。当前机器能自动发现，fresh clone 仍会缺少 TDD、计划和 Skill 编写依赖；这也是原审查中尚未关闭的发布阻断项。

### 7. settings 缺失 package：**已关闭**

- 缺失的 `../../.r2c/integrations/pi-adapter` 已从 packages 删除；当前只保留隔离资源的 `npm:pi-subagents@0.45.2`：`pi/settings.json:9-17`。
- default provider/model 能在 enabledModels 中找到，DeepSeek executor override 也指向已启用模型：`pi/settings.json:6-7,44-53`。
- 防复发测试同时验证缺失 adapter 不存在、默认模型与 pi-subagents 保留：`test/pi-adapter-settings.test.mjs:7-29`；本次 2 项通过。

### 8. description 重新评级：**已关闭**

- 对当前 18 个实际可发现 Skill 的 line 3 description 逐项重评；当前**需改进/高风险 description：无**。仓库共享 10 项见 `skill-overrides/*/SKILL.md:3`，项目 3 项见 `.pi/skills/*/SKILL.md:3`，个人 5 项见 `~/.agents/skills/*/SKILL.md:3`。
- `writing-plans` 的“计划/规划、多步骤实施、DAG、Wave”是宽加载触发，不是正文授权；description 不含“产出/创建/编写计划”承诺，正文门禁仍位于任何计划分析与写入前：`skill-overrides/writing-plans/SKILL.md:1-3,12-24`；`test/writing-skill-workflow-policy.test.mjs:15-25`。
- 先前高风险项 TDD、Playwright、manage-providers 已覆盖所需触发或安全范围：`skill-overrides/test-driven-development/SKILL.md:3`；`skill-overrides/playwright/SKILL.md:3`；`.pi/skills/manage-providers/SKILL.md:3`。external review 的触发与正文路径职责也一致：`skill-overrides/external-llm-review/SKILL.md:3,38-40`。

## 2. 实际发现与依赖核验

- `resources_discover` 返回 18 个路径；以 Pi `loadSkills({includeDefaults:false})` 加载后为 **18 Skills / 0 diagnostics / 0 名称重复**。
- 构成仍为 10 个本仓共享软链、5 个独立个人目录、3 个项目 Skill。仅读取个人 Skill frontmatter 以评级 description，未读取其服务器操作正文或任何服务器秘密。
- 名称依赖均可在这 18 项中解析：`using-goal-engine → subagent-dispatch`、`playwright ↔ browser-auth-session`、`writing-skills → test-driven-development/subagent-dispatch`。
- 当前运行时依赖闭合；fresh clone 依赖因三个核心目录未纳入 Git 而未闭合，见 §1.6。

## 3. 新发现与仍存风险

1. **发布阻断：核心 Skill 未跟踪。** 当前自动发现成功只证明本机工作树可用，不能证明 clone 后可用；三个核心目录仍是 `??`。
2. **安全契约缺口：header 名回显。** 值已脱敏，但脚本错误消息仍回显被拒绝的敏感名称；与本次验收文字不完全一致。
3. **删除契约缺口：model 删除无确认。** provider 有确认和跨文件回滚，model 删除没有等价确认入口。
4. **测试漂移：Doctor 测试残留固定清单且有空断言测试。** 不影响当前生产发现，但会降低后续回归可信度。

## 4. Must fix / Should fix / No change

### Must fix

- **[核心 Skill 发布完整性]**：将 TDD、writing-plans、writing-skills 完整纳入 Git，并保留 `skills.list` 删除。
- **推荐**：合入前用 `git ls-files` 验证三个目录均有文件，因为 fresh clone 只接收 Git 管理内容。
- **不选原因**：当前 18/0 只是本机未跟踪文件参与发现的快照。
- **选错代价**：换机或 clone 时暴露，TDD/计划/Skill 编写依赖同时断裂，修复代价高。

- **[manage-providers 删除与回显契约]**：禁止错误消息回显敏感 header 名，并给 `remove-model` 增加名称匹配确认及测试。
- **推荐**：统一输出固定脱敏错误；所有删除入口执行同一确认规则，因为当前实现只保护 provider。
- **不选原因**：现状没有完整满足本次明确验收文字。
- **选错代价**：错误日志或误删 model 时暴露，修复代价中。

### Should fix

- **[Doctor 测试去固定清单]**：用最小动态 fixture 替代旧 10 项数组，并让 additional-skills 测试真正断言结果。
- **推荐**：复用 `addSkill()` / `discoverManagedSkills()` 构造期望，因为生产代码已经没有 global/local 固定分类。
- **不选原因**：保留空断言测试会制造虚假通过。
- **选错代价**：后续发现逻辑回归时暴露，修复代价低。

### No change

- **[已闭合规则与依赖]**：保持 TDD 最小路由、writing-plans 宽加载/正文授权分层、真实 subagent ABI、显式依赖、配置根导出与 adapter 删除。
- **推荐**：继续由现有定向测试保护，因为职责边界已清楚且 39 项定向测试通过。
- **不选原因**：再次把完整流程复制回 AGENTS 或把宽加载误改成正文授权会重建原冲突。
- **选错代价**：规则再次漂移时暴露，修复代价中。

## 5. 验证记录

| 命令/检查 | 结果 |
|---|---|
| Pi Extension `resources_discover` + `loadSkills(includeDefaults:false)` | 18 paths、18 Skills、0 diagnostics |
| `node --test`：TDD、writing、依赖 ABI、external config、manage security、Skill 自动发现、settings、pi-shell、loader 共 11 个文件 | 39/39 通过 |
| manage-providers 临时目录故障注入 | models 写失败后 auth 恢复，models 定义保持 |
| manage-providers 临时假 header 探针 | 值未回显；名称仍回显，形成 finding |
| `git ls-files` / `git status --short` / `git diff --cached --name-only` | 三个核心 Skill 未跟踪；本次报告写入前后均无 staged 文件 |
| 显式 `cd` / `git -C` 的只读 diff 尝试 | 被安全门禁拒绝；随后在已处于仓库根的当前目录完成同类只读检查，无副作用 |

未运行 `npm test`、Doctor CLI 或 `test/doctor.test.mjs`，因为它们会加载或覆盖 Goal Engine 验证面；本次按要求只做定向非 Goal 验证。

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "§1 对八组逐项给出已关闭/部分关闭及文件行号；结论为 6 组已关闭、2 组部分关闭。"
    },
    {
      "id": "criterion-2",
      "status": "satisfied",
      "evidence": "§1.8 对 18 个当前 description 逐项重评为无剩余需改进/高风险项，并明确 writing-plans 宽触发只负责加载、正文继续授权门禁。"
    },
    {
      "id": "criterion-3",
      "status": "satisfied",
      "evidence": "§2 记录 Extension + Pi loader 的 18 Skills/0 diagnostics，并核验 using-goal、Playwright/browser-auth、writing-skills 的依赖链；未读取真实凭据。"
    },
    {
      "id": "criterion-4",
      "status": "satisfied",
      "evidence": "本次唯一写入为 docs/reviews/2026-08-17-agents-skills-consistency-followup.md；未修改代码、Skill、AGENTS、测试或配置。"
    },
    {
      "id": "criterion-5",
      "status": "satisfied",
      "evidence": "未调用 Goal Engine，未运行 Goal Engine 测试；定向测试列表不含 goal-engine 测试。"
    }
  ],
  "changedFiles": [
    "docs/reviews/2026-08-17-agents-skills-consistency-followup.md"
  ],
  "testsAddedOrUpdated": [],
  "commandsRun": [
    {
      "command": "node --input-type=module（resources_discover + loadSkills includeDefaults:false）",
      "result": "passed",
      "summary": "18 个路径、18 个 Skill、0 diagnostics。"
    },
    {
      "command": "node --test test/tdd-routing-policy.test.mjs test/writing-skill-workflow-policy.test.mjs test/writing-plans-authorization.test.mjs test/skill-dependency-abi.test.mjs test/external-review-config-home.test.mjs test/manage-providers-security.test.mjs test/skill-list.test.mjs test/pi-adapter-settings.test.mjs test/pi-shell.test.mjs test/core-skills-local.test.mjs test/skill-whitelist-extension.test.mjs",
      "result": "passed",
      "summary": "39/39 通过。"
    },
    {
      "command": "python3 临时目录 manage-providers 回滚故障注入",
      "result": "passed",
      "summary": "auth 已恢复，models 定义未变化。"
    },
    {
      "command": "python3 临时假 header 脱敏探针",
      "result": "passed",
      "summary": "确认值不回显，但敏感 header 名仍回显。"
    },
    {
      "command": "git status --short；git ls-files；git diff --cached --name-only",
      "result": "passed",
      "summary": "确认三个核心 Skill 未跟踪；无 staged 文件。"
    },
    {
      "command": "带显式 cd / git -C 的只读 diff 尝试",
      "result": "failed",
      "summary": "被安全门禁拒绝，未产生副作用；改用当前仓库根执行只读检查。"
    }
  ],
  "validationOutput": [
    "实际 Skill：18；Pi loader diagnostics：0。",
    "定向非 Goal 测试：39 passed，0 failed。",
    "manage-providers 回滚临时验证通过。",
    "敏感 header 值不回显，但名称仍回显。",
    "未运行 Goal Engine 或其测试。"
  ],
  "residualRisks": [
    "三个核心 Skill 目录未被 Git 跟踪，fresh clone 依赖仍断裂。",
    "manage-providers 回显被拒绝的敏感 header 名。",
    "remove-model 没有名称匹配确认。",
    "Doctor 活动测试仍残留固定 Skill 数组，且 additional-skills 用例没有断言。"
  ],
  "noStagedFiles": true,
  "diffSummary": "仅新增中文跟进复审报告；未修改其他文件。",
  "reviewFindings": [
    "blocker: skill-overrides/test-driven-development、writing-plans、writing-skills - 仍未纳入 Git，fresh clone 缺失核心 Skill。",
    "important: .pi/skills/manage-providers/manage-providers.py:156-159 - 敏感 header 名仍被错误消息回显。",
    "important: .pi/skills/manage-providers/manage-providers.py:222-233,274-275 - remove-model 无确认入口。",
    "minor: test/doctor.test.mjs:165-172,213-231 - 固定清单残留，且 additional-skills 测试无断言。"
  ],
  "manualNotes": "只读取 manage-providers 脚本和个人 Skill frontmatter；未读取真实 auth.json、.env 或任何凭据内容。"
}
```
