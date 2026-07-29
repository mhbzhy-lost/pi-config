import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { TextDecoder } from "node:util";

import { parsePlanDocument } from "./plan-document.mjs";
import { compilePlanToIR } from "./ir/index.mjs";

const PLAN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const MAX_SOURCE_BYTES = 1024 * 1024;
const HASH = /^[a-f0-9]{64}$/;

function sha256Bytes(value) {
  return createHash("sha256").update(value).digest("hex");
}

function hashCanonical(value) {
  return sha256Bytes(Buffer.from(JSON.stringify(value), "utf8"));
}

function revisionDirectory(stateRoot, planId, revision) {
  if (!PLAN_ID.test(planId) || planId.includes("..") || !Number.isSafeInteger(revision) || revision < 1) {
    throw new Error("invalid Plan revision identity");
  }
  return path.join(stateRoot, "var", "plan-runs", planId, "revisions", String(revision).padStart(6, "0"));
}

async function writePrivate(file, bytes) {
  await writeFile(file, bytes, { mode: 0o600, flag: "wx" });
  await chmod(file, 0o600);
}

function revisionTaskHashes(ir) {
  return Object.fromEntries(ir.nodes.map((node) => {
    if (ir.version === "plan-ir.v3") return [node.id, { full: node.hashes.full, effective: node.hashes.effective, scheduling: node.hashes.scheduling }];
    const full = hashCanonical(node);
    return [node.id, { full, effective: full, scheduling: ir.nodeFingerprints?.[node.id] ?? full }];
  }));
}

function validIdentity(planId, revision) {
  revisionDirectory("/ignored", planId, revision);
}

function validateHash(value, label) {
  if (typeof value !== "string" || !HASH.test(value)) throw new Error(`invalid Plan revision ${label}`);
}

function validateInitiator(initiator) {
  if (!initiator || typeof initiator !== "object" || Array.isArray(initiator) || typeof initiator.kind !== "string" || !initiator.kind) {
    throw new Error("invalid Plan revision initiator");
  }
  return initiator;
}

export function createPlanRevisionStore({ stateRoot, now = () => new Date().toISOString() }) {
  if (typeof stateRoot !== "string" || !stateRoot) throw new Error("stateRoot is required");
  const root = path.resolve(stateRoot);
  const planRoot = (planId) => path.join(root, "var", "plan-runs", planId);
  const currentPath = (planId) => path.join(planRoot(planId), "current.json");

  async function readRevision(planId, revision) {
    validIdentity(planId, revision);
    const directory = revisionDirectory(root, planId, revision);
    let sourceBytes;
    let artifact;
    let manifestBytes;
    try {
      [sourceBytes, artifact, manifestBytes] = await Promise.all([
        readFile(path.join(directory, "source.md")), readFile(path.join(directory, "plan-ir.json")), readFile(path.join(directory, "manifest.json")),
      ]);
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
    let manifest;
    let ir;
    try { manifest = JSON.parse(manifestBytes); ir = JSON.parse(artifact); } catch { throw new Error("malformed Plan revision artifact"); }
    if (!manifest || manifest.schemaVersion !== "plan-revision.v1" || manifest.planId !== planId || manifest.revision !== revision
      || sha256Bytes(sourceBytes) !== manifest.sourceBytesSha256 || sha256Bytes(artifact) !== manifest.irArtifactSha256
      || manifest.irHash !== (ir.hash ?? sha256Bytes(artifact)) || !HASH.test(manifest.planHash) || !HASH.test(manifest.irHash)) {
      throw new Error("malformed Plan revision artifact");
    }
    const source = new TextDecoder("utf-8", { fatal: true }).decode(sourceBytes);
    const plan = parsePlanDocument(source, path.join(directory, "source.md"));
    if (plan.sha256 !== manifest.planHash) throw new Error("malformed Plan revision artifact");
    return Object.freeze({ planId, revision, directory, sourcePath: path.join(directory, "source.md"), irPath: path.join(directory, "plan-ir.json"), sourceBytes, plan, ir, manifest, manifestSha256: sha256Bytes(manifestBytes) });
  }

  async function prepareRevision({ planId, sourceBytes, reason, initiator, expectedIrHash } = {}) {
    if (!Buffer.isBuffer(sourceBytes)) throw new Error("Plan revision sourceBytes must be a Buffer");
    if (sourceBytes.length > MAX_SOURCE_BYTES) throw new Error("Plan revision source exceeds 1 MiB");
    if (typeof reason !== "string" || !reason) throw new Error("invalid Plan revision reason");
    validateInitiator(initiator);
    const source = new TextDecoder("utf-8", { fatal: true }).decode(sourceBytes);
    const plan = parsePlanDocument(source, `${planId}.md`);
    const revision = plan.schemaVersion === "pi-plan.v3" ? plan.revision : 1;
    validIdentity(planId, revision);
    if (plan.schemaVersion !== "pi-plan.v3" && (reason !== "initial-approval" || initiator.kind !== "launcher")) {
      throw new Error("legacy Plan revisions can only be initially approved by Launcher");
    }
    const ir = compilePlanToIR(plan);
    const irArtifact = Buffer.from(`${JSON.stringify(ir, null, 2)}\n`, "utf8");
    const irHash = ir.hash ?? sha256Bytes(irArtifact);
    if (expectedIrHash !== undefined && expectedIrHash !== irHash) throw new Error("expected Plan IR hash does not match");
    const manifest = {
      schemaVersion: "plan-revision.v1", planId, revision, createdAt: now(), reason, initiator,
      sourceBytesSha256: sha256Bytes(sourceBytes), planHash: plan.sha256, irHash,
      irArtifactSha256: sha256Bytes(irArtifact), taskHashes: revisionTaskHashes(ir),
    };
    const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    const directory = revisionDirectory(root, planId, revision);
    const existing = await readRevision(planId, revision);
    const same = (value) => JSON.stringify(value) === JSON.stringify(manifest.initiator);
    if (existing) {
      if (!existing.sourceBytes.equals(sourceBytes) || existing.manifest.irHash !== irHash || existing.manifest.reason !== reason || !same(existing.manifest.initiator)) {
        throw new Error("immutable Plan revision conflict");
      }
      return existing;
    }
    const parent = path.dirname(directory);
    const candidate = path.join(parent, `.candidate-${revision}-${randomUUID()}`);
    await mkdir(candidate, { recursive: true, mode: 0o700 });
    await chmod(candidate, 0o700);
    try {
      await writePrivate(path.join(candidate, "source.md"), sourceBytes);
      await writePrivate(path.join(candidate, "plan-ir.json"), irArtifact);
      await writePrivate(path.join(candidate, "manifest.json"), manifestBytes);
      const verified = await readRevisionFrom(candidate, planId, revision);
      if (!verified.sourceBytes.equals(sourceBytes) || verified.manifest.irHash !== irHash) throw new Error("Plan revision candidate verification failed");
      try { await rename(candidate, directory); } catch (error) {
        if (error?.code !== "EEXIST" && error?.code !== "ENOTEMPTY") throw error;
        const published = await readRevision(planId, revision);
        if (!published || !published.sourceBytes.equals(sourceBytes) || published.manifest.irHash !== irHash || published.manifest.reason !== reason || JSON.stringify(published.manifest.initiator) !== JSON.stringify(initiator)) throw new Error("immutable Plan revision conflict");
        return published;
      }
      return await readRevision(planId, revision);
    } finally { await rm(candidate, { recursive: true, force: true }).catch(() => {}); }
  }

  async function readRevisionFrom(directory, planId, revision) {
    const original = revisionDirectory(root, planId, revision);
    const relative = path.relative(path.dirname(original), directory);
    if (!relative.startsWith(".candidate-")) throw new Error("invalid Plan revision candidate");
    const [sourceBytes, artifact, manifestBytes] = await Promise.all([readFile(path.join(directory, "source.md")), readFile(path.join(directory, "plan-ir.json")), readFile(path.join(directory, "manifest.json"))]);
    const manifest = JSON.parse(manifestBytes);
    const ir = JSON.parse(artifact);
    if (sha256Bytes(sourceBytes) !== manifest.sourceBytesSha256 || sha256Bytes(artifact) !== manifest.irArtifactSha256 || manifest.irHash !== (ir.hash ?? sha256Bytes(artifact))) throw new Error("malformed Plan revision artifact");
    return { sourceBytes, manifest, ir };
  }

  async function writeCurrent(planId, manifest) {
    validIdentity(planId, manifest?.revision);
    validateHash(manifest.manifestSha256 ?? "", "manifest hash");
    validateHash(manifest.irHash, "IR hash");
    const pointer = { schemaVersion: "plan-revision-pointer.v1", planId, revision: manifest.revision, manifestSha256: manifest.manifestSha256, irHash: manifest.irHash };
    const destination = currentPath(planId);
    await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    const temporary = `${destination}.${randomUUID()}.tmp`;
    await writePrivate(temporary, Buffer.from(`${JSON.stringify(pointer, null, 2)}\n`, "utf8"));
    await rename(temporary, destination);
    return pointer;
  }

  async function readCurrent(planId) {
    validIdentity(planId, 1);
    let pointer;
    try { pointer = JSON.parse(await readFile(currentPath(planId), "utf8")); } catch (error) { if (error?.code === "ENOENT") return null; throw new Error("malformed Plan revision current pointer"); }
    if (!pointer || pointer.schemaVersion !== "plan-revision-pointer.v1" || pointer.planId !== planId) throw new Error("malformed Plan revision current pointer");
    const revision = await readRevision(planId, pointer.revision);
    if (!revision || revision.manifestSha256 !== pointer.manifestSha256 || revision.manifest.irHash !== pointer.irHash) throw new Error("stale Plan revision current pointer");
    return revision;
  }

  async function reconcileCurrent(planId, revision) {
    const prepared = await readRevision(planId, revision);
    if (!prepared) return null;
    await writeCurrent(planId, { ...prepared.manifest, manifestSha256: prepared.manifestSha256 });
    return prepared;
  }

  return Object.freeze({ prepareRevision, readRevision, readCurrent, writeCurrent, reconcileCurrent });
}
