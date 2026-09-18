import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
test("four processes enqueue with unique monotonic sequences", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "integration-queue-concurrent-")); const repositoryId = "a".repeat(64);
  try {
    const results = await Promise.all(Array.from({ length: 4 }, (_, index) => new Promise((resolve, reject) => {
      const source = `import { createIntegrationQueue } from './packages/pi-subagents-enhanced/src/workspace/integration-queue.ts'; const [root, repo, ws] = process.argv.slice(1); const q=createIntegrationQueue({stateRoot:root,repositoryId:repo}); const r=q.enqueueIntegration({requestId:ws,repositoryId:repo,workspaceId:ws,leaseId:'lease-'+ws,ownerScope:{kind:'standalone-subagent',rootSessionId:'root'},strategy:'rebase-ff',targetRef:'refs/heads/main',authorizedWorkspaceHead:'${"b".repeat(64)}',observedTargetHead:'${"c".repeat(64)}',attempt:1}); console.log(r.sequence);`;
      const child = spawn(process.execPath, ["--input-type=module", "-e", source, root, repositoryId, `ws-${index}`], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
      let output = ""; child.stdout.on("data", (chunk) => { output += chunk; }); child.once("error", reject); child.once("close", (code) => code ? reject(new Error(`worker exited ${code}`)) : resolve({ sequence: Number(output.trim()) }));
    })));
    const sequences = results.map((entry) => entry.sequence).sort((a, b) => a - b);
    assert.deepEqual(sequences, [1, 2, 3, 4]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
