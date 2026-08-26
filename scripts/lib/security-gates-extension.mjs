import { checkShellPolicy, checkSensitivePath, codingReminderFor } from "./shell-policy.mjs";
import { validateDeclaredBashCwd } from "./bash-cwd-policy.mjs";
import { createPushReviewState } from "./push-review-state.mjs";
import {
  gatherDiffInfo as defaultGatherDiffInfo,
  runReview as defaultRunReview,
  workspaceReviewBypass as defaultWorkspaceReviewBypass,
  parseSections,
  buildDenyReason,
} from "./review-invoker.mjs";
import { join } from "node:path";

function isRealGitPush(command) {
  return /(^|[;&|]\s*)(?:\S+=\S+\s+)*git\s+(?:-\S+(?:\s+\S+)?\s+)*push(?:\s|$)/.test(command)
    && !/\bgit\s+(?:-\S+(?:\s+\S+)?\s+)*push\s+[^\n]*--dry-run\b/.test(command)
    && !/EXTERNAL_REVIEW_SKIP=(?:1|true|yes|on)\b/i.test(command);
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
  shellPolicy = checkShellPolicy,
  gatherDiffInfo = defaultGatherDiffInfo,
  runReview = defaultRunReview,
  workspaceBypass = defaultWorkspaceReviewBypass,
  reviewerPy,
  envFile,
  configRoot = join(import.meta.dirname, "..", ".."),
} = {}) {
  const reviewState = createPushReviewState();
  const resolvedReviewerPy = reviewerPy || join(configRoot, "skill-overrides", "external-llm-review", "reviewer.py");
  const resolvedEnvFile = envFile || join(configRoot, "skill-overrides", "external-llm-review", ".env");

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

    if (!isRealGitPush(event.input.command)) return undefined;
    if (await workspaceBypass({ cwd })) return undefined;

    const diffInfo = await gatherDiffInfo({ cwd });
    if (diffInfo.exempt) return undefined;

    const repoKey = cwd;
    const decision = reviewState.determine({ repoKey, diffHash: diffInfo.diffHash });

    if (decision.action === "allow") return undefined;
    if (decision.action === "deny") {
      return { block: true, reason: buildDenyReason({ reviewOutput: "(未修复上次 review 发现的问题 — 请先 commit 修复再 push)", range: diffInfo.range, cwd, fileCount: diffInfo.fileCount }) };
    }

    // action === "run"
    const { output } = await runReview({ cwd, baseRef: diffInfo.baseRef, round: decision.round, reviewerPy: resolvedReviewerPy, envFile: resolvedEnvFile });

    if (!output) return undefined; // reviewer unavailable → fail-open

    const sections = parseSections(output);
    reviewState.record({ repoKey, diffHash: diffInfo.diffHash, hasCritical: sections.hasCritical, hasImportant: sections.hasImportant, round: decision.round });

    if (sections.hasCritical || sections.hasImportant) {
      return { block: true, reason: buildDenyReason({ reviewOutput: output, range: diffInfo.range, cwd, fileCount: diffInfo.fileCount }) };
    }
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
