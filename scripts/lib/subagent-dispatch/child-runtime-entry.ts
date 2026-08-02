import { createHash, randomUUID } from "node:crypto";
import { chmod, link, lstat, mkdir, readFile, realpath, rm, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

type Receipt = Readonly<{ cwd: string; directoryPath: string; entryPath: string; targetUrl: string; sourceSha256: string; created: boolean }>;

function sha256(value: string | Buffer) { return createHash("sha256").update(value).digest("hex"); }
function entrySource(targetUrl: string) { return `export { default } from ${JSON.stringify(targetUrl)};\n`; }
function isInside(parent: string, child: string) { const relative = path.relative(parent, child); return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative); }

function validateFileName(fileName: unknown): asserts fileName is string {
  if (typeof fileName !== "string" || !/^[^/\\\0.]+\.mjs$/.test(fileName) || fileName === "." || fileName === ".." || path.basename(fileName) !== fileName) {
    throw new TypeError("fileName must be a single .mjs basename");
  }
}

async function canonicalDirectory(cwd: unknown) {
  if (typeof cwd !== "string" || cwd.length === 0) throw new TypeError("cwd must be a directory path");
  const canonical = await realpath(cwd);
  if (!(await stat(canonical)).isDirectory()) throw new TypeError("cwd must be a directory");
  return canonical;
}

async function canonicalTarget(targetUrl: unknown) {
  if (typeof targetUrl !== "string") throw new TypeError("targetUrl must be a file: URL");
  let targetPath: string;
  try { const url = new URL(targetUrl); if (url.protocol !== "file:") throw new TypeError(); targetPath = fileURLToPath(url); } catch { throw new TypeError("targetUrl must be a file: URL"); }
  const canonical = await realpath(targetPath);
  if (!(await stat(canonical)).isFile()) throw new TypeError("targetUrl must resolve to a regular file");
  return pathToFileURL(canonical).href;
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

function receipt(cwd: string, directoryPath: string, entryPath: string, targetUrl: string, sourceSha256: string, created: boolean): Receipt {
  return Object.freeze({ cwd, directoryPath, entryPath, targetUrl, sourceSha256, created });
}

async function matchingExisting(entryPath: string, expected: Buffer) {
  const info = await lstat(entryPath);
  if (info.isSymbolicLink() || !info.isFile()) throw new Error("existing entry is not a regular file");
  if ((info.mode & 0o777) !== 0o600) throw new Error("existing entry has unsafe permissions");
  if (!Buffer.from(await readFile(entryPath)).equals(expected)) throw new Error("existing entry conflicts with requested runtime");
}

export async function materializeChildRuntimeEntry({ cwd, fileName, targetUrl }: { cwd: string; fileName: string; targetUrl: string }): Promise<Receipt> {
  validateFileName(fileName);
  const canonicalCwd = await canonicalDirectory(cwd);
  const canonicalTargetUrl = await canonicalTarget(targetUrl);
  const directoryPath = await namespace(canonicalCwd);
  const entryPath = path.join(directoryPath, fileName);
  const text = entrySource(canonicalTargetUrl); const bytes = Buffer.from(text); const digest = sha256(bytes);
  try { await matchingExisting(entryPath, bytes); return receipt(canonicalCwd, directoryPath, entryPath, canonicalTargetUrl, digest, false); } catch (error: any) { if (error?.code !== "ENOENT") throw error; }

  const temporaryPath = path.join(directoryPath, `.${fileName}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporaryPath, bytes, { mode: 0o600, flag: "wx" });
    const temporaryInfo = await lstat(temporaryPath);
    if (!temporaryInfo.isFile() || temporaryInfo.isSymbolicLink() || (temporaryInfo.mode & 0o777) !== 0o600) throw new Error("temporary entry is unsafe");
    await link(temporaryPath, entryPath);
    await unlink(temporaryPath);
    const published = await lstat(entryPath);
    if (!published.isFile() || published.isSymbolicLink() || (published.mode & 0o777) !== 0o600 || !Buffer.from(await readFile(entryPath)).equals(bytes)) throw new Error("published entry verification failed");
    return receipt(canonicalCwd, directoryPath, entryPath, canonicalTargetUrl, digest, true);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function removeChildRuntimeEntry(value: Receipt) {
  if (!value?.created) return;
  const { cwd, directoryPath, entryPath, sourceSha256 } = value;
  if (typeof cwd !== "string" || typeof directoryPath !== "string" || typeof entryPath !== "string" || typeof sourceSha256 !== "string") throw new TypeError("invalid child runtime receipt");
  const canonicalCwd = await canonicalDirectory(cwd);
  const canonicalNamespace = await realpath(directoryPath);
  if (!isInside(canonicalCwd, canonicalNamespace) || path.dirname(entryPath) !== canonicalNamespace) throw new Error("receipt path is unsafe");
  const info = await lstat(entryPath);
  if (info.isSymbolicLink() || !info.isFile()) throw new Error("entry ownership changed");
  const bytes = await readFile(entryPath);
  if (sha256(bytes) !== sourceSha256) throw new Error("entry ownership changed");
  await unlink(entryPath);
  await rmdir(canonicalNamespace).catch((error: any) => { if (error?.code !== "ENOTEMPTY" && error?.code !== "EEXIST") throw error; });
}
