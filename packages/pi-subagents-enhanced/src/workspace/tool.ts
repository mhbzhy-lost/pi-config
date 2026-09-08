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
export const SUBAGENT_WORKSPACE_DESCRIPTION = "Manage only standalone subagent workspaces owned by the current session. Use status before dispose; use release only after preserve.";

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
    label: "Subagent Workspace",
    description: SUBAGENT_WORKSPACE_DESCRIPTION,
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
          value = scopedService.disposeOwned({ workspaceId: input.workspace_id, ownerScope, disposition: input.disposition, strategy: input.strategy ?? "cherry-pick", reason: input.disposition === "preserve" ? "subagent workspace preserved" : undefined, actionToken: input.action_token });
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
