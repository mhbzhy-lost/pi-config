import { createHash } from "node:crypto";
import { lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { validateObligationFinalizationManifest } from "./finalization.ts";
import { withGoalStateWriterLock } from "./store.ts";

const INTENT_KEYS = ["approval", "goalId", "head", "idempotencyKey", "manifestHash", "reviewId", "stateHash", "worldHash"];
const RESULT_KEYS = [...INTENT_KEYS, "reportRef", "residual", "resultHash", "severity", "status"];
const locks = new Map();
const object = value => value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const hash = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const sameKeys = (value, keys) => object(value) && Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
const canonical = value => Array.isArray(value) ? value.map(canonical) : object(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const digest = value => createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
const same = (left, right) => JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));

function fail(message) { throw new Error(`FINAL_REVIEW_INVALID: ${message}`); }
function approvalOf(value) {
  if (!sameKeys(value, ["entryId", "sessionId", "source"]) || value.source !== "user" || ![value.entryId, value.sessionId].every(item => typeof item === "string" && item)) fail("approval");
  return { entryId: value.entryId, sessionId: value.sessionId, source: "user" };
}
function reviewIdFor(intent) { return `review-${digest({ goalId: intent.goalId, manifestHash: intent.manifestHash, stateHash: intent.stateHash, worldHash: intent.worldHash, head: intent.head, approval: intent.approval })}`; }
function validReviewId(reviewId) { return typeof reviewId === "string" && /^review-[a-z0-9-]{1,127}$/.test(reviewId); }
function assertIntent(value, requireDerived = false) {
  if (!sameKeys(value, INTENT_KEYS) || !validReviewId(value.reviewId) || value.idempotencyKey !== value.reviewId || typeof value.goalId !== "string" || !value.goalId || !hash(value.manifestHash) || !hash(value.stateHash) || !hash(value.worldHash) || !/^[a-f0-9]{40}$/.test(value.head)) fail("intent");
  const approval = approvalOf(value.approval);
  const normalized = { reviewId: value.reviewId, idempotencyKey: value.idempotencyKey, goalId: value.goalId, manifestHash: value.manifestHash, stateHash: value.stateHash, worldHash: value.worldHash, head: value.head, approval };
  if (requireDerived && reviewIdFor(normalized) !== normalized.reviewId) fail("intent identity");
  return normalized;
}
function resultHash(result) { const { resultHash: ignored, ...body } = result; return digest(body); }
function assertResult(value, intent) {
  if (!sameKeys(value, RESULT_KEYS)) fail("result");
  const identity = assertIntent(Object.fromEntries(INTENT_KEYS.map(key => [key, value[key]])));
  if (!same(identity, intent) || !["none", "minor", "important", "critical"].includes(value.severity) || !["recorded", "changes_required"].includes(value.status) || (value.status === "recorded") !== !["important", "critical"].includes(value.severity) || typeof value.reportRef !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value.reportRef) || (value.severity === "minor") !== (value.residual === "minor") || (value.severity !== "minor" && value.residual !== null) || !hash(value.resultHash) || value.resultHash !== resultHash(value)) fail("result identity");
  return { ...identity, severity: value.severity, status: value.status, reportRef: value.reportRef, residual: value.residual, resultHash: value.resultHash };
}
function expectedIntent(manifest, approval) {
  if (!validateObligationFinalizationManifest(manifest) || manifest.complete !== true) fail("manifest");
  const base = { goalId: manifest.goalId, manifestHash: manifest.manifestHash, stateHash: manifest.stateHash, worldHash: manifest.worldHash, head: manifest.head, approval: approvalOf(approval) };
  const reviewId = reviewIdFor(base);
  return { reviewId, idempotencyKey: reviewId, ...base };
}
function assertStore(store) {
  if (!object(store) || Object.keys(store).filter(key => typeof store[key] === "function").sort().join("\0") !== "inspect\0persistIntent\0persistResult" || !["inspect", "persistIntent", "persistResult"].every(key => typeof store[key] === "function")) fail("reviewStore");
}
async function serialized(key, fn) {
  const prior = locks.get(key) ?? Promise.resolve(); let release;
  const tail = new Promise(resolve => { release = resolve; });
  locks.set(key, tail);
  await prior;
  try { return await fn(); }
  finally { release(); if (locks.get(key) === tail) locks.delete(key); }
}
async function withStateWriterLock(stateRoot, fn) {
  // The local queue prevents the synchronous cross-process acquisition from
  // blocking this process while its current async writer is awaiting I/O.
  return serialized(stateRoot, () => withGoalStateWriterLock(stateRoot, fn));
}

export async function runRecoverableFinalReview(input) {
  if (!sameKeys(input, ["approval", "manifest", "provider", "reviewStore"]) || typeof input.provider !== "function") fail("input");
  const { manifest, approval, reviewStore, provider } = input;
  assertStore(reviewStore);
  const intent = expectedIntent(manifest, approval);
  const existing = await reviewStore.inspect(intent.reviewId);
  if (!sameKeys(existing, ["intent", "result"]) || (existing.intent !== null && !object(existing.intent)) || (existing.result !== null && !object(existing.result))) fail("inspect");
  if (existing.intent === null) await reviewStore.persistIntent(intent);
  else if (!same(assertIntent(existing.intent, true), intent)) fail("intent conflict");
  if (existing.result !== null) return assertResult(existing.result, intent);
  let output;
  try { output = await provider({ reviewId: intent.reviewId, idempotencyKey: intent.reviewId, writerLockHeld: false }); }
  catch { return Object.freeze({ ...intent, status: "failed", code: "FINAL_REVIEW_PROVIDER_FAILED" }); }
  if (!object(output) || !["none", "minor", "important", "critical"].includes(output.severity) || typeof output.reportRef !== "string" || !/^sha256:[a-f0-9]{64}$/.test(output.reportRef)) fail("provider output");
  const result = { ...intent, severity: output.severity, status: ["important", "critical"].includes(output.severity) ? "changes_required" : "recorded", reportRef: output.reportRef, residual: output.severity === "minor" ? "minor" : null };
  result.resultHash = resultHash(result);
  const normalized = assertResult(result, intent);
  await reviewStore.persistResult(normalized);
  return Object.freeze(normalized);
}

async function directory(path, mode) {
  let stat;
  try { stat = await lstat(path); } catch (error) { if (error?.code !== "ENOENT") throw error; await mkdir(path, { mode }); stat = await lstat(path); }
  if (stat.isSymbolicLink() || !stat.isDirectory() || (stat.mode & 0o777) !== mode) fail("unsafe directory");
}
async function fsyncPath(path, flags = "r") { const handle = await open(path, flags); try { await handle.sync(); } finally { await handle.close(); } }
async function safeRoot(stateRoot) {
  if (typeof stateRoot !== "string" || !stateRoot) fail("stateRoot");
  const root = await lstat(stateRoot);
  if (root.isSymbolicLink() || !root.isDirectory()) fail("stateRoot");
  const reviews = join(stateRoot, "final-reviews"); await directory(reviews, 0o700); return reviews;
}
async function readRecord(path, reviewId) {
  let stat;
  try { stat = await lstat(path); } catch (error) { if (error?.code === "ENOENT") return { intent: null, result: null }; throw error; }
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600) fail("unsafe record");
  const parsed = JSON.parse(await readFile(path, "utf8"));
  if (!sameKeys(parsed, ["intent", "result"]) || !object(parsed.intent) || (parsed.result !== null && !object(parsed.result))) fail("record");
  const intent = assertIntent(parsed.intent); if (intent.reviewId !== reviewId) fail("record id");
  return { intent, result: parsed.result === null ? null : assertResult(parsed.result, intent) };
}
async function writeNew(path, record, reviews) {
  const handle = await open(path, "wx", 0o600);
  try { await handle.writeFile(`${JSON.stringify(record)}\n`); await handle.sync(); } finally { await handle.close(); }
  await fsyncPath(reviews);
}
async function replaceRecord(path, record, reviews) {
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  const handle = await open(temp, "wx", 0o600);
  try { await handle.writeFile(`${JSON.stringify(record)}\n`); await handle.sync(); } finally { await handle.close(); }
  try { await rename(temp, path); await fsyncPath(reviews); } catch (error) { await unlink(temp).catch(() => {}); throw error; }
}

export function createFinalReviewFileStore({ stateRoot } = {}) {
  async function pathFor(reviewId) { if (!validReviewId(reviewId)) fail("reviewId"); return { reviews: await safeRoot(stateRoot), path: join(stateRoot, "final-reviews", `${reviewId}.json`) }; }
  return Object.freeze({
    async inspect(reviewId) {
      return withStateWriterLock(stateRoot, async () => { const { path } = await pathFor(reviewId); return readRecord(path, reviewId); });
    },
    async persistIntent(value) {
      const intent = assertIntent(value);
      return withStateWriterLock(stateRoot, async () => {
        const { path, reviews } = await pathFor(intent.reviewId);
        const record = await readRecord(path, intent.reviewId);
        if (record.intent) { if (!same(record.intent, intent)) fail("intent conflict"); return; }
        await writeNew(path, { intent, result: null }, reviews);
      });
    },
    async persistResult(value) {
      const reviewId = value?.reviewId;
      return withStateWriterLock(stateRoot, async () => {
        const { path, reviews } = await pathFor(reviewId);
        const record = await readRecord(path, reviewId);
        if (!record.intent) fail("missing intent");
        const result = assertResult(value, record.intent);
        if (record.result) { if (!same(record.result, result)) fail("result conflict"); return; }
        await replaceRecord(path, { intent: record.intent, result }, reviews);
      });
    },
  });
}

// Legacy helpers retain the old surface but now use the safe canonical store.
export async function persistFinalReviewIntent({ stateRoot, intent }) { const store = createFinalReviewFileStore({ stateRoot }); await store.persistIntent(intent); return assertIntent(intent); }
export async function recoverFinalReview({ stateRoot, reviewId }) { return createFinalReviewFileStore({ stateRoot }).inspect(reviewId); }
