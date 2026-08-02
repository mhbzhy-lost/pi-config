import assert from "node:assert/strict";
import test from "node:test";
import { createBasicMemoryExtension, containsLikelySecret } from "../scripts/lib/basic-memory-extension.mjs";

function createMockPi() {
  const tools = [];
  const execCalls = [];
  return {
    tools,
    execCalls,
    registerTool(def) { tools.push(def); },
    async exec(command, args, opts) {
      execCalls.push({ command, args, opts });
      return { stdout: "OK", stderr: "", code: 0 };
    },
  };
}

function executeTool(tool, params) {
  return tool.execute("memory-test-call", params);
}

test("registers exactly five memory tools", () => {
  const pi = createMockPi();
  createBasicMemoryExtension(pi);
  const names = pi.tools.map((t) => t.name).sort();
  assert.deepEqual(names, ["memory_context", "memory_read", "memory_recent", "memory_search", "memory_write"]);
});

test("registered memory tools satisfy the current Pi execute contract", async () => {
  const pi = createMockPi();
  createBasicMemoryExtension(pi);
  const search = pi.tools.find((tool) => tool.name === "memory_search");

  assert.equal(typeof search.execute, "function");
  const result = await search.execute("memory-call-1", { query: "test" });
  assert.deepEqual(result, {
    content: [{ type: "text", text: "OK" }],
    details: {},
  });
});

test("all tool descriptions mention no secrets", () => {
  const pi = createMockPi();
  createBasicMemoryExtension(pi);
  for (const tool of pi.tools) {
    assert.match(tool.description, /凭据|秘密|secret/i);
  }
});

test("tool commands start with basic-memory tool and include --local", async () => {
  const pi = createMockPi();
  createBasicMemoryExtension(pi);

  const search = pi.tools.find((t) => t.name === "memory_search");
  await executeTool(search, { query: "test" });
  assert.equal(pi.execCalls[0].command, "basic-memory");
  assert.ok(pi.execCalls[0].args.includes("--local"));
  assert.ok(pi.execCalls[0].args.includes("search-notes"));
});

test("memory_write includes title, folder, content args", async () => {
  const pi = createMockPi();
  createBasicMemoryExtension(pi);

  const write = pi.tools.find((t) => t.name === "memory_write");
  await executeTool(write, { title: "Test", folder: "decisions", content: "Some content" });
  const args = pi.execCalls[0].args;
  assert.ok(args.includes("--title"));
  assert.ok(args.includes("Test"));
  assert.ok(args.includes("--folder"));
  assert.ok(args.includes("decisions"));
  assert.ok(args.includes("--content"));
  assert.ok(args.includes("Some content"));
  assert.ok(args.includes("--local"));
  assert.ok(!args.includes("--overwrite"));
});

test("memory_write rejects likely secrets", async () => {
  const pi = createMockPi();
  createBasicMemoryExtension(pi);
  const write = pi.tools.find((t) => t.name === "memory_write");

  await assert.rejects(
    () => executeTool(write, { title: "creds", folder: "secrets", content: "api_key=sk-abcdefghijklmnop" }),
    /secret|凭据/i,
  );
  assert.equal(pi.execCalls.length, 0);
});

test("containsLikelySecret detects real secrets", () => {
  assert.equal(containsLikelySecret("api_key=sk-abcdefghijklmnop"), true);
  assert.equal(containsLikelySecret("-----BEGIN PRIVATE KEY-----"), true);
  assert.equal(containsLikelySecret("token: ghp_xYz12345678901234567890"), true);
  assert.equal(containsLikelySecret("password=super_secret_pass"), true);
  assert.equal(containsLikelySecret("Bearer eyJhbGciOiJIUzI1NiIs"), true);
  assert.equal(containsLikelySecret("sk-proj-abc123def456ghi789"), true);
});

test("containsLikelySecret allows normal text", () => {
  assert.equal(containsLikelySecret("API token rotates weekly"), false);
  assert.equal(containsLikelySecret("https://api.example.com/auth"), false);
  assert.equal(containsLikelySecret("The password field is required"), false);
  assert.equal(containsLikelySecret("architecture decision record for auth flow"), false);
  assert.equal(containsLikelySecret("token-based approach works well"), false);
});

test("memory_search passes project param when provided", async () => {
  const pi = createMockPi();
  createBasicMemoryExtension(pi);
  const search = pi.tools.find((t) => t.name === "memory_search");
  await executeTool(search, { query: "test", project: "my-proj" });
  const args = pi.execCalls[0].args;
  assert.ok(args.includes("--project"));
  assert.ok(args.includes("my-proj"));
});

test("memory_recent requires no required params", async () => {
  const pi = createMockPi();
  createBasicMemoryExtension(pi);
  const recent = pi.tools.find((t) => t.name === "memory_recent");
  await executeTool(recent, {});
  assert.equal(pi.execCalls[0].command, "basic-memory");
  assert.ok(pi.execCalls[0].args.includes("recent-activity"));
});

test("truncates output exceeding 50KB", async () => {
  const bigOutput = "x".repeat(60 * 1024);
  const tools = [];
  const pi = {
    registerTool(def) { tools.push(def); },
    async exec() { return { stdout: bigOutput, stderr: "", code: 0 }; },
  };
  createBasicMemoryExtension(pi);
  const search = tools.find((t) => t.name === "memory_search");
  const result = await executeTool(search, { query: "test" });
  const output = result.content[0].text;
  assert.ok(output.length < bigOutput.length);
  assert.match(output, /\[truncated/i);
});
