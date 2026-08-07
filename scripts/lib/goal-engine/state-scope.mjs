import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

const IDENTITY_SCHEMA = "goal-engine.cwd-identity.v1";
const MAX_READABLE_BYTES = 200;

function codedError(code, message) {
  return Object.assign(new Error(`${code}: ${message}`), { code });
}

function truncateUtf8(value, maxBytes) {
  let bytes = 0;
  let result = "";
  for (const character of value) {
    const width = Buffer.byteLength(character, "utf8");
    if (bytes + width > maxBytes) break;
    result += character;
    bytes += width;
  }
  return result;
}

export function canonicalGoalCwd(cwd) {
  if (typeof cwd !== "string" || !isAbsolute(cwd)) {
    throw codedError("INVALID_GOAL_CWD", "Goal cwd must be an absolute path");
  }
  return realpathSync(cwd);
}

export function cwdNamespace(canonicalCwd) {
  if (typeof canonicalCwd !== "string" || !isAbsolute(canonicalCwd)) {
    throw codedError("INVALID_GOAL_CWD", "canonical Goal cwd must be an absolute path");
  }
  const readable = canonicalCwd.replace(/^[/\\]+/, "").replace(/[/\\:]/g, "-") || "root";
  const label = truncateUtf8(readable, MAX_READABLE_BYTES);
  const digest = createHash("sha256").update(canonicalCwd).digest("hex").slice(0, 16);
  return `--${label}--_${digest}`;
}

export function resolveGoalStateScope({ cwd, env = process.env }) {
  const canonicalCwd = canonicalGoalCwd(cwd);
  const namespace = cwdNamespace(canonicalCwd);
  const legacyRoot = join(canonicalCwd, ".state", "goal-engine");
  const configuredRoot = env?.PI_CODING_GOAL_DIR;
  if (!configuredRoot) {
    return {
      cwd: canonicalCwd,
      namespace,
      preferredRoot: legacyRoot,
      legacyRoot,
      storage: "legacy",
      identity: { schemaVersion: IDENTITY_SCHEMA, canonicalCwd, namespace },
    };
  }
  if (!isAbsolute(configuredRoot)) {
    throw codedError("INVALID_GOAL_STATE_ROOT", "PI_CODING_GOAL_DIR must be an absolute path");
  }
  return {
    cwd: canonicalCwd,
    namespace,
    preferredRoot: join(resolve(configuredRoot), namespace),
    legacyRoot,
    storage: "global",
    identity: { schemaVersion: IDENTITY_SCHEMA, canonicalCwd, namespace },
  };
}

export function ensureGoalStateIdentity(scope) {
  if (scope.storage !== "global" || scope.preferredRoot === scope.legacyRoot) return;
  mkdirSync(scope.preferredRoot, { recursive: true, mode: 0o700 });
  const identityPath = join(scope.preferredRoot, "identity.json");
  const expectedBytes = `${JSON.stringify(scope.identity, null, 2)}\n`;

  const directoryBefore = lstatSync(scope.preferredRoot);
  if (!directoryBefore.isDirectory() || directoryBefore.isSymbolicLink() || (directoryBefore.mode & 0o777) !== 0o700) {
    throw codedError("GOAL_STATE_IDENTITY_INSECURE", `namespace directory is not a private non-symlink directory: ${scope.preferredRoot}`);
  }

  try {
    writeFileSync(identityPath, expectedBytes, { encoding: "utf8", flag: "wx", mode: 0o600 });
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }

  let descriptor;
  let observed;
  try {
    const pathMetadata = lstatSync(identityPath);
    if (pathMetadata.isSymbolicLink()) {
      throw codedError("GOAL_STATE_IDENTITY_INSECURE", `identity path is a symbolic link: ${identityPath}`);
    }
    descriptor = openSync(identityPath, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const fileMetadata = fstatSync(descriptor);
    if (!fileMetadata.isFile() || (fileMetadata.mode & 0o777) !== 0o600) {
      throw codedError("GOAL_STATE_IDENTITY_INSECURE", `identity is not a private regular file: ${identityPath}`);
    }
    observed = JSON.parse(readFileSync(descriptor, "utf8"));
    const directoryAfter = lstatSync(scope.preferredRoot);
    if (directoryAfter.dev !== directoryBefore.dev || directoryAfter.ino !== directoryBefore.ino
      || !directoryAfter.isDirectory() || directoryAfter.isSymbolicLink() || (directoryAfter.mode & 0o777) !== 0o700) {
      throw codedError("GOAL_STATE_IDENTITY_INSECURE", `namespace directory identity changed during verification: ${scope.preferredRoot}`);
    }
  } catch (error) {
    if (error?.code === "GOAL_STATE_IDENTITY_INSECURE") throw error;
    throw codedError("GOAL_STATE_IDENTITY_MISMATCH", `identity at ${identityPath} is unreadable: ${error.message}`);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
  if (JSON.stringify(observed) !== JSON.stringify(scope.identity)) {
    throw codedError(
      "GOAL_STATE_IDENTITY_MISMATCH",
      `identity at ${identityPath} does not match cwd ${scope.identity.canonicalCwd}; observed=${JSON.stringify(observed)}`,
    );
  }
}

function selection(root, scope) {
  return { root, storage: root === scope.preferredRoot && scope.storage === "global" ? "global" : "legacy" };
}

export function selectGoalStateRoot(scope, { operation, goalId, listActive, hasGoal }) {
  if (!new Set(["init", "read", "mutate"]).has(operation)) {
    throw codedError("INVALID_GOAL_STATE_OPERATION", `unsupported operation: ${operation}`);
  }
  if (scope.preferredRoot === scope.legacyRoot || scope.storage !== "global") {
    return { root: scope.legacyRoot, storage: "legacy" };
  }
  if (typeof listActive !== "function" || typeof hasGoal !== "function") {
    throw codedError("INVALID_GOAL_STATE_INSPECTOR", "listActive and hasGoal are required");
  }

  if (goalId) {
    const inGlobal = Boolean(hasGoal(scope.preferredRoot, goalId));
    const inLegacy = Boolean(hasGoal(scope.legacyRoot, goalId));
    if (inGlobal && inLegacy) {
      throw codedError("GOAL_STATE_IDENTITY_CONFLICT", `goal ${goalId} exists in both global and legacy state roots`);
    }
    if (inGlobal) return selection(scope.preferredRoot, scope);
    if (inLegacy) return selection(scope.legacyRoot, scope);
  }

  const globalActive = listActive(scope.preferredRoot) || [];
  const legacyActive = listActive(scope.legacyRoot) || [];
  if (globalActive.length > 0 && legacyActive.length > 0) {
    throw codedError(
      "GOAL_STATE_ROOT_CONFLICT",
      `global and legacy state roots both contain active Goals: global=${globalActive.join(",")}; legacy=${legacyActive.join(",")}`,
    );
  }
  if (globalActive.length > 0) return selection(scope.preferredRoot, scope);
  if (legacyActive.length > 0) return selection(scope.legacyRoot, scope);
  return selection(scope.preferredRoot, scope);
}
