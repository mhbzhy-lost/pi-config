import { createHash } from "node:crypto";

const REAL_USER_SOURCES = new Set(["interactive", "rpc"]);
const CHOICE_ALIASES = new Map([
  ["discard", "discard"], ["丢弃", "discard"],
  ["preserve", "preserve"], ["保留", "preserve"],
  ["approve", "approve"], ["批准", "approve"], ["同意", "approve"],
  ["reject", "reject"], ["拒绝", "reject"],
]);

function fail(message) {
  throw new Error(`invalid human decision: ${message}`);
}

function requiredString(value, location) {
  if (typeof value !== "string" || !value.trim()) fail(`${location} is required`);
  return value.trim();
}

function validTimestamp(value, location) {
  const normalized = requiredString(value, location);
  const milliseconds = Date.parse(normalized);
  if (Number.isNaN(milliseconds)) fail(`${location} must be a timestamp`);
  return milliseconds;
}

function normalizeStringArray(value, location) {
  if (!Array.isArray(value)) fail(`${location} must be an array`);
  return value.map((entry, index) => requiredString(entry, `${location}[${index}]`));
}

export function recordHumanChoice({ inputEvent, challenge, sessionId } = {}) {
  if (!inputEvent || typeof inputEvent !== "object") fail("inputEvent is required");
  if (!challenge || typeof challenge !== "object") fail("challenge is required");
  const boundSessionId = requiredString(sessionId, "sessionId");
  if (inputEvent.role !== "user") fail("inputEvent must be a user entry");
  if (!REAL_USER_SOURCES.has(inputEvent.source)) fail("user input source must be interactive or rpc");
  if (inputEvent.sessionId !== boundSessionId || challenge.sessionId !== boundSessionId) fail("input and challenge must use the same session");
  if (validTimestamp(inputEvent.occurredAt, "inputEvent.occurredAt") <= validTimestamp(challenge.requestedAt, "challenge.requestedAt")) {
    fail("user input must occur after the challenge");
  }

  const challengeId = requiredString(challenge.id, "challenge.id");
  const kind = requiredString(challenge.kind, "challenge.kind");
  const choices = normalizeStringArray(challenge.choices, "challenge.choices");
  const normalizedText = requiredString(inputEvent.text, "inputEvent.text").toLocaleLowerCase("en-US");
  const choice = CHOICE_ALIASES.get(normalizedText);
  if (!choice || !choices.includes(choice)) fail("user input must exactly match one allowed choice");

  if (kind === "goal_metadata_approval") {
    if (challenge.proposalPresented !== true) fail("metadata proposal must be presented before approval");
    if (typeof challenge.proposalHash !== "string" || !/^[a-f0-9]{64}$/.test(challenge.proposalHash)) fail("valid proposalHash is required");
  } else if (kind !== "orphan_disposition") {
    fail(`unsupported challenge kind: ${kind}`);
  }

  return {
    challengeId,
    kind,
    choice,
    ...(kind === "goal_metadata_approval" ? { proposalHash: challenge.proposalHash } : {}),
    userEntryId: requiredString(inputEvent.id, "inputEvent.id"),
    sessionId: boundSessionId,
    source: inputEvent.source,
  };
}

export function hashGoalMetadataProposal({ objective, scope, nonGoals, dod } = {}) {
  const normalized = {
    objective: requiredString(objective, "objective"),
    scope: normalizeStringArray(scope, "scope"),
    nonGoals: normalizeStringArray(nonGoals, "nonGoals"),
    dod: normalizeStringArray(dod, "dod"),
  };
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}
