import { createHash } from "node:crypto";
import { lstat, mkdir, open, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";

const SEVERITIES = new Set(["none", "minor", "important", "critical"]);
const plainObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : plainObject(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
const same = (left: unknown, right: unknown) => JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
function invalid(message: string): never { throw new Error(`FINAL_REVIEW_PROVIDER_INVALID: ${message}`); }

export type FinalReviewProviderInput = Readonly<{
  manifest: Readonly<Record<string, unknown>>;
  approval: Readonly<{ entryId: string; sessionId: string; source: "user" }>;
  reviewId: string;
  idempotencyKey: string;
  writerLockHeld: false;
}>;
export type ProductionFinalReviewProvider = (input: FinalReviewProviderInput) => Promise<Readonly<{ severity: "none" | "minor" | "important" | "critical"; reportRef: `sha256:${string}` }>>;

async function directory(path: string) {
  try { const stat = await lstat(path); if (stat.isSymbolicLink() || !stat.isDirectory() || (stat.mode & 0o777) !== 0o700) invalid("unsafe report directory"); }
  catch (error: any) { if (error?.code !== "ENOENT") throw error; await mkdir(path, { recursive: true, mode: 0o700 }); const stat = await lstat(path); if (stat.isSymbolicLink() || !stat.isDirectory() || (stat.mode & 0o777) !== 0o700) invalid("unsafe report directory"); }
}
async function safeRecord(path: string) {
  const stat = await lstat(path);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600) invalid("unsafe report record");
  return JSON.parse(await readFile(path, "utf8"));
}

export function createFinalReviewReportStore({ stateRoot }: Readonly<{ stateRoot: string }>) {
  if (typeof stateRoot !== "string" || !stateRoot) invalid("stateRoot");
  const root = join(stateRoot, "final-review-reports");
  return Object.freeze({
    async persist(input: Readonly<{ reviewId: string; manifestHash: string; approval: Readonly<{ entryId: string; sessionId: string; source: "user" }>; content: string }>): Promise<`sha256:${string}`> {
      if (!plainObject(input) || Object.keys(input).sort().join("\0") !== ["approval", "content", "manifestHash", "reviewId"].join("\0") || typeof input.reviewId !== "string" || !input.reviewId || !/^[a-f0-9]{64}$/.test(input.manifestHash) || typeof input.content !== "string" || !plainObject(input.approval) || Object.keys(input.approval).sort().join("\0") !== ["entryId", "sessionId", "source"].join("\0") || input.approval.source !== "user" || typeof input.approval.entryId !== "string" || !input.approval.entryId || typeof input.approval.sessionId !== "string" || !input.approval.sessionId) invalid("report input");
      const state = await lstat(stateRoot); if (state.isSymbolicLink() || !state.isDirectory()) invalid("unsafe stateRoot");
      const sha = join(root, "sha256"), byReview = join(root, "by-review"); await directory(root); await directory(sha); await directory(byReview);
      const record = { reviewId: input.reviewId, manifestHash: input.manifestHash, approval: input.approval, content: input.content };
      const ref = `sha256:${digest(record)}` as `sha256:${string}`, recordPath = join(sha, `${ref.slice(7)}.json`), indexPath = join(byReview, `${input.reviewId}.json`);
      try { const existing = await safeRecord(indexPath); if (!same(existing, { reviewId: input.reviewId, manifestHash: input.manifestHash, approval: input.approval, reportRef: ref })) invalid("report conflict"); return ref; } catch (error: any) { if (error?.code !== "ENOENT") throw error; }
      try { const handle = await open(recordPath, "wx", 0o600); try { await handle.writeFile(`${JSON.stringify(record)}\n`); await handle.sync(); } finally { await handle.close(); } } catch (error: any) { if (error?.code !== "EEXIST" || !same(await safeRecord(recordPath), record)) throw error; }
      const index = { reviewId: input.reviewId, manifestHash: input.manifestHash, approval: input.approval, reportRef: ref };
      try { const handle = await open(indexPath, "wx", 0o600); try { await handle.writeFile(`${JSON.stringify(index)}\n`); await handle.sync(); } finally { await handle.close(); } } catch (error: any) { if (error?.code !== "EEXIST" || !same(await safeRecord(indexPath), index)) invalid("report conflict"); }
      return ref;
    },
  });
}

function outputFrom(session: any) {
  const message = [...session.messages].reverse().find((entry: any) => entry?.role === "assistant");
  const content = message?.content;
  const text = typeof content === "string" ? content : Array.isArray(content) && content.length === 1 && content[0]?.type === "text" && typeof content[0].text === "string" ? content[0].text : null;
  if (text === null) invalid("model output");
  let parsed: unknown; try { parsed = JSON.parse(text); } catch { invalid("model JSON"); }
  if (!plainObject(parsed) || Object.keys(parsed).sort().join("\0") !== "report\0severity" || !SEVERITIES.has(parsed.severity as string) || typeof parsed.report !== "string") invalid("model output");
  return parsed as { severity: "none" | "minor" | "important" | "critical"; report: string };
}

export function createProductionFinalReviewProvider(options: Readonly<{ modelRuntime: any; model: any; timeoutMs: number; reportStore: ReturnType<typeof createFinalReviewReportStore> }>): ProductionFinalReviewProvider {
  if (!plainObject(options) || !options.modelRuntime || !options.model || !Number.isInteger(options.timeoutMs) || options.timeoutMs <= 0 || typeof options.reportStore?.persist !== "function") invalid("options");
  return async input => {
    if (!plainObject(input) || Object.keys(input).sort().join("\0") !== ["approval", "idempotencyKey", "manifest", "reviewId", "writerLockHeld"].join("\0") || input.idempotencyKey !== input.reviewId || input.writerLockHeld !== false) invalid("input");
    const { session } = await createAgentSession({ modelRuntime: options.modelRuntime, model: options.model, sessionManager: SessionManager.inMemory(), noTools: "all", thinkingLevel: "off" });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timedOut = new Promise<never>((_, reject) => { timer = setTimeout(() => { void session.abort().then(() => reject(new Error("FINAL_REVIEW_PROVIDER_TIMEOUT")), () => reject(new Error("FINAL_REVIEW_PROVIDER_TIMEOUT"))); }, options.timeoutMs); });
      await Promise.race([session.prompt(`Return only exact JSON {"severity":"none|minor|important|critical","report":"..."}. Review this immutable finalization manifest and approval.\n${JSON.stringify({ manifest: input.manifest, approval: input.approval, reviewId: input.reviewId })}`), timedOut]);
      const result = outputFrom(session);
      const reportRef = await options.reportStore.persist({ reviewId: input.reviewId, manifestHash: String(input.manifest.manifestHash), approval: input.approval, content: result.report });
      return Object.freeze({ severity: result.severity, reportRef });
    } finally { if (timer) clearTimeout(timer); session.dispose(); }
  };
}
