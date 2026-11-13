import { createHash, randomUUID } from "node:crypto";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { QueueLedger } from "./ledger.ts";
import { currentBranch, isAncestor, repositoryIdentity, targetHead, worktreeClean } from "./repository.ts";
import type { QueueItem, QueueSource, QueueStatus } from "./records.ts";

export class GitIntegrationQueue {
  private readonly ledger: QueueLedger;
  private processing = false;
  private processingPromise: Promise<void> | undefined;
  readonly stateRoot: string;
  readonly repositoryRoot: string;

  constructor(stateRoot: string, repositoryRoot: string) {
    this.stateRoot = stateRoot;
    this.repositoryRoot = repositoryRoot;
    this.ledger = new QueueLedger(join(stateRoot, repositoryIdentity(repositoryRoot).repositoryId));
  }

  async init(): Promise<void> {
    await this.ledger.init();
    const index = await this.ledger.read<string[]>("index.json", []);
    if (!index.length) await this.ledger.write("index.json", []);
  }

  private async items(): Promise<QueueItem[]> {
    const names = await this.ledger.read<string[]>("index.json", []);
    const items = await Promise.all(names.map((name) => this.ledger.read<QueueItem | null>(name, null)));
    return items.filter((item): item is QueueItem => item !== null).sort((a, b) => a.sequence - b.sequence);
  }

  async status(): Promise<QueueStatus> {
    const identity = repositoryIdentity(this.repositoryRoot);
    return { ...identity, items: await this.items() };
  }

  async enqueue(input: { targetRef: string; source: QueueSource; requestId?: string; metadata?: Record<string, string> }): Promise<QueueItem> {
    const identity = repositoryIdentity(this.repositoryRoot);
    const requestId = input.requestId ?? randomUUID();
    const items = await this.items();
    const existing = items.find((item) => item.requestId === requestId);
    if (existing) return existing;
    const meta = await this.ledger.read<{ nextSequence: number }>("meta.json", { nextSequence: 1 });
    const now = new Date().toISOString();
    const item: QueueItem = { version: 1, requestId, sequence: meta.nextSequence, repositoryRoot: identity.repositoryRoot, repositoryId: identity.repositoryId, targetRef: input.targetRef, source: input.source, ...(input.metadata ? { metadata: input.metadata } : {}), state: "queued", revision: 0, createdAt: now, updatedAt: now };
    const name = `${requestId}.json`;
    await this.ledger.write(name, item);
    await this.ledger.write("meta.json", { nextSequence: meta.nextSequence + 1 });
    await this.ledger.write("index.json", [...items.map((entry) => `${entry.requestId}.json`), name]);
    void this.process();
    return item;
  }

  async process(): Promise<void> {
    if (this.processingPromise) return this.processingPromise;
    this.processing = true;
    this.processingPromise = (async () => {
      for (;;) {
        const item = (await this.items()).find((entry) => entry.state === "queued");
        if (!item) return;
        await this.integrate(item);
      }
    })().finally(() => { this.processing = false; this.processingPromise = undefined; });
    return this.processingPromise;
  }

  private async integrate(item: QueueItem): Promise<void> {
    if (currentBranch(this.repositoryRoot) !== item.targetRef) return this.finish(item, "preserved", "TARGET_NOT_CHECKED_OUT", "target ref must be the currently checked out branch");
    const currentHead = targetHead(this.repositoryRoot, item.targetRef);
    if (!worktreeClean(this.repositoryRoot)) return this.finish(item, "preserved", "TARGET_DIRTY", "target worktree is dirty");
    await this.update(item, { state: "integrating", previousTargetHead: currentHead });
    try {
      let candidate = item.source.kind === "commit" ? item.source.commit : await this.candidateFromPatch(item, currentHead);
      if (!isAncestor(this.repositoryRoot, currentHead, candidate)) return this.finish(item, "conflict", "STALE_SOURCE", "source is not a descendant of target HEAD");
      execFileSync("git", ["-C", this.repositoryRoot, "merge", "--ff-only", candidate], { stdio: "ignore" });
      const integratedHead = targetHead(this.repositoryRoot, item.targetRef);
      await this.update(item, { state: "completed", integratedHead });
    } catch (error) {
      await this.finish(item, "conflict", "INTEGRATION_FAILED", error instanceof Error ? error.message : String(error));
    }
  }

  private async candidateFromPatch(item: QueueItem, parent: string): Promise<string> {
    const source = item.source;
    if (source.kind !== "handoff-patch") throw new Error("queue item is not a handoff patch");
    const temporary = await mkdtemp(join(tmpdir(), "pi-git-queue-"));
    const index = join(temporary, "index");
    try {
      execFileSync("git", ["-C", this.repositoryRoot, "read-tree", `--index-output=${index}`, parent], { stdio: "ignore" });
      const patch = await readFile(source.patchPath, "utf8");
      const digest = createHash("sha256").update(patch).digest("hex");
      if (digest !== source.patchDigest) throw new Error("handoff patch digest mismatch");
      execFileSync("git", ["-C", this.repositoryRoot, "apply", "--cached", "--index", "--3way", source.patchPath], { env: { ...process.env, GIT_INDEX_FILE: index }, stdio: "ignore" });
      const tree = execFileSync("git", ["-C", this.repositoryRoot, "write-tree"], { env: { ...process.env, GIT_INDEX_FILE: index }, encoding: "utf8" }).trim();
      return execFileSync("git", ["-C", this.repositoryRoot, "commit-tree", tree, "-p", parent, "-m", "Integrate handoff patch"], { encoding: "utf8" }).trim();
    } finally { await rm(temporary, { recursive: true, force: true }); }
  }

  private async update(item: QueueItem, change: Partial<QueueItem>): Promise<void> {
    const next = { ...item, ...change, revision: item.revision + 1, updatedAt: new Date().toISOString() };
    await this.ledger.write(`${item.requestId}.json`, next);
    Object.assign(item, next);
  }

  private async finish(item: QueueItem, state: QueueItem["state"], reasonCode: string, reason: string): Promise<void> {
    await this.update(item, { state, reasonCode, reason });
  }
}
