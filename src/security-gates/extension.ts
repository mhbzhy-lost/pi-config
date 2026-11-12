import { checkShellPolicy, checkSensitivePath, checkSynchronousBash } from "./shell-policy.ts";

export function createSecurityGatesExtension(pi, {
  shellPolicy = checkShellPolicy,
}: any = {}) {
  pi.on("tool_call", async (event, ctx) => {
    // read/write/edit 的敏感路径门禁与 shell 门禁分开处理。
    const sensitiveViolation = checkSensitivePath({ toolName: event.toolName, input: event.input, cwd: ctx.cwd || "." });
    if (sensitiveViolation) return { block: true, reason: sensitiveViolation.reason };

    if (!["bash", "bash_async"].includes(event.toolName) || typeof event.input?.command !== "string") return undefined;
    const workspaceRoot = ctx.cwd;
    if (!workspaceRoot) return { block: true, reason: "无法取得可信工作目录，安全门禁已按 fail-closed 阻断 bash" };
    if (event.input.cwd !== undefined) return { block: true, reason: "bash 与 bash_async 不支持 cwd 参数，请使用当前会话工作目录" };

    if (event.toolName === "bash") {
      const sleepViolation = checkSynchronousBash(event.input.command, workspaceRoot);
      if (sleepViolation) return { block: true, reason: sleepViolation.reason };
    }

    const violation = shellPolicy({ command: event.input.command, cwd: workspaceRoot, workspaceRoot, env: process.env });
    if (violation) return { block: true, reason: violation.reason };

    return undefined;
  });
}

export default createSecurityGatesExtension;
