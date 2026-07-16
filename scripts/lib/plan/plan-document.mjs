import { createHash } from "node:crypto";

const REQUIRED_GATES = ["deterministic", "plan-audit", "external-review", "final-completeness"];

function fail(path, message, taskId) {
  throw new Error(`${path}${taskId ? ` ${taskId}` : ""}: ${message}`);
}

function normalize(text) {
  return text.replace(/\r\n?/g, "\n").replace(/[ \t]+$/gm, "");
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
  if (contract.schemaVersion !== "pi-plan.v1") fail(path, "Execution Contract schemaVersion must be pi-plan.v1");
  if (!Array.isArray(contract.verification) || contract.verification.length === 0 || !contract.verification.every((item) => typeof item === "string" && item.trim())) {
    fail(path, "Execution Contract verification must be a non-empty command array");
  }
  if (!Array.isArray(contract.requiredGates) || !REQUIRED_GATES.every((gate) => contract.requiredGates.includes(gate))) {
    fail(path, "Execution Contract requiredGates is incomplete");
  }
  return contract;
}

function parseTasks(text, path) {
  const matches = [...text.matchAll(/^### Task (\d+):\s*(.+)\n([\s\S]*?)(?=^### Task \d+:|(?![\s\S]))/gm)];
  const tasks = [];
  const ids = new Set();

  for (const match of matches) {
    const id = `task-${match[1]}`;
    if (ids.has(id)) fail(path, "duplicate Task ID", id);
    ids.add(id);

    const body = match[3].trim();
    const depsMatch = body.match(/^(?:\*\*Deps:\*\* Task (\d+(?:, Task \d+)*)\n\n)?\*\*Files:\*\*\n([\s\S]+)$/);
    if (!depsMatch) fail(path, "Task must use optional Deps followed by non-empty Files", id);
    const files = [...depsMatch[2].matchAll(/^- (?:Create|Modify|Delete): `([^`]+)`$/gm)].map((file) => file[1]);
    if (files.length === 0) fail(path, "Files must be non-empty", id);
    const deps = depsMatch[1] ? depsMatch[1].split(", ").map((dep) => `task-${dep}`) : [];
    tasks.push({ id, title: match[2].trim(), deps, files, body });
  }

  if (tasks.length === 0) fail(path, "requires at least one Task");
  for (const task of tasks) {
    for (const dep of task.deps) {
      if (dep === task.id) fail(path, "self dependency", task.id);
      if (!ids.has(dep)) fail(path, `unknown dependency ${dep}`, task.id);
    }
  }
  return tasks;
}

export function parsePlanDocument(source, path) {
  const text = normalize(source);
  const contract = parseContract(text, path);
  const title = (text.match(/^#\s+(.+)$/m) ?? [])[1]?.trim();
  if (!title) fail(path, "requires a title");
  const tasks = parseTasks(text, path);
  const canonical = {
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
