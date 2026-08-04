import { validateDAG } from "./graph.mjs";
import { normalizeRepoRelativePosixPath } from "./repo-path.mjs";
import { MAX_CONTRACT_ARRAY_ITEMS, assertContractArray, assertContractString } from "./contract-limits.mjs";

const ID = /^[A-Za-z0-9._-]{1,160}$/;
const WORKFLOWS = new Set(["tdd", "existing-tests", "docs-only"]);

function nonEmpty(value, label) {
  return assertContractString(value, label);
}

export function validateRepoRelativePath(value, label = "writePath") {
  return normalizeRepoRelativePosixPath(nonEmpty(value, label), label);
}

function validateCommand(value, label, cwd, realpathCwd) {
  const command = nonEmpty(value, label);
  // This deliberately is not a shell parser: except for an exact prose echo, fail closed
  // when the supported subset observes an absolute cd, including shell-wrapper payloads.
  if (!/^echo\s+(['"])cd\s+\/.*\1$/.test(command) && /\bcd\s+(?:--\s+)?["']?\//.test(command)) throw new Error(`${label} must not use absolute cd`);
  if ([cwd, realpathCwd].filter(Boolean).some((origin) => command.includes(origin))) throw new Error(`${label} must not hardcode origin cwd`);
  return command;
}

export function validateTaskDefinitions(tasks, taskDefs, { requireNonEmpty = true, cwd, realpathCwd } = {}) {
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
    assertContractArray(def.deps, `taskDef ${id} deps`);
    const deps = new Set();
    for (const dep of def.deps) {
      if (!ID.test(dep || "") || deps.has(dep)) throw new Error(`taskDef ${id} has invalid or duplicate dep: ${dep}`);
      deps.add(dep);
    }
    assertContractArray(def.writePaths, `taskDef ${id} writePaths`);
    if (!def.writePaths.length) throw new Error(`taskDef ${id} missing writePaths`);
    def.writePaths.forEach((path, index) => validateRepoRelativePath(path, `taskDef ${id} writePaths[${index}]`));
    if (!def.acceptance) throw new Error(`taskDef ${id} requires non-empty acceptance criteria and commands`);
    assertContractArray(def.acceptance.criteria, `taskDef ${id} acceptance.criteria`);
    assertContractArray(def.acceptance.commands, `taskDef ${id} acceptance.commands`);
    if (!def.acceptance.criteria.length || !def.acceptance.commands.length) throw new Error(`taskDef ${id} requires non-empty acceptance criteria and commands`);
    def.acceptance.criteria.forEach((value, index) => nonEmpty(value, `taskDef ${id} acceptance.criteria[${index}]`));
    def.acceptance.commands.forEach((value, index) => validateCommand(value, `taskDef ${id} acceptance.commands[${index}]`, cwd, realpathCwd));
    if (!WORKFLOWS.has(def.workflow || "tdd")) throw new Error(`taskDef ${id} workflow is not supported`);
    graph.set(id, { deps: def.deps });
  }
  validateDAG(graph);
}
