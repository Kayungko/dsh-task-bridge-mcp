// Shared CLI/MCP transport. Validate before reading credentials; never echo raw responses.
export class TransportError extends Error {
  constructor(code, message, httpStatus) { super(message); this.code = code; if (httpStatus !== undefined) this.httpStatus = httpStatus; }
}

export function bridgeUrl(base, path) {
  try {
    const url = new URL(base);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
        url.search || url.hash || !['', '/'].includes(url.pathname) ||
        !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
        !/^\/v1\/[a-z]+$/.test(path)) throw new Error();
    return new URL(path, url);
  } catch { throw new TransportError('invalid-params', 'base 必须是无凭据、无查询串的本机回环 HTTP(S) URL，path 必须是桥端点。'); }
}

export function redact(value, secrets = []) {
  if (typeof value === 'string') {
    for (const secret of secrets) if (secret) value = value.split(secret).join('[REDACTED]');
    return value.replace(/[a-f0-9]{64}/gi, '[REDACTED-64HEX]')
      .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
  }
  if (Array.isArray(value)) return value.map(v => redact(v, secrets));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k,v]) => [k, redact(v, secrets)]));
  return value;
}

export async function requestJson({ base, path, method = 'GET', query, body, getToken,
  timeoutMs = 30000, signal, fetchImpl = fetch }) {
  const url = bridgeUrl(base, path);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new TransportError('invalid-params', 'timeout 必须是正数。');
  const token = await getToken();
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (signal?.aborted) onAbort();
  else signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(onAbort, timeoutMs);
  try {
    const response = await fetchImpl(url.toString(), { method, redirect: 'error',
      headers: { accept: 'application/json', 'X-Task-Bridge-Token': token,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: controller.signal });
    const text = await response.text(); // Timer includes body consumption.
    if (controller.signal.aborted) throw new Error('aborted');
    let data;
    try { data = JSON.parse(text); } catch { /* static error below */ }
    if (!data || typeof data !== 'object' || Array.isArray(data) ||
        (data.ok !== true && !(data.ok === false && typeof data.code === 'string' && typeof data.error === 'string'))) {
      throw new TransportError(response.ok ? 'bridge-invalid-response' : 'bridge-http-error',
        `桥响应不是合法 JSON 信封（HTTP ${response.status}）；不输出原始响应体。`, response.status);
    }
    if (!response.ok && data.ok !== false) throw new TransportError('bridge-http-error', `桥返回 HTTP ${response.status}。`, response.status);
    return { data: redact(data, [token]), status: response.status };
  } catch (error) {
    if (error instanceof TransportError) throw error;
    const code = signal?.aborted ? 'bridge-cancelled' : controller.signal.aborted ? 'bridge-timeout' : 'bridge-unreachable';
    throw new TransportError(code, `请求 ${path} 失败（${code}）；确认 DSH 与 TASK_BRIDGE_URL。写请求结果不确定时先对账，勿盲目重发。`);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}
