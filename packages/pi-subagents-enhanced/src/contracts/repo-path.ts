// Shared repository-boundary grammar. Callers own their surrounding error contract.
export function normalizeRepoRelativePosixPath(value, location = "path") {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${location} must be a non-empty string`);
  const normalized = value.trim();
  if (normalized.includes("\0") || normalized.includes("\\") || normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized) || normalized.startsWith("\\\\")) {
    throw new Error(`${location} must be a repo-relative POSIX path`);
  }
  const recursive = normalized.endsWith("/**");
  const base = recursive ? normalized.slice(0, -3) : normalized;
  if (!base || base.endsWith("/") || /[*?\[\]]/.test(base)) throw new Error(`${location} contains an unsupported path pattern`);
  const segments = base.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) throw new Error(`${location} must be a repo-relative POSIX path (unsafe segment)`);
  return recursive ? `${segments.join("/")}/**` : segments.join("/");
}
