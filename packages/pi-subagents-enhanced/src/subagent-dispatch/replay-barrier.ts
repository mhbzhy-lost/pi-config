import { durableDigest, parseReplayCursorV1, type ReplayCursorV1 } from "./durable-contract.ts";
import { DurableStorage } from "./durable-storage.ts";
import { DurableEventOutbox } from "./durable-event-outbox.ts";

export class ReplayBarrierError extends Error { constructor(readonly code: string, message = code) { super(message); } }
type BarrierState = { cursor: ReplayCursorV1; highWater: ReplayCursorV1; liveBoundary?: ReplayCursorV1 };
const identity = (cursor: ReplayCursorV1) => ({ rootSessionId: cursor.rootSessionId, runId: cursor.runId, ownerGeneration: cursor.ownerGeneration, epoch: cursor.epoch });
const keyFor = (cursor: ReplayCursorV1) => `replay-barrier-${durableDigest(identity(cursor))}`;
const same = (a: ReplayCursorV1, b: ReplayCursorV1) => a.rootSessionId === b.rootSessionId && a.runId === b.runId && a.ownerGeneration === b.ownerGeneration && a.epoch === b.epoch;

export class ReplayBarrier {
  constructor(private readonly options: { storage: DurableStorage; outbox: DurableEventOutbox }) {}
  private async load(cursor: ReplayCursorV1): Promise<{ state: BarrierState; revision: number } | null> { const saved = await this.options.storage.read<BarrierState>(keyFor(cursor)); return saved ? { state: saved.value, revision: saved.revision } : null; }
  async beginReplayBarrier(input: unknown): Promise<{ highWater: ReplayCursorV1 }> {
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length !== 1 || !Object.hasOwn(input, "cursor")) throw new ReplayBarrierError("REPLAY_BARRIER_FIELDS");
    const cursor = parseReplayCursorV1((input as any).cursor); const existing = await this.load(cursor); if (existing) return { highWater: existing.state.highWater };
    const highWater = await this.options.outbox.highWater(cursor); const state: BarrierState = { cursor, highWater };
    try { await this.options.storage.write(keyFor(cursor), state, 0); return { highWater }; }
    catch (error: any) { if (error?.code !== "DURABLE_REVISION_CONFLICT") throw error; const winner = await this.load(cursor); if (!winner) throw new ReplayBarrierError("REPLAY_BARRIER_CAS"); return { highWater: winner.state.highWater }; }
  }
  async replayBatch(input: unknown) {
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length !== 2 || !Object.hasOwn(input, "cursor") || !Object.hasOwn(input, "limit")) throw new ReplayBarrierError("REPLAY_BARRIER_FIELDS");
    const cursor = parseReplayCursorV1((input as any).cursor); const barrier = await this.load(cursor); if (!barrier) throw new ReplayBarrierError("REPLAY_BARRIER_MISSING");
    const batch = await this.options.outbox.readReplayBatch({ after: cursor, limit: (input as any).limit }); return { events: batch.events.filter(event => event.cursor.sequence <= barrier.state.highWater.sequence) };
  }
  async switchLiveAfterBarrier(input: unknown): Promise<{ liveBoundary: ReplayCursorV1 }> {
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length !== 1 || !Object.hasOwn(input, "cursor")) throw new ReplayBarrierError("REPLAY_BARRIER_FIELDS");
    const cursor = parseReplayCursorV1((input as any).cursor); const barrier = await this.load(cursor); if (!barrier) throw new ReplayBarrierError("REPLAY_BARRIER_MISSING");
    if (barrier.state.liveBoundary) return { liveBoundary: barrier.state.liveBoundary };
    const state = { ...barrier.state, liveBoundary: barrier.state.highWater };
    try { await this.options.storage.write(keyFor(cursor), state, barrier.revision); return { liveBoundary: state.liveBoundary }; }
    catch (error: any) { if (error?.code !== "DURABLE_REVISION_CONFLICT") throw error; const winner = await this.load(cursor); if (!winner?.state.liveBoundary) throw new ReplayBarrierError("REPLAY_BARRIER_CAS"); return { liveBoundary: winner.state.liveBoundary }; }
  }
  async acceptLiveFrame(input: unknown): Promise<boolean> {
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length !== 1 || !Object.hasOwn(input, "cursor")) throw new ReplayBarrierError("REPLAY_BARRIER_FIELDS");
    const cursor = parseReplayCursorV1((input as any).cursor); const barrier = await this.load(cursor); return !!barrier?.state.liveBoundary && same(cursor, barrier.state.liveBoundary) && cursor.sequence > barrier.state.liveBoundary.sequence;
  }
}
