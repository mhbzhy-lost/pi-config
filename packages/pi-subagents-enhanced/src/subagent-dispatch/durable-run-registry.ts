import { parseInventoryReferenceV1, parseProvenanceV1, type InventoryReferenceV1, type ProvenanceV1 } from "./durable-contract.ts";
import { DurableStorage } from "./durable-storage.ts";

export interface InventoryV1 { runId: string; authorizationReference: InventoryReferenceV1; ownerReference: InventoryReferenceV1; workspaceReference: InventoryReferenceV1; provenance: ProvenanceV1; orphaned?: boolean; }
const parse = (value: unknown): InventoryV1 => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("DURABLE_INVENTORY_FIELDS");
  const item = value as Record<string, unknown>; const keys = Object.keys(item); const allowed = ["runId", "authorizationReference", "ownerReference", "workspaceReference", "provenance", "orphaned"];
  if (!keys.every(key => allowed.includes(key)) || !["runId", "authorizationReference", "ownerReference", "workspaceReference", "provenance"].every(key => Object.hasOwn(item, key)) || typeof item.runId !== "string" || !item.runId || (item.orphaned !== undefined && item.orphaned !== true)) throw new TypeError("DURABLE_INVENTORY_FIELDS");
  return Object.freeze({ runId: item.runId, authorizationReference: parseInventoryReferenceV1(item.authorizationReference), ownerReference: parseInventoryReferenceV1(item.ownerReference), workspaceReference: parseInventoryReferenceV1(item.workspaceReference), provenance: parseProvenanceV1(item.provenance), ...(item.orphaned ? { orphaned: true } : {}) });
};
export class DurableRunRegistry {
  constructor(private readonly options: { storage: DurableStorage }) {}
  async recordInventory(value: unknown) { const inventory = parse(value); const result = await this.options.storage.write(`inventory-${inventory.runId}`, inventory, (await this.options.storage.read(`inventory-${inventory.runId}`))?.revision ?? 0); return { inventory, revision: result.revision, status: inventory.provenance.status }; }
  async loadInventory(runId: string) { const saved = await this.options.storage.read<InventoryV1>(`inventory-${runId}`); if (!saved) return null; return { inventory: parse(saved.value), revision: saved.revision, status: saved.value.provenance.status }; }
  async markOrphaned(runId: string, input: unknown = {}) { if (!input || typeof input !== "object" || Object.keys(input as object).length !== 0) throw new TypeError("DURABLE_ORPHAN_FIELDS"); const existing = await this.loadInventory(runId); if (!existing) return { status: "blocked-unknown" as const }; return this.recordInventory({ ...existing.inventory, orphaned: true }); }
}
