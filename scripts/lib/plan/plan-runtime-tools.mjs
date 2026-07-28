export function ensurePlanRuntimeTools(pi, requiredTools) {
  if (!pi || typeof pi.getAllTools !== "function" || typeof pi.getActiveTools !== "function"
    || typeof pi.setActiveTools !== "function") {
    throw new Error("Standalone Plan Runner runtime tool API is unavailable");
  }
  if (!Array.isArray(requiredTools) || requiredTools.some((name) => typeof name !== "string" || !name)) {
    throw new Error("Standalone Plan Runner required tools are invalid");
  }

  const registered = new Set(pi.getAllTools().map((tool) => tool?.name).filter(Boolean));
  const missing = requiredTools.filter((name) => !registered.has(name));
  if (missing.length > 0) {
    throw new Error(`Standalone Plan Runner runtime tools are not registered: ${missing.join(", ")}`);
  }

  const current = pi.getActiveTools();
  pi.setActiveTools([...new Set([...current, ...requiredTools])]);
  const active = new Set(pi.getActiveTools());
  const inactive = requiredTools.filter((name) => !active.has(name));
  if (inactive.length > 0) {
    throw new Error(`Standalone Plan Runner runtime tools could not be activated: ${inactive.join(", ")}`);
  }
  return [...requiredTools];
}
