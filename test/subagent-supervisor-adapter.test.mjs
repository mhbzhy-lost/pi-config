import assert from "node:assert/strict";
import test from "node:test";

import {
  SUPERVISOR_DESCRIPTION,
  SUPERVISOR_PARAMETERS,
  createSupervisorAdapter,
  createSupervisorTool,
} from "../packages/pi-subagents-enhanced/src/subagent-dispatch/supervisor-adapter.ts";

test("project supervisor exposes the stable typed contract", () => {
  const tool = createSupervisorTool(createSupervisorAdapter());
  assert.equal(tool.name, "subagent_supervisor");
  assert.equal(tool.label, "Subagent Supervisor");
  assert.equal(tool.description, SUPERVISOR_DESCRIPTION);
  assert.equal(tool.parameters, SUPERVISOR_PARAMETERS);
  assert.equal(Object.isFrozen(tool), true);
  assert.equal(Object.isFrozen(SUPERVISOR_PARAMETERS), true);
  assert.deepEqual(SUPERVISOR_PARAMETERS.required, ["action"]);
  assert.deepEqual(SUPERVISOR_PARAMETERS.properties.action.enum, ["reply", "pending", "status"]);
});

test("project supervisor delegates every execution argument unchanged", async () => {
  const adapter = createSupervisorAdapter();
  const signal = new AbortController().signal;
  const onUpdate = () => {};
  const ctx = { cwd: "/repo" };
  const params = { action: "reply", replyTo: "request-1", message: "approved" };
  let received;
  adapter.bind((...args) => { received = args; return { replied: true }; });
  const tool = createSupervisorTool(adapter);
  assert.deepEqual(await tool.execute("tool-1", params, signal, onUpdate, ctx), { replied: true });
  assert.deepEqual(received, ["tool-1", params, signal, onUpdate, ctx]);
});

test("project supervisor fails closed before binding, on duplicate binding, and after dispose", async () => {
  const adapter = createSupervisorAdapter();
  await assert.rejects(adapter.execute("tool", { action: "status" }), (error) => error?.code === "SUPERVISOR_TARGET_UNAVAILABLE");
  assert.throws(() => adapter.bind(null), (error) => error?.code === "SUPERVISOR_TARGET_INVALID");
  adapter.bind(async () => ({ pending: [] }));
  assert.equal(adapter.isBound(), true);
  assert.throws(() => adapter.bind(async () => ({})), (error) => error?.code === "SUPERVISOR_TARGET_ALREADY_BOUND");
  adapter.dispose();
  assert.equal(adapter.isBound(), false);
  await assert.rejects(adapter.execute("tool", { action: "status" }), (error) => error?.code === "SUPERVISOR_TARGET_UNAVAILABLE");
});

test("project supervisor validates custom names without reserving a Plan-only tool", () => {
  const adapter = createSupervisorAdapter();
  assert.throws(() => createSupervisorTool(adapter, { name: "", label: "label" }), /name and label/);
  assert.throws(() => createSupervisorTool(adapter, { name: "custom", label: "" }), /name and label/);
  const tool = createSupervisorTool(adapter, { name: "project_supervisor", label: "Project Supervisor" });
  assert.equal(tool.name, "project_supervisor");
  assert.equal(tool.label, "Project Supervisor");
});
