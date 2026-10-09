import path from 'node:path';
import { AuthorityStore } from './authority-store.ts';
import { captureProcessBirthIdentity } from './process-birth-identity.ts';
import { readBrokerGrant } from './root-broker-protocol.ts';

/** locator只寻找现有authority；自身birth+current receipt+grant才允许连接。 */
export async function resolveChildBrokerIdentity(env: NodeJS.ProcessEnv, { timeoutMs = 5000 }: { timeoutMs?: number } = {}): Promise<{ rootSessionId: string; runId: string }> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 5000) throw new Error('child broker timeout非法');
  const raw = env.PI_SUBAGENT_EXTENSION_BINDINGS;
  const binding = raw ? JSON.parse(raw)['pi-config.root/1'] : undefined;
  if (env.PI_SUBAGENT_CHILD !== '1' || !binding || typeof binding.rootSessionId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(binding.rootSessionId) || !env.PI_CODING_WORKSPACE_DIR || !path.isAbsolute(env.PI_CODING_WORKSPACE_DIR)) throw new Error('child broker locator身份非法');
  const rootSessionId = binding.rootSessionId;
  const birth = await captureProcessBirthIdentity(process.pid);
  const store = new AuthorityStore({ root: path.join(env.PI_CODING_WORKSPACE_DIR, 'root-broker-authority', rootSessionId), rootSessionId });
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const receipts = await store.findByProcessBirth(birth);
    if (receipts.length > 1) throw new Error('child broker identity匹配不唯一');
    if (receipts.length === 1) {
      const current = receipts[0];
      let lease;
      try { lease = await store.readLease(current.runId); } catch (cause) { throw new Error('child broker lease身份不可用', { cause }); }
      const now = Date.now();
      if (lease.rootSessionId !== rootSessionId || lease.runId !== current.runId || lease.ownerGeneration !== current.ownerGeneration || lease.processBirth !== birth || lease.lastRenewedAt > now || lease.expiresAt <= now) throw new Error('child broker lease身份失效');
      try {
        const grant = await readBrokerGrant(rootSessionId, current.runId);
        if (!grant.capabilities.includes('root.subscribe')) throw new Error('child broker binding缺少root.subscribe');
        return Object.freeze({ rootSessionId, runId: current.runId });
      } catch (error) { if (error?.code !== 'ENOENT') throw error; }
    }
    if (Date.now() >= deadline) throw new Error('child broker binding身份未就绪');
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}
