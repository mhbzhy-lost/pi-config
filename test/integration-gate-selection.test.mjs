import assert from "node:assert/strict";
import test from "node:test";

import { selectIntegrationFiles } from "../scripts/run-integration-gate.ts";

test("selectIntegrationFiles 自动纳入全部集成文件并减去显式排除表", () => {
  const all = [
    "a.integration.mjs",
    "b.integration.mjs",
    "excluded-one.integration.mjs",
    "excluded-two.integration.mjs",
  ];
  const excluded = new Map([
    ["excluded-one.integration.mjs", "PENDING-DIAGNOSIS: reason one"],
    ["excluded-two.integration.mjs", "PENDING-ADJUDICATION: reason two"],
  ]);
  assert.deepEqual(selectIntegrationFiles(all, excluded), ["a.integration.mjs", "b.integration.mjs"]);
});

test("selectIntegrationFiles 对非 integration 后缀与排除表外的未知排除项保持鲁棒", () => {
  const all = ["a.test.mjs", "b.integration.mjs", "notes.md"];
  const excluded = new Map([["not-in-list.integration.mjs", "登记了但目录中不存在的排除项"]]);
  // 排除表多余项不应吞掉任何现有文件；非 integration 文件不纳入。
  assert.deepEqual(selectIntegrationFiles(all, excluded), ["b.integration.mjs"]);
});

test("selectIntegrationFiles 返回排序结果保证门禁输出稳定", () => {
  const all = ["z.integration.mjs", "a.integration.mjs"];
  assert.deepEqual(selectIntegrationFiles(all, new Map()), ["a.integration.mjs", "z.integration.mjs"]);
});
