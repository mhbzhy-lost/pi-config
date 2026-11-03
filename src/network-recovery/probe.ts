// 探活：只判断「能否拿到 HTTP 响应」。任何状态码（含 4xx/5xx）都说明链路可达，
// 只有网络错误或超时才算不可达——断网与鉴权/配额失败必须区分开，
// 前者才值得等下一轮唤醒，后者唤醒也不会成功。

export const DEFAULT_PROBE_TIMEOUT_MS = 3000;

export type ProbeOptions = {
  timeoutMs?: number;
  fetch?: typeof globalThis.fetch;
};

/** 探测 url 是否可达；空 url 直接视为不可达，不发请求。 */
export async function probeEndpointReachability(url: string, options: ProbeOptions = {}): Promise<boolean> {
  const { timeoutMs = DEFAULT_PROBE_TIMEOUT_MS, fetch: fetchImpl = globalThis.fetch } = options;
  if (!url) return false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    await fetchImpl(url, { method: "HEAD", signal: controller.signal });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
