import { createHash } from "node:crypto";

const REQUIRED_GATES = ["deterministic", "plan-audit", "external-review", "final-completeness"];

function fail(path, message, taskId) {
  throw new Error(`${path}${taskId ? ` ${taskId}` : ""}: ${message}`);
}

function normalize(text) {
  return text.replace(/\r\n?/g, "\n").replace(/[ \t]+$/gm, "");
}

function sortedEntries(record) {
  return Object.entries(record).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
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
  if (contract.schemaVersion !== "pi-plan.v1" && contract.schemaVersion !== "pi-plan.v2") {
    fail(path, "Execution Contract schemaVersion must be pi-plan.v1 or pi-plan.v2");
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
  return contract;
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
  return { deps, files, allowedPaths: [...files], resources };
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
    tasks.push({ id, title: match[2].trim(), ...parsed, body });
  }
  if (tasks.length === 0) fail(path, "requires at least one Task");
  validateDependencies(tasks, ids, path);
  return tasks;
}

export function parsePlanDocument(source, path) {
  const text = normalize(source);
  const contract = parseContract(text, path);
  const title = (text.match(/^#\s+(.+)$/m) ?? [])[1]?.trim();
  if (!title) fail(path, "requires a title");
  const tasks = contract.schemaVersion === "pi-plan.v2" ? parseV2Tasks(text, path) : parseV1Tasks(text, path);
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
