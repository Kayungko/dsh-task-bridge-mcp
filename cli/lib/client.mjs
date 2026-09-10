import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { CliError, bridgeError } from './errors.mjs';

export const DEFAULT_BASE = 'http://127.0.0.1:43120';

export class Client {
  constructor({ base, timeout = 30000, env = process.env, home = homedir() } = {}) {
    this.env = env;
    this.home = home;
    this.timeout = timeout;
    this.secrets = new Set();
    if (env.TASK_BRIDGE_TOKEN?.trim()) this.secrets.add(env.TASK_BRIDGE_TOKEN.trim());
    this.base = base ?? env.TASK_BRIDGE_URL ?? DEFAULT_BASE;
  }

  // The default home override is dependency injection for offline tests only, never argv.
  async token() {
    const direct = this.env.TASK_BRIDGE_TOKEN?.trim();
    if (direct) {
      this.secrets.add(direct);
      return { value: direct, source: 'env:TASK_BRIDGE_TOKEN' };
    }
    const explicit = this.env.TASK_BRIDGE_TOKEN_FILE?.trim();
    let value;
    try { value = (await readFile(explicit || join(this.home, '.dsh', 'task-bridge-token'), 'utf8')).trim(); }
    catch { /* Never expose filesystem error messages or their interpolated paths. */ }
    if (!value) throw new CliError('token-missing', '未找到可用的桥 token。', {
      advice: '检查 TASK_BRIDGE_TOKEN、TASK_BRIDGE_TOKEN_FILE 或 ~/.dsh/task-bridge-token；只用环境变量或文件，勿放 argv。',
    });
    this.secrets.add(value);
    return { value, source: explicit ? 'env:TASK_BRIDGE_TOKEN_FILE' : 'default-file' };
  }

  redact(text) {
    let result = String(text);
    for (const secret of this.secrets) result = result.split(secret).join('[REDACTED]');
    return result.replace(/[a-f0-9]{64}/gi, '[REDACTED-64HEX]')
      .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
  }

  async request(path, { query = {}, body, timeout = this.timeout } = {}) {
    let url;
    try {
      const base = new URL(this.base);
      if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password ||
          base.search || base.hash || !['', '/'].includes(base.pathname) ||
          !['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname)) throw new Error();
      url = new URL(path, base);
    } catch { throw new CliError('invalid-params', 'base 必须是无凭据、无查询串的本机回环 HTTP(S) URL。'); }
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    const token = await this.token(); // Re-read on every request; rotation needs no restart.
    this.tokenSource = token.source;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const res = await fetch(url, {
        method: body === undefined ? 'GET' : 'POST', redirect: 'error',
        headers: { accept: 'application/json', 'X-Task-Bridge-Token': token.value,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: controller.signal,
      });
      // Keep the timer active while reading the body, not just until response headers.
      let data;
      try { data = JSON.parse(await res.text()); }
      catch (error) {
        if (controller.signal.aborted) throw error;
        throw new CliError('bridge-invalid-response', `桥响应不是 JSON 信封（HTTP ${res.status}）。`, {
          advice: '确认桥与 coordinator 可用；不输出不可信原始响应体。',
        });
      }
      if (data?.ok === false && typeof data.code === 'string' && typeof data.error === 'string') {
        throw bridgeError(data, res.status);
      }
      if (!res.ok || data?.ok !== true) {
        throw new CliError('bridge-invalid-response', `桥响应缺少有效信封（HTTP ${res.status}）。`);
      }
      return data;
    } catch (error) {
      if (error instanceof CliError) throw error;
      throw new CliError(controller.signal.aborted ? 'bridge-timeout' : 'bridge-unreachable',
        controller.signal.aborted ? `请求 ${path} 超时（${timeout}ms）。` : `无法访问桥 ${path}。`, {
          advice: '确认 DSH Desktop 与桥运行、TASK_BRIDGE_URL 正确；写请求结果不确定时先 progress/list 对账，勿盲目重发。',
        });
    } finally { clearTimeout(timer); }
  }
}
