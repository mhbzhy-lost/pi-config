/**
 * `customPrompt` / `forceSystemPrompt` 完整替换默认禁止策略测试。
 *
 * 用户授权范围：「测试集中保留检查，确保 customPrompt/forceSystemPrompt 默认不在本仓使用，
 * 例外白名单且逻辑确保 promptGuidelines 保留」。本文件**只新增测试与测试自有 helper**，
 * 不改生产代码、不改 rules/skills、不改上游 vendored 包。
 *
 * 证据边界（如实声明，不宣称形式验证）：
 * - 行为矩阵用**真实 SDK `ExtensionRunner.emitBeforeAgentStart`** 编排**真实生产 handler**
 *   （`src/agents-global/index.ts`、`src/agents-shared/index.ts` 的 factory 直接安装），
 *   canary 走 SDK 正规 `toolGuidelines` / `promptGuidelines` 入口，由真实 `buildRules` 渲染。
 *   不启动 Host、不联网、不调用任何 provider/model。
 * - 静态扫描只覆盖仓库自有生产 TS/JS 的字面写入、可判类的计算键写入与 flag 字面量语境；
 *   `eval` / Proxy / 跨模块间接别名 / vendored node_modules / 真实用户 settings
 *   （`subagents.agentOverrides.*.systemPrompt`）在静态能力之外，由记录文档标注为扫描外风险。
 * - 不读取真实用户配置：settings.json / models.json / auth.json / trust.json / run-history /
 *   sessions / logs / authority / state 一律不打开；`pi/` 只做 depth-1 **文件名**枚举。
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  GLOBAL_BLOCK_CLOSE,
  GLOBAL_BLOCK_OPEN,
  GUIDELINE_CANARY,
  REPO_ROOT,
  SHARED_BLOCK_OPEN,
  SHARED_CHILD_BLOCK_OPEN,
  classifyProfileSystemPromptMode,
  classifySystemPromptMarkdownName,
  createCanaryOptions,
  createExtensionRecorder,
  inspectAgentProfiles,
  installAgentsGlobal,
  installAgentsShared,
  probeSystemPromptMarkdown,
  runBeforeAgentStart,
  runInput,
  scanPromptOverridePolicy,
  scanPromptOverridePolicyInDirectory,
} from "./helpers/system-prompt-fixture.mjs";

/* -------------------------------------------------------------------------- */
/* 策略常量：扫描范围、精确 site 白名单、DTO 豁免、profile 名册                   */
/* -------------------------------------------------------------------------- */

/**
 * 显式枚举的自有生产扫描根（不做 glob 泛化）。
 * `packages/pi-subagents-enhanced/child-extensions` 单列，child 入口不得漏扫。
 */
const SCAN_ROOTS = [
  "src",
  "pi/extensions",
  "packages/pi-subagents-enhanced/src",
  "packages/pi-subagents-enhanced/extensions",
  "packages/pi-subagents-enhanced/child-extensions",
  "scripts",
];

/** 扫描必须真实覆盖到的哨兵文件：证明各 root（含 child-extensions / scripts）没被静默跳过。 */
const REQUIRED_SCANNED_FILES = [
  "src/agents-global/index.ts",
  "src/agents-shared/index.ts",
  "src/session-owner/contract.ts",
  "pi/extensions/agents-global.ts",
  "pi/extensions/agents-shared.ts",
  "packages/pi-subagents-enhanced/src/compat/pi-subagents-0.75.ts",
  "packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts",
  "packages/pi-subagents-enhanced/extensions/subagent-runtime.ts",
  "packages/pi-subagents-enhanced/child-extensions/root-session-owner.ts",
  "packages/pi-subagents-enhanced/child-extensions/acceptance-evidence.ts",
  "packages/pi-subagents-enhanced/child-extensions/integration-queue.ts",
  "scripts/assert-session-tool-policy.ts",
];

/** 扫描根内的非源码文本文件（launcher / 配置）走字面探针，同样不得漏。 */
const REQUIRED_TEXT_PROBED_FILES = [
  "scripts/pi-launcher.zsh",
  "scripts/pi-shell.zsh",
  "pi/extensions/subagent/config.json",
];

/**
 * 自有生产 `before_agent_start` 完整替换 site 白名单。
 *
 * 定位不用易漂移的行号，而用「精确 path + enclosing 具名函数链 + handler 内序号 +
 * 结构化表达式 shape 指纹」四元组；任何一项漂移都会让测试红。
 * 每条必须挂**已执行的 preservation test id**，该测试用真实生产 handler + 真实
 * `ExtensionRunner` 证明 guideline canary 保留；behavior 红 → 白名单条目在本文件内即失效。
 */
const REPLACEMENT_WHITELIST = [
  {
    path: "src/agents-global/index.ts",
    enclosing: "function createAgentsGlobalExtension > arrow",
    ordinal: 1,
    shape: "id(base).slice(num,id(ownBlock).start)+id(fresh)+id(base).slice(id(ownBlock).end)",
    reason:
      "GLOBAL 自有块最小替换分支：base 中已存在 <pi_global_instructions> 且本轮快照不同时，只把 open..close 区间换成新块，区间外逐字保留（不 strip 其它 feature 的 tag、不吞 <rules> guidelines）。",
    preservationTest: "behavior#global-block-replace-preserves-base-and-canary",
    supportingTests: ["behavior#global-block-replace-keeps-foreign-block-outside-own-region"],
  },
  {
    path: "src/agents-global/index.ts",
    enclosing: "function createAgentsGlobalExtension > arrow",
    ordinal: 2,
    shape: "[id(base),id(globalBlock)(id(loaded).instructions)].join(str)",
    reason:
      "GLOBAL 纯追加分支：`[base, globalBlock(...)].join(\"\\n\\n\")`，base 是 SDK 当轮已渲染的完整 prompt（含 <rules> 里的 toolGuidelines/promptGuidelines），只在尾部追加自有块。",
    preservationTest: "behavior#global-append-preserves-base-and-canary",
    supportingTests: ["behavior#global-then-shared-order-preserves-canary"],
  },
  {
    path: "src/agents-shared/index.ts",
    enclosing: "function createAgentsSharedExtension > arrow",
    ordinal: 1,
    shape: "[id(base),...id(additions)].join(str)",
    reason:
      "SHARED 纯追加分支：`[base, ...additions].join(\"\\n\\n\")`，additions 只可能是共享块与 child 边界块，main/child 两种 scope 都在 base 之后追加，不重写 base。",
    preservationTest: "behavior#shared-append-preserves-base-and-canary",
    supportingTests: [
      "behavior#shared-child-append-preserves-base-and-adds-boundaries",
      "behavior#shared-then-global-order-preserves-canary",
    ],
  },
];

/**
 * `systemPrompt` 数据 DTO 精确豁免（不是目录级忽略）。
 * 该 site 是 admission 数据对象：把 profile frontmatter body 投影给上游 runtime 的
 * agent 定义结构，不写 SDK `systemPromptOptions`、不是 before_agent_start handler 返回体。
 */
const DATA_DTO_SITES = [
  {
    path: "packages/pi-subagents-enhanced/src/compat/pi-subagents-0.75.ts",
    enclosing: "function parseFrontmatter",
    shape: "id(body)",
    reason:
      "BuiltinAdmissionAgent 数据 DTO：`systemPrompt: body` 是 profile 正文的结构化投影，交给上游 admission/runtime 决定 append 还是 replace；本仓 profile 一律 systemPromptMode: append（见 policy#profile-frontmatter-requires-explicit-append），此处不写 SDK options、不构成替换入口。",
  },
];

/** 仓库自有 profile 名册：新增/改名 profile 必须显式更新本清单并重新接受策略审查。 */
const PROFILE_ROSTER = ["delegate.md", "executor.md", "reviewer.md"];

/** 期望的 site 计数：静态事实一旦漂移（新增替换入口、DTO、读访问）测试即红，逼迫显式复核。 */
const EXPECTED_SITE_COUNTS = Object.freeze({
  "handler-return-replacement": 3,
  "data-dto": 1,
  "type-declaration": 2,
  "read-access": 4,
  "flag-classifier-literal": 2,
  "append-flag-literal": 2,
});

const GLOBAL_FIXTURE = "# PI AGENTS GLOBAL 正文\n- 全局规则一\n- 全局规则二";
const SHARED_FIXTURE = "# PI AGENTS SHARED 正文\n- 共享规则一\n- 共享规则二";
const FOREIGN_BLOCK = '<foreign_feature_tag source="other-feature">\n外部 feature 的自有内容\n</foreign_feature_tag>';

/* -------------------------------------------------------------------------- */
/* preservation test 注册表：白名单 id 必须真的被执行过                          */
/* -------------------------------------------------------------------------- */

const executedTests = new Set();
/** 只有被白名单引用的 preservation test 才进这个集合；用无关伪 handler 让绿会被 orphan 断言抓住。 */
const executedPreservationTests = new Set();

function behaviorTest(id, fn) {
  test(id, async () => {
    await fn();
    executedTests.add(id);
  });
}

/** 白名单 preservation test：真实生产 handler + 真实 ExtensionRunner，且被 policy#... 守卫核对执行事实。 */
function preservationTest(id, fn) {
  test(id, async () => {
    await fn();
    executedTests.add(id);
    executedPreservationTests.add(id);
  });
}

function assertCanaryRetained(prompt, label) {
  assert.match(prompt, new RegExp(`- ${GUIDELINE_CANARY.tool}`), `${label}: toolGuidelines canary 必须仍在 <rules> 中`);
  assert.match(prompt, new RegExp(`- ${GUIDELINE_CANARY.prompt}`), `${label}: promptGuidelines canary 必须仍在 <rules> 中`);
  assert.match(prompt, /<rules>/, `${label}: <rules> section 必须仍被渲染（未被 customPrompt/force 降级）`);
  assert.match(prompt, /<docs>/, `${label}: <docs> section 必须仍被渲染`);
}

/* -------------------------------------------------------------------------- */
/* 行为矩阵：真实 ExtensionRunner + 真实生产 handler                             */
/* -------------------------------------------------------------------------- */

behaviorTest("behavior#default-prompt-keeps-guideline-canary", async () => {
  const run = await runBeforeAgentStart({ extensions: [] });
  assert.equal(run.errors.length, 0, "默认路径不得产生扩展错误");
  assert.equal(run.systemPromptOptions.forceSystemPrompt, undefined, "无 handler 时不得进入 force 分支");
  assert.equal(run.systemPromptOptions.customPrompt, undefined, "无 handler 时不得存在 customPrompt");
  assert.equal(run.base, run.final, "无 handler 时 base 必须逐字不动");
  assertCanaryRetained(run.base, "默认 prompt");
});

preservationTest("behavior#global-append-preserves-base-and-canary", async () => {
  const global = installAgentsGlobal({ instructions: GLOBAL_FIXTURE });
  const run = await runBeforeAgentStart({ extensions: [global.extension] });
  assert.equal(run.errors.length, 0);
  // base 逐字保留为前缀：这是「纯追加」而不是「重排/截断后拼接」的可验证形式。
  assert.ok(run.final.startsWith(run.base), "GLOBAL 追加后 base 必须逐字保留为前缀");
  assert.ok(run.final.includes(GLOBAL_BLOCK_OPEN), "GLOBAL 自有块必须存在");
  assert.ok(run.final.includes(GLOBAL_FIXTURE), "GLOBAL 正文必须注入");
  assert.equal(run.final.slice(run.base.length).trimStart().startsWith("<pi_global_instructions"), true);
  assertCanaryRetained(run.final, "GLOBAL 追加");
  assert.equal(run.systemPromptOptions.customPrompt, undefined, "GLOBAL 不得引入 customPrompt");
});

preservationTest("behavior#global-block-replace-preserves-base-and-canary", async () => {
  // 双重加载场景：两个**真实** GLOBAL factory 实例，快照内容不同。
  // 第一个实例走纯追加分支写入 v1 块，第二个实例命中「自有块已存在且内容不同」的最小替换分支。
  const first = installAgentsGlobal({ extensionPath: "<src/agents-global/index.ts#first>", instructions: "GLOBAL v1 正文" });
  const second = installAgentsGlobal({ extensionPath: "<src/agents-global/index.ts#second>", instructions: "GLOBAL v2 正文（已更新）" });
  // 替换分支消费 input 门禁捕获的 pending 快照；不绕过正常事件顺序。
  const input = await runInput({ extensions: [first.extension, second.extension] });
  assert.deepEqual(input.result, { action: "continue" });
  const run = await runBeforeAgentStart({ extensions: [first.extension, second.extension] });
  assert.equal(run.errors.length, 0);
  assert.ok(run.final.includes("GLOBAL v2 正文（已更新）"), "最小替换分支必须写入本轮新快照");
  assert.ok(!run.final.includes("GLOBAL v1 正文"), "旧的自有块区间必须被替换而不是并列堆叠");
  assert.equal(
    run.final.split(GLOBAL_BLOCK_OPEN).length - 1,
    1,
    "自有块必须只有一个（去重语义不被替换分支破坏）",
  );
  assertCanaryRetained(run.final, "GLOBAL 自有块最小替换");
});

preservationTest("behavior#global-block-replace-keeps-foreign-block-outside-own-region", async () => {
  // 关键回归：替换分支只能动 open..close 区间，块外内容（含 guidelines 与其它 feature 的 tag）
  // 必须逐字保留。用一个已经含 base + 外部 tag + GLOBAL v1 块的 prompt 作为第二轮起点。
  const first = installAgentsGlobal({ extensionPath: "<src/agents-global/index.ts#first>", instructions: "GLOBAL v1 正文" });
  const seeded = await runBeforeAgentStart({ extensions: [first.extension] });
  const seededBase = `${seeded.final}\n\n${FOREIGN_BLOCK}`;

  const second = installAgentsGlobal({ extensionPath: "<src/agents-global/index.ts#second>", instructions: "GLOBAL v2 正文" });
  // 第二个实例必须先经真实 runner 的 input 门禁拿到本轮快照，否则生产逻辑按设计不动 base。
  const seededInput = await runInput({ extensions: [second.extension] });
  assert.deepEqual(seededInput.result, { action: "continue" });
  const probeBefore = createExtensionRecorder("<probe:seeded-base>");
  let observedBase;
  probeBefore.extension.handlers.set("before_agent_start", [
    async (event) => {
      observedBase = event.systemPrompt;
      return undefined;
    },
  ]);
  const run = await runBeforeAgentStart({
    extensions: [probeBefore.extension, second.extension],
    // 把上一轮结果 + 外部 tag 作为本轮起点（真实 Host 的 forced prompt 续轮形状）。
    options: createCanaryOptions({ extra: { forceSystemPrompt: seededBase } }),
  });
  assert.equal(run.errors.length, 0);
  assert.equal(observedBase, seededBase, "handler 必须看到逐字的既有 base");

  const openIndex = run.final.indexOf(GLOBAL_BLOCK_OPEN);
  const closeIndex = run.final.indexOf(GLOBAL_BLOCK_CLOSE, openIndex);
  assert.ok(openIndex >= 0 && closeIndex > openIndex, "自有块必须仍然完整");
  const beforeOwn = run.final.slice(0, openIndex);
  const afterOwn = run.final.slice(closeIndex + GLOBAL_BLOCK_CLOSE.length);
  assert.equal(beforeOwn, seededBase.slice(0, seededBase.indexOf(GLOBAL_BLOCK_OPEN)), "自有块之前的内容必须逐字保留");
  assert.equal(afterOwn, seededBase.slice(seededBase.indexOf(GLOBAL_BLOCK_CLOSE) + GLOBAL_BLOCK_CLOSE.length), "自有块之后的内容（含外部 feature tag）必须逐字保留");
  assert.ok(run.final.includes(FOREIGN_BLOCK), "替换分支不得吞掉块外的其它 feature 内容");
  assert.ok(run.final.includes("GLOBAL v2 正文"), "本轮新快照必须生效");
  assertCanaryRetained(run.final, "GLOBAL 块外内容保留");
});

preservationTest("behavior#shared-append-preserves-base-and-canary", async () => {
  const shared = installAgentsShared({ instructions: SHARED_FIXTURE, scope: "main" });
  const run = await runBeforeAgentStart({ extensions: [shared.extension] });
  assert.equal(run.errors.length, 0);
  assert.ok(run.final.startsWith(run.base), "SHARED main scope 追加后 base 必须逐字保留为前缀");
  assert.ok(run.final.includes(SHARED_BLOCK_OPEN), "SHARED 自有块必须存在");
  assert.ok(run.final.includes(SHARED_FIXTURE), "SHARED 正文必须注入");
  assert.ok(!run.final.includes(SHARED_CHILD_BLOCK_OPEN), "main scope 不得注入 child 边界块");
  assertCanaryRetained(run.final, "SHARED main 追加");
});

preservationTest("behavior#shared-child-append-preserves-base-and-adds-boundaries", async () => {
  const shared = installAgentsShared({ instructions: SHARED_FIXTURE, scope: "child" });
  const run = await runBeforeAgentStart({ extensions: [shared.extension] });
  assert.equal(run.errors.length, 0);
  assert.ok(run.final.startsWith(run.base), "SHARED child scope 追加后 base 必须逐字保留为前缀");
  assert.ok(run.final.includes(SHARED_BLOCK_OPEN), "child 仍必须收到同一份共享块");
  assert.ok(run.final.includes(SHARED_CHILD_BLOCK_OPEN), "child scope 必须追加运行时边界块");
  assertCanaryRetained(run.final, "SHARED child 追加");
  assert.equal(shared.emittedEvents.length, 0, "before_agent_start 阶段不得发 ACK（ACK 属 session_start）");
});

preservationTest("behavior#global-then-shared-order-preserves-canary", async () => {
  const global = installAgentsGlobal({ instructions: GLOBAL_FIXTURE });
  const shared = installAgentsShared({ instructions: SHARED_FIXTURE, scope: "main" });
  const run = await runBeforeAgentStart({ extensions: [global.extension, shared.extension] });
  assert.equal(run.errors.length, 0);
  assert.ok(run.final.startsWith(run.base), "GLOBAL→SHARED 顺序下 base 仍必须逐字保留");
  assertCanaryRetained(run.final, "GLOBAL→SHARED");
  assert.ok(run.final.indexOf(GLOBAL_BLOCK_OPEN) < run.final.indexOf(SHARED_BLOCK_OPEN), "两块必须各自独立存在且按加载顺序排列");
  assert.equal(run.final.split(GLOBAL_BLOCK_OPEN).length - 1, 1, "GLOBAL 块不得重复");
  assert.equal(run.final.split(SHARED_BLOCK_OPEN).length - 1, 1, "SHARED 块不得重复");
});

preservationTest("behavior#shared-then-global-order-preserves-canary", async () => {
  const shared = installAgentsShared({ instructions: SHARED_FIXTURE, scope: "child" });
  const global = installAgentsGlobal({ instructions: GLOBAL_FIXTURE });
  const run = await runBeforeAgentStart({ extensions: [shared.extension, global.extension] });
  assert.equal(run.errors.length, 0);
  assert.ok(run.final.startsWith(run.base), "SHARED→GLOBAL 顺序下 base 仍必须逐字保留");
  assertCanaryRetained(run.final, "SHARED→GLOBAL");
  assert.ok(run.final.includes(SHARED_CHILD_BLOCK_OPEN), "child 边界块不得被后加载的 GLOBAL 吞掉");
});

behaviorTest("behavior#profile-append-addendum-preserves-canary", async () => {
  const profiles = await inspectAgentProfiles({ expectedRoster: PROFILE_ROSTER });
  for (const profile of profiles) {
    assert.equal(classifyProfileSystemPromptMode(profile.frontmatter), "append", `${profile.path} 必须显式 append`);
    // 真实 SDK 的 append 语义：appendSystemPrompt → 独立 <addendum> section，
    // preamble/tools/rules/docs 全部保留。
    const run = await runBeforeAgentStart({
      extensions: [],
      options: createCanaryOptions({ appendSystemPrompt: profile.body }),
    });
    assert.equal(run.errors.length, 0);
    assert.equal(run.systemPromptOptions.forceSystemPrompt, undefined, `${profile.path} append 不得进入 force 分支`);
    assert.match(run.base, /<addendum>/, `${profile.path} 角色正文必须作为 addendum section 出现`);
    assert.ok(run.base.includes(profile.body.slice(0, 40)), `${profile.path} 正文必须逐字进入 addendum`);
    assertCanaryRetained(run.base, `${profile.path} append`);
  }
});

/* --- 负 fixture：证明替换语义真的会丢 guidelines，也证明检测语义成立 ----------- */

behaviorTest("behavior#negative-customPrompt-drops-guidelines", async () => {
  const run = await runBeforeAgentStart({
    extensions: [],
    options: createCanaryOptions({ extra: { customPrompt: "CUSTOM-ONLY-PREAMBLE" } }),
  });
  assert.ok(run.base.includes("CUSTOM-ONLY-PREAMBLE"), "customPrompt 会成为唯一 preamble");
  assert.ok(!run.base.includes("<rules>"), "customPrompt 下 <rules> section 整体不生成");
  assert.ok(!run.base.includes(GUIDELINE_CANARY.prompt), "customPrompt 下 promptGuidelines canary 消失");
  assert.ok(!run.base.includes(GUIDELINE_CANARY.tool), "customPrompt 下 toolGuidelines canary 消失");
});

behaviorTest("behavior#negative-forceSystemPrompt-is-opaque-and-drops-guidelines", async () => {
  const run = await runBeforeAgentStart({
    extensions: [],
    options: createCanaryOptions({ extra: { forceSystemPrompt: "FORCED-ONLY-CONTENT" } }),
  });
  assert.equal(run.base, "FORCED-ONLY-CONTENT", "forceSystemPrompt 的 content 不透明、无 sections");
  assert.ok(!run.base.includes(GUIDELINE_CANARY.prompt), "forceSystemPrompt 下 promptGuidelines canary 消失");
  assert.ok(!run.base.includes("<rules>"), "forceSystemPrompt 下不存在结构化 section");
});

behaviorTest("behavior#negative-handler-full-replacement-drops-canary", async () => {
  // 伪造 handler 只用于**负**证明：一旦 handler 返回不含 base 的 systemPrompt，
  // runner 就把它写进 forceSystemPrompt，canary 立即丢失。白名单保留证明不使用此类替身。
  const hostile = createExtensionRecorder("<fixture:hostile-full-replacement>");
  hostile.extension.handlers.set("before_agent_start", [async () => ({ systemPrompt: "只有新文本，base 被丢弃" })]);
  const run = await runBeforeAgentStart({ extensions: [hostile.extension] });
  assert.equal(run.systemPromptOptions.forceSystemPrompt, "只有新文本，base 被丢弃");
  assert.ok(!run.final.includes(GUIDELINE_CANARY.prompt), "完整替换 handler 会丢 promptGuidelines canary");
  assert.ok(!run.final.includes(GUIDELINE_CANARY.tool), "完整替换 handler 会丢 toolGuidelines canary");
});

behaviorTest("behavior#negative-handler-truncated-base-drops-canary", async () => {
  const truncating = createExtensionRecorder("<fixture:hostile-truncate>");
  truncating.extension.handlers.set("before_agent_start", [
    async (event) => ({ systemPrompt: String(event.systemPrompt ?? "").slice(0, 120) }),
  ]);
  const run = await runBeforeAgentStart({ extensions: [truncating.extension] });
  assert.ok(run.final.length < run.base.length, "截断 handler 必须真的缩短了 prompt");
  assert.ok(!run.final.includes(GUIDELINE_CANARY.prompt), "截断 base 会丢 canary（证明检测语义）");
});

behaviorTest("behavior#negative-handler-empty-return-leaves-base-untouched", async () => {
  const passive = createExtensionRecorder("<fixture:passive-undefined>");
  passive.extension.handlers.set("before_agent_start", [async () => undefined]);
  const run = await runBeforeAgentStart({ extensions: [passive.extension] });
  assert.equal(run.systemPromptOptions.forceSystemPrompt, undefined, "返回 undefined 不得进入 force 分支");
  assert.equal(run.final, run.base, "返回 undefined 时 base 逐字不动");
  assertCanaryRetained(run.final, "handler 返回 undefined");
});

behaviorTest("behavior#negative-real-handlers-unreadable-file-never-fabricate-replacement", async () => {
  // 真实生产 handler 在规范文件缺失时不得伪造错误 system prompt 冒充 provider 拦截。
  const global = installAgentsGlobal({ instructions: new Error("ENOENT: fixture AGENTS_GLOBAL.md missing") });
  const sharedMain = installAgentsShared({ instructions: new Error("ENOENT: fixture AGENTS_SHARED.md missing"), scope: "main" });
  const run = await runBeforeAgentStart({ extensions: [global.extension, sharedMain.extension] });
  assert.equal(run.errors.length, 0);
  assert.equal(run.systemPromptOptions.forceSystemPrompt, undefined, "读取失败不得改写成错误 system prompt");
  assert.equal(run.final, run.base, "读取失败时 base 逐字不动");
  assertCanaryRetained(run.final, "真实 handler 读取失败路径");

  // child scope 的边界块来自 runtime 而非 AGENTS_SHARED，因此仍会追加；
  // 关键是它仍然是「base 逐字保留 + 追加」，canary 不丢。
  const sharedChild = installAgentsShared({ instructions: new Error("ENOENT"), scope: "child" });
  const childRun = await runBeforeAgentStart({ extensions: [sharedChild.extension] });
  assert.ok(childRun.final.startsWith(childRun.base), "child 边界块仍必须是追加而不是替换");
  assert.ok(childRun.final.includes(SHARED_CHILD_BLOCK_OPEN), "child 边界块与 AGENTS_SHARED 可读性无关");
  assert.ok(!childRun.final.includes(SHARED_BLOCK_OPEN), "共享文件不可读时不得注入空的共享块");
  assertCanaryRetained(childRun.final, "child 边界块追加");
});

behaviorTest("behavior#input-gate-loads-snapshot-through-real-runner", async () => {
  // 真实 runner 的 emitInput 门禁：生产 handler 在 input 阶段加载快照，
  // before_agent_start 消费同一快照，两个阶段都不引入 customPrompt/forceSystemPrompt。
  const global = installAgentsGlobal({ instructions: GLOBAL_FIXTURE });
  const shared = installAgentsShared({ instructions: SHARED_FIXTURE, scope: "main" });
  const input = await runInput({ extensions: [global.extension, shared.extension] });
  assert.equal(input.errors.length, 0);
  assert.deepEqual(input.result, { action: "continue" }, "input 门禁必须放行而不是 handled 短路");
  const run = await runBeforeAgentStart({ extensions: [global.extension, shared.extension] });
  assert.equal(run.systemPromptOptions.customPrompt, undefined);
  assert.ok(run.final.includes(GLOBAL_FIXTURE) && run.final.includes(SHARED_FIXTURE), "input 阶段的快照必须被 before_agent_start 消费");
  assertCanaryRetained(run.final, "input 门禁 + before_agent_start");
});

/* -------------------------------------------------------------------------- */
/* 静态策略：默认拒绝 + 精确 site 白名单                                         */
/* -------------------------------------------------------------------------- */

let cachedReport;

function scanProduction() {
  if (!cachedReport) {
    cachedReport = scanPromptOverridePolicy({
      roots: SCAN_ROOTS,
      whitelist: REPLACEMENT_WHITELIST,
      dataDtoSites: DATA_DTO_SITES,
    });
  }
  return cachedReport;
}

function formatViolations(violations) {
  return violations.map((item) => `  - ${item.path}:${item.line} [${item.rule}] ${item.message}`).join("\n");
}

test("policy#production-scan-is-default-deny-with-precise-site-whitelist", () => {
  const report = scanProduction();
  assert.deepEqual(
    report.violations,
    [],
    `自有生产范围出现完整替换违规（默认拒绝 + 精确白名单）：\n${formatViolations(report.violations)}`,
  );
  for (const file of REQUIRED_SCANNED_FILES) {
    assert.ok(report.files.source.includes(file), `扫描必须真实覆盖 ${file}（child-extensions / scripts 不得漏扫）`);
  }
  for (const file of REQUIRED_TEXT_PROBED_FILES) {
    assert.ok(report.files.text.includes(file), `非源码文本必须走字面探针：${file}`);
  }
  assert.ok(report.files.source.length >= REQUIRED_SCANNED_FILES.length, "源码扫描文件数必须覆盖哨兵清单");
});

test("policy#replacement-site-count-matches-whitelist-exactly", () => {
  const report = scanProduction();
  const counts = {};
  for (const site of report.sites) counts[site.kind] = (counts[site.kind] ?? 0) + 1;
  assert.deepEqual(counts, { ...EXPECTED_SITE_COUNTS }, "site 分类计数漂移：新增/消失的替换入口必须显式复核策略");
  const replacements = report.sites.filter((site) => site.kind === "handler-return-replacement");
  assert.equal(replacements.length, REPLACEMENT_WHITELIST.length, "替换 site 总数必须等于白名单条目数（不得为绿扩白，也不得留死条目）");
  for (const entry of REPLACEMENT_WHITELIST) {
    const matched = replacements.filter((site) => site.path === entry.path && site.enclosing === entry.enclosing && site.ordinal === entry.ordinal);
    assert.equal(matched.length, 1, `白名单条目必须精确命中一个现场 site：${entry.path}#${entry.ordinal}`);
    assert.equal(matched[0].shape, entry.shape, `白名单 shape 指纹必须与现场一致：${entry.path}#${entry.ordinal}`);
    assert.ok(typeof entry.reason === "string" && entry.reason.length > 20, `白名单条目必须写明理由：${entry.path}#${entry.ordinal}`);
    assert.ok(typeof entry.preservationTest === "string" && entry.preservationTest.startsWith("behavior#"), `白名单条目必须挂 preservation test id：${entry.path}#${entry.ordinal}`);
  }
  assert.equal(report.sites.filter((site) => site.kind === "data-dto").length, DATA_DTO_SITES.length, "DTO 豁免必须按精确 site 授予");
});

test("policy#customPrompt-and-forceSystemPrompt-absent-from-production", () => {
  const report = scanProduction();
  const banned = report.violations.filter((item) => item.rule.startsWith("banned-override"));
  assert.deepEqual(banned, [], `customPrompt/forceSystemPrompt/systemPromptOverride 默认不得出现在自有生产代码：\n${formatViolations(banned)}`);
  // 反向自证扫描不是空转：白名单/DTO/只读访问 site 确实被识别到。
  assert.ok(report.sites.some((site) => site.kind === "read-access"), "扫描必须识别到 event.systemPrompt 只读访问");
  assert.ok(report.sites.some((site) => site.kind === "handler-return-replacement"), "扫描必须识别到 handler 返回替换 site");
});

test("policy#profile-frontmatter-requires-explicit-append", async () => {
  const profiles = await inspectAgentProfiles({ expectedRoster: PROFILE_ROSTER });
  assert.deepEqual(profiles.map((profile) => profile.name), PROFILE_ROSTER, "profile 名册漂移必须显式复核");
  for (const profile of profiles) {
    assert.equal(
      classifyProfileSystemPromptMode(profile.frontmatter),
      "append",
      `${profile.path} 必须显式声明 systemPromptMode: append；缺失也拒绝（上游 child-launch 多数路径默认 replace）`,
    );
    assert.ok(profile.body.length > 0, `${profile.path} 正文不得为空（append 追加的是角色正文）`);
  }
  // 分类器自证：replace / 缺失 / 空串 / 其它取值都必须被判为不合法。
  assert.equal(classifyProfileSystemPromptMode({ systemPromptMode: "append" }), "append");
  assert.equal(classifyProfileSystemPromptMode({ systemPromptMode: "replace" }), "other");
  assert.equal(classifyProfileSystemPromptMode({ systemPromptMode: "inherit" }), "other");
  assert.equal(classifyProfileSystemPromptMode({ systemPromptMode: "" }), "missing");
  assert.equal(classifyProfileSystemPromptMode({}), "missing");
  assert.equal(classifyProfileSystemPromptMode(undefined), "missing");
});

test("policy#no-system-md-in-own-scope-and-append-system-md-is-legal", () => {
  const probe = probeSystemPromptMarkdown({ roots: SCAN_ROOTS });
  assert.deepEqual(probe.system, [], `自有范围出现 SYSTEM.md（SDK 会接到 customPrompt 完整替换路径）：${JSON.stringify(probe.system)}`);
  // APPEND_SYSTEM.md 是合法追加形态：当前不存在；分类器必须放行它，不得与 SYSTEM.md 一视同仁。
  assert.equal(classifySystemPromptMarkdownName("APPEND_SYSTEM.md"), "append");
  assert.equal(classifySystemPromptMarkdownName("SYSTEM.md"), "replace");
  assert.equal(classifySystemPromptMarkdownName("AGENTS_SHARED.md"), "unrelated");
  assert.ok(Array.isArray(probe.appendSystem), "APPEND_SYSTEM.md 存在性检查必须始终执行（存在即记录、不判违规）");
});

test("policy#whitelist-preservation-tests-actually-executed", () => {
  const required = new Set();
  for (const entry of REPLACEMENT_WHITELIST) {
    required.add(entry.preservationTest);
    for (const supporting of entry.supportingTests ?? []) required.add(supporting);
  }
  const missing = [...required].filter((id) => !executedPreservationTests.has(id));
  assert.deepEqual(missing, [], `白名单引用的 preservation test 未执行（白名单条目因此不生效）：${JSON.stringify(missing)}`);
  const orphans = [...executedPreservationTests].filter((id) => !required.has(id));
  assert.deepEqual(orphans, [], `存在与白名单无关的 preservation test id（不得用无关伪 handler 让白名单变绿）：${JSON.stringify(orphans)}`);
});

/* -------------------------------------------------------------------------- */
/* 扫描器自测：负 fixture 只写在测试自有临时目录，绝不落入生产路径                 */
/* -------------------------------------------------------------------------- */

async function withFixtureDirectory(t, files, fn) {
  const dir = await mkdtemp(join(tmpdir(), "prompt-override-policy-"));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  for (const [relativePath, content] of Object.entries(files)) {
    const full = join(dir, relativePath);
    await mkdir(join(full, ".."), { recursive: true });
    await writeFile(full, content, "utf8");
  }
  return fn(dir);
}

function rulesOf(result) {
  return result.violations.map((item) => item.rule).sort();
}

test("scanner#unknown-handler-return-site-is-rejected", async (t) => {
  await withFixtureDirectory(
    t,
    {
      "src/unknown.ts": [
        "export function createUnknownExtension(pi) {",
        '  pi.on("before_agent_start", async (event) => {',
        '    const base = typeof event.systemPrompt === "string" ? event.systemPrompt : "";',
        '    return { systemPrompt: [base, "追加块"].join("\\n\\n") };',
        "  });",
        "}",
        "",
      ].join("\n"),
    },
    async (dir) => {
      const result = scanPromptOverridePolicyInDirectory({ baseDir: dir });
      assert.deepEqual(rulesOf(result), ["unknown-handler-return-replacement"], "未登记的 handler 返回替换 site 必须被拒绝（即使形状是纯追加）");
      assert.equal(result.sites.filter((site) => site.kind === "handler-return-replacement").length, 1);
      assert.match(result.violations[0].message, /默认拒绝/);
    },
  );
});

test("scanner#named-handler-function-return-site-is-rejected", async (t) => {
  await withFixtureDirectory(
    t,
    {
      "src/named.ts": [
        "async function beforeAgentStart(event) {",
        '  return { systemPrompt: "整段替换" };',
        "}",
        "export function createNamedExtension(pi) {",
        '  pi.on("before_agent_start", beforeAgentStart);',
        "}",
        "",
      ].join("\n"),
    },
    async (dir) => {
      const result = scanPromptOverridePolicyInDirectory({ baseDir: dir });
      assert.deepEqual(rulesOf(result), ["unknown-handler-return-replacement"], "具名 handler 注册形式同样必须被识别并默认拒绝");
      assert.match(result.sites[0].enclosing, /function beforeAgentStart/);
    },
  );
});

test("scanner#banned-override-writes-are-rejected", async (t) => {
  await withFixtureDirectory(
    t,
    {
      "src/banned.ts": [
        "export function createBannedExtension(pi) {",
        '  pi.on("before_agent_start", async (event) => {',
        '    event.systemPromptOptions.forceSystemPrompt = "forced";',
        '    event.systemPromptOptions.customPrompt = "custom";',
        '    event.systemPromptOptions["systemPromptOverride"] = "override";',
        "    return undefined;",
        "  });",
        "}",
        "",
      ].join("\n"),
    },
    async (dir) => {
      const result = scanPromptOverridePolicyInDirectory({ baseDir: dir });
      const counts = {};
      for (const rule of rulesOf(result)) counts[rule] = (counts[rule] ?? 0) + 1;
      assert.equal(counts["banned-override-identifier"], 2, "forceSystemPrompt / customPrompt 字面写入必须被拒");
      assert.equal(counts["banned-override-key-literal"], 1, "字符串键形式的 systemPromptOverride 必须被拒");
    },
  );
});

test("scanner#computed-key-and-assign-on-options-are-rejected", async (t) => {
  await withFixtureDirectory(
    t,
    {
      "src/computed.ts": [
        "export function createComputedExtension(pi) {",
        '  pi.on("before_agent_start", async (event) => {',
        "    const options = event.systemPromptOptions;",
        '    options["force" + "SystemPrompt"] = "x";',
        '    Object.assign(options, { customPrompt: "y" });',
        "    delete options.promptGuidelines;",
        "    return undefined;",
        "  });",
        "}",
        "",
      ].join("\n"),
    },
    async (dir) => {
      const result = scanPromptOverridePolicyInDirectory({ baseDir: dir });
      const rules = rulesOf(result);
      assert.ok(rules.includes("computed-key-write-unclassified"), `计算键写入必须 fail closed：${JSON.stringify(rules)}`);
      assert.ok(rules.includes("object-assign-on-options-unclassified"), `Object.assign(options, ...) 必须 fail closed：${JSON.stringify(rules)}`);
      assert.ok(rules.includes("delete-on-options-unclassified"), `delete options.* 必须 fail closed：${JSON.stringify(rules)}`);
      assert.ok(rules.includes("banned-override-identifier"), "Object.assign 里的字面 customPrompt 也必须命中禁止标识符规则");
    },
  );
});

test("scanner#legal-append-forms-are-allowed", async (t) => {
  await withFixtureDirectory(
    t,
    {
      "src/legal-append.ts": [
        "export function createLegalAppendExtension(pi) {",
        '  pi.on("before_agent_start", async (event) => {',
        "    const base = typeof event.systemPrompt === \"string\" ? event.systemPrompt : \"\";",
        '    event.systemPromptOptions.promptGuidelines.push("合法追加的 guideline");',
        '    event.systemPromptOptions.appendSystemPrompt += "\\n\\n合法追加块";',
        "    if (base.length < 0) return undefined;",
        "    return undefined;",
        "  });",
        "}",
        'export const FLAG_NAMES = new Set(["--system-prompt", "--append-system-prompt"]);',
        "",
      ].join("\n"),
    },
    async (dir) => {
      const result = scanPromptOverridePolicyInDirectory({ baseDir: dir });
      assert.deepEqual(result.violations, [], `合法追加形态（promptGuidelines.push / appendSystemPrompt / 只读 event.systemPrompt / flag 名分类器）不得被判违规：${JSON.stringify(result.violations)}`);
      assert.ok(result.sites.some((site) => site.kind === "read-access"), "只读 event.systemPrompt 必须被识别为 read-access 而不是被禁");
      assert.ok(result.sites.some((site) => site.kind === "flag-classifier-literal"), "flag 名分类器字面量必须被识别");
    },
  );
});

test("scanner#launcher-argv-injection-is-rejected", async (t) => {
  await withFixtureDirectory(
    t,
    {
      "src/launcher.ts": [
        'import { spawn } from "node:child_process";',
        "export function launchChild(prompt) {",
        '  const args = ["pi", "--print"];',
        '  args.push("--system-prompt", prompt);',
        '  return spawn("pi", [...args, "--system-prompt", prompt], { stdio: "inherit" });',
        "}",
        "",
      ].join("\n"),
    },
    async (dir) => {
      const result = scanPromptOverridePolicyInDirectory({ baseDir: dir });
      const launcher = result.violations.filter((item) => item.rule === "launcher-argv-injection");
      assert.equal(launcher.length, 2, `launcher argv 主动注入 --system-prompt 必须被拒（push 与数组字面量两种形态）：${JSON.stringify(result.violations)}`);
    },
  );
});

test("scanner#data-dto-exemption-is-site-precise", async (t) => {
  await withFixtureDirectory(
    t,
    {
      "src/dto.ts": [
        "export type Admission = { name: string; systemPrompt: string };",
        "export function parseProfile(body) {",
        "  return { name: \"x\", systemPrompt: body };",
        "}",
        "export function otherProjection(body) {",
        "  return { name: \"y\", systemPrompt: body };",
        "}",
        "",
      ].join("\n"),
    },
    async (dir) => {
      const exempt = {
        path: "src/dto.ts",
        enclosing: "function parseProfile",
        shape: "id(body)",
        reason: "fixture：只豁免 parseProfile 一处，证明 DTO 豁免不是目录级忽略",
      };
      const result = scanPromptOverridePolicyInDirectory({ baseDir: dir, dataDtoSites: [exempt] });
      assert.deepEqual(rulesOf(result), ["unclassified-data-dto"], "同文件另一处的 systemPrompt DTO 必须仍被拒绝（精确 site 豁免，不是目录忽略）");
      assert.match(result.violations[0].message, /otherProjection|systemPrompt/);
      assert.equal(result.sites.filter((site) => site.kind === "type-declaration").length, 1, "类型声明成员必须被识别为非运行时写入");
    },
  );
});

test("scanner#whitelist-shape-drift-and-dead-entries-are-rejected", async (t) => {
  await withFixtureDirectory(
    t,
    {
      "src/drift.ts": [
        "export function createDriftExtension(pi) {",
        '  pi.on("before_agent_start", async (event) => {',
        '    const base = typeof event.systemPrompt === "string" ? event.systemPrompt : "";',
        '    return { systemPrompt: [base, "追加块"].join("\\n\\n") };',
        "  });",
        "}",
        "",
      ].join("\n"),
    },
    async (dir) => {
      const base = {
        path: "src/drift.ts",
        enclosing: "function createDriftExtension > arrow",
        ordinal: 1,
        reason: "fixture：白名单条目",
        preservationTest: "behavior#fixture",
      };
      const drifted = scanPromptOverridePolicyInDirectory({
        baseDir: dir,
        whitelist: [{ ...base, shape: "id(base)" }],
      });
      assert.ok(rulesOf(drifted).includes("whitelist-shape-drift"), `shape 指纹漂移必须被拒：${JSON.stringify(drifted.violations)}`);

      const dead = scanPromptOverridePolicyInDirectory({
        baseDir: dir,
        whitelist: [{ ...base, shape: "[id(base),str].join(str)" }, { ...base, ordinal: 9, shape: "id(none)" }],
      });
      assert.ok(rulesOf(dead).includes("whitelist-entry-not-found"), `白名单死条目必须被拒：${JSON.stringify(dead.violations)}`);
    },
  );
});

test("scanner#non-source-text-probe-rejects-launcher-flag", async (t) => {
  await withFixtureDirectory(
    t,
    {
      "scripts/launcher.zsh": '#!/bin/zsh\nexec pi --print --system-prompt "$PROMPT"\n',
      "scripts/launcher-append.zsh": '#!/bin/zsh\nexec pi --print --append-system-prompt "$PROMPT"\n',
      "scripts/config.json": '{ "providerBlacklist": ["deepseek"] }\n',
    },
    async (dir) => {
      const report = scanPromptOverridePolicy({ roots: [join(dir, "scripts")], whitelist: [], dataDtoSites: [] });
      assert.deepEqual(
        report.files.text.map((item) => item.split("/").at(-1)).sort(),
        ["config.json", "launcher-append.zsh", "launcher.zsh"],
        "非源码文本必须全部进入字面探针，不得静默跳过",
      );
      const launcher = report.violations.filter((item) => item.rule === "launcher-argv-injection");
      assert.equal(launcher.length, 1, `launcher 文本里的 --system-prompt 必须被拒：${JSON.stringify(report.violations)}`);
      assert.match(launcher[0].path, /launcher\.zsh$/);
      assert.deepEqual(report.files.ignored, [], "fixture 目录不得有被静默跳过的文件");
      assert.equal(report.violations.filter((item) => item.rule === "unhandled-file-kind").length, 0);
    },
  );
});

test("policy#scan-coverage-accounts-for-every-file-and-excludes-state-dirs", () => {
  const report = scanProduction();
  // 扫描不得静默漏文件：每个常规文件必须被归为源码/文本/显式忽略三类之一。
  const accounted = new Set([...report.files.source, ...report.files.text, ...report.files.ignored]);
  assert.ok(
    accounted.size >= REQUIRED_SCANNED_FILES.length + REQUIRED_TEXT_PROBED_FILES.length,
    `扫描必须实际覆盖哨兵清单，实际 ${accounted.size} 个文件`,
  );
  // 忽略清单按现场真实输入核对，不硬编码「本机恰好存在哪些垃圾文件」：
  // 干净 clone 里没有任何 .DS_Store 时允许为空，但只要出现被忽略条目，就必须同时满足
  // 「显式登记的 OS 垃圾文件名 + 落在显式枚举的扫描根内 + 磁盘上真实存在 + 不进源码/文本证据」。
  const registeredJunkBasenames = [".DS_Store", "Thumbs.db"];
  for (const path of report.files.ignored) {
    const basename = path.split("/").at(-1);
    assert.ok(registeredJunkBasenames.includes(basename), `只有显式登记的 OS 垃圾文件可以被忽略，实际出现：${path}`);
    assert.ok(
      SCAN_ROOTS.some((root) => path.startsWith(`${root}/`)),
      `被忽略条目必须落在显式枚举的扫描根内：${path}`,
    );
    assert.ok(existsSync(join(REPO_ROOT, path)), `被忽略条目必须在现场真实存在，不得凭期待登记：${path}`);
    assert.ok(
      !report.files.source.includes(path) && !report.files.text.includes(path),
      `OS 垃圾文件不得进入源码/文本证据：${path}`,
    );
  }
  // 扫描外边界必须真实成立：不得混入 vendored / 真实用户状态 / 测试目录。
  for (const path of [...report.files.source, ...report.files.text]) {
    assert.ok(!path.includes("node_modules"), `不得扇入 vendored 依赖：${path}`);
    assert.ok(!path.startsWith("var/"), `不得扇入上游工作区：${path}`);
    assert.ok(!path.startsWith("test/"), `测试内部允许 negative fixture，不得被扫描：${path}`);
    assert.ok(
      !path.startsWith("pi/sessions") && !path.startsWith("pi/logs") && !path.startsWith("pi/run-history"),
      `不得读取真实会话/日志状态：${path}`,
    );
    assert.ok(!/(^|\/)(settings|models|auth|trust)\.json$/.test(path), `不得读取真实用户配置：${path}`);
  }
  assert.ok(
    report.typeScriptEntry.includes("typescript"),
    `必须使用仓库已安装的 TypeScript AST 解析器，实际：${report.typeScriptEntry}`,
  );
});
