const MAX_TITLE_BYTES = 256;
const CONTROL_OR_LINE_BREAK = /[\u0000-\u001f\u007f-\u009f]/;

export function normalizeSubagentTitle(value) {
  if (typeof value !== "string") throw titleError("title must be a string");
  const title = value.trim();
  if (!title || Buffer.byteLength(title, "utf8") > MAX_TITLE_BYTES || CONTROL_OR_LINE_BREAK.test(title)) {
    throw titleError("title must be a non-empty single-line display string of at most 256 bytes");
  }
  return title;
}

function titleError(message) {
  const error = new Error(`INVALID_TITLE: ${message}`);
  error.code = "INVALID_TITLE";
  return error;
}

export function createTitleRegistry({ maxEntries = 256 } = {}) {
  const pending = [];
  const titles = new Map();
  const completed = [];
  const remember = (runId, title) => {
    if (typeof runId !== "string" || !runId || !title) return;
    titles.delete(runId);
    titles.set(runId, title);
    while (titles.size > maxEntries) titles.delete(titles.keys().next().value);
  };
  return Object.freeze({
    version: 2,
    prepare({ agent, task, title }) {
      pending.push({ agent, task, title: normalizeSubagentTitle(title) });
      while (pending.length > maxEntries) pending.shift();
    },
    started(event) {
      const runId = event?.id ?? event?.runId;
      const agent = event?.agent;
      const task = event?.goal ?? event?.task ?? "";
      const index = pending.findIndex((entry) => entry.agent === agent && (
        !task || entry.task.startsWith(task) || task.startsWith(entry.task)
      ));
      if (index < 0) return undefined;
      const [{ title }] = pending.splice(index, 1);
      remember(runId, title);
      return title;
    },
    remember(runId, title) { remember(runId, normalizeSubagentTitle(title)); },
    titleFor(runId) { return titles.get(runId); },
    completed(event) {
      const title = titles.get(event?.runId ?? event?.id);
      if (title) completed.push({ agent: event?.agent, title, presentation: event?.presentation });
      while (completed.length > maxEntries) completed.shift();
      return title;
    },
    resetCompleted() { completed.length = 0; },
    takeCompleted(agent) {
      const index = completed.findIndex((entry) => entry.agent === agent);
      if (index < 0) return undefined;
      return completed.splice(index, 1)[0].title;
    },
    takeCompletedDetail(agent) {
      const index = completed.findIndex((entry) => entry.agent === agent);
      if (index < 0) return undefined;
      return completed.splice(index, 1)[0];
    },
  });
}

export function getTitleRegistry(store = globalThis) {
  const key = "__typedSubagentTitleRegistry";
  if (store[key]?.version !== 2 || typeof store[key].prepare !== "function") store[key] = createTitleRegistry();
  return store[key];
}
