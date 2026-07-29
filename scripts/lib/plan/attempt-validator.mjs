import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { lstat, mkdir, readlink, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const COMMAND_ID = /^[A-Za-z0-9][A-Za-z0-9:._-]*$/;

async function git(cwd, ...args) {
  const { stdout } = await execFile("git", args, { cwd, encoding: "utf8" });
  return stdout.trim();
}

function rejected(lease, code, detail = {}) {
  return { accepted: false, attemptId: lease.attemptId, baseCommit: lease.baseCommit, code, ...detail };
}

function validOwnedPath(value) {
  if (typeof value !== "string" || !value || value.startsWith("/") || /^[A-Za-z]:/.test(value)
    || value.includes("\\") || /[\x00-\x1f\x7f]/.test(value)) return false;
  const wildcard = value.endsWith("/**");
  const raw = wildcard ? value.slice(0, -3) : value;
  const segments = raw.split("/");
  return raw && segments.every((segment) => segment && segment !== "." && segment !== ".." && segment !== ".git")
    && !(/[?*\[\]{}]/.test(raw));
}

function pathOwned(changedPath, allowedPaths) {
  return allowedPaths.some((allowed) => {
    if (allowed.endsWith("/**")) {
      const prefix = allowed.slice(0, -3).replace(/\/$/, "");
      return changedPath === prefix || changedPath.startsWith(`${prefix}/`);
    }
    return changedPath === allowed;
  });
}

function parseNameStatus(output) {
  const tokens = output.split("\0");
  if (tokens.at(-1) === "") tokens.pop();
  const paths = [];
  for (let index = 0; index < tokens.length;) {
    const status = tokens[index++];
    if (!status) continue;
    if (/^[RC]/.test(status)) {
      if (index + 1 >= tokens.length) throw new Error("Invalid git rename/copy status output");
      paths.push(tokens[index++], tokens[index++]);
    } else {
      if (index >= tokens.length) throw new Error("Invalid git name-status output");
      paths.push(tokens[index++]);
    }
  }
  return [...new Set(paths)].sort();
}

async function hasSymlinkEscape(root, changedPath) {
  const rootReal = await realpath(root);
  const segments = changedPath.split("/");
  let current = root;
  for (const segment of segments) {
    current = path.join(current, segment);
    let metadata;
    try {
      metadata = await lstat(current);
    } catch (error) {
      if (error?.code === "ENOENT") return false;
      throw error;
    }
    if (!metadata.isSymbolicLink()) continue;
    const target = await readlink(current);
    const resolved = path.resolve(path.dirname(current), target);
    let targetReal;
    try {
      targetReal = await realpath(resolved);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      targetReal = resolved;
    }
    const relative = path.relative(rootReal, targetReal);
    if (relative.startsWith("..") || path.isAbsolute(relative)) return true;
  }
  return false;
}

function safeCommandCwd(value) {
  return typeof value === "string" && !path.isAbsolute(value) && !value.includes("\\")
    && !/[\x00-\x1f\x7f?*\[\]{}]/.test(value)
    && (value === "." || (value !== "" && value.split("/").every((segment) => segment && segment !== "." && segment !== "..")));
}

function normalizeVerificationCommand(entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)
    || !COMMAND_ID.test(entry.id ?? "") || typeof entry.command !== "string" || !entry.command.trim()) {
    throw new Error("controlled verification requires registered command objects");
  }
  if (entry.cwd === undefined && entry.timeoutMs === undefined) return { id: entry.id, command: entry.command };
  if (!safeCommandCwd(entry.cwd) || !Number.isSafeInteger(entry.timeoutMs) || entry.timeoutMs <= 0 || entry.timeoutMs > 86_400_000) {
    throw new Error("controlled verification cwd or timeout is invalid");
  }
  return { id: entry.id, command: entry.command, cwd: entry.cwd, timeoutMs: entry.timeoutMs };
}

function validateVerification(verification) {
  if (!Array.isArray(verification)) throw new Error("controlled verification must be an array");
  return verification.map(normalizeVerificationCommand);
}

async function runVerification({ lease, commands }) {
  const evidenceRoot = path.join(
    lease.stateRoot ?? lease.path,
    "var", "plan-runs", lease.planId, "attempts", lease.attemptId, "verification",
  );
  await mkdir(evidenceRoot, { recursive: true });
  const evidence = [];
  for (let index = 0; index < commands.length; index++) {
    const item = commands[index];
    const stdoutPath = path.join(evidenceRoot, `${index + 1}.stdout.log`);
    const stderrPath = path.join(evidenceRoot, `${index + 1}.stderr.log`);
    let stdout = "";
    let stderr = "";
    let exitCode = 0;
    try {
      const result = await execFile("/bin/sh", ["-c", item.command], {
        cwd: item.cwd === undefined ? lease.path : path.resolve(lease.path, item.cwd),
        encoding: "utf8",
        ...(item.timeoutMs === undefined ? {} : { timeout: item.timeoutMs }),
      });
      stdout = result.stdout;
      stderr = result.stderr;
    } catch (error) {
      stdout = typeof error?.stdout === "string" ? error.stdout : "";
      stderr = typeof error?.stderr === "string" ? error.stderr : "";
      exitCode = Number.isInteger(error?.code) ? error.code : 1;
    }
    await Promise.all([
      writeFile(stdoutPath, stdout, { mode: 0o600 }),
      writeFile(stderrPath, stderr, { mode: 0o600 }),
    ]);
    evidence.push({
      kind: "command",
      commandId: item.id,
      command: item.command,
      exitCode,
      stdoutPath,
      stderrPath,
    });
    if (exitCode !== 0) return { passed: false, evidence };
  }
  return { passed: true, evidence };
}

export async function validateAttemptResult({ lease, allowedPaths, verification = [] } = {}) {
  if (!lease || typeof lease.path !== "string" || typeof lease.baseCommit !== "string" || typeof lease.attemptId !== "string") {
    throw new Error("Attempt lease is required");
  }
  if (!Array.isArray(allowedPaths) || allowedPaths.length === 0 || !allowedPaths.every(validOwnedPath)) {
    return rejected(lease, "INVALID_ALLOWED_PATH");
  }
  const commands = validateVerification(verification);
  const resultCommit = await git(lease.path, "rev-parse", "HEAD");
  if (resultCommit === lease.baseCommit) return rejected(lease, "NO_RESULT_COMMIT", { resultCommit });

  try {
    await execFile("git", ["merge-base", "--is-ancestor", lease.baseCommit, resultCommit], { cwd: lease.path });
  } catch (error) {
    if (error?.code === 1) return rejected(lease, "NON_DESCENDANT_HEAD", { resultCommit });
    throw error;
  }

  const revisions = (await git(lease.path, "rev-list", "--parents", `${lease.baseCommit}..${resultCommit}`))
    .split("\n").filter(Boolean);
  if (revisions.length !== 1 || revisions[0].trim().split(/\s+/).length !== 2) {
    return rejected(lease, "INVALID_COMMIT_COUNT", { resultCommit, commitCount: revisions.length });
  }

  const status = await execFile("git", ["status", "--porcelain=v1", "-z"], { cwd: lease.path, encoding: "utf8" });
  const dirty = status.stdout.split("\0").filter((entry) => entry && !entry.slice(3).startsWith(".pi-subagents/"));
  if (dirty.length > 0) return rejected(lease, "DIRTY_WORKTREE", { resultCommit });

  const { stdout: names } = await execFile("git", ["diff", "--name-status", "-z", `${lease.baseCommit}..${resultCommit}`], {
    cwd: lease.path,
    encoding: "utf8",
  });
  const changedPaths = parseNameStatus(names);
  if (changedPaths.length === 0) return rejected(lease, "NO_CHANGED_PATHS", { resultCommit });
  const outside = changedPaths.filter((changedPath) => !validOwnedPath(changedPath) || !pathOwned(changedPath, allowedPaths));
  if (outside.length > 0) return rejected(lease, "PATH_NOT_OWNED", { resultCommit, paths: outside });
  for (const changedPath of changedPaths) {
    if (await hasSymlinkEscape(lease.path, changedPath)) {
      return rejected(lease, "SYMLINK_ESCAPE", { resultCommit, paths: [changedPath] });
    }
  }

  const { stdout: diff } = await execFile("git", ["diff", "--binary", `${lease.baseCommit}..${resultCommit}`], {
    cwd: lease.path,
    encoding: "utf8",
  });
  const diffSha256 = createHash("sha256").update(diff).digest("hex");
  const verificationResult = await runVerification({ lease, commands });
  if (!verificationResult.passed) {
    return rejected(lease, "VERIFICATION_FAILED", {
      resultCommit,
      changedPaths,
      diffSha256,
      evidence: verificationResult.evidence,
    });
  }
  return {
    accepted: true,
    attemptId: lease.attemptId,
    baseCommit: lease.baseCommit,
    resultCommit,
    changedPaths,
    diffSha256,
    evidence: verificationResult.evidence,
  };
}
