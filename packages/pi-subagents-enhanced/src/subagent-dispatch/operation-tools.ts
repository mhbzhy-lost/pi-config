// S1：start/roster/run 七个 main/model-only 操作工具的薄 factory。
// 合同来源：docs/plans/records/2026-10-16-operation-tools/contract.md §2.1/§3 与计划 §S1。
// 约束：
// - 每份 schema 根为单 type:"object" + additionalProperties:false，顶层不使用 anyOf/oneOf/allOf/if-then；
//   coding 的 acceptance 条件必填仍由原 typed 编译器（contracts/dispatch-ir.ts，位于注入回调内）裁决，
//   schema 不加 if/then 早拒。
// - 本模块不得 import extension.ts（避免 S4 唯一注册点反向循环）；schema 字段按 S0 冻结表局部声明，
//   不新增 runtime-only 字段（view/lines/mode/childId/context/timeoutMs/version）。
// - 固定 action 由 factory 注入：schema 不声明 action，调用方 args 携带 action 即跨面未知字段，
//   与 additionalProperties:false 一致 fail closed，不覆盖、不透传、不触达任何下游回调；
//   其余白名单之外字段同样 fail closed（isError + details.code/keypath，形状与既有 failure 一致）。
// - 轻量必填检查只做“非空 string”：start 的 agent/task、steer/resume 的 message；
//   steer 的 index 必填只由 schema 的 required 表达（不新增 factory 运行时检查，
//   执行期仍由 extension.ts 的 steer resolver 裁决 code）；
//   细粒度 coding/模型/字节验证仍由回调内原 typed 编译器与 runtime 裁决，不复制进 factory。
// - 无新 dispatcher/state/定时器：start 复用注入的 executeStart（内含 coding/generic 路由），
//   roster/run_* 复用注入的 executeControl 固定 action。

/** 原 ToolDefinition.execute 的参数顺序；DI 回调按同一顺序委托，便于 S4 直接注入既有闭包。 */
export type SubagentOperationExecute = (
  toolCallId: string,
  input: Record<string, unknown>,
  signal: unknown,
  onUpdate: unknown,
  ctx: unknown,
) => unknown;

export interface SubagentOperationToolDeps {
  /** 启动入口：接收 start 白名单字段（无 action），内部按 writePaths 路由 coding/generic。 */
  executeStart: SubagentOperationExecute;
  /** 控制入口：接收已注入固定 action 的参数对象，内部委托既有 executeControl/rpc。 */
  executeControl: SubagentOperationExecute;
  renderCall?: unknown;
  renderResult?: unknown;
}

const TARGET_ID_FIELD = { type: "string", minLength: 1, maxLength: 4096 };
const TARGET_FIELDS = Object.freeze({
  id: TARGET_ID_FIELD,
  runId: TARGET_ID_FIELD,
  dir: TARGET_ID_FIELD,
  index: { type: "integer", minimum: 0 },
});
const MESSAGE_FIELD = { type: "string", minLength: 1, maxLength: 65536 };

// 以下字段形状逐项照抄 extension.ts TYPED_SUBAGENT_PARAMETERS 的同名声明（S0 §2.1 冻结）。
const AGENT_FIELD = {
  type: "string", minLength: 1, maxLength: 256,
  pattern: "^[^\\u0000-\\u001F\\u007F-\\u009F]*[^\\s\\u0000-\\u001F\\u007F-\\u009F][^\\u0000-\\u001F\\u007F-\\u009F]*$",
};
const MODEL_FIELD = { type: "string", minLength: 1, maxLength: 512, pattern: ".*\\S.*" };
const THINKING_LEVEL_FIELD = { enum: ["minimal", "low", "medium", "high", "xhigh", "max"] };
const ACCEPTANCE_FIELD = {
  anyOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["criteria"],
      properties: {
        criteria: { type: "array", items: { type: "string", minLength: 1, maxLength: 4096 }, maxItems: 32, minItems: 1 },
      },
    },
    { type: "object", additionalProperties: true },
    { type: "array" },
    { type: "string" },
  ],
};
const OUTPUT_FIELD = { anyOf: [{ type: "string", minLength: 1 }, { const: false }] };
const OUTPUT_SCHEMA_FIELD = { type: "object", additionalProperties: true };
const SKILL_FIELD = {
  anyOf: [
    { type: "string", minLength: 1 },
    { type: "array", items: { type: "string", minLength: 1 } },
    { type: "boolean" },
  ],
};
const READS_FIELD = {
  anyOf: [
    { type: "array", items: { type: "string", minLength: 1 } },
    { type: "boolean" },
  ],
};

export const SUBAGENT_ROSTER_PARAMETERS = Object.freeze({
  type: "object",
  additionalProperties: false,
  properties: {},
});

export const SUBAGENT_START_PARAMETERS = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["agent", "task"],
  properties: {
    agent: AGENT_FIELD,
    task: { type: "string", minLength: 1 },
    title: { type: "string", minLength: 1, maxLength: 4096 },
    model: MODEL_FIELD,
    thinkingLevel: THINKING_LEVEL_FIELD,
    worktree: { type: "boolean" },
    cwd: { type: "string", minLength: 1, maxLength: 4096 },
    writePaths: {
      type: "array", items: { type: "string", minLength: 1, maxLength: 4096 }, maxItems: 32, minItems: 1,
    },
    acceptance: ACCEPTANCE_FIELD,
    output: OUTPUT_FIELD,
    outputMode: { enum: ["inline", "file-only"] },
    outputSchema: OUTPUT_SCHEMA_FIELD,
    artifacts: { type: "boolean" },
    progress: { type: "boolean" },
    skill: SKILL_FIELD,
    reads: READS_FIELD,
  },
});

export const SUBAGENT_RUN_STATUS_PARAMETERS = Object.freeze({
  type: "object",
  additionalProperties: false,
  properties: { ...TARGET_FIELDS },
});

export const SUBAGENT_RUN_STEER_PARAMETERS = Object.freeze({
  type: "object",
  additionalProperties: false,
  // index 必填：执行期（extension.ts:1487）在缺 index 时直接返回 SUPERVISOR_STEER_CHILD_AMBIGUOUS，
  // 不推断唯一 child、不默认 0、不广播。公开 schema 必须与已冻结的执行期一致，否则模型按
  // 「index 可选」发出的最小合法调用 {runId,message} 必然被拒。
  // TARGET_FIELDS 仍与 status/interrupt/resume/stop 共享字段形状，只在 steer 上收紧 required，
  // 其余三个动作经同一直通分支（不共享 steer resolver），行为不变。
  required: ["message", "index"],
  properties: { ...TARGET_FIELDS, message: MESSAGE_FIELD },
});

export const SUBAGENT_RUN_INTERRUPT_PARAMETERS = Object.freeze({
  type: "object",
  additionalProperties: false,
  properties: { ...TARGET_FIELDS },
});

export const SUBAGENT_RUN_RESUME_PARAMETERS = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["message"],
  properties: {
    ...TARGET_FIELDS,
    message: MESSAGE_FIELD,
    // 父层裁决（S0 §5.4）：resume 保留既有可达的 output/outputMode；output 沿原 string|false 形状，
    // outputMode 仅 file-only；执行仍交原 resumeParams 裁决，不实现模型换模。
    output: OUTPUT_FIELD,
    outputMode: { enum: ["file-only"] },
  },
});

export const SUBAGENT_RUN_STOP_PARAMETERS = Object.freeze({
  type: "object",
  additionalProperties: false,
  properties: { ...TARGET_FIELDS },
});

function isRecord(value: unknown) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

// 与 extension.ts / workspace/tool.ts 的 failure 同形：isError + details.code/detail/keypath。
function failure(code: string, message: string, detail = undefined, keypath = undefined) {
  return {
    content: [{ type: "text", text: `${code}: ${message}` }],
    isError: true,
    details: { code, ...(detail === undefined ? {} : { detail }), ...(keypath === undefined ? {} : { keypath }) },
  };
}

/** 必填非空 string 的轻量检查；code 沿用各路径原既有兼容 code，keypath 精确到字段。 */
interface RequiredStringCheck {
  key: string;
  code: string;
}

interface OperationToolDescriptor {
  name: string;
  label: string;
  description: string;
  promptSnippet: string;
  promptGuidelines: string[];
  parameters: Record<string, unknown>;
  /** "start" → executeStart；"control" → executeControl 并注入固定 action。 */
  kind: "start" | "control";
  action?: string;
  /** 允许透传回调的字段白名单（S0 §2.1 各工具 required/optional 精确表）。 */
  allowedKeys: readonly string[];
  /** 必填非空 string 字段的轻量检查（direct 非法输入不触回调）。 */
  requiredStrings: readonly RequiredStringCheck[];
}

const DESCRIPTORS: readonly OperationToolDescriptor[] = Object.freeze([
  {
    name: "subagent_roster",
    label: "Subagent Roster",
    description: "列出当前可用的 subagent agent 名单（无参数）。权威来源为项目 agent 发现与准入过滤；输出 name 与 frontmatter 元数据，不启动任何 run。",
    promptSnippet: "用 subagent_roster 查看当前可用 agent 名单与 frontmatter。",
    promptGuidelines: [
      "subagent_roster 无参数；启动新 run 用 subagent_start，不要通过本工具传任何启动或控制字段。",
    ],
    parameters: SUBAGENT_ROSTER_PARAMETERS,
    kind: "control",
    action: "list",
    allowedKeys: [],
    requiredStrings: [],
  },
  {
    name: "subagent_start",
    label: "Subagent Start",
    description: "启动一个新的 subagent run：agent、task 必填。writePaths 存在时为 coding 派发，acceptance.criteria 必填，该条件必填由运行时 typed 编译器裁决。worktree:true 时回执携带 workspace_id，其处置一律以本次 managed_workspace_status 实时返回的 allowed_dispositions 与一次性 token 为权威，不在此预判 integrate 或 discard；coding 工作区的集成由子代理 integration queue 自主拥有。本工具不含任何控制 action 字段，也不负责 run 的后续 status/steer/interrupt/resume/stop；启动成功只代表已开始，不是 terminal proof。",
    promptSnippet: "用 subagent_start 携带完整合同（agent、task，coding 另加 writePaths 与 acceptance.criteria）启动子代理。",
    promptGuidelines: [
      "派发必须一次携带完整任务合同，不要靠追问补齐关键上下文；启动成功只代表子代理已开始执行，完成以子代理完成通知为准。",
    ],
    parameters: SUBAGENT_START_PARAMETERS,
    kind: "start",
    allowedKeys: [
      "agent", "task", "title", "model", "thinkingLevel", "worktree", "cwd", "writePaths",
      "acceptance", "output", "outputMode", "outputSchema", "artifacts", "progress", "skill", "reads",
    ],
    // INVALID_GENERIC_DISPATCH：沿用 executeGeneric 对缺失 agent/task 的既有兼容 code。
    requiredStrings: [
      { key: "agent", code: "INVALID_GENERIC_DISPATCH" },
      { key: "task", code: "INVALID_GENERIC_DISPATCH" },
    ],
  },
  {
    name: "subagent_run_status",
    label: "Subagent Run Status",
    description: "查询一个 subagent run 的状态：定位字段 id/runId/dir/index 均可选。状态回执只报告 runtime 事实，不代替自动送达的完成通知，也不构成 workspace 处置权威（处置一律以 managed_workspace_status 实时返回为准）；完成通知自动送达，不要轮询等待，status 仅用于用户明确要求、需要干预或诊断。",
    promptSnippet: "用 subagent_run_status 查询 run 状态；不要用它轮询等待完成。",
    promptGuidelines: [
      "完成通知自动送达，仅在用户明确要求、需要干预或诊断时调用 status。",
    ],
    parameters: SUBAGENT_RUN_STATUS_PARAMETERS,
    kind: "control",
    action: "status",
    allowedKeys: ["id", "runId", "dir", "index"],
    requiredStrings: [],
  },
  {
    name: "subagent_run_steer",
    label: "Subagent Run Steer",
    description: "向运行中的 subagent run 投递转向指令：message 与 index 均必填。index 是目标 child 在该 run 内的非负整数下标（从 0 起），单 child 的 run 也必须写 index: 0；缺 index 一律返回 SUPERVISOR_STEER_CHILD_AMBIGUOUS，非安全非负整数返回 SUPERVISOR_STEER_TARGET_INVALID，执行期不推断唯一 child、不默认 0、不广播。定位另需 id 或 runId 之一：两者同时给出且不一致返回 SUPERVISOR_STEER_TARGET_CONFLICT，8–35 字符的 runId 前缀返回 SUPERVISOR_STEER_TARGET_AMBIGUOUS，dir 在 steer 上会被目标解析器以 SUPERVISOR_STEER_TARGET_ALIAS 拒绝（status/interrupt/stop 的 dir 不受影响）。受控投递由 supervisor gate 裁决，本工具不绕过。",
    promptSnippet: "用 subagent_run_steer 向运行中的 run 注入新指令（message 与 index 必填）。",
    promptGuidelines: [
      "steer 需非空 message、可唯一定位的 id 或 runId，以及必填的非负整数 index（缺 index 直接被 SUPERVISOR_STEER_CHILD_AMBIGUOUS 拒绝，不推断、不默认 0、不广播）；受控 run 的投递以 supervisor gate 决策为准，被拒即停止，不改道。",
    ],
    parameters: SUBAGENT_RUN_STEER_PARAMETERS,
    kind: "control",
    action: "steer",
    allowedKeys: ["id", "runId", "dir", "index", "message"],
    // 通用 INVALID_DISPATCH：canonicalSteerTarget 只校验 run 定位不校验 message，
    // 不得把 $.message 错误标成 steer 目标解析码。
    requiredStrings: [{ key: "message", code: "INVALID_DISPATCH" }],
  },
  {
    name: "subagent_run_interrupt",
    label: "Subagent Run Interrupt",
    description: "中断一个 subagent run 的当前 turn。id/runId/dir/index 为可选定位；本工具只中断，不改变 run 的可 resume 性。",
    promptSnippet: "用 subagent_run_interrupt 中断 run 的当前 turn。",
    promptGuidelines: [
      "interrupt 只中断当前 turn；需要注入新指令续跑时改用 subagent_run_resume。",
    ],
    parameters: SUBAGENT_RUN_INTERRUPT_PARAMETERS,
    kind: "control",
    action: "interrupt",
    allowedKeys: ["id", "runId", "dir", "index"],
    requiredStrings: [],
  },
  {
    name: "subagent_run_resume",
    label: "Subagent Run Resume",
    description: "以新 run 续跑一个 subagent：message 必填非空。paused/completed/failed 的 run 以新 run（新子会话）方式续跑并注入新指令，不承诺在原存活进程内就地继续；stopped 的 run 不可 resume。可选 output（string|false）与 outputMode（仅 file-only）；不提供模型换模。",
    promptSnippet: "用 subagent_run_resume 携带非空新消息续跑 run；stopped 的 run 不可 resume。",
    promptGuidelines: [
      "resume 生成新 run（新子会话），完成通知会以新身份送达；不等待原进程就地继续。",
    ],
    parameters: SUBAGENT_RUN_RESUME_PARAMETERS,
    kind: "control",
    action: "resume",
    allowedKeys: ["id", "runId", "dir", "index", "message", "output", "outputMode"],
    // 保留既有 INVALID_RESUME_MESSAGE + $.message 语义（与 executeControl 一致）。
    requiredStrings: [{ key: "message", code: "INVALID_RESUME_MESSAGE" }],
  },
  {
    name: "subagent_run_stop",
    label: "Subagent Run Stop",
    description: "停止一个 subagent run。id/runId/dir/index 为可选定位；停止后的 run 终态且不可 resume。",
    promptSnippet: "用 subagent_run_stop 停止 run；stopped 后不可再 resume。",
    promptGuidelines: [
      "stop 是终态操作；仍需该工作继续时用 steer 或改用新 start，不要 stop 后期待 resume。",
    ],
    parameters: SUBAGENT_RUN_STOP_PARAMETERS,
    kind: "control",
    action: "stop",
    allowedKeys: ["id", "runId", "dir", "index"],
    requiredStrings: [],
  },
]);

/**
 * 创建七个 main/model-only subagent 操作工具（S1）。
 * 唯一执行回调按原 ToolDefinition.execute 参数顺序 (toolCallId, input, signal, onUpdate, ctx) 委托：
 * - subagent_start → executeStart（白名单字段，无 action 注入，coding/generic 路由留在回调内）；
 * - subagent_roster / subagent_run_* → executeControl（固定 action 注入为 input.action；
 *   调用方 args 的 action 及一切白名单外字段 fail closed，不触达任何下游回调）。
 */
export function createSubagentOperationTools({ executeStart, executeControl, renderCall, renderResult }: SubagentOperationToolDeps) {
  if (typeof executeStart !== "function") throw new TypeError("subagent operation tools require an executeStart callback");
  if (typeof executeControl !== "function") throw new TypeError("subagent operation tools require an executeControl callback");
  const renderers = {
    ...(typeof renderCall === "function" ? { renderCall } : {}),
    ...(typeof renderResult === "function" ? { renderResult } : {}),
  };
  return DESCRIPTORS.map((descriptor) => Object.freeze({
    name: descriptor.name,
    exposure: "model-only" as const,
    label: descriptor.label,
    description: descriptor.description,
    promptSnippet: descriptor.promptSnippet,
    promptGuidelines: descriptor.promptGuidelines,
    parameters: descriptor.parameters,
    ...renderers,
    async execute(toolCallId: string, rawInput: unknown, signal: unknown, onUpdate: unknown, ctx: unknown) {
      // 运行入口对无 schema 调用（direct raw）fail closed：非对象输入不进回调。
      if (!isRecord(rawInput)) {
        return failure(
          "INVALID_DISPATCH",
          `${descriptor.name} input must be an object; expected object; received ${rawInput === null ? "null" : Array.isArray(rawInput) ? "array" : typeof rawInput}`,
          "$", "$",
        );
      }
      const record = rawInput as Record<string, unknown>;
      // 跨面/未知字段 fail closed：action 也不例外（schema additionalProperties:false 同样拒绝），
      // 不会被固定 action 覆盖，也不触达任何下游回调。字段隔离不得依赖 schema 侧 Host 校验。
      const unexpected = Object.keys(record).filter((key) => !descriptor.allowedKeys.includes(key));
      if (unexpected.length > 0) {
        return failure(
          "INVALID_DISPATCH",
          `${descriptor.name} received unsupported fields: ${unexpected.join(", ")}`,
          undefined, `$.${unexpected[0]}`,
        );
      }
      // 轻量必填非空 string 检查：direct 非法输入不触回调；细粒度验证仍留原 typed 编译器/runtime。
      for (const check of descriptor.requiredStrings) {
        const value = record[check.key];
        if (typeof value !== "string" || value.length === 0) {
          return failure(
            check.code,
            `${descriptor.name} requires a non-empty string ${check.key}`,
            undefined, `$.${check.key}`,
          );
        }
      }
      const params: Record<string, unknown> = {};
      for (const key of descriptor.allowedKeys) {
        if (Object.hasOwn(record, key)) params[key] = record[key];
      }
      if (descriptor.kind === "start") {
        return await executeStart(toolCallId, params, signal, onUpdate, ctx);
      }
      // 固定 action 注入：仅在 fail closed 之后执行，调用方 args 不可能携带 action 到这里。
      const input = Object.freeze({ action: descriptor.action, ...params });
      return await executeControl(toolCallId, input, signal, onUpdate, ctx);
    },
  }));
}
