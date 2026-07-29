import { applyEvent, createProjection } from "./plan-events.mjs";

function replay(entries) {
  let projection = createProjection();
  for (const entry of entries) projection = applyEvent(projection, entry);
  return projection;
}

export function createPlanEventWriter({ readEntries, append, id = () => crypto.randomUUID(), now = () => new Date().toISOString() } = {}) {
  if (typeof readEntries !== "function" || typeof append !== "function") throw new Error("readEntries and append are required");
  let tail = Promise.resolve();

  function submit({ expectedProjectionVersion, planId, type, data } = {}) {
    const result = tail.then(async () => {
      if (!Number.isInteger(expectedProjectionVersion) || expectedProjectionVersion < 0) {
        throw new Error("expectedProjectionVersion must be a non-negative integer");
      }
      const projection = replay(await readEntries());
      if (projection.version !== expectedProjectionVersion) {
        throw new Error(`projection version conflict: expected ${expectedProjectionVersion}, current ${projection.version}`);
      }
      const entry = {
        schemaVersion: "pi-plan-event.v1",
        eventId: id(),
        planId: projection.planId ?? planId,
        occurredAt: now(),
        type,
        data,
      };
      applyEvent(projection, entry);
      await append(entry);
      return entry;
    });
    tail = result.catch(() => {});
    return result;
  }

  return Object.freeze({ append: submit });
}
