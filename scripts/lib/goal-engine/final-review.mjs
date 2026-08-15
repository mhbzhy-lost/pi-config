import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

function assertIntent(intent) {
  if (!intent || typeof intent !== "object" || Array.isArray(intent)) throw new Error("final review intent is required");
  for (const key of ["goalId", "reviewId", "manifestHash", "approvalEntryId"]) {
    if (typeof intent[key] !== "string" || !intent[key]) throw new Error(`final review intent ${key} is required`);
  }
  if (!/^[a-f0-9]{64}$/.test(intent.manifestHash)) throw new Error("final review intent manifestHash is invalid");
  return Object.freeze({ goalId: intent.goalId, reviewId: intent.reviewId, manifestHash: intent.manifestHash, approvalEntryId: intent.approvalEntryId });
}

function reviewPath(stateRoot, reviewId) { return join(stateRoot, "final-reviews", `${reviewId}.json`); }

async function writeReview(stateRoot, reviewId, value) {
  await mkdir(join(stateRoot, "final-reviews"), { recursive: true, mode: 0o700 });
  await writeFile(reviewPath(stateRoot, reviewId), `${JSON.stringify(value)}\n`, { mode: 0o600 });
}

export async function persistFinalReviewIntent({ stateRoot, intent }) {
  const normalized = assertIntent(intent);
  if (!stateRoot) return normalized;
  await writeReview(stateRoot, normalized.reviewId, { intent: normalized, result: null });
  return normalized;
}

export async function recoverFinalReview({ stateRoot, reviewId }) {
  if (!stateRoot || typeof reviewId !== "string" || !reviewId) return null;
  try {
    const record = JSON.parse(await readFile(reviewPath(stateRoot, reviewId), "utf8"));
    return { intent: assertIntent(record.intent), result: record.result ?? null };
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

export async function executeFinalReview({ stateRoot, intent, provider }) {
  const normalized = await persistFinalReviewIntent({ stateRoot, intent });
  try {
    const providerResult = await provider({ intent: normalized, writerLockHeld: false });
    const result = { status: "recorded", severity: providerResult?.severity ?? "unknown", summary: providerResult?.summary ?? "" };
    if (stateRoot) await writeReview(stateRoot, normalized.reviewId, { intent: normalized, result });
    return result;
  } catch {
    // Provider text can contain credentials, prompts, and responses; retain only a stable code.
    const result = { status: "failed", code: "FINAL_REVIEW_PROVIDER_FAILED" };
    if (stateRoot) await writeReview(stateRoot, normalized.reviewId, { intent: normalized, result });
    return result;
  }
}
