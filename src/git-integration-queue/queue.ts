import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { realpathSync } from "node:fs";
import { QueueLedger } from "./ledger.ts";
import { currentBranch, hasSequencer, isAncestor, repositoryIdentity, targetHead, worktreeClean } from "./repository.ts";
import type { QueueItem, QueueReasonCode, QueueSource, QueueStatus } from "./records.ts";

export class GitIntegrationQueue {
  private readonly ledger: QueueLedger;
  private processing = false;
  private processingPromise: Promise<void> | undefined;
  private mutation: Promise<void> = Promise.resolve();
  readonly stateRoot: string;
  readonly repositoryRoot: string;
  readonly leaseEpoch: number;
  readonly leaseToken?: string;

  constructor(stateRoot: string, repositoryRoot: string, leaseEpoch = 0, leaseToken?: string) {
    this.stateRoot = stateRoot;
    const identity = repositoryIdentity(repositoryRoot);
    this.repositoryRoot = identity.repositoryRoot;
    this.leaseEpoch = leaseEpoch;
    this.leaseToken = leaseToken;
    this.ledger = new QueueLedger(join(stateRoot, identity.repositoryId));
  }

  async init(): Promise<void> {
    await this.ledger.init();
    const index = await this.ledger.read<string[]>("index.json", []);
    if (!index.length) await this.ledger.write("index.json", []);
    for (const item of await this.items()) {
      if (item.state !== "integrating" && item.state !== "admitted") continue;
      await this.update(item, { state: "preserved", reasonCode: "DAEMON_RESTART_DURING_INTEGRATION", reason: "queue daemon 在集成临界区重启，无法证明 target 是否已更新" });
    }
  }

  private async items(): Promise<QueueItem[]> {
    const names = await this.ledger.read<string[]>("index.json", []);
    const items = await Promise.all(names.map((name) => this.ledger.readItem<QueueItem | null>(name.replace(/\.json$/, ""), null)));
    return items.filter((item): item is QueueItem => item !== null).map((item) => ({ ...item, leaseEpoch: item.leaseEpoch ?? 0 })).sort((a, b) => a.sequence - b.sequence);
  }

  async status(): Promise<QueueStatus> {
    const identity = repositoryIdentity(this.repositoryRoot);
    return { ...identity, items: await this.items() };
  }

  async enqueue(input: { targetRef: string; source: QueueSource; requestId?: string; metadata?: Record<string, string> }): Promise<QueueItem> {
    const item = await this.withMutation(async () => {
      await this.assertLease();
      const identity = repositoryIdentity(this.repositoryRoot);
      const requestId = input.requestId ?? randomUUID();
      validateRequestId(requestId);
      const targetRef = normalizeTargetRef(input.targetRef);
      await this.validateSource(input.source, identity.repositoryId);
      const items = await this.items();
      const existing = items.find((entry) => entry.requestId === requestId);
      if (existing) {
        if (JSON.stringify({ targetRef: existing.targetRef, source: existing.source, metadata: existing.metadata }) !== JSON.stringify({ targetRef, source: input.source, metadata: input.metadata })) {
          throw new Error("requestId already exists with different queue input");
        }
        return existing;
      }
      const meta = await this.ledger.read<{ nextSequence: number }>("meta.json", { nextSequence: 1 });
      const now = new Date().toISOString();
      const next: QueueItem = { version: 1, requestId, sequence: meta.nextSequence, repositoryRoot: identity.repositoryRoot, repositoryId: identity.repositoryId, targetRef, source: input.source, ...(input.metadata ? { metadata: input.metadata } : {}), state: "queued", revision: 0, leaseEpoch: this.leaseEpoch, createdAt: now, updatedAt: now };
      await this.ledger.writeItem(requestId, next);
      await this.ledger.write("meta.json", { nextSequence: meta.nextSequence + 1 });
      await this.ledger.write("index.json", [...items.map((entry) => entry.requestId), requestId]);
      return next;
    });
    void this.process().catch(async (error) => {
      // The next status request remains authoritative; integration failures are
      // persisted by integrate(), while scheduler failures must not become an
      // unhandled rejection that kills a daemon process.
      if (error instanceof Error) console.error(`[git-queue] process failed: ${error.message}`);
    });
    return item;
  }

  async process(): Promise<void> {
    if (this.processingPromise) return this.processingPromise;
    this.processing = true;
    this.processingPromise = (async () => {
      for (;;) {
        const item = (await this.items()).find((entry) => entry.state === "queued" || entry.state === "admitted");
        if (!item) return;
        await this.withMutation(() => this.integrate(item));
      }
    })().finally(() => {
      this.processing = false;
      this.processingPromise = undefined;
      void this.items().then((items) => {
        if (items.some((entry) => entry.state === "queued" || entry.state === "admitted")) void this.process().catch((error) => console.error(`[git-queue] process rescan failed: ${error instanceof Error ? error.message : String(error)}`));
      }).catch((error) => console.error(`[git-queue] process rescan failed: ${error instanceof Error ? error.message : String(error)}`));
    });
    return this.processingPromise;
  }

  private async withMutation<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.mutation;
    let release!: () => void;
    this.mutation = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try { return await operation(); } finally { release(); }
  }

  private async integrate(item: QueueItem): Promise<void> {
    try {
      if (currentBranch(this.repositoryRoot) !== item.targetRef) return this.finish(item, "preserved", "TARGET_NOT_CHECKED_OUT", "target ref must be the currently checked out branch");
      if (hasSequencer(this.repositoryRoot)) return this.finish(item, "preserved", "SEQUENCER_ACTIVE", "target repository has an active merge/rebase/cherry-pick/revert/bisect operation");
      const currentHead = targetHead(this.repositoryRoot, item.targetRef);
      if (!worktreeClean(this.repositoryRoot)) return this.finish(item, "preserved", "TARGET_DIRTY", "target worktree is dirty");
      await this.update(item, { state: "admitted", previousTargetHead: currentHead });
      await this.update(item, { state: "integrating" });
      let candidate = item.source.kind === "commit" ? item.source.commit : await this.candidateFromPatch(item, currentHead);
      if (item.source.kind === "handoff-patch") await this.update(item, { candidateCommit: candidate });
      if (!isAncestor(this.repositoryRoot, currentHead, candidate)) return this.finish(item, "conflict", "STALE_SOURCE", "source is not a descendant of target HEAD");
      execFileSync("git", ["-C", this.repositoryRoot, "merge", "--ff-only", candidate], { stdio: "ignore" });
      const integratedHead = targetHead(this.repositoryRoot, item.targetRef);
      await this.update(item, { state: "completed", integratedHead });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const reasonCode: QueueReasonCode = message.includes("symbolic-ref") ? "DETACHED_HEAD"
        : message.includes("sequencer") ? "SEQUENCER_ACTIVE"
        : message.includes("digest mismatch") ? "HANDOFF_DIGEST_MISMATCH"
        : message.includes("base commit") ? "TARGET_DRIFTED"
        : message.includes("patch is empty") ? "HANDOFF_PATCH_UNREADABLE"
        : "GIT_FACTS_UNAVAILABLE";
      await this.finish(item, "preserved", reasonCode, message);
    }
  }

  private async validateSource(source: QueueSource, repositoryId: string): Promise<void> {
    if (source.kind === "handoff-patch") {
      const handoff = realpathSync(source.handoffPath);
      const patch = realpathSync(source.patchPath);
      const pathFromHandoff = relative(dirname(handoff), patch);
      if (pathFromHandoff.startsWith("..") || pathFromHandoff.startsWith("/")) throw new Error("handoff patch is outside its artifact directory");
      return;
    }
    const facts = repositoryIdentity(source.worktreePath);
    if (facts.repositoryId !== repositoryId) throw new Error("source worktree belongs to another repository");
    if (!worktreeClean(source.worktreePath)) throw new Error("source worktree must be clean before enqueue");
    const head = execFileSync("git", ["-C", source.worktreePath, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    if (head !== source.commit) throw new Error("sourceCommit must equal source worktree HEAD");
  }

  private async candidateFromPatch(item: QueueItem, parent: string): Promise<string> {
    const source = item.source;
    if (source.kind !== "handoff-patch") throw new Error("queue item is not a handoff patch");
    const temporary = await mkdtemp(join(tmpdir(), "pi-git-queue-"));
    const index = join(temporary, "index");
    const candidateRepo = join(temporary, "candidate.git");
    try {
      execFileSync("git", ["init", "--bare", candidateRepo], { stdio: "ignore" });
      const targetObjects = resolve(this.repositoryRoot, execFileSync("git", ["-C", this.repositoryRoot, "rev-parse", "--git-path", "objects"], { encoding: "utf8" }).trim());
      await writeFile(join(candidateRepo, "objects", "info", "alternates"), `${targetObjects}\n`);
      const objectEnv = { ...process.env, GIT_OBJECT_DIRECTORY: join(candidateRepo, "objects"), GIT_ALTERNATE_OBJECT_DIRECTORIES: targetObjects };
      execFileSync("git", ["-C", this.repositoryRoot, "read-tree", `--index-output=${index}`, parent], { env: objectEnv, stdio: "ignore" });
      const patch = await readFile(source.patchPath, "utf8");
      if (!patch.trim()) throw new Error("handoff patch is empty");
      const digest = createHash("sha256").update(patch).digest("hex");
      if (digest !== source.patchDigest) throw new Error("handoff patch digest mismatch");
      if (!isAncestor(this.repositoryRoot, source.baseCommit, parent)) throw new Error("handoff base commit is not an ancestor of target HEAD");
      execFileSync("git", ["-C", this.repositoryRoot, "apply", "--cached", "--index", "--3way", source.patchPath], { env: { ...objectEnv, GIT_INDEX_FILE: index }, stdio: "ignore" });
      const tree = execFileSync("git", ["-C", this.repositoryRoot, "write-tree"], { env: { ...objectEnv, GIT_INDEX_FILE: index }, encoding: "utf8" }).trim();
      const candidate = execFileSync("git", ["-C", this.repositoryRoot, "commit-tree", tree, "-p", parent, "-m", `Integrate handoff patch ${item.requestId}`], { env: objectEnv, encoding: "utf8" }).trim();
      execFileSync("git", ["--git-dir", candidateRepo, "update-ref", "refs/queue/candidate", candidate], { stdio: "ignore" });
      execFileSync("git", ["-C", this.repositoryRoot, "fetch", "--no-tags", candidateRepo, "refs/queue/candidate"], { stdio: "ignore" });
      return candidate;
    } finally { await rm(temporary, { recursive: true, force: true }); }
  }

  private async update(item: QueueItem, change: Partial<QueueItem>): Promise<void> {
    await this.assertLease();
    const next = { ...item, ...change, ...(change.state === "admitted" || change.state === "integrating" ? { leaseEpoch: this.leaseEpoch } : {}), revision: item.revision + 1, updatedAt: new Date().toISOString() };
    await this.ledger.writeItem(item.requestId, next);
    Object.assign(item, next);
  }

  private async assertLease(): Promise<void> {
    if (!this.leaseToken || this.leaseEpoch === 0) return;
    const leasePath = join(this.stateRoot, repositoryIdentity(this.repositoryRoot).repositoryId, "daemon-lease.json");
    const current = JSON.parse(await readFile(leasePath, "utf8")) as { token?: string; epoch?: number };
    if (current.token !== this.leaseToken || current.epoch !== this.leaseEpoch) throw new Error("git queue lease fencing token is stale");
  }

  private async finish(item: QueueItem, state: QueueItem["state"], reasonCode: QueueReasonCode, reason: string): Promise<void> {
    await this.update(item, { state, reasonCode, reason });
  }
}

function validateRequestId(requestId: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(requestId)) throw new Error("requestId contains unsupported characters or is too long");
  if (requestId === "meta" || requestId === "index" || requestId === "daemon-lease") throw new Error("requestId is reserved");
}

function normalizeTargetRef(targetRef: string): string {
  if (/^refs\/heads\/[A-Za-z0-9._/-]+$/.test(targetRef)) return targetRef;
  if (/^[A-Za-z0-9._-]+$/.test(targetRef)) return `refs/heads/${targetRef}`;
  throw new Error("targetRef must be a branch name or refs/heads branch ref");
}
