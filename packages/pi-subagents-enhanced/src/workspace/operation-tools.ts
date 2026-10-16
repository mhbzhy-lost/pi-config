// S2：workspace 每操作独立工具（model-only 四工具薄 factory）。
//
// 架构约束（计划 §2.1/§3、S0 合同 §2.2/§3）：
// - 本文件只是薄操作入口：内部直接构造一次旧 createSubagentWorkspaceTool，
//   四个新定义委托它的同一 execute 闭包；不复制 service 权威、不新建 store、
//   不引入第二执行入口。
// - owner 固定 { kind: "standalone-subagent", rootSessionId }（旧实现从 live ctx 注入），
//   模型不得填 owner/kind/rootSessionId/action。
// - 根 schema 为单 object + additionalProperties:false，不用 anyOf/oneOf/allOf/if-then
//   （root-no-combinator 约束，见 docs/bugs/2026-09-14-glm-empty-tool-args-from-root-union-schema.md）。
// - dispose 的 strategy 仅 integrate 约束：顶层 allOf 早拒已移除，降级为原 runtime
//   INVALID_WORKSPACE_STRATEGY 裁决（旧 execute 内 guard 保持），description 说明。
// - renderer 复用传入引用（新 name→operation 的显示接线归 S4，本文件不产生新渲染逻辑）。
import { createSubagentWorkspaceTool } from "./tool.ts";

const ID_MAX = 4096;
const DISPOSITIONS = Object.freeze(["integrate", "discard", "preserve"]);
const STRATEGIES = Object.freeze(["cherry-pick", "merge"]);

function nonempty(value: unknown): boolean {
  return typeof value === "string" && value.length > 0 && value.length <= ID_MAX;
}

type WorkspaceToolFailure = Readonly<{
  content: [{ type: "text"; text: string }];
  isError: true;
  details: Readonly<{ code: string; keypath?: string }>;
}>;

// 错误 shape 与旧 tool.ts failure() 一致：content 单 text `${code}: ${message}`、
// isError:true、details { code, detail?, keypath? }；code 在对象自身的类型上声明。
function failure(code: string, message: string, keypath?: string): WorkspaceToolFailure {
  return {
    content: [{ type: "text", text: `${code}: ${message}` }],
    isError: true,
    details: { code, ...(keypath === undefined ? {} : { keypath }) },
  };
}

const STRING_FIELD = Object.freeze({ type: "string", minLength: 1, maxLength: ID_MAX });

type FieldRule = Readonly<{ key: string; required: boolean; kind: "string" | "enum"; values?: readonly string[] }>;

function fieldSchema(field: FieldRule) {
  return field.kind === "string" ? { ...STRING_FIELD } : { enum: [...(field.values ?? [])] };
}

type OperationSpec = Readonly<{
  name: string;
  action: "list" | "status" | "dispose" | "release";
  label: string;
  description: string;
  promptSnippet: string;
  promptGuidelines: readonly string[];
  fields: readonly FieldRule[];
}>;

const OPERATIONS: readonly OperationSpec[] = Object.freeze([
  Object.freeze({
    name: "managed_workspace_list",
    action: "list",
    label: "Managed Workspace List",
    description:
      "列出当前 root session 拥有的托管工作区：无参数（只接受空对象），只读投影。" +
      "返回每个工作区的 workspace_id、state、lease_id、process_terminal 等公开字段；" +
      "owner 身份（kind=standalone-subagent、rootSessionId）由工具从实时会话上下文注入，调用方不可指定或覆盖。" +
      "本工具只做名册，具体可处置动作以 managed_workspace_status 实时返回为权威。",
    promptSnippet: "列出当前 root session 拥有的托管工作区（无参数、只读）。",
    promptGuidelines: [
      "list 投影只是名册；allowed_dispositions 与 action_token 以 managed_workspace_status 的实时返回为准，不预判动作可用性。",
    ],
    fields: [],
  }),
  Object.freeze({
    name: "managed_workspace_status",
    action: "status",
    label: "Managed Workspace Status",
    description:
      "查询单个托管工作区的实时状态与允许动作：必填 workspace_id，不接受其他参数。" +
      "返回为权威事实：state、process_terminal、allowed_dispositions、integrate_blocked_reasons；" +
      "当 state=active 且存在允许处置时同时签发一次性 action_token，供 managed_workspace_dispose 携带。" +
      "owner 身份由工具从实时会话上下文注入，调用方不可指定；非本会话拥有的工作区会被 service 拒绝（MANAGED_WORKSPACE_OWNER_SCOPE）。",
    promptSnippet: "查询托管工作区实时状态、allowed_dispositions 与一次性 action_token。",
    promptGuidelines: [
      "处置前先调用本工具，以实时 allowed_dispositions 为唯一权威，只执行当前状态允许的动作，不复用过期返回。",
      "action_token 一次性且绑定当前快照；stale 或重放会被 service 拒（MANAGED_WORKSPACE_ACTION），需重新查询 status。",
    ],
    fields: [Object.freeze({ key: "workspace_id", required: true, kind: "string" })],
  }),
  Object.freeze({
    name: "managed_workspace_dispose",
    action: "dispose",
    label: "Managed Workspace Dispose",
    description:
      "按一次性 token 处置托管工作区：必填 workspace_id、disposition（integrate|discard|preserve）与 managed_workspace_status 签发的 action_token。" +
      "只执行 status 当前 allowed_dispositions 包含的处置；publication=allowed 的 coding 工作区 integrate 由子代理 integration queue 自主拥有，" +
      "本调用会被拒（CHILD_OWNS_INTEGRATION）；其余工作区能否 integrate 同样以 status 实时返回为权威，不在此预判。" +
      "strategy 为可选参数（cherry-pick|merge，缺省 cherry-pick），仅对 integrate 有效：schema 不保留顶层 allOf 条件早拒，" +
      "非 integrate 携带 strategy 由原 runtime 以 INVALID_WORKSPACE_STRATEGY 拒绝，这是明确的 schema 早拒降级为 runtime 裁决，而非语义放宽。" +
      "preserve 的 reason 由 runtime 注入，不作为模型参数。",
    promptSnippet: "携带 status 签发的 action_token 处置工作区（integrate|discard|preserve）。",
    promptGuidelines: [
      "先用 managed_workspace_status 取得 state、allowed_dispositions 与 action_token，只执行当前状态允许的处置，不预判动作可用性。",
      "strategy 仅对 integrate 有效；非 integrate 携带 strategy 由 runtime INVALID_WORKSPACE_STRATEGY 拒绝，不在 schema 层提前判定。",
    ],
    fields: [
      Object.freeze({ key: "workspace_id", required: true, kind: "string" }),
      Object.freeze({ key: "disposition", required: true, kind: "enum", values: DISPOSITIONS }),
      Object.freeze({ key: "strategy", required: false, kind: "enum", values: STRATEGIES }),
      Object.freeze({ key: "action_token", required: true, kind: "string" }),
    ],
  }),
  Object.freeze({
    name: "managed_workspace_release",
    action: "release",
    label: "Managed Workspace Release",
    description:
      "回收处于 preserved 或 cleanup-debt 的托管工作区：必填 workspace_id，不接受其他参数。"
      + "release 是针对这两个状态各自独立可执行的分支，不是 dispose 之后才轮到执行的串联续步："
      + "preserved 可来自 dispose=preserve，也来自 child 结算路径的保留；cleanup-debt 由 service 清理失败时标记；"
      + "released 为终态，无需任何处置动作。active 工作区不能直接 release，当前状态可否 release 以 managed_workspace_status 实时返回为权威；"
      + "非法状态调用会被 service 拒（MANAGED_WORKSPACE_STATE）并附带该状态的允许动作与下一步说明。",
    promptSnippet: "回收 preserved 或 cleanup-debt 工作区（各自独立可执行；released 终态无需动作）。",
    promptGuidelines: [
      "release 适用于 preserved 或 cleanup-debt 两个独立分支状态；不要假设它必须串联在 dispose 之后，也不要用它替代对 active 的处置；released 终态无需任何动作。",
    ],
    fields: [Object.freeze({ key: "workspace_id", required: true, kind: "string" })],
  }),
]);

export const WORKSPACE_OPERATION_TOOL_NAMES: readonly string[] = Object.freeze(
  OPERATIONS.map((operation) => operation.name),
);

function validateOperationInput(operation: OperationSpec, input: unknown): { value?: Record<string, unknown>; error?: WorkspaceToolFailure } {
  // 保持 strict 原始拒绝：null/数组/非对象不得当作空参数（只允许 undefined 或纯对象）。
  if (input !== undefined && (input === null || typeof input !== "object" || Array.isArray(input))) {
    return { error: failure("INVALID_WORKSPACE_TOOL_INPUT", `${operation.name} 参数必须是扁平对象`, "$") };
  }
  const args = (input === undefined ? {} : input) as Record<string, unknown>;
  const allowed = new Set(operation.fields.map((field) => field.key));
  for (const key of Object.keys(args)) {
    if (allowed.has(key)) continue;
    const message = key === "action"
      ? `action 由 ${operation.name} 固定注入为 "${operation.action}"，调用方不可提供或覆盖`
      : `未知参数 "${key}" 不被 ${operation.name} 接受`;
    return { error: failure("INVALID_WORKSPACE_TOOL_INPUT", message, `$.${key}`) };
  }
  const value: Record<string, unknown> = { action: operation.action };
  for (const field of operation.fields) {
    const raw = args[field.key];
    if (raw === undefined) {
      if (field.required) {
        return { error: failure("INVALID_WORKSPACE_TOOL_INPUT", `缺少必填参数 "${field.key}"`, `$.${field.key}`) };
      }
      continue;
    }
    if (field.kind === "string") {
      if (!nonempty(raw)) {
        return { error: failure("INVALID_WORKSPACE_TOOL_INPUT", `参数 "${field.key}" 必须是 1-${ID_MAX} 个字符的非空字符串`, `$.${field.key}`) };
      }
    } else if (!(field.values ?? []).includes(raw as string)) {
      return { error: failure("INVALID_WORKSPACE_TOOL_INPUT", `参数 "${field.key}" 必须是 ${field.values?.join(" | ")}`, `$.${field.key}`) };
    }
    value[field.key] = raw;
  }
  return { value };
}

function schemaFor(operation: OperationSpec) {
  return Object.freeze({
    type: "object",
    additionalProperties: false,
    ...(operation.fields.some((field) => field.required)
      ? { required: operation.fields.filter((field) => field.required).map((field) => field.key) }
      : {}),
    properties: Object.freeze(
      Object.fromEntries(operation.fields.map((field) => [field.key, Object.freeze(fieldSchema(field))])),
    ),
  });
}

export function createWorkspaceOperationTools(
  options: { service: unknown; resolveRootSessionId: (sessionManager: unknown) => string | undefined; renderCall?: unknown; renderResult?: unknown },
) {
  // 只构造一次旧 union 工具：其 execute 是唯一执行闭包（session 解析、owner 注入、
  // service 路由、INVALID_WORKSPACE_STRATEGY/CHILD_OWNS_INTEGRATION 捕获、公开投影全部沿用）。
  const delegated = createSubagentWorkspaceTool(options as never);
  const delegatedExecute = delegated.execute;
  return Object.freeze(OPERATIONS.map((operation) => Object.freeze({
    name: operation.name,
    exposure: "model-only" as const,
    label: operation.label,
    description: operation.description,
    promptSnippet: operation.promptSnippet,
    promptGuidelines: [...operation.promptGuidelines],
    parameters: schemaFor(operation),
    ...(typeof delegated.renderCall === "function" ? { renderCall: delegated.renderCall } : {}),
    ...(typeof delegated.renderResult === "function" ? { renderResult: delegated.renderResult } : {}),
    async execute(toolCallId: unknown, input: unknown, signal: unknown, onUpdate: unknown, ctx: unknown) {
      const decision = validateOperationInput(operation, input);
      if (decision.error) return decision.error;
      // 同一 execute 闭包；固定 action 在上面已注入为 operation 常量的 value.action。
      return delegatedExecute(toolCallId, decision.value, signal, onUpdate, ctx);
    },
  })));
}
