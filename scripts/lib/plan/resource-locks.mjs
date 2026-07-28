import { pathsOverlap } from "./ir/compile.mjs";

const MODES = new Set(["shared", "exclusive"]);

function codedError(code, message, detail) {
  return Object.assign(new Error(message), { code, detail });
}

function normalizeCapacities(capacities) {
  if (!capacities || typeof capacities !== "object" || Array.isArray(capacities)) {
    throw codedError("INVALID_CAPACITIES", "Resource capacities must be an object");
  }
  const normalized = {};
  for (const [resourceId, capacity] of Object.entries(capacities)) {
    if (!resourceId || !Number.isSafeInteger(capacity) || capacity < 1) {
      throw codedError("INVALID_CAPACITY", `Invalid capacity for resource ${resourceId}`, resourceId);
    }
    normalized[resourceId] = capacity;
  }
  return normalized;
}

function compareClaims(left, right) {
  return left.resourceId.localeCompare(right.resourceId)
    || left.nodeId.localeCompare(right.nodeId)
    || left.attemptId.localeCompare(right.attemptId);
}

function validateNode(node, capacities) {
  if (!node || typeof node.id !== "string" || !Array.isArray(node.allowedPaths) || !Array.isArray(node.resources)) {
    throw codedError("INVALID_RESOURCE_NODE", "Resource authorization node is invalid", node?.id);
  }
  const seen = new Set();
  for (const resource of node.resources) {
    if (!resource || typeof resource.id !== "string" || !MODES.has(resource.mode)) {
      throw codedError("INVALID_RESOURCE_CLAIM", `Invalid resource claim in ${node.id}`, node.id);
    }
    if (!(resource.id in capacities)) {
      throw codedError("UNKNOWN_RESOURCE", `Unknown resource ${resource.id} in ${node.id}`, resource.id);
    }
    if (seen.has(resource.id)) {
      throw codedError("DUPLICATE_RESOURCE", `Duplicate resource ${resource.id} in ${node.id}`, resource.id);
    }
    seen.add(resource.id);
  }
}

function claimsFor(node, attemptId) {
  return [
    ...node.allowedPaths.map((ownedPath) => ({
      attemptId,
      nodeId: node.id,
      resourceId: `path:${ownedPath}`,
      mode: "exclusive",
      path: ownedPath,
    })),
    ...node.resources.map((resource) => ({
      attemptId,
      nodeId: node.id,
      resourceId: resource.id,
      mode: resource.mode,
    })),
  ];
}

export function createResourceClaimSet({ capacities, claims = [] }) {
  const normalizedCapacities = normalizeCapacities(capacities);
  const held = [];
  const attempts = new Set();

  function hydrate(claim) {
    if (!claim || typeof claim.attemptId !== "string" || typeof claim.nodeId !== "string"
      || typeof claim.resourceId !== "string" || !MODES.has(claim.mode)) {
      throw codedError("INVALID_RESOURCE_CLAIM", "Persisted resource claim is invalid");
    }
    if (claim.resourceId.startsWith("path:")) {
      if (claim.mode !== "exclusive" || typeof claim.path !== "string" || claim.resourceId !== `path:${claim.path}`) {
        throw codedError("INVALID_RESOURCE_CLAIM", "Persisted path claim is invalid", claim.resourceId);
      }
    } else if (!(claim.resourceId in normalizedCapacities)) {
      throw codedError("UNKNOWN_RESOURCE", `Unknown persisted resource ${claim.resourceId}`, claim.resourceId);
    }
    held.push(Object.freeze({ ...claim }));
    attempts.add(claim.attemptId);
  }

  for (const claim of claims) hydrate(claim);
  for (let leftIndex = 0; leftIndex < held.length; leftIndex++) {
    for (let rightIndex = leftIndex + 1; rightIndex < held.length; rightIndex++) {
      const left = held[leftIndex];
      const right = held[rightIndex];
      if (left.attemptId === right.attemptId) continue;
      const pathConflict = left.path && right.path && pathsOverlap(left.path, right.path);
      const resourceConflict = left.resourceId === right.resourceId
        && (left.mode === "exclusive" || right.mode === "exclusive");
      if (pathConflict || resourceConflict) {
        throw codedError("CLAIM_SNAPSHOT_CONFLICT", `Conflicting recovered claims: ${left.resourceId} and ${right.resourceId}`);
      }
    }
  }
  for (const [resourceId, capacity] of Object.entries(normalizedCapacities)) {
    const resourceClaims = held.filter((claim) => claim.resourceId === resourceId);
    if (resourceClaims.length > capacity || new Set(resourceClaims.map((claim) => claim.attemptId)).size !== resourceClaims.length) {
      throw codedError("CLAIM_SNAPSHOT_CONFLICT", `Recovered claims exceed capacity for ${resourceId}`, resourceId);
    }
  }

  function canAcquire(node) {
    validateNode(node, normalizedCapacities);
    for (const ownedPath of node.allowedPaths) {
      if (held.some((claim) => claim.path && pathsOverlap(ownedPath, claim.path))) return false;
    }
    for (const requested of node.resources) {
      const resourceClaims = held.filter((claim) => claim.resourceId === requested.id);
      if (requested.mode === "exclusive") {
        if (resourceClaims.length > 0) return false;
        continue;
      }
      if (resourceClaims.some((claim) => claim.mode === "exclusive")) return false;
      if (resourceClaims.length >= normalizedCapacities[requested.id]) return false;
    }
    return true;
  }

  function acquire(node, attemptId) {
    if (typeof attemptId !== "string" || !attemptId) {
      throw codedError("INVALID_ATTEMPT", "attemptId is required for resource acquisition");
    }
    if (attempts.has(attemptId)) {
      throw codedError("DUPLICATE_ATTEMPT_CLAIM", `Attempt already owns resource claims: ${attemptId}`, attemptId);
    }
    if (!canAcquire(node)) {
      throw codedError("RESOURCE_UNAVAILABLE", `Resources are unavailable for ${node.id}`, node.id);
    }
    for (const claim of claimsFor(node, attemptId)) held.push(Object.freeze(claim));
    attempts.add(attemptId);
    return snapshot().filter((claim) => claim.attemptId === attemptId);
  }

  function release(attemptId) {
    let write = 0;
    for (let read = 0; read < held.length; read++) {
      if (held[read].attemptId !== attemptId) held[write++] = held[read];
    }
    const removed = held.length - write;
    held.length = write;
    attempts.delete(attemptId);
    return removed;
  }

  function snapshot() {
    return held.map((claim) => ({ ...claim })).sort(compareClaims);
  }

  return Object.freeze({ canAcquire, acquire, release, snapshot });
}

export function selectAuthorizedFrontier(nodes, { capacities, claims = [] }) {
  const candidates = nodes.map((node, inputOrder) => ({ node, inputOrder }));
  candidates.sort((left, right) => {
    const leftOrder = Number.isSafeInteger(left.node.planOrder) ? left.node.planOrder : left.inputOrder;
    const rightOrder = Number.isSafeInteger(right.node.planOrder) ? right.node.planOrder : right.inputOrder;
    return leftOrder - rightOrder || left.node.id.localeCompare(right.node.id);
  });
  const claimSet = createResourceClaimSet({ capacities, claims });
  const selected = [];
  for (const { node } of candidates) {
    if (!claimSet.canAcquire(node)) continue;
    claimSet.acquire(node, `candidate:${node.id}`);
    selected.push(node);
  }
  return selected;
}
