import { validateDAG } from "./graph.mjs";
import { normalizeRepoRelativePosixPath } from "./repo-path.mjs";
import { MAX_CONTRACT_ARRAY_ITEMS, assertContractArray, assertContractString } from "./contract-limits.mjs";

const ID = /^[A-Za-z0-9._-]{1,160}$/;
const WORKFLOWS = new Set(["tdd", "existing-tests", "docs-only"]);
const CRITERION_ID = /^[A-Za-z0-9._-]{1,160}$/;
const EVIDENCE_KINDS = new Set(["changed-files", "tests", "command", "manual-review"]);

function nonEmpty(value, label) {
  return assertContractString(value, label);
}

export function validateRepoRelativePath(value, label = "writePath") {
  return normalizeRepoRelativePosixPath(nonEmpty(value, label), label);
}

// Repair metadata is persisted with the internal task definition, never transported.
export function validateRemediationMetadata(metadata, label = "taskDef metadata") {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)
    || Object.keys(metadata).length !== 8
    || !["kind", "goalId", "executionRevision", "episodeId", "conditionId", "findingIds", "subjectHash", "taskDefHash"].every((key) => Object.hasOwn(metadata, key))
    || metadata.kind !== "remediation"
    || !ID.test(metadata.goalId || "") || !Number.isSafeInteger(metadata.executionRevision) || !ID.test(metadata.conditionId || "")
    || !/^[a-f0-9]{64}$/.test(metadata.subjectHash || "") || !/^[a-f0-9]{64}$/.test(metadata.taskDefHash || "")
    || !ID.test(metadata.episodeId || "")
    || !Array.isArray(metadata.findingIds) || !metadata.findingIds.length
    || metadata.findingIds.some((id) => !ID.test(id || ""))
    || new Set(metadata.findingIds).size !== metadata.findingIds.length) throw new Error(`${label} must be exact remediation metadata`);
  return metadata;
}

function validateCommand(value, label, cwd, realpathCwd) {
  const command = nonEmpty(value, label);
  // This deliberately is not a shell parser: except for an exact prose echo, fail closed
  // when the supported subset observes an absolute cd, including shell-wrapper payloads.
  if (!/^echo\s+(['"])cd\s+\/.*\1$/.test(command) && /\bcd\s+(?:--\s+)?["']?\//.test(command)) throw new Error(`${label} must not use absolute cd`);
  if ([cwd, realpathCwd].filter(Boolean).some((origin) => command.includes(origin))) throw new Error(`${label} must not hardcode origin cwd`);
  return command;
}

export function validateTaskDefinitions(tasks, taskDefs, { requireNonEmpty = true, cwd, realpathCwd, planned = false, hostInternalRemediation = false } = {}) {
  if (!Array.isArray(tasks) || (requireNonEmpty && tasks.length === 0)) throw new Error("tasks must be non-empty");
  if (tasks.length > MAX_CONTRACT_ARRAY_ITEMS) throw new Error(`tasks must contain at most ${MAX_CONTRACT_ARRAY_ITEMS} items`);
  if (!taskDefs || typeof taskDefs !== "object" || Array.isArray(taskDefs)) throw new Error("taskDefs is required");
  const ids = new Set();
  for (const id of tasks) {
    if (!ID.test(id || "") || ids.has(id)) throw new Error(`invalid or duplicate task id: ${id}`);
    ids.add(id);
  }
  const keys = Object.keys(taskDefs);
  if (keys.length !== ids.size || keys.some((id) => !ids.has(id))) throw new Error("taskDefs must exactly match tasks");
  const graph = new Map();
  for (const id of tasks) {
    const def = taskDefs[id];
    if (!def || typeof def !== "object") throw new Error(`missing taskDef for ${id}`);
    nonEmpty(def.description, `taskDef ${id} description`);
    if (Object.hasOwn(def, "metadata")) {
      if (!hostInternalRemediation) throw new Error(`taskDef ${id} metadata is Host-internal only`);
      validateRemediationMetadata(def.metadata, `taskDef ${id} metadata`);
    }
    assertContractArray(def.deps, `taskDef ${id} deps`);
    const deps = new Set();
    for (const dep of def.deps) {
      if (!ID.test(dep || "") || deps.has(dep)) throw new Error(`taskDef ${id} has invalid or duplicate dep: ${dep}`);
      deps.add(dep);
    }
    assertContractArray(def.writePaths, `taskDef ${id} writePaths`);
    if (!def.writePaths.length) throw new Error(`taskDef ${id} missing writePaths`);
    def.writePaths.forEach((path, index) => validateRepoRelativePath(path, `taskDef ${id} writePaths[${index}]`));
    if (!def.acceptance || typeof def.acceptance !== "object" || Array.isArray(def.acceptance)) throw new Error(`taskDef ${id} requires acceptance`);
    if (planned) validatePlannedAcceptance(def.acceptance, id);
    else {
      assertContractArray(def.acceptance.criteria, `taskDef ${id} acceptance.criteria`);
      assertContractArray(def.acceptance.commands, `taskDef ${id} acceptance.commands`);
      if (!def.acceptance.criteria.length || !def.acceptance.commands.length) throw new Error(`taskDef ${id} requires non-empty acceptance criteria and commands`);
      def.acceptance.criteria.forEach((value, index) => nonEmpty(value, `taskDef ${id} acceptance.criteria[${index}]`));
      def.acceptance.commands.forEach((value, index) => validateCommand(value, `taskDef ${id} acceptance.commands[${index}]`, cwd, realpathCwd));
    }
    if (!WORKFLOWS.has(def.workflow || "tdd")) throw new Error(`taskDef ${id} workflow is not supported`);
    graph.set(id, { deps: def.deps });
  }
  validateDAG(graph);
}

function validatePlannedAcceptance(acceptance, taskId) {
  if (Object.keys(acceptance).length !== 1 || !Object.hasOwn(acceptance, "criteria")) throw new Error(`taskDef ${taskId} planned acceptance must contain only criteria`);
  assertContractArray(acceptance.criteria, `taskDef ${taskId} acceptance.criteria`);
  if (!acceptance.criteria.length) throw new Error(`taskDef ${taskId} acceptance.criteria must be non-empty`);
  const ids = new Set();
  acceptance.criteria.forEach((criterion, index) => {
    if (!criterion || typeof criterion !== "object" || Array.isArray(criterion) || Object.keys(criterion).length !== 3
      || !["id", "statement", "evidenceKinds"].every((key) => Object.hasOwn(criterion, key))) throw new Error(`taskDef ${taskId} acceptance.criteria[${index}] must contain exactly id, statement, evidenceKinds`);
    if (!CRITERION_ID.test(criterion.id || "") || ids.has(criterion.id)) throw new Error(`taskDef ${taskId} acceptance.criteria has invalid or duplicate id: ${criterion.id}`);
    ids.add(criterion.id);
    nonEmpty(criterion.statement, `taskDef ${taskId} acceptance.criteria[${index}].statement`);
    assertContractArray(criterion.evidenceKinds, `taskDef ${taskId} acceptance.criteria[${index}].evidenceKinds`);
    if (!criterion.evidenceKinds.length || criterion.evidenceKinds.some((kind) => !EVIDENCE_KINDS.has(kind))) throw new Error(`taskDef ${taskId} acceptance.criteria[${index}].evidenceKinds is invalid`);
  });
}
