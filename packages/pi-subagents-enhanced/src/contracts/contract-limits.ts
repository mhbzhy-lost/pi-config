// Shared dispatch/task-contract bounds. Keep init, events, and dispatch IR aligned.
export const MAX_CONTRACT_ARRAY_ITEMS = 32;
export const MAX_CONTRACT_STRING_BYTES = 4 * 1024;

export function assertContractString(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  const normalized = value.trim();
  if (Buffer.byteLength(normalized, "utf8") > MAX_CONTRACT_STRING_BYTES) throw new Error(`${label} exceeds ${MAX_CONTRACT_STRING_BYTES} bytes`);
  return normalized;
}

export function assertContractArray(value, label) {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  if (value.length > MAX_CONTRACT_ARRAY_ITEMS) throw new Error(`${label} must contain at most ${MAX_CONTRACT_ARRAY_ITEMS} items`);
  return value;
}
