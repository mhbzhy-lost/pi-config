import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { inspectCoordinatorDoctor, resolveRpcSource } from "../scripts/doctor.ts";

test("resolveRpcSource 兼容 0.62 TS 源与 0.71 编译版", async () => {
  const root = mkdtempSync(join(tmpdir(), "doctor-rpc-"));
  try {
    const pkg = join(root, "pi-subagents");
    const ext = join(pkg, "src", "extension");
    mkdirSync(ext, { recursive: true });
    // 仅编译版（0.71 布局）：应读到源并兼容方法检查
    writeFileSync(join(ext, "rpc.js"), "const methods = [\"ping\", \"spawn\"];");
    const compiledOnly = await resolveRpcSource(pkg);
    assert.ok(compiledOnly.includes("ping"), "rpc.js-only 布局应能读到源");
    // 仅 TS 源（0.62 布局）：优先读取
    writeFileSync(join(ext, "rpc.ts"), "const methodsTs = [\"ping\"];");
    const tsFirst = await resolveRpcSource(pkg);
    assert.ok(tsFirst.includes("methodsTs"), "存在 rpc.ts 时应优先 TS 源");
    // 两者皆无：返回 null
    rmSync(join(ext, "rpc.js"));
    rmSync(join(ext, "rpc.ts"));
    assert.equal(await resolveRpcSource(pkg), null, "无源时应返回 null");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("doctor rejects split brain, unknown queue schema, and unresolved debts", () => {
  const issues = inspectCoordinatorDoctor({
    schemaVersion: "managed-workspace-administration.v1",
    coordinator: { status: "observed", protocol: "old" },
    queue: { items: [] },
    debts: [
      { kind: "state-root-split-brain" },
      { kind: "queue-schema" },
      { kind: "proof" },
      { kind: "delivery" },
      { kind: "cleanup" },
    ],
  });
  assert.match(issues.join("\n"), /protocol|split-brain|schema|proof|delivery|cleanup/);
});

test("doctor accepts an empty isolated coordinator audit", () => {
  assert.deepEqual(inspectCoordinatorDoctor({
    schemaVersion: "managed-workspace-administration.v1",
    coordinator: { status: "missing" }, queue: { items: [] }, debts: [],
  }), []);
});
