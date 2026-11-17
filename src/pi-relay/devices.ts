/**
 * 可信设备存储：devices.json / pair-pending.json 的锁协议读写与批准/吊销纯逻辑。
 * 权威列表唯一写者是 CLI（approve/deny/revoke）；agent 只读 devices.json，
 * 仅经锁写 pair-pending.json，lastSeen 独写 devices-lastseen.json。
 * 一切 read-modify-write 经 withDeviceLock（O_EXCL + pid 陈旧检测）+ 临时文件 rename 原子写。
 */
import { mkdir, open, readFile, rename, unlink, writeFile, appendFile } from "node:fs/promises";
import path from "node:path";
import { PAIR_TTL_MS } from "pi-relay-server/protocol";

export type DeviceRecord = {
  id: string;
  name: string;
  ua: string;
  secretHash: string;
  approvedAt: string;
};

export type PendingRecord = {
  id: string;
  code: string;
  ua: string;
  ip: string;
  secretHash: string;
  ts: number;
  status: "pending" | "denied";
};

export function relayDir(root: string): string {
  return path.join(root, "var", "pi-relay");
}

export function devicesPath(root: string): string {
  return path.join(relayDir(root), "devices.json");
}

export function pendingPath(root: string): string {
  return path.join(relayDir(root), "pair-pending.json");
}

export function lastSeenPath(root: string): string {
  return path.join(relayDir(root), "devices-lastseen.json");
}

async function readJsonArray<T>(file: string): Promise<T[]> {
  try {
    const raw = await readFile(file, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    // 文件损坏按空列表处理会导致吊销设备复活，必须 fail closed
    throw new Error(`设备存储文件损坏（${path.basename(file)}）：请人工检查后再试`);
  }
}

/** 0600 原子写：同目录临时文件 + rename */
async function atomicWriteJson(file: string, value: unknown): Promise<void> {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, file);
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * 设备存储互斥锁：O_EXCL 创建 devices.lock（写入 pid）。
 * 拿锁失败时检测锁内 pid 存活，陈旧锁清除重试；活锁则短等待重试，超时中文报错。
 */
export async function withDeviceLock<T>(root: string, fn: () => Promise<T>): Promise<T> {
  const dir = relayDir(root);
  await mkdir(dir, { recursive: true });
  const lockFile = path.join(dir, "devices.lock");
  const deadline = Date.now() + 5_000;
  for (;;) {
    try {
      const handle = await open(lockFile, "wx", 0o600);
      try {
        await handle.writeFile(String(process.pid));
      } finally {
        await handle.close();
      }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let stale = false;
      try {
        const pid = Number.parseInt((await readFile(lockFile, "utf8")).trim(), 10);
        stale = !Number.isInteger(pid) || pid <= 0 || !pidAlive(pid);
      } catch {
        stale = true; // 锁文件读不到视为陈旧
      }
      if (stale) {
        await unlink(lockFile).catch(() => {});
        continue;
      }
      if (Date.now() > deadline) throw new Error("设备存储锁等待超时：可能有其他 pi-relay 命令正在执行，请稍后重试");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  try {
    return await fn();
  } finally {
    await unlink(lockFile).catch(() => {});
  }
}

export async function readDevices(root: string): Promise<DeviceRecord[]> {
  return readJsonArray<DeviceRecord>(devicesPath(root));
}

export async function readPending(root: string): Promise<PendingRecord[]> {
  return readJsonArray<PendingRecord>(pendingPath(root));
}

export async function readLastSeen(root: string): Promise<Record<string, string>> {
  try {
    const parsed = JSON.parse(await readFile(lastSeenPath(root), "utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, string>) : {};
  } catch {
    return {}; // lastSeen 仅展示用，损坏/缺失不影响安全语义
  }
}

/** 本机审计日志：可含配对 code/UA/IP 与批准/吊销动作（gitignored var/ 下） */
export async function audit(root: string, line: string): Promise<void> {
  const dir = relayDir(root);
  await mkdir(dir, { recursive: true });
  await appendFile(path.join(dir, "audit.log"), `${new Date().toISOString()} ${line}\n`, { mode: 0o600 });
}

function pendingAlive(record: PendingRecord): boolean {
  return Date.now() - record.ts < PAIR_TTL_MS;
}

/** 按配对码定位唯一未过期 pending 条目；0 条/多条均中文报错（碰撞防护） */
function locateByCode(pending: PendingRecord[], code: string): PendingRecord {
  const matches = pending.filter((p) => p.code === code && p.status === "pending" && pendingAlive(p));
  if (matches.length === 0) throw new Error(`没有配对码 ${code} 对应的待批准设备（可能已过期或已处理）`);
  if (matches.length > 1) throw new Error(`配对码 ${code} 命中多条待批准记录（碰撞），请让设备重新配对后再批准`);
  return matches[0]!;
}

/** 批准：按 id 幂等去重追加 devices.json，并移除对应 pending。返回设备记录。 */
export async function approveByCode(root: string, code: string, name?: string): Promise<DeviceRecord> {
  return withDeviceLock(root, async () => {
    const pending = await readPending(root);
    const target = locateByCode(pending, code);
    const devices = await readDevices(root);
    let device = devices.find((d) => d.id === target.id);
    if (!device) {
      device = {
        id: target.id,
        name: name?.trim() || target.ua.slice(0, 60) || "未命名设备",
        ua: target.ua,
        secretHash: target.secretHash,
        approvedAt: new Date().toISOString(),
      };
      devices.push(device);
      await atomicWriteJson(devicesPath(root), devices);
    }
    await atomicWriteJson(pendingPath(root), pending.filter((p) => p.id !== target.id));
    await audit(root, `approve id=${device.id} name=${device.name} code=${code} ua=${target.ua} ip=${target.ip}`);
    return device;
  });
}

/** 拒绝：pending 条目置 denied（配对页轮询可见），不下发任何凭据 */
export async function denyByCode(root: string, code: string): Promise<PendingRecord> {
  return withDeviceLock(root, async () => {
    const pending = await readPending(root);
    const target = locateByCode(pending, code);
    target.status = "denied";
    await atomicWriteJson(pendingPath(root), pending);
    await audit(root, `deny id=${target.id} code=${code} ua=${target.ua} ip=${target.ip}`);
    return target;
  });
}

/** 吊销：按 id 移除 devices.json；agent 目录 watch 推送后中继即时切断存量通道 */
export async function revokeById(root: string, id: string): Promise<DeviceRecord> {
  return withDeviceLock(root, async () => {
    const devices = await readDevices(root);
    const device = devices.find((d) => d.id === id);
    if (!device) throw new Error(`没有 id 为 ${id} 的可信设备`);
    await atomicWriteJson(devicesPath(root), devices.filter((d) => d.id !== id));
    await audit(root, `revoke id=${id} name=${device.name}`);
    return device;
  });
}

/** agent 侧：登记配对请求（合并既有 pending，剔除过期），经锁原子写 */
export async function addPending(root: string, record: PendingRecord): Promise<void> {
  await withDeviceLock(root, async () => {
    const pending = (await readPending(root)).filter((p) => pendingAlive(p) && p.id !== record.id);
    pending.push(record);
    await atomicWriteJson(pendingPath(root), pending);
  });
  await audit(root, `pair-request id=${record.id} code=${record.code} ua=${record.ua} ip=${record.ip}`);
}

/** agent 重连成功后：清空 status=pending 条目（中继内存 pending 已随旧控制连接作废），denied 保留 */
export async function clearStalePending(root: string): Promise<void> {
  await withDeviceLock(root, async () => {
    const pending = await readPending(root);
    const kept = pending.filter((p) => p.status === "denied" && pendingAlive(p));
    if (kept.length !== pending.length) await atomicWriteJson(pendingPath(root), kept);
  });
}

/** agent 独占写 lastSeen（节流由调用方负责） */
export async function writeLastSeen(root: string, map: Record<string, string>): Promise<void> {
  await atomicWriteJson(lastSeenPath(root), map);
}