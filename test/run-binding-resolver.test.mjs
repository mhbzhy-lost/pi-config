import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "../packages/pi-subagents-enhanced/node_modules/jiti/lib/jiti.mjs";

const jiti = createJiti(import.meta.url, { moduleCache: false });
const { createTrustedRunBindingResolver } = await jiti.import("../packages/pi-subagents-enhanced/src/subagent-dispatch/run-binding-resolver.ts");

function fakeClient(records) {
  let calls = 0;
  return {
    calls: () => calls,
    async listOwned({ runId }) {
      calls++;
      return records[runId] ?? [];
    },
  };
}

test("caches a resolved binding per run across coordinator operations", async () => {
  const client = fakeClient({ run1: [{ workspaceId: "ws1", leaseId: "lease1", run: { runId: "run1" } }] });
  const resolver = createTrustedRunBindingResolver(client, { rootSessionId: "root" });
  const first = await resolver.resolve("run1");
  const second = await resolver.resolve("run1");
  const third = await resolver.resolve("run1");
  assert.deepEqual(first, { workspaceId: "ws1", leaseId: "lease1", runId: "run1", ownerScope: { kind: "standalone-subagent", rootSessionId: "root" } });
  assert.strictEqual(second, first);
  assert.strictEqual(third, first);
  assert.equal(client.calls(), 1);
});

test("shares one in-flight lookup for concurrent first resolution", async () => {
  let calls = 0; let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const client = {
    async listOwned() {
      calls++;
      await gate;
      return [{ workspaceId: "ws1", leaseId: "lease1", run: { runId: "run1" } }];
    },
  };
  const resolver = createTrustedRunBindingResolver(client, { rootSessionId: "root" });
  const first = resolver.resolve("run1");
  const second = resolver.resolve("run1");
  release();
  const [a, b] = await Promise.all([first, second]);
  assert.strictEqual(a, b);
  assert.equal(calls, 1);
});

test("does not cache a failed resolution", async () => {
  const client = fakeClient({});
  const resolver = createTrustedRunBindingResolver(client, { rootSessionId: "root" });
  await assert.rejects(() => resolver.resolve("missing"), /trusted run binding is unavailable/);
  await assert.rejects(() => resolver.resolve("missing"), /trusted run binding is unavailable/);
  assert.equal(client.calls(), 2);
});

test("different runs resolve independently and dispose clears the cache", async () => {
  const client = fakeClient({
    run1: [{ workspaceId: "ws1", leaseId: "lease1", run: { runId: "run1" } }],
    run2: [{ workspaceId: "ws2", leaseId: "lease2", run: { runId: "run2" } }],
  });
  const resolver = createTrustedRunBindingResolver(client, { rootSessionId: "root" });
  await resolver.resolve("run1");
  const second = await resolver.resolve("run2");
  assert.equal(second.workspaceId, "ws2");
  assert.equal(client.calls(), 2);
  resolver.dispose();
  await resolver.resolve("run1");
  assert.equal(client.calls(), 3);
});
