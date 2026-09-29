import { compileCodingDispatchIR, CodingDispatchContractError } from "../../packages/pi-subagents-enhanced/src/contracts/dispatch-ir.ts";

const coding = {
  title: "Probe coding", agent: "executor", model: "provider/model",
  task: "Run probe", requirements: ["Read the required files"],
  context: { knownFacts: [], decisions: [], relevantFiles: [] },
  boundaries: { writePaths: [], excludedWork: [], forbiddenActions: [] },
  acceptance: { criteria: ["Report result"] }, execution: { timeoutMs: 1000 },
};

const samples: Array<[string, Record<string, unknown>]> = [
  ["完整合法 coding", coding],
  ["缺 version 但含 taskId", { ...coding, version: undefined }],
  ["缺 version 但含 boundaries", { boundaries: coding.boundaries, agent: "executor", title: "x", }],
  ["缺 version 且只有 agent/title/task 的合法 generic", { agent: "executor", title: "generic", task: "Run probe" }],
  ["generic 混入 coding-exclusive 字段", { agent: "executor", title: "generic", task: "Run probe", }],
  ["coding 混入 generic 字段", { ...coding, outputMode: "inline" }],
  ["带 action 的 control", { action: "status", id: "probe" }],
  ["action 与 version 同时存在", { action: "status", }],
];

function route(input: Record<string, unknown>) {
  if (Object.hasOwn(input, "action")) return { branch: "control", result: "CONTROL_ROUTE" };
  if (Object.hasOwn(input, "version")) {
    try {
      compileCodingDispatchIR(input, { cwd: "/probe" });
      return { branch: "coding", result: "OK" };
    } catch (error) {
      const e = error as CodingDispatchContractError;
      return { branch: "coding", result: e.code ?? "UNKNOWN_ERROR", detail: e.message };
    }
  }
  if (typeof input.agent !== "string" || !input.agent.trim() || typeof input.title !== "string" || !input.title.trim() || typeof input.task !== "string" || !input.task.trim()) {
    if (Object.hasOwn(input, "taskId") || Object.hasOwn(input, "objective")) return { branch: "generic", result: "INVALID_CODING_ROUTER" };
    return { branch: "generic", result: "INVALID_GENERIC_DISPATCH" };
  }
  return { branch: "generic", result: "OK" };
}

for (const [name, input] of samples) {
  // undefined means omitted, matching JSON tool arguments.
  const clean = Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
  const result = route(clean);
  console.log(JSON.stringify({ sample: name, inputKeys: Object.keys(clean), ...result }));
}
