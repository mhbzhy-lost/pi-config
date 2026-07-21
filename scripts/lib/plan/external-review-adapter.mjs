import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import path from "node:path";

const execFile = promisify(execFileCallback);
const SKILL_DIR = path.dirname(fileURLToPath(new URL("../../../skill-overrides/external-llm-review/reviewer.py", import.meta.url)));
const REVIEWER = path.join(SKILL_DIR, "reviewer.py");

export function createExternalReviewAdapter({ provider = "idealab-anthropic", reviewerPath = REVIEWER, timeoutMs = 300_000 } = {}) {
  return async function externalReview({ cwd, inputHead, baseCommit }) {
    if (!baseCommit) {
      return { available: false, findings: [], reason: "baseCommit not provided" };
    }

    try {
      const { stdout, stderr } = await execFile(
        "uv",
        ["run", reviewerPath, baseCommit, inputHead, "--provider", provider, "--worktree", cwd],
        { cwd: SKILL_DIR, timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 },
      );
      return { available: true, findings: [], reviewContent: stdout.trim() };
    } catch (error) {
      const stderr = error.stderr || "";
      const message = stderr.includes("ERROR") ? stderr.split("\n").find((l) => l.includes("ERROR")) || error.message : error.message;
      return { available: false, findings: [], reason: message };
    }
  };
}
