import { allowedActionsFor, MANAGED_WORKSPACE_STATES } from "./ledger.ts";

const WORKSPACE_LIST_SCHEMA = {
  type: "object", additionalProperties: false, required: ["action"],
  properties: { action: { const: "list" } },
};
const WORKSPACE_STATUS_SCHEMA = {
  type: "object", additionalProperties: false, required: ["action", "workspace_id"],
  properties: { action: { const: "status" }, workspace_id: { type: "string", minLength: 1, maxLength: 4096 } },
};
const WORKSPACE_DISPOSE_SCHEMA = {
  type: "object", additionalProperties: false, required: ["action", "workspace_id", "disposition", "action_token"],
  properties: {
    action: { const: "dispose" }, workspace_id: { type: "string", minLength: 1, maxLength: 4096 },
    disposition: { enum: ["integrate", "discard", "preserve"] },
    strategy: { enum: ["cherry-pick", "merge"] }, action_token: { type: "string", minLength: 1, maxLength: 4096 },
  },
  allOf: [{ if: { required: ["strategy"] }, then: { properties: { disposition: { const: "integrate" } } } }],
};
const WORKSPACE_RELEASE_SCHEMA = {
  type: "object", additionalProperties: false, required: ["action", "workspace_id"],
  properties: { action: { const: "release" }, workspace_id: { type: "string", minLength: 1, maxLength: 4096 } },
};

export const SUBAGENT_WORKSPACE_PARAMETERS = Object.freeze({
  type: "object", anyOf: [WORKSPACE_LIST_SCHEMA, WORKSPACE_STATUS_SCHEMA, WORKSPACE_DISPOSE_SCHEMA, WORKSPACE_RELEASE_SCHEMA],
});
export const SUBAGENT_WORKSPACE_DESCRIPTION =
  "当 worktree=true 的 subagent 派发返回 workspace_id 且 run 已完成时使用本工具。 " +
  "每个已分配的工作区都必须显式处置，处置选项不固定：以 status 返回的 allowed_dispositions 与 integrate_blocked_reasons 为准，已 released 的即为终态、无需额外处置；先用 action:\"status\" 查看状态、allowed_dispositions 与 integrate_blocked_reasons，再按各状态可执行的动作携带 action_token 操作。 " +
  "publication=allowed 的 coding 托管工作区（Auto Integration）集成由子代理 integration queue 自主拥有：父层对其执行 integrate 会被拒绝（CHILD_OWNS_INTEGRATION），子代理自行发布并释放；并非所有工作区都禁止父层 integrate，publication=forbidden（generic）的工作区能否 integrate 以状态权威返回为准。 " +
  `工作区状态：${MANAGED_WORKSPACE_STATES.join(" | ")}。 ` +
  `各状态下 agent 可执行的动作：${MANAGED_WORKSPACE_STATES.map((state) => `${state}=[${allowedActionsFor(state).join(",") || "none"}]`).join("; ")}。`;

function nonempty(value) { return typeof value === "string" && value.length > 0; }
function failure(code, message, detail = undefined, keypath = undefined) {
  return {
    content: [{ type: "text", text: `${code}: ${message}` }], isError: true,
    details: { code, ...(detail === undefined ? {} : { detail }), ...(keypath === undefined ? {} : { keypath }) },
  };
}
function workspacePublic(value) {
  const workspace = value?.receipt ?? value;
  const allowed = value?.allowedDispositions;
  const blocked = value?.blockedReasons;
  const activeChallenge = workspace?.state === "active" && Array.isArray(allowed) && allowed.length > 0 && nonempty(value?.actionToken);
  return {
    workspace_id: workspace.workspaceId, state: workspace.state, workspace_state: workspace.state, lease_id: workspace.leaseId,
    process_terminal: value?.terminalProof?.state ?? "unknown",
    ...(workspace.dispatchCwd ? { dispatch_cwd: workspace.dispatchCwd } : {}),
    ...(allowed ? { allowed_dispositions: allowed } : {}),
    ...(activeChallenge ? { action_token: value.actionToken } : {}),
    ...(blocked ? { integrate_blocked_reasons: blocked } : {}),
  };
}

export function createSubagentWorkspaceTool({ service, resolveRootSessionId, renderCall, renderResult }) {
  if (!service || typeof resolveRootSessionId !== "function") throw new TypeError("subagent workspace tool requires service and root-session resolver");
  return {
    name: "subagent_worktree",
    exposure: "model-only" as const,
    label: "Subagent Workspace",
    description: SUBAGENT_WORKSPACE_DESCRIPTION,
    // M05B：单工具提示按状态与 token 操作、coding 集成 child-owned；不复制整状态机。
    promptSnippet: "查询与处置 worktree=true 派发返回的托管工作区（list/status/dispose/release）。",
    promptGuidelines: [
      "处置按状态操作：先用 status 取得 state、allowed_dispositions 与 action_token，只执行当前状态允许的动作，不预判动作可用性。",
      "publication=allowed 的 coding 托管工作区集成由子代理自主拥有（父层 integrate 返回 CHILD_OWNS_INTEGRATION），父层只处理状态权威允许的其余处置。",
    ],
    parameters: SUBAGENT_WORKSPACE_PARAMETERS,
    ...(typeof renderCall === "function" ? { renderCall } : {}),
    ...(typeof renderResult === "function" ? { renderResult } : {}),
    async execute(_toolCallId, input, _signal, _onUpdate, ctx) {
      try {
        const rootSessionId = resolveRootSessionId(ctx?.sessionManager);
        if (!nonempty(rootSessionId)) return failure("WORKSPACE_SESSION_ID_UNAVAILABLE", "root session identity is unavailable");
        const ownerScope = Object.freeze({ kind: "standalone-subagent", rootSessionId });
        const scopedService = typeof service === "function" ? service(ownerScope) : service;
        let value;
        if (input?.action === "list") {
          value = scopedService.listOwned({ ownerScope });
          const publicWorkspaces = value.map(workspacePublic);
          return { content: [{ type: "text", text: JSON.stringify(publicWorkspaces) }], isError: false, details: { workspaces: publicWorkspaces } };
        }
        if (input?.action === "status") {
          const status = scopedService.statusOwned({ workspaceId: input.workspace_id, ownerScope });
          value = status.receipt?.state === "active" ? scopedService.issueOwnedDisposition({ workspaceId: input.workspace_id, ownerScope }) : status;
        } else if (input?.action === "dispose") {
          if (input.strategy !== undefined && input.disposition !== "integrate") return failure("INVALID_WORKSPACE_STRATEGY", "strategy is only valid for integrate");
          try {
            value = scopedService.disposeOwned({ workspaceId: input.workspace_id, ownerScope, disposition: input.disposition, strategy: input.strategy ?? "cherry-pick", reason: input.disposition === "preserve" ? "subagent workspace preserved" : undefined, actionToken: input.action_token });
          } catch (error) {
            if (error?.code !== "CHILD_OWNS_INTEGRATION") throw error;
            return failure("CHILD_OWNS_INTEGRATION", error.message);
          }
        } else if (input?.action === "release") {
          value = scopedService.releaseOwned({ workspaceId: input.workspace_id, ownerScope });
        } else return failure("UNSUPPORTED_WORKSPACE_ACTION", "unsupported subagent workspace action");
        const publicWorkspace = workspacePublic(value);
        return { content: [{ type: "text", text: JSON.stringify(publicWorkspace) }], isError: false, details: publicWorkspace };
      } catch (error) {
        return failure(error?.code ?? "MANAGED_WORKSPACE_ERROR", error instanceof Error ? error.message : String(error), error?.detail, error?.keypath);
      }
    },
  };
}
