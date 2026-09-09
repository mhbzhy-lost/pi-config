import { checkShellPolicy, checkSensitivePath, codingReminderFor } from "./shell-policy.ts";
import { validateDeclaredBashCwd } from "../bash-cwd/policy.ts";

function appendReminder(content, reminder) {
  let appended = false;
  const nextContent = content.map((part) => {
    if (appended || part?.type !== "text" || typeof part.text !== "string") return part;
    appended = true;
    return { ...part, text: `${part.text}\n\n${reminder}` };
  });
  return appended ? nextContent : undefined;
}

export function createSecurityGatesExtension(pi, {
  shellPolicy = checkShellPolicy,
}: any = {}) {
  pi.on("tool_call", async (event, ctx) => {
    // Check sensitive path access for read/write/edit tools
    const sensitiveViolation = checkSensitivePath({ toolName: event.toolName, input: event.input, cwd: ctx.cwd || "." });
    if (sensitiveViolation) return { block: true, reason: sensitiveViolation.reason };

    if (event.toolName !== "bash" || typeof event.input?.command !== "string") return undefined;
    const workspaceRoot = ctx.cwd;
    if (!workspaceRoot) return { block: true, reason: "无法取得可信工作目录，安全门禁已按 fail-closed 阻断 bash" };
    let cwd = workspaceRoot;
    if (event.input.cwd !== undefined) {
      try {
        cwd = await validateDeclaredBashCwd({ cwd: event.input.cwd, workspaceRoot });
      } catch (error) {
        return { block: true, reason: error instanceof Error ? error.message : "声明的 bash cwd 无效，安全门禁已阻断" };
      }
    }

    const violation = shellPolicy({ command: event.input.command, cwd, workspaceRoot, env: process.env });
    if (violation) return { block: true, reason: violation.reason };

    return undefined;
  });

  pi.on("tool_result", (event) => {
    if (event.isError) return undefined;
    const reminder = codingReminderFor({ toolName: event.toolName, input: event.input });
    if (!reminder || !Array.isArray(event.content)) return undefined;
    const content = appendReminder(event.content, reminder);
    if (!content) return undefined;
    return { content, details: event.details, isError: event.isError };
  });
}

export default createSecurityGatesExtension;
