const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_ROUNDS = 2;

export function createPushReviewState({ ttlMs = DEFAULT_TTL_MS } = {}) {
  const entries = new Map();

  function determine({ repoKey, diffHash }) {
    const entry = entries.get(repoKey);
    if (!entry || Date.now() - entry.timestamp > ttlMs) {
      return { action: "run", round: 1 };
    }

    const hasIssues = entry.hasCritical || entry.hasImportant;

    if (entry.diffHash === diffHash) {
      if (hasIssues) {
        if (entry.round >= MAX_ROUNDS) {
          entries.delete(repoKey);
          return { action: "allow", reason: "budget-exhausted" };
        }
        return { action: "deny" };
      }
      return { action: "allow" };
    }

    // diffHash changed
    if (hasIssues && entry.round < MAX_ROUNDS) {
      return { action: "run", round: entry.round + 1 };
    }
    return { action: "run", round: 1 };
  }

  function record({ repoKey, diffHash, hasCritical, hasImportant, round }) {
    entries.set(repoKey, { diffHash, hasCritical, hasImportant, round, timestamp: Date.now() });
  }

  return { determine, record, _entries: entries };
}
