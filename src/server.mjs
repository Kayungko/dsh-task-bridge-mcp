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

const SUPPORTED_PROTOCOL_VERSIONS = ['2024-11-05', '2025-03-26', '2025-06-18'];
const LATEST_PROTOCOL_VERSION = '2025-06-18';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const SERVER_INFO = { name: pkg.name, version: pkg.version };

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
  } else {
    code = 'internal-error';
    error = `dsh-task-bridge-mcp 内部错误：${err?.stack ?? err}`;
  }
  const envelope = { ok: false, code, error };
  if (err instanceof BridgeApiError) {
    if (err.httpStatus !== undefined) envelope.httpStatus = err.httpStatus;
    // 信封附加字段透传：rate-limited 的 retryAfterMs、spawn 失败的孤儿 sessionId 等。
    Object.assign(envelope, err.extras);
  }
  return {
    content: [{ type: 'text', text: JSON.stringify(envelope) }],
    isError: true,
  };
}

/**
 * 处理一条已解析的 JSON-RPC 消息。
 * @returns {object|null} 响应消息（写入 stdout），通知或无需响应时返回 null。
 */
export function handleRpcMessage(msg, ctx) {
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
        instructions: INSTRUCTIONS,
      });
    }
    case 'initialized':
    case 'notifications/initialized':
    case 'notifications/cancelled':
    case 'notifications/roots/list_changed':
    case 'notifications/progress':
      return null;
    case 'ping':
      return jsonRpcResult(id, {});
    case 'tools/list':
      return jsonRpcResult(id, {
        tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
      });
    case 'tools/call': {
      const name = params?.name;
      const tool = TOOLS.find((t) => t.name === name);
      if (!tool) {
        return jsonRpcError(id, -32602, `Unknown tool: ${name}`);
      }
      // handler 是 async；把 Promise 交回调用方（stdio 循环 await 后写 stdout）。
      const p = (async () => {
        let result;
        try {
          result = await tool.handler(ctx.client, params?.arguments ?? {});
        } catch (err) {
          return errorToToolResult(err);
        }
        return {
          content: [{ type: 'text', text: JSON.stringify(result) }],
        };
      })();
      return p.then((toolResult) => jsonRpcResult(id, toolResult));
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
