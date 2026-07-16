import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const EPHEMERAL = Object.freeze({ type: "ephemeral" });
const MAX_MARKERS = 4;
const MIN_CACHE_TOKENS = 1024;
const NO_TURN_DEPTH_BUCKETS = Object.freeze([512000, 256000, 128000, 64000, 32000]);
const CACHEABLE_CONTENT_TYPES = new Set(["text", "tool_use", "tool_result"]);

function loadModelsConfig() {
  const rewrites = new Map<string, string>();
  const anthropicProviders = new Set<string>();
  const metadataUserIds = new Map<string, string>();
  try {
    const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
    const modelsPath = join(agentDir, "models.json");
    const config = JSON.parse(readFileSync(modelsPath, "utf-8"));
    for (const [name, provider] of Object.entries(config.providers || {})) {
      const p = provider as { api?: string; metadataUserId?: string; models?: Array<{ id: string; actualModelId?: string }> };
      if (p.api === "anthropic-messages") {
        anthropicProviders.add(name);
        if (p.metadataUserId) metadataUserIds.set(name, p.metadataUserId);
      }
      if (!p.models) continue;
      for (const model of p.models) {
        if (model.actualModelId) rewrites.set(model.id, model.actualModelId);
      }
    }
  } catch { /* ignore */ }
  return { rewrites, anthropicProviders, metadataUserIds };
}

const {
  rewrites: MODEL_REWRITES,
  anthropicProviders: ANTHROPIC_PROVIDERS,
  metadataUserIds: METADATA_USER_IDS,
} = loadModelsConfig();

function estimateTokens(value: unknown): number {
  if (typeof value === "string") return Math.ceil(value.length / 4);
  if (value && typeof value === "object") {
    const v = value as Record<string, unknown>;
    if (typeof v.text === "string") return estimateTokens(v.text);
    if (typeof v.thinking === "string") return estimateTokens(v.thinking);
    return Math.ceil(JSON.stringify(value).length / 4);
  }
  return 0;
}

function stripCacheControl(block: Record<string, unknown>): Record<string, unknown> {
  if (!block || typeof block !== "object") return block;
  const cloned = { ...block };
  delete cloned.cache_control;
  return cloned;
}

function canMarkBlock(block: unknown): boolean {
  if (!block || typeof block !== "object") return false;
  return CACHEABLE_CONTENT_TYPES.has((block as Record<string, unknown>).type as string);
}

function isTurnAnchor(message: Record<string, unknown>): boolean {
  if (message.role !== "user") return false;
  if (!Array.isArray(message.content)) return false;
  return message.content.some(
    (b: unknown) => b && typeof b === "object" && (b as Record<string, unknown>).type === "text",
  );
}

interface BlockEntry {
  location: "system" | "message";
  systemIndex: number | null;
  messageIndex: number | null;
  blockIndex: number | null;
  prefixTokens: number;
  canMark: boolean;
  role: string;
  isTurnAnchor: boolean;
  groupKey: string;
  globalIndex: number;
}

function planCacheMarkers(payload: Record<string, unknown>): void {
  const blocks: BlockEntry[] = [];
  let prefixTokens = 0;

  // Strip existing markers and build block index
  if (typeof payload.system === "string") {
    payload.system = [{ type: "text", text: payload.system }];
  }
  if (Array.isArray(payload.system)) {
    const system = payload.system as Record<string, unknown>[];
    for (let i = 0; i < system.length; i++) {
      system[i] = stripCacheControl(system[i]);
      const block = system[i];
      prefixTokens += estimateTokens(block);
      blocks.push({
        location: "system", systemIndex: i, messageIndex: null, blockIndex: null,
        prefixTokens, canMark: canMarkBlock(block), role: "system",
        isTurnAnchor: false, groupKey: "system", globalIndex: blocks.length,
      });
    }
  }

  if (Array.isArray(payload.messages)) {
    const messages = payload.messages as Record<string, unknown>[];
    for (let mi = 0; mi < messages.length; mi++) {
      const msg = messages[mi];
      if (!msg || typeof msg !== "object") continue;
      const content = msg.content;
      if (!Array.isArray(content)) continue;
      msg.content = content.map((p: unknown) =>
        p && typeof p === "object" ? stripCacheControl(p as Record<string, unknown>) : p
      );
      const msgIsAnchor = isTurnAnchor(msg);
      for (let bi = 0; bi < (msg.content as unknown[]).length; bi++) {
        const block = (msg.content as unknown[])[bi] as Record<string, unknown>;
        prefixTokens += estimateTokens(block);
        blocks.push({
          location: "message", systemIndex: null, messageIndex: mi, blockIndex: bi,
          prefixTokens, canMark: canMarkBlock(block), role: String(msg.role || ""),
          isTurnAnchor: msgIsAnchor && bi === 0,
          groupKey: `message:${mi}`, globalIndex: blocks.length,
        });
      }
    }
  }

  // Strip tool markers (they count against budget)
  let existingToolMarkers = 0;
  if (Array.isArray(payload.tools)) {
    const tools = payload.tools as Record<string, unknown>[];
    for (const tool of tools) {
      if (tool?.cache_control) existingToolMarkers++;
    }
    if (existingToolMarkers > MAX_MARKERS) {
      let kept = 0;
      for (const tool of tools) {
        if (tool?.cache_control) {
          if (kept < MAX_MARKERS) { kept++; } else { delete tool.cache_control; }
        }
      }
      existingToolMarkers = kept;
    }
  }
  const markerBudget = Math.max(0, MAX_MARKERS - existingToolMarkers);

  const eligible = blocks.filter(b => b.canMark && b.prefixTokens >= MIN_CACHE_TOKENS);
  if (eligible.length === 0) return;

  const selected = new Map<number, string>();
  const selectedByGroup = new Map<string, number>();

  const removeSelected = (gi: number) => {
    selected.delete(gi);
    for (const [gk, idx] of selectedByGroup) {
      if (idx === gi) { selectedByGroup.delete(gk); break; }
    }
  };

  const selectBlock = (block: BlockEntry, label: string, opts?: { replaceLaterInGroup?: boolean }) => {
    const existing = selectedByGroup.get(block.groupKey);
    if (existing !== undefined) {
      if (!opts?.replaceLaterInGroup || block.globalIndex <= existing) return false;
      removeSelected(existing);
    }
    selected.set(block.globalIndex, label);
    selectedByGroup.set(block.groupKey, block.globalIndex);
    return true;
  };

  // Slot 0: last system block
  const lastSystem = [...eligible].reverse().find(b => b.location === "system") ?? null;
  if (lastSystem) selectBlock(lastSystem, "system", { replaceLaterInGroup: true });

  // Slot tail: last eligible block
  const tail = eligible.at(-1)!;
  selectBlock(tail, "tail", { replaceLaterInGroup: true });

  // Turn anchors (from tail backward, skip tail itself)
  const turnAnchors: BlockEntry[] = [];
  for (let i = eligible.length - 1; i >= 0 && turnAnchors.length < 2; i--) {
    const b = eligible[i];
    if (b.isTurnAnchor && b.globalIndex !== tail.globalIndex) {
      turnAnchors.unshift(b);
    }
  }

  // Slots 1 & 2: turn anchors
  if (turnAnchors.length >= 2) {
    selectBlock(turnAnchors[0], "turn-prev");
    selectBlock(turnAnchors[1], "turn-current");
  } else if (turnAnchors.length === 1) {
    selectBlock(turnAnchors[0], "turn-current");
  }

  // Fallback: depth buckets when turn anchors < 2
  if (turnAnchors.length < 2 && selected.size < markerBudget) {
    const anchorIndex = turnAnchors.at(-1)?.globalIndex ?? lastSystem?.globalIndex ?? -1;
    const targetTokens = NO_TURN_DEPTH_BUCKETS.find(bucket => bucket < tail.prefixTokens);
    const deepStable = targetTokens
      ? eligible.findLast(b =>
          b.prefixTokens <= targetTokens &&
          b.globalIndex > anchorIndex &&
          b.globalIndex !== tail.globalIndex &&
          !selected.has(b.globalIndex) &&
          !selectedByGroup.has(b.groupKey),
        ) ?? null
      : null;
    if (deepStable) selectBlock(deepStable, "no-turn-depth");
  }

  // Fallback: early stable
  if (turnAnchors.length < 2 && selected.size < markerBudget) {
    const anchorIndex = turnAnchors.at(-1)?.globalIndex ?? lastSystem?.globalIndex ?? -1;
    const earlyStable = eligible.find(b =>
      b.globalIndex > anchorIndex &&
      b.globalIndex !== tail.globalIndex &&
      !selected.has(b.globalIndex) &&
      !selectedByGroup.has(b.groupKey),
    ) ?? null;
    if (earlyStable) selectBlock(earlyStable, "early-stable");
  }

  // Apply markers (trim to budget)
  const finalIndexes = markerBudget > 0
    ? [...selected.keys()].sort((a, b) => a - b).slice(-markerBudget)
    : [];
  const finalSet = new Set(finalIndexes);

  for (const block of blocks) {
    if (!finalSet.has(block.globalIndex)) continue;
    if (block.location === "system") {
      const sys = payload.system as Record<string, unknown>[];
      sys[block.systemIndex!] = { ...sys[block.systemIndex!], cache_control: { ...EPHEMERAL } };
    } else {
      const msg = (payload.messages as Record<string, unknown>[])[block.messageIndex!];
      const content = msg.content as Record<string, unknown>[];
      content[block.blockIndex!] = { ...content[block.blockIndex!], cache_control: { ...EPHEMERAL } };
    }
  }
}

function fillMetadataUserId(payload: Record<string, unknown>, userId: string): void {
  const metadata = payload.metadata;
  if (metadata && typeof metadata === "object" && !Array.isArray(metadata) && (metadata as Record<string, unknown>).user_id !== undefined) {
    return;
  }
  payload.metadata = {
    ...(metadata && typeof metadata === "object" && !Array.isArray(metadata) ? metadata as Record<string, unknown> : {}),
    user_id: userId,
  };
}

function rewriteThinking(payload: Record<string, unknown>): void {
  const thinking = payload.thinking;
  if (!thinking || typeof thinking !== "object") return;
  const t = thinking as Record<string, unknown>;
  if (t.type === "enabled") {
    t.type = "adaptive";
    delete t.budget_tokens;
  }
}

export default function anthropicRequestRewriter(pi: ExtensionAPI) {
  pi.on("before_provider_request", (event, ctx) => {
    const payload = event.payload as Record<string, unknown>;
    if (!payload || typeof payload !== "object") return;
    if (!(ctx.model && ANTHROPIC_PROVIDERS.has(ctx.model.provider))) return;

    if (typeof payload.model === "string") {
      const rewritten = MODEL_REWRITES.get(payload.model);
      if (rewritten) payload.model = rewritten;
    }

    const userId = METADATA_USER_IDS.get(ctx.model.provider);
    if (userId) fillMetadataUserId(payload, userId);

    planCacheMarkers(payload);
    rewriteThinking(payload);

    return payload;
  });
}
