import { createHash, randomUUID } from "node:crypto";

const TOKEN_PREFIX = "goal-action.v1:";

function fail(message) {
  throw new Error(`invalid action offer: ${message}`);
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function canonicalize(value, location = "value") {
  if (Array.isArray(value)) return value.map((item, index) => canonicalize(item, `${location}[${index}]`));
  if (value === null || ["string", "boolean"].includes(typeof value)) return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (!isPlainObject(value)) fail(`${location} must contain only JSON values`);
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key], `${location}.${key}`)]));
}

function canonicalJSON(value) {
  return JSON.stringify(canonicalize(value));
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function normalizedString(value, location) {
  if (typeof value !== "string" || !value.trim()) fail(`${location} is required`);
  return value.trim();
}

function tokenFor(fields) {
  return TOKEN_PREFIX + createHash("sha256").update(canonicalJSON(fields)).digest("hex");
}

function tokenFields(offer) {
  return {
    goalId: offer.goalId,
    projectionVersion: offer.projectionVersion,
    sessionId: offer.sessionId,
    tool: offer.tool,
    params: offer.params,
    nonce: offer.nonce,
  };
}

export function issueActionOffer(projection, machineAction, sessionId) {
  if (!projection || typeof projection !== "object") fail("projection is required");
  const goalId = normalizedString(projection.goalId, "projection.goalId");
  if (!Number.isSafeInteger(projection.version) || projection.version < 0) fail("projection.version must be a non-negative safe integer");
  if (!isPlainObject(machineAction)) fail("machineAction must be an object");
  const tool = normalizedString(machineAction.tool, "machineAction.tool");
  if (!isPlainObject(machineAction.params)) fail("machineAction.params must be an object");
  const boundSessionId = normalizedString(sessionId, "sessionId");
  const params = canonicalize(machineAction.params, "machineAction.params");
  const offer = {
    id: randomUUID(),
    nonce: randomUUID(),
    goalId,
    projectionVersion: projection.version + 1,
    sessionId: boundSessionId,
    tool,
    params,
    consumed: false,
  };
  return deepFreeze({ ...offer, token: tokenFor(tokenFields(offer)) });
}

export function verifyAndConsumeActionOffer(projection, request) {
  if (!projection || typeof projection !== "object") fail("projection is required");
  if (!isPlainObject(request)) fail("request must be an object");
  const offer = projection.actionOffer;
  if (!isPlainObject(offer)) fail("no action offer is active");
  if (offer.consumed) fail("action offer is already consumed");
  if (projection.goalId !== offer.goalId) fail("goal does not match the action offer");
  if (projection.version !== offer.projectionVersion) fail("projection version does not match the action offer");
  if (request.sessionId !== offer.sessionId) fail("session does not match the action offer");
  if (request.tool !== offer.tool) fail("tool does not match the action offer");
  if (canonicalJSON(request.params) !== canonicalJSON(offer.params)) fail("params do not match the action offer");
  if (request.token !== offer.token) fail("token does not match the action offer");
  if (offer.token !== tokenFor(tokenFields(offer))) fail("persisted action offer token is invalid");
  return deepFreeze({ offerId: offer.id, token: offer.token, tool: offer.tool, sessionId: offer.sessionId });
}
