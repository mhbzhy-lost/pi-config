import { checkShellPolicy, codingReminderFor } from "./shell-policy.mjs";
import { runExternalReview as defaultRunExternalReview } from "./external-review-runner.mjs";
import { join } from "node:path";

function isRealGitPush(command) {
  return /(^|[;&|]\s*)(?:\S+=\S+\s+)*git\s+(?:-\S+(?:\s+\S+)?\s+)*push(?:\s|$)/.test(command) && !/\bgit\s+(?:-\S+(?:\s+\S+)?\s+)*push\s+[^\n]*--dry-run\b/.test(command) && !/EXTERNAL_REVIEW_SKIP=(?:1|true|yes|on)\b/i.test(command);
}

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
  runExternalReview = defaultRunExternalReview,
  hookPath,
  logPath,
  configRoot = join(import.meta.dirname, "..", ".."),
} = {}) {
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "bash" || typeof event.input?.command !== "string") return undefined;
    const cwd = ctx.cwd;
    if (!cwd) return { block: true, reason: "无法取得可信工作目录，安全门禁已按 fail-closed 阻断 bash" };
    const violation = checkShellPolicy({
      command: event.input.command,
      cwd,
      workspaceRoot: ctx.cwd,
      env: process.env,
    });
    if (violation) return { block: true, reason: violation.reason };
    if (!isRealGitPush(event.input.command)) return undefined;
    const result = await runExternalReview({
      hookPath: hookPath || join(import.meta.dirname, "..", "hooks", "external-review-gate.sh"),
      command: event.input.command,
      cwd,
      logPath: logPath || join(configRoot, "var", "logs", "external-review-gate.log"),
    });
    return result.block ? { block: true, reason: result.reason } : undefined;
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
