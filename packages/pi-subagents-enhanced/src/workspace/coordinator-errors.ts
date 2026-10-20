export type CoordinatorErrorInfo = {
  code?: string;
  detail?: string | { state: string; allowedActions: string[]; nextAction: string };
  keypath?: string;
};

/** 仅投影现有公开错误字段，不序列化 Error、cause 或 stack。 */
export function toCoordinatorErrorInfo(error: unknown): CoordinatorErrorInfo | undefined {
  if (error === null || typeof error !== "object") return undefined;
  const value = error as Record<string, unknown>;
  const info: CoordinatorErrorInfo = {};
  if (typeof value.code === "string") info.code = value.code;
  if (typeof value.keypath === "string") info.keypath = value.keypath;
  const detail = value.detail;
  if (typeof detail === "string") info.detail = detail;
  else if (detail && typeof detail === "object" && !Array.isArray(detail)) {
    const item = detail as Record<string, unknown>;
    if (Object.keys(item).length === 3 && typeof item.state === "string" && typeof item.nextAction === "string"
        && Array.isArray(item.allowedActions) && item.allowedActions.every(action => typeof action === "string")) {
      info.detail = { state: item.state, allowedActions: [...item.allowedActions], nextAction: item.nextAction };
    }
  }
  return Object.keys(info).length ? info : undefined;
}

/** 调用前由严格 Reply schema 校验投影，普通字符串错误仍保持原样。 */
export function fromCoordinatorFailure(message: string, info?: CoordinatorErrorInfo): Error {
  return Object.assign(new Error(message), info);
}
