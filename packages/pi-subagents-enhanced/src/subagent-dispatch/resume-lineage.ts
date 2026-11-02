import path from "node:path";
import { tmpdir, userInfo } from "node:os";
// 复用上游 recovery descriptor 读取器（按任务合同禁止复制实现）。pi-subagents 的
// package exports 未开放该子路径；本 package 以 bundleDependencies 将
// node_modules/pi-subagents 物化为 package 内固定闭包（scripts/verify-package.ts
// 校验该闭包与 registry 版本一致），因此按 package 内相对文件路径消费；上游版本
// 由 package.json dependencies 精确锚定（0.80.0）。
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
 * 判定 descriptor 复活时是否会重放 Root Broker 绑定装配：
 * - extensionBindings 含 `pi-config.root/1` 命名空间（child 装载期要求解析
 *   broker 身份，见 child-extensions/integration-queue.ts 的装载期分支）；
 * - 或 requiredExtensions 含 integration-queue.ts / root-session-owner.ts
 *   （二者均以 broker 身份可用为启用前提）。
 * 命中任一即表示：宿主若不为当次新 run 写入 owner receipt（processBirth 匹配），
 * required 扩展装载必然在 5s 轮询超时后失败。
 */
export function descriptorBrokerBindingReplay(descriptor: any): { replays: boolean; rootBinding: boolean; brokerRequiredExtension: boolean } {
  const bindings = descriptor?.extensionBindings;
  const rootBinding = Boolean(bindings) && typeof bindings === "object" && !Array.isArray(bindings)
    && Object.hasOwn(bindings as Record<string, unknown>, "pi-config.root/1");
  const required = Array.isArray(descriptor?.requiredExtensions) ? descriptor.requiredExtensions : [];
  const brokerRequiredExtension = required.some((entry: any) => typeof entry?.path === "string"
    && /(?:^|[/\\])(?:integration-queue|root-session-owner)\.ts$/.test(entry.path));
  return { replays: rootBinding || brokerRequiredExtension, rootBinding, brokerRequiredExtension };
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
