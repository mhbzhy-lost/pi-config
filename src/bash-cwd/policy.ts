import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

export function isWithinWorkspace(parent, child) {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

export async function validateDeclaredBashCwd({ cwd, workspaceRoot }) {
  if (typeof cwd !== "string" || cwd.length === 0 || typeof workspaceRoot !== "string" || workspaceRoot.length === 0) {
    throw new Error("bash cwd 必须是存在的目录");
  }

  const resolvedCwd = resolve(workspaceRoot, cwd);
  let canonicalCwd;
  try {
    canonicalCwd = await realpath(resolvedCwd);
  } catch {
    throw new Error("bash cwd 必须是存在的目录");
  }

  let metadata;
  try {
    metadata = await stat(canonicalCwd);
  } catch {
    throw new Error("bash cwd 必须是存在的目录");
  }
  if (!metadata.isDirectory()) throw new Error("bash cwd 必须是目录");
  return canonicalCwd;
}
