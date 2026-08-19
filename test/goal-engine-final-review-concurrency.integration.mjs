import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, chmod, lstat, mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createFinalReviewFileStore } from "../scripts/lib/goal-engine/final-review.mjs";

const h = letter => letter.repeat(64);
const approval = { entryId: "entry-concurrency", sessionId: "session-concurrency", source: "user" };
const canonical = value => Array.isArray(value) ? value.map(canonical) : value !== null && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const digest = value => createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
const intent = (overrides = {}) => ({ reviewId: "review-cross-process", idempotencyKey: "review-cross-process", goalId: "goal-concurrency", manifestHash: h("1"), stateHash: h("2"), worldHash: h("3"), head: "a".repeat(40), approval: structuredClone(approval), ...overrides });
function result(base, reportRef) {
  const value = { ...base, severity: "none", status: "recorded", reportRef, residual: null };
  return { ...value, resultHash: digest(value) };
}

const workerSource = `
import { access, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createFinalReviewFileStore } from ${JSON.stringify(new URL("../scripts/lib/goal-engine/final-review.mjs", import.meta.url).href)};
const { stateRoot, operation, value, gate } = JSON.parse(process.env.FINAL_REVIEW_WORKER);
const ready = join(stateRoot, \`.final-review-ready-\${gate}-\${process.pid}\`);
const release = join(stateRoot, \`.final-review-release-\${gate}\`);
await writeFile(ready, "", { mode: 0o600 });
for (;;) { try { await access(release); break; } catch { await new Promise(resolve => setTimeout(resolve, 2)); } }
try {
  const store = createFinalReviewFileStore({ stateRoot });
  await store[operation](value);
  process.stdout.write("success\\n");
} catch (error) {
  if (operation === "persistIntent" || String(error?.message).startsWith("FINAL_REVIEW_INVALID:")) process.stdout.write("conflict\\n");
  else process.exitCode = 1;
}
`;

async function withRoot(fn) {
  const stateRoot = await mkdtemp(join(tmpdir(), "r11-final-review-concurrency-"));
  await chmod(stateRoot, 0o700);
  try { await fn(stateRoot); } finally { await rm(stateRoot, { recursive: true, force: true }); }
}
function startWorker(stateRoot, operation, value, gate) {
  const child = spawn(process.execPath, ["--input-type=module", "--eval", workerSource], {
    env: { ...process.env, FINAL_REVIEW_WORKER: JSON.stringify({ stateRoot, operation, value, gate }) },
    stdio: ["ignore", "pipe", "ignore"],
  });
  let output = "";
  child.stdout.on("data", chunk => { output += chunk; });
  const done = new Promise(resolve => child.once("exit", code => resolve({ code, output })));
  return { child, done };
}
async function waitForBarrier(stateRoot, children, gate) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const ready = await Promise.all(children.map(({ pid }) => access(join(stateRoot, `.final-review-ready-${gate}-${pid}`)).then(() => true, () => false)));
    if (ready.every(Boolean)) return;
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  throw new Error("workers did not reach barrier");
}
async function concurrently(stateRoot, operation, values) {
  const gate = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const workers = values.map(value => startWorker(stateRoot, operation, value, gate));
  await waitForBarrier(stateRoot, workers.map(({ child }) => child), gate);
  await writeFile(join(stateRoot, `.final-review-release-${gate}`), "", { flag: "wx", mode: 0o600 });
  const outcomes = await Promise.all(workers.map(async ({ done }) => {
    const completed = await done;
    assert.equal(completed.code, 0, "worker must report only a contract outcome");
    assert.match(completed.output, /^(success|conflict)\n$/);
    return completed.output.trim();
  }));
  return outcomes;
}
async function assertPrivateRecord(stateRoot, reviewId) {
  assert.equal((await lstat(stateRoot)).mode & 0o777, 0o700);
  assert.equal((await lstat(join(stateRoot, "final-reviews"))).mode & 0o777, 0o700);
  assert.equal((await lstat(join(stateRoot, "final-reviews", `${reviewId}.json`))).mode & 0o777, 0o600);
}

test("separate processes CAS conflicting canonical results instead of last-writer-wins", async () => withRoot(async stateRoot => {
  for (let round = 0; round < 12; round++) {
    const reviewIntent = intent({ reviewId: `review-result-cas-${round}`, idempotencyKey: `review-result-cas-${round}` });
    const store = createFinalReviewFileStore({ stateRoot });
    await store.persistIntent(reviewIntent);
    const candidates = [result(reviewIntent, `sha256:${h("a")}`), result(reviewIntent, `sha256:${h("b")}`)];
    const outcomes = await concurrently(stateRoot, "persistResult", candidates);
    assert.deepEqual([...outcomes].sort(), ["conflict", "success"], `round ${round} must have one winner`);
    const winner = candidates[outcomes.indexOf("success")];
    assert.deepEqual((await store.inspect(reviewIntent.reviewId)).result, winner, `round ${round} must retain its only winner`);
    await assertPrivateRecord(stateRoot, reviewIntent.reviewId);
  }
}));

test("separate processes CAS conflicting intents and preserve exact-intent idempotency", async () => withRoot(async stateRoot => {
  const first = intent({ reviewId: "review-intent-conflict", idempotencyKey: "review-intent-conflict" });
  const second = intent({ reviewId: first.reviewId, idempotencyKey: first.idempotencyKey, goalId: "other-goal" });
  const outcomes = await concurrently(stateRoot, "persistIntent", [first, second]);
  assert.deepEqual([...outcomes].sort(), ["conflict", "success"]);
  const winner = [first, second][outcomes.indexOf("success")];
  assert.deepEqual((await createFinalReviewFileStore({ stateRoot }).inspect(first.reviewId)).intent, winner);
  await assertPrivateRecord(stateRoot, first.reviewId);

  const same = intent({ reviewId: "review-intent-idempotent", idempotencyKey: "review-intent-idempotent" });
  assert.deepEqual(await concurrently(stateRoot, "persistIntent", [same, structuredClone(same)]), ["success", "success"]);
  assert.deepEqual((await createFinalReviewFileStore({ stateRoot }).inspect(same.reviewId)).intent, same);
  await assertPrivateRecord(stateRoot, same.reviewId);
}));
