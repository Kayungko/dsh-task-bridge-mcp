import { requestJson, TransportError } from '../../src/transport.mjs';
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

  async request(path, { query = {}, body, timeout = this.timeout, signal } = {}) {
    try {
      const { data, status } = await requestJson({ base: this.base, path, query, body, signal,
        method: body === undefined ? 'GET' : 'POST', timeoutMs: timeout,
        getToken: async () => { const token = await this.token(); this.tokenSource = token.source; return token.value; } });
      if (data.ok === false) throw bridgeError(data, status);
      return data;
    } catch (error) {
      if (error instanceof CliError) throw error;
      if (error instanceof TransportError) throw new CliError(
        error.code === 'bridge-http-error' ? 'bridge-invalid-response' : error.code, error.message,
        { ...(error.httpStatus === undefined ? {} : { httpStatus: error.httpStatus }), advice: '确认 DSH Desktop 与桥运行；写请求结果不确定时先 progress/list 对账，勿盲目重发。' });
      throw error;
    }
  }
}
