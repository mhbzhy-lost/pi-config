import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export type ActivityKind = "subagent" | "bash_async" | "scheduler";
export type ActivityPlacement = "main" | "recent";

export type ActivityRow = Readonly<{
  key: string;
  kind: ActivityKind;
  label: string;
  stateLabel: string;
  placement: ActivityPlacement;
  metaLabel?: string;
}>;

export type ActivitySnapshot = Readonly<{
  availability: "available" | "stale" | "unavailable";
  rows: readonly ActivityRow[];
  selectedKey?: string;
  observedAt?: string;
  errorLabel?: string;
}>;

export type DetailComponent = {
  render(width: number): string[];
  invalidate(): void;
  dispose?(): void;
};

export type DetailRequest = Readonly<{
  expanded: boolean;
  requestRender(): void;
}>;

export interface ActivitySource {
  kind: ActivityKind;
  snapshot(): ActivitySnapshot;
  subscribe(listener: () => void): () => void;
  detail?(key: string, request: DetailRequest): Promise<DetailComponent | undefined>;
  select?(key: string): void;
  dispose?(): void;
}

type ActivityHostState = {
  sources: Map<string, ActivitySource>;
  listeners: Set<() => void>;
};

const HOST_REGISTRY = Symbol.for("pi-config.tui-activity-host.v1");

function hostRegistry(): Map<unknown, ActivityHostState> {
  const root = globalThis as typeof globalThis & { [HOST_REGISTRY]?: Map<unknown, ActivityHostState> };
  return root[HOST_REGISTRY] ??= new Map();
}

function activityHost(pi: ExtensionAPI): ActivityHostState {
  const key = pi.events;
  const registry = hostRegistry();
  const existing = registry.get(key);
  if (existing) return existing;
  const created: ActivityHostState = { sources: new Map(), listeners: new Set() };
  registry.set(key, created);
  return created;
}

function notify(host: ActivityHostState): void {
  for (const listener of [...host.listeners]) {
    try { listener(); } catch { /* one display listener must not block the others */ }
  }
}

export function registerActivitySource(pi: ExtensionAPI, id: string, source: ActivitySource): () => void {
  const host = activityHost(pi);
  host.sources.set(id, source);
  notify(host);
  return () => {
    if (host.sources.get(id) !== source) return;
    host.sources.delete(id);
    notify(host);
  };
}

export function activitySources(pi: ExtensionAPI): readonly ActivitySource[] {
  return [...activityHost(pi).sources.values()];
}

export function subscribeActivitySources(pi: ExtensionAPI, listener: () => void): () => void {
  const host = activityHost(pi);
  host.listeners.add(listener);
  return () => host.listeners.delete(listener);
}

export function createActivityRegistry(sources: readonly ActivitySource[] = []): {
  setSources(next: readonly ActivitySource[]): void;
  snapshot(): ActivitySnapshot;
  select(key: string): void;
  detail(key: string, request: DetailRequest): Promise<DetailComponent | undefined>;
  subscribe(listener: () => void): () => void;
  dispose(): void;
} {
  let current = [...sources];
  const listeners = new Set<() => void>();
  const unsubscribers = new Map<ActivitySource, () => void>();

  const notifyLocal = () => {
    for (const listener of [...listeners]) {
      try { listener(); } catch { /* render invalidation is best effort */ }
    }
  };

  const connect = (source: ActivitySource) => {
    if (unsubscribers.has(source)) return;
    unsubscribers.set(source, source.subscribe(notifyLocal));
  };

  const disconnect = (source: ActivitySource) => {
    unsubscribers.get(source)?.();
    unsubscribers.delete(source);
  };

  const setSources = (next: readonly ActivitySource[]) => {
    for (const source of current) if (!next.includes(source)) disconnect(source);
    current = [...next];
    for (const source of current) connect(source);
    notifyLocal();
  };

  for (const source of current) connect(source);

  return {
    setSources,
    snapshot() {
      const snapshots = current.map((source) => source.snapshot());
      const unavailable = snapshots.filter((snapshot) => snapshot.availability === "unavailable");
      const stale = snapshots.find((snapshot) => snapshot.availability === "stale");
      return {
        availability: unavailable.length === snapshots.length && snapshots.length > 0
          ? "unavailable"
          : stale || unavailable.length > 0 ? "stale" : "available",
        rows: snapshots.flatMap((snapshot) => snapshot.rows),
        ...(snapshots.find((snapshot) => snapshot.selectedKey !== undefined)?.selectedKey
          ? { selectedKey: snapshots.find((snapshot) => snapshot.selectedKey !== undefined)?.selectedKey }
          : {}),
        ...(stale?.observedAt ? { observedAt: stale.observedAt } : {}),
        ...(unavailable[0]?.errorLabel ? { errorLabel: unavailable[0].errorLabel } : {}),
      };
    },
    select(key) {
      for (const source of current) {
        if (!source.snapshot().rows.some((row) => row.key === key)) continue;
        source.select?.(key);
        notifyLocal();
        return;
      }
    },
    async detail(key, request) {
      for (const source of current) {
        const component = await source.detail?.(key, request);
        if (component) return component;
      }
      return undefined;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose() {
      for (const source of current) {
        disconnect(source);
        try { source.dispose?.(); } catch { /* source teardown is isolated */ }
      }
      listeners.clear();
    },
  };
}
