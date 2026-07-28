import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const TYPES = ["deterministic", "plan-audit", "external-review", "final-completeness"];

async function git(cwd, ...args) {
  const { stdout } = await execFile("git", args, { cwd });
  return stdout.trim();
}

function attempt(type, inputHead, changeSetHash, status, findings = [], evidence = []) {
  return { gateId: crypto.randomUUID(), type, inputHead, changeSetHash, status, evidence, findings };
}

function clean(inspection) {
  return inspection.dirtyTrackedFiles.length === 0 && inspection.untrackedFiles.length === 0;
}

async function inspect(cwd, baseCommit) {
  const [head, status, diff] = await Promise.all([
    git(cwd, "rev-parse", "HEAD"),
    git(cwd, "status", "--porcelain=v1", "-uno"),
    git(cwd, "diff", "--binary", `${baseCommit}..HEAD`),
  ]);
  const { stdout: untracked } = await execFile("git", ["ls-files", "--others", "--exclude-standard", "-z"], { cwd });
  return {
    head,
    dirtyTrackedFiles: status ? status.split("\n") : [],
    untrackedFiles: untracked.split("\0").filter((file) => file && !file.startsWith(".pi-subagents/")),
    diff,
    changeSetHash: createHash("sha256").update(`${baseCommit}\0${head}\0${diff}`).digest("hex"),
  };
}

function complete(projection, attempts, inspection) {
  return [...projection.tasks.values()].every((task) => task.status === "accepted")
    && [...projection.attempts.values()].every((item) => !["dispatch-requested", "active"].includes(item.status))
    && clean(inspection)
    && attempts.slice(0, 3).every((item) => item.status === "passed");
}

export async function createTaskCommandRegistry({ cwd, plan }) {
  const registry = new Map();
  for (const [index, command] of (plan?.verification ?? []).entries()) {
    if (typeof command !== "string" || !command.trim()) throw new Error("Approved contract verification command is invalid");
    registry.set(`contract:verification:${index + 1}`, Object.freeze({
      id: `contract:verification:${index + 1}`,
      command,
    }));
  }
  let packageJson;
  try {
    packageJson = JSON.parse(await readFile(path.join(cwd, "package.json"), "utf8"));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  for (const name of Object.keys(packageJson?.scripts ?? {}).sort()) {
    if (!/^[A-Za-z0-9][A-Za-z0-9:._-]*$/.test(name)) continue;
    registry.set(`package:${name}`, Object.freeze({ id: `package:${name}`, command: `npm run ${name} --` }));
  }
  return registry;
}

export function resolveTaskVerification({ plan, taskId, registry }) {
  const ids = plan?.taskVerification?.[taskId] ?? [];
  if (!Array.isArray(ids)) throw new Error(`Task verification is invalid for ${taskId}`);
  return ids.map((id) => {
    const command = registry?.get?.(id);
    if (!command) throw new Error(`Task verification ID is not a registered command: ${id}`);
    return { id: command.id, command: command.command };
  });
}

export async function runPlanGates({ cwd, baseCommit, projection, commands, audit = async () => ({ findings: [] }), externalReview = async () => ({ available: false, findings: [] }) }) {
  const initial = await inspect(cwd, baseCommit);
  const validCommands = Array.isArray(commands) && commands.length > 0 && commands.every((command) => typeof command === "string" && command.trim() !== "");
  const preflight = initial.diff !== ""
    && clean(initial)
    && initial.head === projection.workspace?.headCommit
    && validCommands
    && [...projection.attempts.values()].every((item) => !["dispatch-requested", "active"].includes(item.status));
  const attempts = [];
  const inputHead = initial.head;
  const changeSetHash = initial.changeSetHash;

  let commandStatus = preflight ? "passed" : "failed";
  if (preflight) {
    try {
      for (const command of commands) await execFile("/bin/sh", ["-c", command], { cwd });
    } catch (error) {
      commandStatus = "failed";
    }
  }
  attempts.push(attempt("deterministic", inputHead, changeSetHash, commandStatus));

  let auditResult;
  try {
    auditResult = await audit({ cwd, inputHead, changeSetHash });
  } catch {
    auditResult = undefined;
  }
  const auditValid = Array.isArray(auditResult?.findings);
  attempts.push(attempt("plan-audit", inputHead, changeSetHash, preflight && auditValid && auditResult.findings.length === 0 ? "passed" : "failed", auditValid ? auditResult.findings : [{ severity: "Important", message: "invalid audit schema" }]));

  let review;
  try {
    review = await externalReview({ cwd, inputHead, changeSetHash, baseCommit });
  } catch {
    review = undefined;
  }
  const reviewFindings = Array.isArray(review?.findings) ? review.findings : [];
  const blocking = reviewFindings.some((finding) => ["Critical", "Important"].includes(finding?.severity));
  attempts.push(attempt("external-review", inputHead, changeSetHash, preflight && review?.available === true && !blocking ? "passed" : review?.available === false ? "unavailable" : "failed", reviewFindings));

  const beforeFinal = await inspect(cwd, baseCommit);
  attempts.push(attempt("final-completeness", inputHead, changeSetHash, complete(projection, attempts, beforeFinal) ? "passed" : "failed"));

  const final = await inspect(cwd, baseCommit);
  if (final.head !== inputHead) {
    for (const result of attempts) result.status = "failed";
    return { validated: false, lifecycle: "running", attempts };
  }
  const validated = attempts.every((result) => result.status === "passed");
  return { validated, lifecycle: validated ? "verifying" : "running", attempts };
}

export { TYPES };
