import { createHash } from "node:crypto";

const REQUIRED_GATES = ["deterministic", "plan-audit", "external-review", "final-completeness"];
const PLAN_SCHEMAS = new Set(["pi-plan.v1", "pi-plan.v2", "pi-plan.v3"]);
const RISKS = new Set(["low", "normal", "high"]);
const WORKFLOW_MODES = new Set(["inherit-repository", "tdd", "existing-tests", "docs-only"]);
const ACCEPTANCE_STRATEGIES = new Set(["commands", "inherit-final", "structural-only", "deferred"]);
const MAX_TIMEOUT_MS = 24 * 60 * 60 * 1000;

function fail(path, message, taskId) {
  throw new Error(`${path}${taskId ? ` ${taskId}` : ""}: ${message}`);
}

function normalize(text) {
  return text.replace(/\r\n?/g, "\n").replace(/[ \t]+$/gm, "");
}

function sortedEntries(record) {
  return Object.entries(record).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
}

function exactKeys(value, location, allowed, required = allowed) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(location, "must be an object");
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(location, `unknown field ${key}`);
  for (const key of required) if (!Object.hasOwn(value, key)) fail(location, `missing field ${key}`);
  return value;
}

function normalizeTimeout(value, location) {
  if (!Number.isSafeInteger(value) || value < 1_000 || value > MAX_TIMEOUT_MS) fail(location, "timeoutMs must be between 1000 and 86400000");
  return value;
}

function normalizeWorkflow(value, location) {
  exactKeys(value, location, ["mode", "reason"], ["mode"]);
  if (!WORKFLOW_MODES.has(value.mode)) fail(location, "workflow is invalid");
  if (["existing-tests", "docs-only"].includes(value.mode) && (typeof value.reason !== "string" || !value.reason.trim())) fail(location, "workflow reason is required");
  if (value.reason !== undefined && (typeof value.reason !== "string" || !value.reason.trim())) fail(location, "workflow reason is invalid");
  return value.reason === undefined ? { mode: value.mode } : { mode: value.mode, reason: value.reason.trim() };
}

function normalizeCommandCwd(value, location) {
  if (value === ".") return value;
  validateAllowedPath(value, location);
  if (/[?*\[\]{}]/.test(value)) fail(location, "verification cwd cannot contain globs");
  return value;
}

function normalizeVerificationCommands(value, location) {
  if (!Array.isArray(value) || value.length === 0) fail(location, "verification must be non-empty");
  const seen = new Set();
  return value.map((entry, index) => {
    const item = exactKeys(entry, `${location}[${index}]`, ["id", "command", "cwd", "timeoutMs"]);
    if (typeof item.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9:._-]*$/.test(item.id) || seen.has(item.id)) fail(location, "verification id is invalid or duplicated");
    if (typeof item.command !== "string" || !item.command.trim()) fail(location, "verification command is invalid");
    seen.add(item.id);
    return { id: item.id, command: item.command.trim(), cwd: normalizeCommandCwd(item.cwd, `${location}[${index}].cwd`), timeoutMs: normalizeTimeout(item.timeoutMs, `${location}[${index}].timeoutMs`) };
  });
}

function normalizeExecutionDefaults(value, location) {
  exactKeys(value, location, ["agent", "risk", "workflow", "timeoutMs"]);
  if (value.agent !== "executor") fail(location, "agent must be executor");
  if (!RISKS.has(value.risk)) fail(location, "risk is invalid");
  return { agent: value.agent, risk: value.risk, workflow: normalizeWorkflow(value.workflow, `${location}.workflow`), timeoutMs: normalizeTimeout(value.timeoutMs, `${location}.timeoutMs`) };
}

function normalizeTaskExecution(value, defaults, location) {
  exactKeys(value ?? {}, location, ["risk", "workflow", "timeoutMs"], []);
  const risk = value?.risk ?? defaults.risk;
  if (!RISKS.has(risk)) fail(location, "risk is invalid");
  return { agent: defaults.agent, risk, workflow: value?.workflow ? normalizeWorkflow(value.workflow, `${location}.workflow`) : { ...defaults.workflow }, timeoutMs: value?.timeoutMs === undefined ? defaults.timeoutMs : normalizeTimeout(value.timeoutMs, `${location}.timeoutMs`) };
}

function normalizeAcceptance(value, location) {
  exactKeys(value, location, ["strategy", "commandIds", "reason"], ["strategy"]);
  if (!ACCEPTANCE_STRATEGIES.has(value.strategy)) fail(location, "acceptance is invalid");
  const commandIds = value.commandIds ?? [];
  if (!Array.isArray(commandIds) || commandIds.some((id) => typeof id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9:._-]*$/.test(id))) fail(location, "acceptance commandIds are invalid");
  if (value.strategy === "commands") {
    if (commandIds.length === 0 || value.reason !== undefined) fail(location, "commands acceptance requires commandIds and forbids reason");
    return { strategy: value.strategy, commandIds: [...commandIds], reason: null };
  }
  if (commandIds.length !== 0 || typeof value.reason !== "string" || !value.reason.trim()) fail(location, `${value.strategy} acceptance requires reason and forbids commandIds`);
  return { strategy: value.strategy, commandIds: [], reason: value.reason.trim() };
}

function parseContract(text, path) {
  const matches = [...text.matchAll(/^## Execution Contract\n\n```json\n([\s\S]*?)\n```\s*$/gm)];
  if (matches.length !== 1) fail(path, "requires exactly one top-level Execution Contract JSON block");

  let contract;
  try {
    contract = JSON.parse(matches[0][1]);
  } catch {
    fail(path, "Execution Contract must contain valid JSON");
  }
  if (!PLAN_SCHEMAS.has(contract.schemaVersion)) {
    fail(path, "Execution Contract schemaVersion must be pi-plan.v1, pi-plan.v2, or pi-plan.v3");
  }
  const contractRange = { start: matches[0].index, end: matches[0].index + matches[0][0].length };
  if (contract.schemaVersion === "pi-plan.v3") {
    exactKeys(contract, path, ["schemaVersion", "revision", "parentPlanHash", "verification", "requiredGates", "resourceCapacities", "executionDefaults", "taskExecution", "taskAcceptance"]);
    if (!Number.isSafeInteger(contract.revision) || contract.revision < 1) fail(path, "revision must be a positive integer");
    if ((contract.revision === 1 && contract.parentPlanHash !== null) || (contract.revision > 1 && (typeof contract.parentPlanHash !== "string" || !/^[a-f0-9]{64}$/.test(contract.parentPlanHash)))) fail(path, "parentPlanHash is invalid");
    contract.verification = normalizeVerificationCommands(contract.verification, `${path}: Execution Contract verification`);
    if (!Array.isArray(contract.requiredGates) || !REQUIRED_GATES.every((gate) => contract.requiredGates.includes(gate))) fail(path, "Execution Contract requiredGates is incomplete");
    if (!contract.resourceCapacities || typeof contract.resourceCapacities !== "object" || Array.isArray(contract.resourceCapacities)) fail(path, "Execution Contract resourceCapacities must be an object");
    for (const [id, capacity] of Object.entries(contract.resourceCapacities)) {
      if (!id.trim() || id !== id.trim() || /[\s\x00-\x1f\x7f]/.test(id) || !Number.isInteger(capacity) || capacity < 1) fail(path, "resource capacity is invalid");
    }
    contract.resourceCapacities = Object.fromEntries(sortedEntries(contract.resourceCapacities));
    contract.executionDefaults = normalizeExecutionDefaults(contract.executionDefaults, `${path}: executionDefaults`);
    if (!contract.taskExecution || typeof contract.taskExecution !== "object" || Array.isArray(contract.taskExecution)) fail(path, "taskExecution must be an object");
    if (!contract.taskAcceptance || typeof contract.taskAcceptance !== "object" || Array.isArray(contract.taskAcceptance)) fail(path, "taskAcceptance must be an object");
    return { contract, contractRange };
  }
  if (!Array.isArray(contract.verification) || contract.verification.length === 0 || !contract.verification.every((item) => typeof item === "string" && item.trim())) {
    fail(path, "Execution Contract verification must be a non-empty command array");
  }
  if (!Array.isArray(contract.requiredGates) || !REQUIRED_GATES.every((gate) => contract.requiredGates.includes(gate))) {
    fail(path, "Execution Contract requiredGates is incomplete");
  }
  if (contract.schemaVersion === "pi-plan.v2") {
    const capacities = contract.resourceCapacities;
    if (!capacities || typeof capacities !== "object" || Array.isArray(capacities)) {
      fail(path, "Execution Contract resourceCapacities must be an object");
    }
    for (const [id, capacity] of Object.entries(capacities)) {
      if (!id.trim() || id !== id.trim() || /[\s\x00-\x1f\x7f]/.test(id)) fail(path, "resource capacity ID is invalid");
      if (!Number.isInteger(capacity) || capacity < 1) fail(path, `resource capacity ${id} must be an integer greater than zero`);
    }
    contract.resourceCapacities = Object.fromEntries(sortedEntries(capacities));
    const taskVerification = contract.taskVerification ?? {};
    if (!taskVerification || typeof taskVerification !== "object" || Array.isArray(taskVerification)) {
      fail(path, "Execution Contract taskVerification must be an object");
    }
    for (const [taskId, commandIds] of Object.entries(taskVerification)) {
      if (!/^task-[1-9][0-9]*$/.test(taskId) || !Array.isArray(commandIds) || commandIds.length === 0
        || !commandIds.every((id) => typeof id === "string" && /^[A-Za-z0-9][A-Za-z0-9:._-]*$/.test(id))) {
        fail(path, `Execution Contract taskVerification is invalid for ${taskId}`);
      }
    }
    contract.taskVerification = Object.fromEntries(sortedEntries(taskVerification).map(([taskId, ids]) => [taskId, [...ids]]));
  }
  return { contract, contractRange };
}

function parseTaskMatches(text) {
  return [...text.matchAll(/^### Task (\d+):\s*(.+)\n([\s\S]*?)(?=^### Task \d+:|(?![\s\S]))/gm)];
}

function validateDependencies(tasks, ids, path) {
  for (const task of tasks) {
    for (const dep of task.deps) {
      if (dep === task.id) fail(path, "self dependency", task.id);
      if (!ids.has(dep)) fail(path, `unknown dependency ${dep}`, task.id);
    }
  }
}

function parseV1Tasks(text, path) {
  const tasks = [];
  const ids = new Set();

  for (const match of parseTaskMatches(text)) {
    const id = `task-${match[1]}`;
    if (ids.has(id)) fail(path, "duplicate Task ID", id);
    ids.add(id);

    const body = match[3].trim();
    const depsMatch = body.match(/^(?:\*\*Deps:\*\* Task (\d+(?:, Task \d+)*)\n\n)?\*\*Files:\*\*\n([\s\S]+)$/);
    if (!depsMatch) fail(path, "Task must use optional Deps followed by non-empty Files", id);
    const files = [...depsMatch[2].matchAll(/^- (?:Create|Modify|Delete): `([^`]+)`$/gm)].map((file) => file[1]);
    if (files.length === 0) fail(path, "Files must be non-empty", id);
    const deps = depsMatch[1] ? [...depsMatch[1].matchAll(/\d+/g)].map((value) => `task-${value[0]}`) : [];
    tasks.push({ id, title: match[2].trim(), deps, files, body });
  }

  if (tasks.length === 0) fail(path, "requires at least one Task");
  validateDependencies(tasks, ids, path);
  return tasks;
}

function validateAllowedPath(value, path, taskId) {
  if (!value || value !== value.trim() || value.startsWith("/") || /^[A-Za-z]:/.test(value) || value.includes("\\") || /[\x00-\x1f\x7f]/.test(value)) {
    fail(path, `invalid repo-relative path ${JSON.stringify(value)}`, taskId);
  }
  const segments = value.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === ".." || segment === ".git")) {
    fail(path, `invalid repo-relative path ${JSON.stringify(value)}`, taskId);
  }
  const wildcardIndex = value.search(/[?*\[\]{}]/);
  if (wildcardIndex !== -1 && (!value.endsWith("/**") || wildcardIndex !== value.length - 2)) {
    fail(path, `invalid ownership glob ${JSON.stringify(value)}`, taskId);
  }
}

function parseV2TaskBody(body, path, taskId) {
  const header = body.match(/^(?:\*\*Deps:\*\* Task (\d+(?:, Task \d+)*)\n\n)?\*\*Files:\*\*\n/);
  if (!header) fail(path, "Task must use optional Deps followed by non-empty Files", taskId);
  const deps = header[1] ? [...header[1].matchAll(/\d+/g)].map((value) => `task-${value[0]}`) : [];
  const remainder = body.slice(header[0].length);
  const lines = remainder.split("\n");
  const files = [];
  let cursor = 0;
  while (cursor < lines.length && lines[cursor] !== "") {
    const file = lines[cursor].match(/^- (?:Create|Modify|Delete): `([^`]*)`$/);
    if (!file) fail(path, "Files contains an invalid declaration", taskId);
    validateAllowedPath(file[1], path, taskId);
    files.push(file[1]);
    cursor++;
  }
  if (files.length === 0) fail(path, "Files must be non-empty", taskId);

  const resources = [];
  const resourceIds = new Set();
  if (lines[cursor] === "" && lines[cursor + 1] === "**Resources:**") {
    cursor += 2;
    while (cursor < lines.length && lines[cursor] !== "") {
      const resource = lines[cursor].match(/^- `([^`]+)`: `([^`]+)`$/);
      if (!resource || (resource[2] !== "exclusive" && resource[2] !== "shared")) fail(path, "Resources contains an invalid declaration", taskId);
      if (resourceIds.has(resource[1])) fail(path, `duplicate resource ${resource[1]}`, taskId);
      resourceIds.add(resource[1]);
      resources.push({ id: resource[1], mode: resource[2] });
      cursor++;
    }
    if (resources.length === 0) fail(path, "Resources must be non-empty when declared", taskId);
  }
  resources.sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
  while (lines[cursor] === "") cursor++;
  const instructions = lines.slice(cursor).join("\n").trim();
  return { deps, files, allowedPaths: [...files], resources, instructions };
}

function parseV2Tasks(text, path) {
  const tasks = [];
  const ids = new Set();
  for (const match of parseTaskMatches(text)) {
    const id = `task-${match[1]}`;
    if (ids.has(id)) fail(path, "duplicate Task ID", id);
    ids.add(id);
    const body = match[3].trim();
    const parsed = parseV2TaskBody(body, path, id);
    const { instructions: _instructions, ...metadata } = parsed;
    tasks.push({ id, title: match[2].trim(), ...metadata, body });
  }
  if (tasks.length === 0) fail(path, "requires at least one Task");
  validateDependencies(tasks, ids, path);
  return tasks;
}

function parseV3Tasks(text, path) {
  const tasks = [];
  const ids = new Set();
  for (const match of parseTaskMatches(text)) {
    const id = `task-${match[1]}`;
    if (ids.has(id)) fail(path, "duplicate Task ID", id);
    ids.add(id);
    const body = match[3].trim();
    const parsed = parseV2TaskBody(body, path, id);
    if (!parsed.instructions) fail(path, "Task instructions must be non-empty", id);
    const { instructions: _instructions, ...metadata } = parsed;
    tasks.push({ id, title: match[2].trim(), ...metadata, body });
  }
  if (tasks.length === 0) fail(path, "requires at least one Task");
  validateDependencies(tasks, ids, path);
  return tasks;
}

export function parsePlanDocument(source, path) {
  const text = normalize(source);
  const { contract, contractRange } = parseContract(text, path);
  const title = (text.match(/^#\s+(.+)$/m) ?? [])[1]?.trim();
  if (!title) fail(path, "requires a title");
  const tasks = contract.schemaVersion === "pi-plan.v2" ? parseV2Tasks(text, path) : contract.schemaVersion === "pi-plan.v3" ? parseV3Tasks(text, path) : parseV1Tasks(text, path);
  if (contract.schemaVersion === "pi-plan.v3") {
    const taskIds = new Set(tasks.map((task) => task.id));
    for (const key of Object.keys(contract.taskExecution)) if (!taskIds.has(key)) fail(path, `taskExecution references unknown task ${key}`);
    const acceptanceIds = Object.keys(contract.taskAcceptance);
    for (const key of acceptanceIds) if (!taskIds.has(key)) fail(path, `taskAcceptance references unknown task ${key}`);
    if (acceptanceIds.length !== taskIds.size || ![...taskIds].every((id) => Object.hasOwn(contract.taskAcceptance, id))) fail(path, "taskAcceptance must cover every Task");
    const commandIds = new Set(contract.verification.map((command) => command.id));
    for (const task of tasks) {
      task.execution = normalizeTaskExecution(contract.taskExecution[task.id], contract.executionDefaults, `${path}: taskExecution ${task.id}`);
      task.acceptance = normalizeAcceptance(contract.taskAcceptance[task.id], `${path}: taskAcceptance ${task.id}`);
      for (const commandId of task.acceptance.commandIds) if (!commandIds.has(commandId)) fail(path, `acceptance references unknown verification command ${commandId}`, task.id);
      for (const resource of task.resources) if (!Object.hasOwn(contract.resourceCapacities, resource.id)) fail(path, `resource ${resource.id} has no declared capacity`, task.id);
    }
    const firstTaskIndex = parseTaskMatches(text)[0]?.index ?? text.length;
    const instructions = (text.slice(0, contractRange.start) + text.slice(contractRange.end, firstTaskIndex))
      .replace(/^#\s+.+\n?/, "").replace(/^---\s*$/gm, "").trim();
    if (!instructions) fail(path, "Plan instructions must be non-empty");
    const canonical = { schemaVersion: contract.schemaVersion, revision: contract.revision, parentPlanHash: contract.parentPlanHash, title, instructions, tasks, verification: contract.verification, requiredGates: contract.requiredGates, resourceCapacities: contract.resourceCapacities };
    return { ...canonical, sha256: createHash("sha256").update(JSON.stringify(canonical)).digest("hex") };
  }
  if (contract.schemaVersion === "pi-plan.v2") {
    const taskIds = new Set(tasks.map((task) => task.id));
    for (const taskId of Object.keys(contract.taskVerification)) {
      if (!taskIds.has(taskId)) fail(path, `Execution Contract taskVerification references unknown ${taskId}`);
    }
    for (const task of tasks) {
      for (const resource of task.resources) {
        if (!Object.hasOwn(contract.resourceCapacities, resource.id)) {
          fail(path, `resource ${resource.id} has no declared capacity`, task.id);
        }
      }
    }
  }
  const canonical = contract.schemaVersion === "pi-plan.v2"
    ? {
        schemaVersion: contract.schemaVersion,
        title,
        tasks,
        verification: contract.verification,
        taskVerification: contract.taskVerification,
        resourceCapacities: contract.resourceCapacities,
      }
    : {
        schemaVersion: contract.schemaVersion,
        title,
        tasks,
        verification: contract.verification,
      };
  return {
    ...canonical,
    sha256: createHash("sha256").update(JSON.stringify(canonical)).digest("hex"),
  };
}
