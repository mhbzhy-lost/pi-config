import assert from "node:assert/strict";
import test from "node:test";
import { piHostAliases, piHostJitiUrl } from "./helpers/pi-host.mjs";

const { createJiti } = await import(piHostJitiUrl);
const jiti = createJiti(import.meta.url, { moduleCache: false, alias: piHostAliases });
const { recoverProviderStream, isSafeStreamReadRecovery, patchStreamRecoverySource } = await jiti.import("../packages/pi-subagents-enhanced/src/subagent-dispatch/ordered-models-runtime-patch.ts");

const cleanFailure = () => ({ error: "stream_read_error", messages: [], finalOutput: "", usage: { turns: 0 }, toolCount: 0, observedMutationAttempt: false, currentTool: undefined, interrupted: false, timedOut: false, stopped: false, protocolError: undefined });

test("the ordered runtime entry injects recovery into the runner loop, not dispatch", () => {
  const source = patchStreamRecoverySource("function runPiStreaming(args) {}\n\t\tconst run = await runPiStreaming(\n\t\t\targs\n\t\t);\n\t\tif (run.processCloseObservedAt) {}", "runner-fixture.ts");
  assert.match(source, /stream-read-error-recovery\.v1/);
  assert.match(source, /recoverProviderStream\(\(\) => runPiStreaming/);
  assert.match(source, /signal: combinedAbortSignal/);
});

test("an existing ordered-models marker does not suppress stream recovery installation", () => {
  const source = patchStreamRecoverySource([
    "// pi-config patch: ordered-models.v3",
    "function runPiStreaming(args) {}",
    "\t\tconst run = await runPiStreaming(",
    "\t\t\targs",
    "\t\t);",
    "\t\tif (run.processCloseObservedAt) {}",
  ].join("\n"), "runner-marker-fixture.ts");
  assert.match(source, /ordered-models\.v3/);
  assert.match(source, /stream-read-error-recovery\.v1/);
  assert.match(source, /recoverProviderStream\(\(\) => runPiStreaming/);
  assert.equal(source.match(/ordered-models\.v3/g)?.length, 1);
});

test("retries exact stream_read_error twice on the same provider and succeeds once", async () => {
  const attempts = [];
  const result = await recoverProviderStream(async () => {
    attempts.push("provider/locked-model");
    return attempts.length < 3 ? cleanFailure() : { error: undefined, messages: [], finalOutput: "ok", usage: { turns: 1 }, toolCount: 0 };
  }, { sleep: async () => {}, model: "provider/locked-model" });
  assert.equal(attempts.length, 3);
  assert.deepEqual(new Set(attempts), new Set(["provider/locked-model"]));
  assert.equal(result.finalOutput, "ok");
});

test("third exact stream_read_error is terminal after three provider attempts", async () => {
  let completions = 0;
  const result = await recoverProviderStream(async () => { completions++; return cleanFailure(); }, { sleep: async () => {}, model: "provider/locked-model" });
  assert.equal(completions, 3);
  assert.equal(result.error, "stream_read_error");
});

test("the patched runner sends one completion after a recovered provider episode", async () => {
  const source = patchStreamRecoverySource([
    "let attempts = 0;",
    "let completions = 0;",
    "const ctx = { timeoutSignal: undefined, stopSignal: undefined };",
    "const candidate = 'provider/locked-model';",
    "const step = { model: 'provider/locked-model' };",
    "const combinedAbortSignal = () => undefined;",
    "function cleanFailure() { return { error: 'stream_read_error', messages: [], finalOutput: '', usage: { turns: 0 }, toolCount: 0 }; }",
    "function runPiStreaming() { attempts++; return Promise.resolve(attempts < 3 ? cleanFailure() : { error: undefined, messages: [], finalOutput: 'ok', usage: { turns: 1 }, toolCount: 0 }); }",
    "function notifyCompletion() { completions++; }",
    "async function execute() {",
    "\t\tconst run = await runPiStreaming(",
    "\t\t\t{},",
    "\t\t);",
    "\t\tif (run.processCloseObservedAt) {}",
    "\t\tnotifyCompletion(run);",
    "\t\treturn { run, attempts, completions };",
    "}",
  ].join("\n"), "runner-completion-fixture.ts");
  const run = await new Function(`${source}\nreturn execute();`)();
  assert.equal(run.run.finalOutput, "ok");
  assert.equal(run.attempts, 3);
  assert.equal(run.completions, 1);
  assert.match(source, /notifyCompletion\(run\)/);
  assert.match(source, /recoverProviderStream\(\(\) => runPiStreaming/);
});

test("any visible output, usage, tool, mutation, control, or other error is not retryable", async () => {
  const cases = [
    { messages: [{ role: "assistant" }], finalOutput: "visible" },
    { messages: [], finalOutput: "", usage: { turns: 1 } },
    { messages: [], finalOutput: "", toolCount: 1 },
    { messages: [], finalOutput: "", observedMutationAttempt: true },
    { messages: [], finalOutput: "", usage: { input: 1 } },
    { messages: [], finalOutput: "", supervisorWait: true },
    { messages: [], finalOutput: "", interrupted: true },
    { messages: [], finalOutput: "", timedOut: true },
    { messages: [], finalOutput: "", stopped: true },
    { messages: [], finalOutput: "", error: "other_stream_error" },
  ];
  for (const extra of cases) {
    let attempts = 0;
    const result = await recoverProviderStream(async () => { attempts++; return { ...cleanFailure(), ...extra }; }, { sleep: async () => {}, model: "provider/locked-model" });
    assert.equal(attempts, 1, JSON.stringify(extra));
    assert.equal(isSafeStreamReadRecovery(result), false, JSON.stringify(extra));
  }
});

test("abortable backoff stops before a retry", async () => {
  let attempts = 0;
  const controller = new AbortController();
  const result = await recoverProviderStream(async () => { attempts++; controller.abort(); return cleanFailure(); }, { sleep: async () => {}, signal: controller.signal, model: "provider/locked-model" });
  assert.equal(attempts, 1);
  assert.equal(result.error, "stream_read_error");
});
