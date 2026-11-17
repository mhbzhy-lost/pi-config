/**
 * 自签证书管理（无域名 → IP SAN）：系统 openssl 生成根 CA（10 年）+ 服务器叶证书（398 天）。
 * 仅在 ECS 侧 init/renew-cert 使用；私钥/证书落 var/pi-relay/（0600，gitignored）。
 */
import { execFile } from "node:child_process";
import { mkdir, readFile, access, writeFile, unlink } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { normalizeFingerprint } from "./protocol.ts";

const execFileAsync = promisify(execFile);

async function openssl(args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync("openssl", args, { encoding: "utf8" });
    return stdout;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`openssl 执行失败（${args[0]}）：${reason}`);
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

export function certPaths(root: string): { dir: string; caKey: string; caCrt: string; serverKey: string; serverCrt: string } {
  const dir = path.join(root, "var", "pi-relay");
  return {
    dir,
    caKey: path.join(dir, "ca.key"),
    caCrt: path.join(dir, "ca.crt"),
    serverKey: path.join(dir, "server.key"),
    serverCrt: path.join(dir, "server.crt"),
  };
}

/** 生成根 CA（已存在则保留；--rotate-tokens 不重生成 CA） */
export async function ensureCa(root: string): Promise<void> {
  const p = certPaths(root);
  await mkdir(p.dir, { recursive: true });
  if ((await exists(p.caCrt)) && (await exists(p.caKey))) return;
  await openssl([
    "req", "-x509", "-newkey", "rsa:2048", "-nodes",
    "-keyout", p.caKey, "-out", p.caCrt,
    "-days", "3650", "-subj", "/CN=pi-relay-root",
    "-addext", "basicConstraints=critical,CA:TRUE",
    "-addext", "keyUsage=critical,keyCertSign,cRLSign",
  ]);
}

/**
 * 用既有 CA 签发/续签服务器叶证书（IP SAN，398 天）。
 * ips 必须非空；调用方负责并入 127.0.0.1 与公网 IP。
 */
export async function issueLeaf(root: string, ips: string[]): Promise<void> {
  const p = certPaths(root);
  if (ips.length === 0) throw new Error("签发叶证书需要至少一个 IP（--ip 或可探测的本机地址）");
  for (const ip of ips) {
    if (!/^[0-9.]+$/.test(ip) && !/^[0-9A-Fa-f:]+$/.test(ip)) throw new Error(`SAN IP 不合法：${ip}`);
  }
  const csr = path.join(p.dir, "server.csr");
  const ext = path.join(p.dir, "server.ext");
  await openssl(["req", "-new", "-newkey", "rsa:2048", "-nodes", "-keyout", p.serverKey, "-out", csr, "-subj", "/CN=pi-relay"]);
  await writeFile(
    ext,
    `subjectAltName=${ips.map((ip) => `IP:${ip}`).join(",")}\nbasicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n`,
    { mode: 0o600 },
  );
  try {
    await openssl(["x509", "-req", "-in", csr, "-CA", p.caCrt, "-CAkey", p.caKey, "-CAcreateserial", "-out", p.serverCrt, "-days", "398", "-extfile", ext]);
  } finally {
    await unlink(csr).catch(() => {});
    await unlink(ext).catch(() => {});
  }
}

/** CA SHA256 指纹（归一化大写冒号分隔） */
export async function caFingerprint(root: string): Promise<string> {
  const p = certPaths(root);
  const out = await openssl(["x509", "-in", p.caCrt, "-noout", "-fingerprint", "-sha256"]);
  const match = /Fingerprint=([0-9A-Fa-f:]+)/.exec(out);
  const normalized = match ? normalizeFingerprint(match[1]!) : null;
  if (!normalized) throw new Error("无法解析 CA 指纹");
  return normalized;
}

/** 读取 CA PEM（供 /ca.crt 下发与 fetch-ca 比对） */
export async function readCaPem(root: string): Promise<string> {
  return readFile(certPaths(root).caCrt, "utf8");
}

/** 读取叶证书/私钥（供 TLS server） */
export async function readServerCert(root: string): Promise<{ key: Buffer; cert: Buffer }> {
  const p = certPaths(root);
  const [key, cert] = await Promise.all([readFile(p.serverKey), readFile(p.serverCrt)]);
  return { key, cert };
}