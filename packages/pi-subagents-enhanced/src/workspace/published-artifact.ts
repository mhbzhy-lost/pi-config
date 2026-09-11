import { createHash } from "node:crypto";

const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const SHA256 = /^[a-f0-9]{64}$/;

function fail(message: string): never { throw new TypeError(`Published artifact: ${message}`); }
function text(value: unknown, name: string): string {
  if (typeof value !== "string" || !value || value.trim() !== value || value.includes("\0")) fail(`${name} must be a non-empty string`);
  return value;
}
function digest(value: unknown, name: string, pattern = SHA): string {
  const result = text(value, name);
  if (!pattern.test(result)) fail(`${name} must be a lowercase hexadecimal digest`);
  return result;
}

export type PublishedArtifact = Readonly<{
  artifactId: string; workspaceId: string; baseCommit: string; publishedTree: string;
  sourceHead: string; refName: string; policyHash: string; changedFiles: string[]; proofId: string;
}>;

export function createPublishedArtifact(value: Omit<PublishedArtifact, "artifactId"> & { artifactId?: string }): PublishedArtifact {
  const changedFiles = [...new Set(value.changedFiles.map((file, i) => text(file, `changedFiles[${i}]`)))].sort();
  const body = {
    workspaceId: text(value.workspaceId, "workspaceId"), baseCommit: digest(value.baseCommit, "baseCommit"),
    publishedTree: digest(value.publishedTree, "publishedTree"), sourceHead: digest(value.sourceHead, "sourceHead"),
    refName: text(value.refName, "refName"), policyHash: digest(value.policyHash, "policyHash", SHA256), changedFiles,
    proofId: digest(value.proofId, "proofId", SHA256),
  };
  const artifactId = value.artifactId ?? createHash("sha256").update(JSON.stringify(body)).digest("hex");
  if (!SHA256.test(artifactId)) fail("artifactId must be a SHA-256 digest");
  return Object.freeze({ artifactId, ...body, changedFiles: Object.freeze(changedFiles) as unknown as string[] });
}

export function validatePublishedArtifact(value: unknown): PublishedArtifact {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("must be an object");
  const input = value as Record<string, unknown>;
  const keys = ["artifactId", "workspaceId", "baseCommit", "publishedTree", "sourceHead", "refName", "policyHash", "changedFiles", "proofId"];
  if (Object.keys(input).some((key) => !keys.includes(key)) || keys.some((key) => !Object.hasOwn(input, key))) fail("has invalid fields");
  if (!Array.isArray(input.changedFiles)) fail("changedFiles must be an array");
  const artifact = createPublishedArtifact(input as never);
  if (artifact.artifactId !== input.artifactId) fail("artifactId does not match artifact contents");
  return artifact;
}

export const publishedArtifact = createPublishedArtifact;
export const parsePublishedArtifact = validatePublishedArtifact;
