import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { after, test } from "node:test";
import { loadPiTestRuntime } from "./helpers/pi-runtime.mjs";

const previousExperimental = process.env.PI_EXPERIMENTAL;
process.env.PI_EXPERIMENTAL = "1";
after(() => {
  if (previousExperimental === undefined) delete process.env.PI_EXPERIMENTAL;
  else process.env.PI_EXPERIMENTAL = previousExperimental;
});

const { codingAgent, jiti } = await loadPiTestRuntime(import.meta.url);
const compactToolsModule = await jiti.import("../pi/extensions/compact-tools.ts");
const compactTools = compactToolsModule.default;
const names = ["read", "bash", "edit", "write", "find", "grep", "ls"];
const factories = Object.fromEntries(names.map((name) => [
  name,
  codingAgent[`create${name[0].toUpperCase()}${name.slice(1)}Tool`],
]));

function registerCompactTools(factory) {
  const registered = [];
  factory({ registerTool: (tool) => registered.push(tool), on() {} });
  return registered;
}

test("compact overrides retain every native non-renderer field", () => {
  const registered = registerCompactTools(compactTools);

  assert.deepEqual(registered.map((tool) => tool.name), names);
  for (const name of names) {
    const native = factories[name](process.cwd());
    const actual = registered.find((tool) => tool.name === name);
    for (const field of ["parameters", "promptSnippet", "promptGuidelines", "prepareArguments", "constrainedSampling"]) {
      assert.deepEqual(actual[field], native[field], `${name}.${field}`);
    }
    assert.equal(actual.parameters, native.parameters, `${name}.parameters preserves identity`);
    assert.equal(actual.prepareArguments, native.prepareArguments, `${name}.prepareArguments preserves identity`);
  }
});

test("registered execute selects the live cwd native tool and forwards five arguments", async () => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "compact-tools-execute-"));
  try {
    const extensionSource = await readFile(new URL("../pi/extensions/compact-tools.ts", import.meta.url), "utf8");
    const mockPath = join(temporaryDirectory, "pi-mock.mjs");
    const tuiPath = join(temporaryDirectory, "tui-mock.mjs");
    const extensionPath = join(temporaryDirectory, "compact-tools.ts");
    const rendererUrl = pathToFileURL(new URL("../scripts/lib/compact-tools-renderer.mjs", import.meta.url).pathname).href;

    await writeFile(mockPath, `
export const calls = [];
const names = ${JSON.stringify(names)};
const tool = (name, cwd) => ({
  name, label: name, description: name, parameters: { name }, promptSnippet: name,
  promptGuidelines: [name], prepareArguments: (params) => params,
  constrainedSampling: { type: "json_schema", strict: "prefer" },
  execute(...args) { calls.push({ name, cwd, args }); return { cwd }; },
});
${names.map((name) => `export const create${name[0].toUpperCase()}${name.slice(1)}Tool = (cwd) => tool("${name}", cwd);`).join("\n")}
export class SkillInvocationMessageComponent {}
`);
    await writeFile(tuiPath, "export class Container {} export class Markdown {} export class Text {} export const sliceByColumn = () => ''; export const truncateToWidth = () => ''; export const visibleWidth = () => 0;");
    const source = extensionSource
      .replace("@earendil-works/pi-coding-agent", pathToFileURL(mockPath).href)
      .replace("@earendil-works/pi-tui", pathToFileURL(tuiPath).href)
      .replace("../../scripts/lib/compact-tools-renderer.mjs", rendererUrl);
    await writeFile(extensionPath, source);

    const mock = await import(pathToFileURL(mockPath).href);
    const module = await jiti.import(extensionPath);
    const registered = registerCompactTools(module.default);
    const toolCallId = "call-1";
    const params = { path: "safe.txt" };
    const signal = new AbortController().signal;
    const onUpdate = () => {};
    const ctx = { cwd: "/live-cwd" };

    await registered.find((tool) => tool.name === "read").execute(toolCallId, params, signal, onUpdate, ctx);

    assert.deepEqual(mock.calls.at(-1), {
      name: "read",
      cwd: "/live-cwd",
      args: [toolCallId, params, signal, onUpdate, ctx],
    });
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});
