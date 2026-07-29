import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { selectVerificationView } from "./ir/index.mjs";
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
    untrackedFiles: untracked.split("\0").filter((file) => file && !file.startsWith(".pi-subagents/") && !file.startsWith("attempts/")),
    diff,
    changeSetHash: createHash("sha256").update(`${baseCommit}\0${head}\0${diff}`).digest("hex"),
  };
}

function complete(projection, attempts, inspection) {
  return [...projection.tasks.values()].every((task) => ["accepted", "retired"].includes(task.status))
    && [...projection.attempts.values()].every((item) => !["dispatch-requested", "active"].includes(item.status))
    && clean(inspection)
    && attempts.slice(0, 3).every((item) => item.status === "passed");
}

function safeCwd(value) {
  return typeof value === "string" && !path.isAbsolute(value) && !value.includes("\\")
    && !/[\x00-\x1f\x7f?*\[\]{}]/.test(value)
    && (value === "." || (value !== "" && value.split("/").every((segment) => segment && segment !== "." && segment !== "..")));
}

function normalizeGateCommand(entry) {
  if (typeof entry === "string" && entry.trim()) return { command: entry, cwd: ".", timeoutMs: undefined };
  if (!entry || typeof entry !== "object" || typeof entry.command !== "string" || !entry.command.trim()
    || !safeCwd(entry.cwd) || !Number.isSafeInteger(entry.timeoutMs) || entry.timeoutMs <= 0 || entry.timeoutMs > 86_400_000) {
    throw new Error("Plan verification command is invalid");
  }
  return { command: entry.command, cwd: entry.cwd, timeoutMs: entry.timeoutMs };
}

export async function createTaskCommandRegistry({ cwd, ir, legacyPlan }) {
  const approved = ir?.version === "plan-ir.v3"
    ? ir.verification?.commands
    : legacyPlan?.verification?.map((command, index) => ({ id: `contract:verification:${index + 1}`, command }));
  if (!Array.isArray(approved)) throw new Error("Approved contract verification command is invalid");
  const registry = new Map();
  for (const entry of approved) {
    if (!entry || typeof entry.id !== "string" || !entry.id || typeof entry.command !== "string" || !entry.command.trim()) throw new Error("Approved contract verification command is invalid");
    registry.set(entry.id, Object.freeze({ ...entry }));
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

export function resolveTaskVerification({ ir, legacyPlan, taskId, registry }) {
  const v3 = ir?.version === "plan-ir.v3";
  if (!v3 && (!legacyPlan || typeof legacyPlan !== "object")) throw new Error(`Task verification is invalid for ${taskId}`);
  const task = v3 ? ir.nodes?.find((node) => node.id === taskId) : undefined;
  if (v3 && !task) throw new Error(`Task verification is invalid for ${taskId}`);
  const acceptance = v3 ? selectVerificationView(ir, taskId).acceptance : { strategy: "commands", commandIds: legacyPlan.taskVerification?.[taskId] ?? [] };
  if (acceptance.strategy !== "commands") return [];
  if (!Array.isArray(acceptance.commandIds)) throw new Error(`Task verification is invalid for ${taskId}`);
  return acceptance.commandIds.map((id) => {
    const command = registry?.get?.(id);
    if (!command) throw new Error(`Task verification ID is not a registered command: ${id}`);
    if (!v3) return { id: command.id, command: command.command };
    return { id: command.id, command: command.command, cwd: command.cwd ?? ".", timeoutMs: command.timeoutMs ?? task.execution.timeoutMs };
  });
}

export async function runPlanGates({ cwd, baseCommit, projection, commands, audit = async () => ({ findings: [] }), externalReview = async () => ({ available: false, findings: [] }) }) {
  const initial = await inspect(cwd, baseCommit);
  let normalizedCommands;
  try {
    normalizedCommands = Array.isArray(commands) && commands.length > 0 ? commands.map(normalizeGateCommand) : undefined;
  } catch {
    normalizedCommands = undefined;
  }
  const validCommands = Array.isArray(normalizedCommands);
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
      for (const entry of normalizedCommands) await execFile("/bin/sh", ["-c", entry.command], {
        cwd: path.resolve(cwd, entry.cwd),
        ...(entry.timeoutMs === undefined ? {} : { timeout: entry.timeoutMs }),
      });
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
