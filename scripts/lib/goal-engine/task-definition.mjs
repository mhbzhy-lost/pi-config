import { validateDAG } from "./graph.mjs";
import { normalizeRepoRelativePosixPath } from "./repo-path.mjs";

const ID = /^[A-Za-z0-9._-]{1,160}$/;
const WORKFLOWS = new Set(["tdd", "existing-tests", "docs-only"]);

function nonEmpty(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value.trim();
}

export function validateRepoRelativePath(value, label = "writePath") {
  return normalizeRepoRelativePosixPath(value, label);
}

function validateCommand(value, label, cwd) {
  const command = nonEmpty(value, label);
  // Shell separators put cd in command position; echo 'cd /tmp' does not.
  if (/(?:^|&&|\|\||;|\||\n|\()\s*cd\s+(?:--\s+)?["']?\//.test(command)) throw new Error(`${label} must not use absolute cd`);
  if (cwd && command.includes(cwd)) throw new Error(`${label} must not hardcode origin cwd`);
  return command;
}

export function validateTaskDefinitions(tasks, taskDefs, { requireNonEmpty = true, cwd } = {}) {
  if (!Array.isArray(tasks) || (requireNonEmpty && tasks.length === 0)) throw new Error("tasks must be non-empty");
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
    if (!Array.isArray(def.deps)) throw new Error(`taskDef ${id} deps must be an array`);
    const deps = new Set();
    for (const dep of def.deps) {
      if (!ID.test(dep || "") || deps.has(dep)) throw new Error(`taskDef ${id} has invalid or duplicate dep: ${dep}`);
      deps.add(dep);
    }
    if (!Array.isArray(def.writePaths) || !def.writePaths.length) throw new Error(`taskDef ${id} missing writePaths`);
    def.writePaths.forEach((path, index) => validateRepoRelativePath(path, `taskDef ${id} writePaths[${index}]`));
    if (!def.acceptance || !Array.isArray(def.acceptance.criteria) || !def.acceptance.criteria.length || !Array.isArray(def.acceptance.commands) || !def.acceptance.commands.length) throw new Error(`taskDef ${id} requires non-empty acceptance criteria and commands`);
    def.acceptance.criteria.forEach((value, index) => nonEmpty(value, `taskDef ${id} acceptance.criteria[${index}]`));
    def.acceptance.commands.forEach((value, index) => validateCommand(value, `taskDef ${id} acceptance.commands[${index}]`, cwd));
    if (!WORKFLOWS.has(def.workflow || "tdd")) throw new Error(`taskDef ${id} workflow is not supported`);
    graph.set(id, { deps: def.deps });
  }
  validateDAG(graph);
}
