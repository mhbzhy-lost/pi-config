import { createHash, randomUUID } from "node:crypto";

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
  } else if (kind === "runtime_activation_approval") {
    for (const field of ["goalId", "contractHash", "baseHead", "proposalId"]) requiredString(challenge[field], `challenge.${field}`);
    if (!/^[a-f0-9]{64}$/.test(challenge.contractHash)) fail("valid challenge.contractHash is required");
    if (!/^[a-f0-9]{40,64}$/.test(challenge.baseHead)) fail("valid challenge.baseHead is required");
  } else if (kind === "session_transfer_approval") {
    if (!new Set(["批准", "approve", "拒绝", "reject"]).has(requiredString(inputEvent.text, "inputEvent.text").toLocaleLowerCase("en-US"))) fail("user input must exactly match one allowed choice");
  } else if (kind !== "orphan_disposition") {
    fail(`unsupported challenge kind: ${kind}`);
  }

  return {
    challengeId,
    kind,
    choice,
    ...(kind === "goal_metadata_approval" ? { proposalHash: challenge.proposalHash } : {}),
    ...(kind === "runtime_activation_approval" ? {
      goalId: challenge.goalId, contractHash: challenge.contractHash, baseHead: challenge.baseHead, proposalId: challenge.proposalId,
    } : {}),
    userEntryId: requiredString(inputEvent.id, "inputEvent.id"),
    sessionId: boundSessionId,
    source: inputEvent.source,
  };
}

export function createRuntimeActivationChallenge({ goalId, contractHash, baseHead, sessionId, proposalId } = {}) {
  const normalizedGoalId = requiredString(goalId, "goalId");
  const normalizedContractHash = requiredString(contractHash, "contractHash");
  const normalizedBaseHead = requiredString(baseHead, "baseHead");
  const normalizedSessionId = requiredString(sessionId, "sessionId");
  const normalizedProposalId = requiredString(proposalId, "proposalId");
  if (!/^[a-f0-9]{64}$/.test(normalizedContractHash)) fail("contractHash must be a SHA-256 hash");
  if (!/^[a-f0-9]{40,64}$/.test(normalizedBaseHead)) fail("baseHead must be a Git hash");
  return Object.freeze({
    id: randomUUID(), kind: "runtime_activation_approval", choices: ["approve", "reject"], requestedAt: new Date().toISOString(),
    goalId: normalizedGoalId, contractHash: normalizedContractHash, baseHead: normalizedBaseHead, sessionId: normalizedSessionId, proposalId: normalizedProposalId,
  });
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
