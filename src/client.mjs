// dsh-task-bridge-mcp —— REST client 层
// 把 MCP 工具调用翻译为对 dsh-plugin-task-bridge REST 端点的 HTTP 请求。
// 契约（与桥插件共用，不得单方更改）：
//   - base URL 默认 http://127.0.0.1:43120，env TASK_BRIDGE_URL 覆盖；
//   - 鉴权头 X-Task-Bridge-Token；token 读取顺序：
//       env TASK_BRIDGE_TOKEN  >  env TASK_BRIDGE_TOKEN_FILE  >  ~/.dsh/task-bridge-token
//   - 应答信封 {ok:true,...} / {ok:false,code,error}；
//     ok:false 一律抛 BridgeApiError（code+error 透传），绝不吞错。

import { homedir } from 'node:os';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const DEFAULT_BASE_URL = 'http://127.0.0.1:43120';
export const DEFAULT_TOKEN_FILE = () => join(homedir(), '.dsh', 'task-bridge-token');
export const TOKEN_HEADER = 'X-Task-Bridge-Token';

/** token 未配置 / 不可用。code 固定为 token-missing / token-unreadable。 */
export class TokenError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'TokenError';
    this.code = code;
  }
}

/** 网络层 / 协议层失败（桥不可达、超时、HTTP 异常、非法 JSON）。code 见下方映射。 */
export class BridgeClientError extends Error {
  constructor(code, message, { cause } = {}) {
    super(message);
    this.name = 'BridgeClientError';
    this.code = code;
    if (cause !== undefined) this.cause = cause;
  }
}

/** 桥端业务失败：应答信封 ok:false，code 与 error 原样透传。 */
export class BridgeApiError extends Error {
  /**
   * @param {string} code
   * @param {string} error
   * @param {number} httpStatus
   * @param {Record<string, unknown>} extras 信封中除 ok/code/error 外的字段
   *   （如 rate-limited 的 retryAfterMs、spawn 失败的孤儿 sessionId）——一并透传给调用方。
   */
  constructor(code, error, httpStatus, extras = {}) {
    super(error ?? code);
    this.name = 'BridgeApiError';
    this.code = code;
    this.bridgeError = error;
    this.httpStatus = httpStatus;
    this.extras = extras;
  }
}

/**
 * 解析桥 token。每次请求前惰性调用（token 文件可能随桥重启轮换）。
 * @param {NodeJS.ProcessEnv} env
 * @returns {string} token
 * @throws {TokenError} 三处来源均无可用 token 时，报含来源清单的可操作错误。
 */
export function resolveToken(env = process.env) {
  const fromEnv = typeof env.TASK_BRIDGE_TOKEN === 'string' ? env.TASK_BRIDGE_TOKEN.trim() : '';
  if (fromEnv) return fromEnv;

  const file = env.TASK_BRIDGE_TOKEN_FILE && env.TASK_BRIDGE_TOKEN_FILE.trim()
    ? env.TASK_BRIDGE_TOKEN_FILE.trim()
    : DEFAULT_TOKEN_FILE();

  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (err) {
    const reason = err && err.code === 'ENOENT' ? '不存在' : `不可读（${err?.code ?? err?.message}）`;
    throw new TokenError('token-missing',
      `未配置 task-bridge token：env TASK_BRIDGE_TOKEN 未设置，且 token 文件 ${file} ${reason}。` +
      '请设置 env TASK_BRIDGE_TOKEN，或让 dsh-plugin-task-bridge 生成 token 文件（可用 env TASK_BRIDGE_TOKEN_FILE 指定其他路径）。' +
      '注意：token 只经环境变量或文件注入，绝不放进命令行参数。');
  }
  const token = raw.trim();
  if (!token) {
    throw new TokenError('token-missing',
      `未配置 task-bridge token：token 文件 ${file} 内容为空，且 env TASK_BRIDGE_TOKEN 未设置。` +
      '请设置 env TASK_BRIDGE_TOKEN，或让 dsh-plugin-task-bridge 重新生成 token 文件。');
  }
  return token;
}

/**
 * REST client。fetch / env 均可注入以便离线测试。
 */
export class BridgeClient {
  /**
   * @param {object} [options]
   * @param {string} [options.baseUrl] 缺省 DEFAULT_BASE_URL（或 env TASK_BRIDGE_URL）
   * @param {() => string} [options.resolveTokenFn] 缺省 resolveToken(process.env)
   * @param {typeof fetch} [options.fetchImpl] 缺省全局 fetch
   * @param {number} [options.defaultTimeoutMs] 单请求缺省超时，默认 30000
   */
  constructor({ baseUrl, resolveTokenFn, fetchImpl, defaultTimeoutMs = 30000, env = process.env } = {}) {
    this.baseUrl = (baseUrl ?? env.TASK_BRIDGE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.resolveTokenFn = resolveTokenFn ?? (() => resolveToken(env));
    this.fetchImpl = fetchImpl ?? fetch;
    this.defaultTimeoutMs = defaultTimeoutMs;
    this.env = env;
  }

  /**
   * 发起一次桥请求。
   * @param {'GET'|'POST'} method
   * @param {string} path 形如 '/v1/spawn'
   * @param {object} [options]
   * @param {Record<string, string|number|boolean|undefined>} [options.query] query 参数（undefined/空值跳过）
   * @param {object} [options.body] JSON body（POST）
   * @param {number} [options.timeoutMs]
   * @returns {Promise<object>} ok:true 的应答信封（原样透传字段）
   * @throws {TokenError} token 未配置
   * @throws {BridgeClientError} 网络层 / 协议层失败
   * @throws {BridgeApiError} 桥端 ok:false（code+error 透传）
   */
  async request(method, path, { query, body, timeoutMs } = {}) {
    const url = new URL(this.baseUrl + path);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value === undefined || value === null || value === '') continue;
        url.searchParams.set(key, String(value));
      }
    }

    const headers = { accept: 'application/json' };
    headers[TOKEN_HEADER] = this.resolveTokenFn();
    if (body !== undefined) headers['content-type'] = 'application/json';

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`client timeout after ${timeoutMs ?? this.defaultTimeoutMs}ms`)),
      timeoutMs ?? this.defaultTimeoutMs);
    let res;
    try {
      res = await this.fetchImpl(url.toString(), {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      const aborted = controller.signal.aborted === true || err?.name === 'AbortError';
      if (aborted) {
        throw new BridgeClientError('bridge-timeout',
          `请求 ${method} ${path} 超过 ${timeoutMs ?? this.defaultTimeoutMs}ms 未响应（bridge-timeout）。` +
          '若这是 dsh_task_wait 调用，请缩短 timeoutMs（上限 50000ms）后重试。', { cause: err });
      }
      throw new BridgeClientError('bridge-unreachable',
        `无法连接 task-bridge（${method} ${url.host}${path}）：${err?.cause?.code ?? err?.message ?? err}。` +
        `请确认 DSH Desktop 已运行且 dsh-plugin-task-bridge 已启用（默认 ${DEFAULT_BASE_URL}，可用 env TASK_BRIDGE_URL 覆盖）。`,
        { cause: err });
    } finally {
      clearTimeout(timer);
    }

    const text = await res.text().catch(() => '');
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      // 落到下方 invalid-response 分支
    }

    if (json && typeof json === 'object' && json.ok === false) {
      // 桥端业务失败：code+error 透传（无论 HTTP 状态码 4xx/5xx）。
      const code = typeof json.code === 'string' && json.code ? json.code : 'bridge-error';
      const errorText = typeof json.error === 'string' ? json.error : JSON.stringify(json.error ?? '');
      const { ok: _ok, code: _code, error: _error, ...extras } = json;
      throw new BridgeApiError(code, errorText, res.status, extras);
    }
    if (!res.ok) {
      throw new BridgeClientError('bridge-http-error',
        `task-bridge 返回 HTTP ${res.status}（${method} ${path}），且响应体不是 {ok:false,code,error} 信封。` +
        `body 前 200 字符：${text.slice(0, 200)}`);
    }
    if (!json || typeof json !== 'object' || json.ok !== true) {
      throw new BridgeClientError('bridge-invalid-response',
        `task-bridge 响应不是合法的 {ok:true,...} 信封（HTTP ${res.status}，${method} ${path}）。` +
        `body 前 200 字符：${text.slice(0, 200)}`);
    }
    return json;
  }
}
