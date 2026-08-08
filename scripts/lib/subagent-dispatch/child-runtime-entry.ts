import { createHash, randomUUID } from "node:crypto";
import { chmod, link, lstat, mkdir, readFile, realpath, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

type Receipt = Readonly<{ cwd: string; directoryPath: string; entryPath: string; targetUrl: string; sourceSha256: string; created: boolean }>;
type Identity = { dev: bigint; ino: bigint; ctimeNs: bigint };
const receiptIdentities = new WeakMap<object, Identity>();

function sha256(value: string | Buffer) { return createHash("sha256").update(value).digest("hex"); }
function entrySource(targetUrl: string) { return `export { default } from ${JSON.stringify(targetUrl)};\n`; }
function isInside(parent: string, child: string) { const relative = path.relative(parent, child); return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative); }
function sameIdentity(a: Identity, b: Identity) { return a.dev === b.dev && a.ino === b.ino && a.ctimeNs === b.ctimeNs; }
function sameFile(a: Identity, b: Identity) { return a.dev === b.dev && a.ino === b.ino; }
function identity(info: Awaited<ReturnType<typeof lstat>>) { const value = info as typeof info & { dev: bigint; ino: bigint; ctimeNs: bigint }; return { dev: BigInt(value.dev), ino: BigInt(value.ino), ctimeNs: BigInt(value.ctimeNs) }; }

function validateFileName(fileName: unknown): asserts fileName is string {
  if (typeof fileName !== "string" || !/^[^/\\\0.]+\.mjs$/.test(fileName) || fileName === "." || fileName === ".." || path.basename(fileName) !== fileName) throw new TypeError("fileName must be a single .mjs basename");
}
async function canonicalDirectory(cwd: unknown) {
  if (typeof cwd !== "string" || cwd.length === 0) throw new TypeError("cwd must be a directory path");
  const canonical = await realpath(cwd);
  if (!(await stat(canonical)).isDirectory()) throw new TypeError("cwd must be a directory");
  return canonical;
}
async function canonicalTarget(targetUrl: unknown) {
  if (typeof targetUrl !== "string" && !(targetUrl instanceof URL)) throw new TypeError("targetUrl must be a file: URL");
  let targetPath: string;
  try { const url = targetUrl instanceof URL ? targetUrl : new URL(targetUrl); if (url.protocol !== "file:") throw new TypeError(); targetPath = fileURLToPath(url); } catch { throw new TypeError("targetUrl must be a file: URL"); }
  const canonical = await realpath(targetPath);
  if (!(await stat(canonical)).isFile()) throw new TypeError("targetUrl must resolve to a regular file");
  const resolved = pathToFileURL(canonical);
  const source = targetUrl instanceof URL ? targetUrl : new URL(targetUrl);
  resolved.search = source.search;
  return resolved.href;
}
async function namespace(cwd: string) {
  const directoryPath = path.join(cwd, ".pi-subagents");
  await mkdir(directoryPath, { recursive: true, mode: 0o700 });
  const info = await lstat(directoryPath);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(".pi-subagents must be a non-symlink directory");
  await chmod(directoryPath, 0o700);
  const canonical = await realpath(directoryPath);
  if (!isInside(cwd, canonical)) throw new Error(".pi-subagents escapes cwd");
  return canonical;
}
function receipt(cwd: string, directoryPath: string, entryPath: string, targetUrl: string, sourceSha256: string, created: boolean, fileIdentity?: Identity): Receipt {
  const value = Object.freeze({ cwd, directoryPath, entryPath, targetUrl, sourceSha256, created });
  if (fileIdentity) receiptIdentities.set(value, fileIdentity);
  return value;
}
async function matchingExisting(entryPath: string, expected: Buffer) {
  const info = await lstat(entryPath);
  if (info.isSymbolicLink() || !info.isFile()) throw new Error("existing entry is not a regular file");
  if ((info.mode & 0o777) !== 0o600) throw new Error("existing entry has unsafe permissions");
  if (!Buffer.from(await readFile(entryPath)).equals(expected)) throw new Error("existing entry conflicts with requested runtime");
}
async function removeIfSameFile(filePath: string, expected: Identity) {
  try { if (sameFile(identity(await lstat(filePath, { bigint: true })), expected)) await unlink(filePath); } catch (error: any) { if (error?.code !== "ENOENT") throw error; }
}
async function cleanTemporary(temporaryPath: string, temporaryIdentity: Identity) {
  try { await unlink(temporaryPath); return; } catch (error: any) {
    try { await lstat(temporaryPath); } catch (missing: any) { if (missing?.code === "ENOENT") return; throw error; }
    await removeIfSameFile(temporaryPath, temporaryIdentity).catch(() => undefined);
    throw error;
  }
}

export async function materializeChildRuntimeEntry({ cwd, fileName, targetUrl }: { cwd: string; fileName: string; targetUrl: string | URL }): Promise<Receipt> {
  validateFileName(fileName);
  const canonicalCwd = await canonicalDirectory(cwd); const canonicalTargetUrl = await canonicalTarget(targetUrl);
  const directoryPath = await namespace(canonicalCwd); const entryPath = path.join(directoryPath, fileName);
  const bytes = Buffer.from(entrySource(canonicalTargetUrl)); const digest = sha256(bytes);
  try { await matchingExisting(entryPath, bytes); return receipt(canonicalCwd, directoryPath, entryPath, canonicalTargetUrl, digest, false); } catch (error: any) { if (error?.code !== "ENOENT") throw error; }
  const temporaryPath = path.join(directoryPath, `.${fileName}.${randomUUID()}.tmp`);
  let temporaryIdentity: Identity | undefined; let published = false;
  try {
    await writeFile(temporaryPath, bytes, { mode: 0o600, flag: "wx" });
    const temporaryInfo = await lstat(temporaryPath, { bigint: true }); temporaryIdentity = identity(temporaryInfo);
    if (!temporaryInfo.isFile() || temporaryInfo.isSymbolicLink() || (temporaryInfo.mode & 0o777n) !== 0o600n) throw new Error("temporary entry is unsafe");
    try { await link(temporaryPath, entryPath); published = true; } catch (error: any) {
      if (error?.code !== "EEXIST") throw error;
      await cleanTemporary(temporaryPath, temporaryIdentity);
      await matchingExisting(entryPath, bytes);
      return receipt(canonicalCwd, directoryPath, entryPath, canonicalTargetUrl, digest, false);
    }
    await cleanTemporary(temporaryPath, temporaryIdentity);
    const publishedInfo = await lstat(entryPath, { bigint: true }); const publishedIdentity = identity(publishedInfo);
    if (!sameFile(publishedIdentity, temporaryIdentity) || !publishedInfo.isFile() || publishedInfo.isSymbolicLink() || (publishedInfo.mode & 0o777n) !== 0o600n || !Buffer.from(await readFile(entryPath)).equals(bytes)) throw new Error("published entry verification failed");
    return receipt(canonicalCwd, directoryPath, entryPath, canonicalTargetUrl, digest, true, publishedIdentity);
  } catch (error) {
    if (published && temporaryIdentity) await removeIfSameFile(entryPath, temporaryIdentity).catch(() => undefined);
    if (temporaryIdentity) await removeIfSameFile(temporaryPath, temporaryIdentity).catch(() => undefined);
    throw error;
  }
}

export async function removeChildRuntimeEntry(value: Receipt) {
  if (!value?.created) return;
  const expectedIdentity = receiptIdentities.get(value);
  if (!expectedIdentity) throw new Error("invalid child runtime receipt");
  const { cwd, directoryPath, entryPath, sourceSha256 } = value;
  if (typeof cwd !== "string" || typeof directoryPath !== "string" || typeof entryPath !== "string" || typeof sourceSha256 !== "string") throw new TypeError("invalid child runtime receipt");
  const canonicalCwd = await canonicalDirectory(cwd);
  const namespaceInfo = await lstat(directoryPath);
  if (namespaceInfo.isSymbolicLink() || !namespaceInfo.isDirectory()) throw new Error("receipt path is unsafe");
  const canonicalNamespace = await realpath(directoryPath);
  if (!isInside(canonicalCwd, canonicalNamespace) || canonicalNamespace !== path.join(canonicalCwd, ".pi-subagents") || path.dirname(entryPath) !== canonicalNamespace) throw new Error("receipt path is unsafe");
  const info = await lstat(entryPath, { bigint: true });
  if (info.isSymbolicLink() || !info.isFile() || !sameIdentity(identity(info), expectedIdentity)) throw new Error("entry ownership changed");
  if (sha256(await readFile(entryPath)) !== sourceSha256) throw new Error("entry ownership changed");
  await unlink(entryPath); receiptIdentities.delete(value);
  await rmdir(canonicalNamespace).catch((error: any) => { if (error?.code !== "ENOTEMPTY" && error?.code !== "EEXIST") throw error; });
}
