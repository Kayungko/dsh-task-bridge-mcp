#!/usr/bin/env node
// dsh-task-bridge-mcp —— Codex 侧 MCP stdio server 入口
// 手写 JSON-RPC 2.0（NDJSON：stdin 每行一条消息，stdout 每行一条响应）。
// 协议面（MCP）：initialize（含 instructions）/ tools/list / tools/call / ping，
// 忽略通知类消息；未知方法回 -32601；未知工具回 -32602。
// 桥应答 ok:false → MCP tool result isError:true（code+error 透传，绝不吞错）。

import { createInterface } from 'node:readline';
import { readFileSync } from 'node:fs';
import { BridgeClient, TokenError, BridgeClientError, BridgeApiError, DEFAULT_BASE_URL } from './client.mjs';
import { TOOLS, INSTRUCTIONS, ToolValidationError } from './tools.mjs';
import { buildLocalTools, buildLocalInstructions, resolveLocalConfig, LocalToolError } from './local-fs.mjs';

const SUPPORTED_PROTOCOL_VERSIONS = ['2024-11-05', '2025-03-26', '2025-06-18'];
const LATEST_PROTOCOL_VERSION = '2025-06-18';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const SERVER_INFO = { name: pkg.name, version: pkg.version };

/**
 * 本地文件/命令工具（0.5.0 引入，0.5.1 加固）：默认关闭。env DSH_BRIDGE_LOCAL_FS=1 开文件
 * 四件套、DSH_BRIDGE_LOCAL_EXEC=1 另开 local_exec——两个独立开关。都不设时 LOCAL_TOOLS 为空
 * 数组，tools/list、instructions、错误信封与桥路径**逐字节零变化**（initialize 仅
 * serverInfo.version 随版本轨道变化）。
 *
 * 进程启动时读一次 env（不支持热切换：改开关必须重启 bridge-mcp / tunnel-client）。
 * 这是有意的——能力面在进程生命周期内固定，避免"跑着跑着多出个 shell 工具"。
 *
 * 整段包 try/catch（0.5.1）：模块加载期抛错会让整个 server 起不来，**连既有 7 个桥工具
 * 一起死**——那是可选能力拖垮核心链路。失败时降级为「不注册本地工具 + stderr 强告警」。
 */
let LOCAL_CONFIG;
let LOCAL_TOOLS;
try {
  LOCAL_CONFIG = resolveLocalConfig();
  LOCAL_TOOLS = buildLocalTools({ config: LOCAL_CONFIG });
} catch (error) {
  LOCAL_CONFIG = resolveLocalConfig({}); // 全默认（两个开关均 false），保证下面的引用不落空
  LOCAL_TOOLS = [];
  process.stderr.write(
    `[bridge-mcp] WARN 本地工具初始化失败，已降级为不注册（7 个桥工具不受影响）：${error?.message ?? error}\n`,
  );
}
/** 全部工具：桥侧 7 个（冻结契约）+ 本地若干（门控）。分发与 tools/list 共用同一数组。 */
const ALL_TOOLS = [...TOOLS, ...LOCAL_TOOLS];
/** instructions 同样按启用集合动态拼接，未启用就不提本地工具（不诱导模型去调不存在的工具）。 */
const ALL_INSTRUCTIONS = [INSTRUCTIONS, ...buildLocalInstructions(LOCAL_CONFIG)].join('\n');

if (LOCAL_TOOLS.length > 0) {
  // 运维可见性：这个进程开了什么能力必须能在日志里一眼看到。
  // ⚠️ 但**不要指望它落进 tunnel-client 的日志文件**——安全评审实测 3.9MB debug 日志、
  // 两次启动、对 bridge-mcp 的 stderr 零命中（profile 的 mcp.commands[] 没有 stderr 重定向
  // 字段）。经 tunnel-client 部署时 stderr 的实际去向未取证。要持久审计请用
  // DSH_BRIDGE_AUDIT_FILE（见 README）。
  process.stderr.write(
    `[bridge-mcp] local tools ENABLED: ${LOCAL_TOOLS.map((t) => t.name).join(', ')} `
    + `(maxBytes=${LOCAL_CONFIG.maxBytes}, execTimeoutMs=${LOCAL_CONFIG.execTimeoutMs}, `
    + `denyCredentials=${LOCAL_CONFIG.denyCredentials}, cwd=${LOCAL_CONFIG.defaultCwd})\n`,
  );
}

function jsonRpcError(id, code, message) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

function jsonRpcResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}

/** 把任意工具层异常映射为 MCP tool result（isError:true，信封透传）。 */
function errorToToolResult(err) {
  let code;
  let error;
  if (err instanceof ToolValidationError) {
    code = err.code; // invalid-params
    error = err.message;
  } else if (err instanceof TokenError) {
    code = err.code; // token-missing
    error = err.message;
  } else if (err instanceof BridgeApiError) {
    code = err.code; // 桥端 code 原样透传（rate-limited / target-not-found / ...）
    error = err.bridgeError ?? err.message;
  } else if (err instanceof BridgeClientError) {
    code = err.code; // bridge-unreachable / bridge-timeout / bridge-http-error / bridge-invalid-response
    error = err.message;
  } else if (err instanceof LocalToolError) {
    code = err.code; // invalid-params / not-found / too-large / binary-file / credential-protected / path-denied / exec-failed / is-directory / not-directory
    error = err.message;
  } else {
    code = 'internal-error';
    error = 'dsh-task-bridge-mcp 内部错误';
  }
  const envelope = { ok: false, code, error };
  if (err instanceof BridgeApiError) {
    if (err.httpStatus !== undefined) envelope.httpStatus = err.httpStatus;
    // 信封附加字段透传：rate-limited 的 retryAfterMs、spawn 失败的孤儿 sessionId 等。
    Object.assign(envelope, err.extras);
  }
  return {
    content: [{ type: 'text', text: JSON.stringify(envelope) }],
    structuredContent: envelope,
    isError: true,
  };
}

/**
 * 处理一条已解析的 JSON-RPC 消息。
 * @returns {object|null} 响应消息（写入 stdout），通知或无需响应时返回 null。
 */
export function handleRpcMessage(msg, ctx) {
  // ctx 可覆盖 tools/instructions，供离线单测断言不同 env 门控组合下的工具面；
  // 生产路径不传，落到模块级 ALL_TOOLS / ALL_INSTRUCTIONS。
  const tools = ctx?.tools ?? ALL_TOOLS;
  const instructions = ctx?.instructions ?? ALL_INSTRUCTIONS;
  if (msg === null || typeof msg !== 'object' || Array.isArray(msg)) {
    // MCP stdio 不使用 JSON-RPC batch；畸形输入无法可靠取 id，按规范回 id:null。
    return jsonRpcError(null, -32600, 'Invalid Request');
  }
  const { id, method, params } = msg;
  const isNotification = id === undefined || id === null;

  switch (method) {
    case 'initialize': {
      const requested = params?.protocolVersion;
      const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
        ? requested
        : LATEST_PROTOCOL_VERSION;
      return jsonRpcResult(id, {
        protocolVersion,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
        instructions,
      });
    }
    case 'notifications/cancelled':
      ctx.requests?.get(params?.requestId)?.abort();
      return null;
    case 'initialized':
    case 'notifications/initialized':
    case 'notifications/roots/list_changed':
    case 'notifications/progress':
      return null;
    case 'ping':
      return jsonRpcResult(id, {});
    case 'tools/list':
      return jsonRpcResult(id, {
        tools: tools.map(({ name, description, inputSchema, outputSchema, annotations }) => ({ name, description, inputSchema, outputSchema, annotations })),
      });
    case 'tools/call': {
      const name = params?.name;
      const tool = tools.find((t) => t.name === name);
      if (!tool) {
        return jsonRpcError(id, -32602, `Unknown tool: ${name}`);
      }
      // handler 是 async；把 Promise 交回调用方（stdio 循环 await 后写 stdout）。
      const controller = new AbortController();
      ctx.requests ??= new Map();
      ctx.requests.set(id, controller);
      const client = { request: (method, path, options = {}) => ctx.client.request(method, path, { ...options, signal: controller.signal }) };
      const p = (async () => {
        let result;
        try {
          result = await tool.handler(client, params?.arguments ?? {});
        } catch (err) {
          return errorToToolResult(err);
        }
        return {
          content: [{ type: 'text', text: JSON.stringify(result) }],
          structuredContent: result,
        };
      })();
      return p.then((toolResult) => jsonRpcResult(id, toolResult)).finally(() => ctx.requests.delete(id));
    }
    default:
      if (isNotification) return null; // 未知通知按规范静默忽略
      return jsonRpcError(id, -32601, `Method not found: ${method}`);
  }
}

/** stdio 主循环。 */
async function main() {
  const client = new BridgeClient();
  const ctx = { client };
  const pending = new Set(); // 在途 tools/call（async fetch）；stdin EOF 时须等它们落定再退出

  const write = (msg) => {
    process.stdout.write(JSON.stringify(msg) + '\n');
  };

  const handleLine = (text) => {
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      write(jsonRpcError(null, -32700, 'Parse error'));
      return;
    }
    const p = Promise.resolve()
      .then(() => handleRpcMessage(msg, ctx))
      .then((response) => {
        if (response !== null && response !== undefined) write(response);
      })
      .catch((err) => {
        process.stderr.write(`[dsh-task-bridge-mcp] unhandled error: ${err?.stack ?? err}\n`);
        try {
          if (msg?.id !== undefined && msg?.id !== null) {
            write(jsonRpcError(msg.id, -32603, 'Internal error'));
          }
        } catch { /* 已尽力 */ }
      });
    pending.add(p);
    p.finally(() => pending.delete(p));
  };

  const rl = createInterface({ input: process.stdin, terminal: false });
  rl.on('line', (line) => {
    const text = line.trim();
    if (!text) return;
    handleLine(text);
  });
  rl.on('close', () => {
    // stdin EOF ≠ 可立即退出：等在途请求写完响应（请求层自带超时，终会落定）。
    if (pending.size === 0) {
      process.exit(0);
      return;
    }
    Promise.allSettled([...pending]).then(() => process.exit(0));
    setTimeout(() => process.exit(0), 70_000).unref(); // 安全网（> 客户端最大超时 55s）
  });

  process.on('SIGINT', () => process.exit(0));
  process.on('SIGTERM', () => process.exit(0));

  process.stderr.write(
    `[dsh-task-bridge-mcp] v${pkg.version} stdio server started; bridge=${client.baseUrl}` +
    ` (default ${DEFAULT_BASE_URL}; override with TASK_BRIDGE_URL)\n`,
  );
}

// 直接执行时启动（import 供测试时跳过）。
if (process.argv[1] && process.argv[1].replaceAll('\\', '/').endsWith('/src/server.mjs')) {
  main().catch((err) => {
    process.stderr.write(`[dsh-task-bridge-mcp] fatal: ${err?.stack ?? err}\n`);
    process.exit(1);
  });
}
