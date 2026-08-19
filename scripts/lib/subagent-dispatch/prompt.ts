import { CodingDispatchContractError } from "./ir.ts";

export const MAX_CODING_DISPATCH_PROMPT_BYTES = 64 * 1024;

function scalar(value) {
  return JSON.stringify(value);
}

function ordered(items) {
  if (items.length === 0) return "_None declared._";
  return items.map((item, index) => `${index + 1}. ${scalar(item)}`).join("\n");
}

export function renderCodingDispatchPrompt(ir) {
  const workflowReason = ir.workflow.reason === undefined
    ? ""
    : `\n- Exemption reason: ${scalar(ir.workflow.reason)}`;
  const prompt = [
    "# Coding Dispatch Contract v1",
    "",
    "## Identity",
    `- Version: \`${ir.version}\``,
    `- Task ID: ${scalar(ir.taskId)}`,
    `- Title: ${scalar(ir.title)}`,
    `- Agent: \`${ir.agent}\``,
    `- Requested model tier: \`${ir.modelTier}\``,
    `- Risk: \`${ir.risk}\``,
    `- Working directory: ${scalar(ir.execution.cwd)}`,
    `- Timeout: \`${ir.execution.timeoutMs}ms\``,
    ...(ir.execution.worktree === true ? ["- Managed worktree: `true`"] : []),
    `- Contract SHA-256: \`${ir.hash}\``,
    "",
    "## Objective",
    scalar(ir.objective),
    "",
    "## Requirements",
    ordered(ir.requirements),
    "",
    "## Authoritative Known Facts",
    ordered(ir.context.knownFacts),
    "",
    "## Decisions Already Made",
    ordered(ir.context.decisions),
    "",
    "## Relevant Files",
    ordered(ir.context.relevantFiles),
    "",
    "## Declared Write Scope",
    ordered(ir.boundaries.writePaths),
    "",
    "Modify only the declared write paths. They are a contract and acceptance boundary, not an OS sandbox. Escalate before changing any other path.",
    "",
    "## Excluded Work",
    ordered(ir.boundaries.excludedWork),
    "",
    "## Forbidden Actions",
    ordered(ir.boundaries.forbiddenActions),
    "",
    "## Workflow",
    `- Mode: \`${ir.workflow.mode}\`${workflowReason}`,
    "- Follow the selected workflow exactly and preserve its evidence.",
    "",
    "## Acceptance Criteria",
    ordered(ir.acceptance.criteria),
    "",
    "## Escalation",
    "If required information or an unapproved decision is missing, use `contact_supervisor` when available and return `NEEDS_CONTEXT`. Do not substitute broad exploration for missing context or revisit decisions already recorded above.",
    "",
    "## Required Report",
    "Return a compact final report containing:",
    "1. status (`completed` or `NEEDS_CONTEXT`)",
    "2. files changed",
    "3. RED/GREEN or exemption evidence",
    "4. commands and results",
    "5. residual risks",
  ].join("\n");

  const bytes = Buffer.byteLength(prompt, "utf8");
  if (bytes > MAX_CODING_DISPATCH_PROMPT_BYTES) {
    throw new CodingDispatchContractError(
      "PROMPT_TOO_LARGE",
      `coding dispatch prompt exceeds ${MAX_CODING_DISPATCH_PROMPT_BYTES} bytes`,
      String(bytes),
    );
  }
  return prompt;
}
