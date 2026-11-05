import path from "node:path";
import { tmpdir, userInfo } from "node:os";
// 复用上游 recovery descriptor 读取器（按任务合同禁止复制实现）。pi-subagents 的
// package exports 未开放该子路径；本 package 以 bundleDependencies 将
// node_modules/pi-subagents 物化为 package 内固定闭包（scripts/verify-package.ts
// 校验该闭包与 registry 版本一致），因此按 package 内相对文件路径消费；上游版本
// 由 package.json dependencies 精确锚定（0.84.0；该未开放子路径在 0.84.0 仍存在，由 verify-package 闭包门禁把守）。
import { readAsyncRecoveryDescriptor } from "../../node_modules/pi-subagents/src/runs/background/async-resume.js";

/**
 * managed resume 复活目标的 descriptor 读取结果：
 * - absent：目标 asyncDir 无 recovery-descriptor.json（上游 resume 自会拒绝或按
 *   非 descriptor 语义处理）；
 * - unreadable：descriptor 存在但非法（解析/校验失败），由上游 resume 以原始
 *   错误失败，本层不代写语义；
 * - read：成功读取的 descriptor 原始投影。
 */
export type ResumeTargetDescriptorRead =
  | { status: "absent" }
  | { status: "unreadable"; error: unknown }
  | { status: "read"; descriptor: any };

/** 读取复活目标 asyncDir 的 recovery descriptor；任何失败都以状态返回，不抛出。 */
export function readResumeTargetDescriptor(asyncDir: string): ResumeTargetDescriptorRead {
  try {
    const descriptor = readAsyncRecoveryDescriptor(asyncDir);
    return descriptor === undefined ? { status: "absent" } : { status: "read", descriptor };
  } catch (error) {
    return { status: "unreadable", error };
  }
}

/**
 * 判定 descriptor 是否携带 Root Broker 身份绑定。
 * requiredExtensions 由 Host 全局注册，generic child 同样继承；无 root binding
 * 时这些扩展依法禁用，扩展名称只能用于诊断，不能证明 managed coding 身份。
 * root 命名空间一旦存在（包括无效绑定）就必须进入 managed 门禁，不静默放行。
 */
export function descriptorBrokerBindingReplay(descriptor: any): { replays: boolean; rootBinding: boolean; brokerRequiredExtension: boolean } {
  const bindings = descriptor?.extensionBindings;
  const rootBinding = Boolean(bindings) && typeof bindings === "object" && !Array.isArray(bindings)
    && Object.hasOwn(bindings as Record<string, unknown>, "pi-config.root/1");
  const required = Array.isArray(descriptor?.requiredExtensions) ? descriptor.requiredExtensions : [];
  const brokerRequiredExtension = required.some((entry: any) => typeof entry?.path === "string"
    && /(?:^|[/\\])(?:integration-queue|root-session-owner)\.ts$/.test(entry.path));
  return { replays: rootBinding, rootBinding, brokerRequiredExtension };
}

function sanitizeTempScopeSegment(value: string): string {
  const sanitized = value.trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return sanitized || "unknown";
}

/**
 * 推导上游 async run 根目录（与 pi-subagents src/shared/types.js 的
 * TEMP_ROOT_DIR/ASYNC_DIR/resolveTempScopeId 保持同一算法）：显式
 * PI_SUBAGENTS_TEMP_ROOT 优先；缺省为 os.tmpdir() 下 pi-subagents-<scope>，
 * scope 依次回退 uid-<getuid>、user-<USERNAME|USER|LOGNAME>、
 * user-<os.userInfo().username>、shared。上游 resume 即按
 * <根>/<runId> 定位复活目标，本层判定必须使用同一路径事实。
 */
export function resolveAsyncRunsRootDir(): string {
  const configured = process.env.PI_SUBAGENTS_TEMP_ROOT?.trim();
  const tempRoot = configured ? path.resolve(configured) : path.join(tmpdir(), `pi-subagents-${resolveTempScopeId()}`);
  return path.join(tempRoot, "async-subagent-runs");
}

function resolveTempScopeId(): string {
  if (typeof process.getuid === "function") return `uid-${process.getuid()}`;
  for (const key of ["USERNAME", "USER", "LOGNAME"]) {
    const value = process.env[key];
    if (value) return `user-${sanitizeTempScopeSegment(value)}`;
  }
  try {
    const username = userInfo()?.username;
    if (username) return `user-${sanitizeTempScopeSegment(username)}`;
  } catch { /* userInfo 不可用时与上游一致回退 shared */ }
  return "shared";
}
