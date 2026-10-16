/**
 * S3：supervisor 三操作独立模型工具薄 factory。
 *
 * 按已发布 S0 合同（docs/plans/records/2026-10-16-operation-tools/contract.md §2.3/§3）：
 * - `supervisor_request_pending` / `supervisor_request_status` / `supervisor_request_reply`
 *   全部薄委托同一受控 `controlledSupervisorAdapter.execute`，固定 action 由本 factory
 *   注入（schema 不声明 `action`，调用方传入即未知字段，天然不可覆盖）。
 * - 本 factory 不持有新 queue/receipt/flights/observer；串行 flight、commit/compensate、
 *   D2/D3 诊断、native content/isError 全部沿用 adapter 原执行，不复制、不改写。
 * - 字段按 S0 冻结：pending 空、status 仅 `replyTo` 可选（D3 的 requestId 过滤）、
 *   reply `replyTo`/`message` 必填非空、`to` 可选（仅在无控制面/控制面停用路径由 native
 *   兜底解析；受控路径以 `replyTo` 为唯一权威，不新增语义、不加 fallback）。
 * - `subagent_supervisor_inspect`/`_clear` 属 supervisor gate 计划，本 factory 不创建、
 *   不重复注册。
 * - 直连调用（绕过 Host schema 校验）在本层 fail closed：未知字段、缺必填、跨面字段
 *   一律拒绝且不触达 adapter 下游。
 */

const PENDING_ACTION = "pending";
const STATUS_ACTION = "status";
const REPLY_ACTION = "reply";

function operationError(code: string, keypath: string, message: string): Error & { code: string; keypath: string } {
  const error = new Error(message) as Error & { code: string; keypath: string };
  error.code = code;
  error.keypath = keypath;
  return error;
}

/**
 * 严格校验一次工具入参：只允许该操作声明的字段，必填字段必须是非空字符串，
 * 可选字段出现时必须是字符串；返回仅含声明字段的干净对象（固定 action 由调用方注入）。
 * 任何越界即抛错，绝不把未知字段透传给 adapter。
 */
function validateOperationInput(spec, params) {
  if (params === null || typeof params !== "object" || Array.isArray(params)) {
    throw operationError("SUPERVISOR_OPERATION_INVALID_INPUT", "$", "supervisor 操作参数必须是对象");
  }
  const keys = Object.keys(params);
  for (const key of keys) {
    if (!Object.hasOwn(spec.fields, key)) {
      throw operationError(
        "SUPERVISOR_OPERATION_UNKNOWN_FIELD",
        `$.${key}`,
        `supervisor_request_${spec.action} 不支持字段 ${key}`,
      );
    }
  }
  const clean = {};
  for (const key of spec.required) {
    const value = params[key];
    if (typeof value !== "string" || value.length === 0) {
      throw operationError(
        "SUPERVISOR_OPERATION_REQUIRED_FIELD",
        `$.${key}`,
        `supervisor_request_${spec.action} 缺少必填且非空的 ${key}`,
      );
    }
    clean[key] = value;
  }
  for (const key of keys) {
    if (spec.required.includes(key)) continue;
    const value = params[key];
    if (typeof value !== "string") {
      throw operationError(
        "SUPERVISOR_OPERATION_INVALID_FIELD",
        `$.${key}`,
        `supervisor_request_${spec.action} 的 ${key} 必须是字符串`,
      );
    }
    clean[key] = value;
  }
  return clean;
}

export const SUPERVISOR_REQUEST_PENDING_PARAMETERS = Object.freeze({
  type: "object",
  additionalProperties: false,
  properties: {},
});

export const SUPERVISOR_REQUEST_STATUS_PARAMETERS = Object.freeze({
  type: "object",
  additionalProperties: false,
  properties: {
    replyTo: { type: "string", description: "可选；按 requestId 精确过滤只读状态诊断。" },
  },
});

export const SUPERVISOR_REQUEST_REPLY_PARAMETERS = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["replyTo", "message"],
  properties: {
    replyTo: { type: "string", minLength: 1, description: "必填；待决请求的 requestId，受控路径唯一权威定位。" },
    message: { type: "string", minLength: 1, description: "必填；针对该请求原始问题的决策回复正文。" },
    to: { type: "string", description: "可选；仅在无控制面或控制面停用路径由 native 兜底解析，受控路径不消费。" },
  },
});

export const SUPERVISOR_REQUEST_PENDING_DESCRIPTION =
  "列出当前会话下待主代理决策的子代理请求（pending）：无参数，只接受空对象。只读，不消费请求、不投递任何内容；待决列表不证明投递成功，也不代表 child 已消费。";

export const SUPERVISOR_REQUEST_STATUS_DESCRIPTION =
  "查询子代理请求投递状态（status）：无必填参数，可选 replyTo 按 requestId 精确过滤；结果附带只读 supervisorDiagnostic 诊断投影。只读，不消费请求；投影只报告本侧投递事实，queued 不等于 child 已收到或已消费。";

export const SUPERVISOR_REQUEST_REPLY_DESCRIPTION =
  "针对具体待决请求回复决策（reply）：replyTo 与 message 均必填非空；to 为可选，仅在无控制面或控制面停用路径由 native 兜底解析，受控路径以 replyTo 为唯一权威。本工具不代表任何 run 操作。本侧提交只代表提交已记录，不代表子代理已收到、已消费或已理解；投递与消费事实以独立诊断与 child 产出为准。";

export function createSupervisorOperationTools(adapter, { renderCall, renderResult }: {
  renderCall?: unknown;
  renderResult?: unknown;
} = {}) {
  if (!adapter || typeof adapter.execute !== "function") {
    throw new TypeError("supervisor operation tools require an adapter with execute");
  }

  const specs = [
    {
      toolName: "supervisor_request_pending",
      label: "Subagent Supervisor Pending",
      action: PENDING_ACTION,
      fields: {},
      required: [],
      parameters: SUPERVISOR_REQUEST_PENDING_PARAMETERS,
      description: SUPERVISOR_REQUEST_PENDING_DESCRIPTION,
      // pending 只读：请求的决策与投递仍走 reply；不在此消费或锁定请求。
      promptSnippet: "查看当前待主代理决策的子代理请求列表（只读）。",
      promptGuidelines: [
        "pending 只读列出待决请求；决策回复须走 supervisor_request_reply 并针对具体 requestId。",
      ],
    },
    {
      toolName: "supervisor_request_status",
      label: "Subagent Supervisor Status",
      action: STATUS_ACTION,
      fields: { replyTo: true },
      required: [],
      parameters: SUPERVISOR_REQUEST_STATUS_PARAMETERS,
      description: SUPERVISOR_REQUEST_STATUS_DESCRIPTION,
      promptSnippet: "查询子代理请求投递状态，可按 requestId 过滤（只读）。",
      promptGuidelines: [
        "status 是只读诊断投影，不代表 child 已消费；queued 不等于 consumed。",
      ],
    },
    {
      toolName: "supervisor_request_reply",
      label: "Subagent Supervisor Reply",
      action: REPLY_ACTION,
      fields: { replyTo: true, message: true, to: true },
      required: ["replyTo", "message"],
      parameters: SUPERVISOR_REQUEST_REPLY_PARAMETERS,
      description: SUPERVISOR_REQUEST_REPLY_DESCRIPTION,
      // reply 针对实际 request；writeReply 本侧提交不证明投递或 child 消费。
      promptSnippet: "针对具体待决请求回复决策：replyTo 与 message 必填。",
      promptGuidelines: [
        "reply 要针对实际 request 的原始问题作答，replyTo 对应具体待决请求，不泛泛回复。",
        "writeReply 本侧已提交只代表提交已记录，不代表 child 已收到、已消费或理解；以独立 delivery/consumption 事实与 child 实际产出为准。",
      ],
    },
  ];

  const tools = specs.map((spec) => Object.freeze({
    name: spec.toolName,
    exposure: "model-only" as const,
    label: spec.label,
    description: spec.description,
    promptSnippet: spec.promptSnippet,
    promptGuidelines: Object.freeze([...spec.promptGuidelines]),
    parameters: spec.parameters,
    ...(typeof renderCall === "function" ? { renderCall } : {}),
    ...(typeof renderResult === "function" ? { renderResult } : {}),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      // undefined 视为无参（pending 语义）；显式 null 保持非法，交给 validator 拒绝，
      // 不因 ?? {} 把 null 洗成空对象。
      const clean = validateOperationInput(spec, params === undefined ? {} : params);
      // 固定 action 由本 factory 构造新对象注入；调用方参数中不存在 action 字段
      // （schema 未声明、直连调用按未知字段拒绝），因此固定 action 不可覆盖。
      const delegateParams = { action: spec.action, ...clean };
      // raw 结果原样返回：不吞 isError、不改写 content/details，isError 沿 adapter 原执行。
      return adapter.execute(toolCallId, delegateParams, signal, onUpdate, ctx);
    },
  }));

  return Object.freeze(tools);
}

// 供 S4/测试核对固定 action 注入表；不作为第二执行入口。
export const SUPERVISOR_OPERATION_ACTION_BY_TOOL = Object.freeze({
  supervisor_request_pending: PENDING_ACTION,
  supervisor_request_status: STATUS_ACTION,
  supervisor_request_reply: REPLY_ACTION,
});
