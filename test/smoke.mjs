// dsh-task-bridge-mcp v0.1.0 —— 离线 smoke 测试
// 用 node:http 起临时 mock REST server 模拟 dsh-plugin-task-bridge 的 6 端点，
// 不依赖真桥。脱敏红线：所有 token 均为合成假值（FAKE-TOKEN-*）。

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { handleRpcMessage } from '../src/server.mjs';
import { BridgeClient, resolveToken, TokenError, BridgeClientError, BridgeApiError } from '../src/client.mjs';
import { TOOLS, INSTRUCTIONS, WAIT_MAX_MS, WAIT_DEFAULT_MS } from '../src/tools.mjs';

const testDir = dirname(fileURLToPath(import.meta.url)); // <repo>/test
const repoDir = join(testDir, '..');

// ---------- 合成假值（绝不读取真实 token） ----------
const FAKE_TOKEN = 'FAKE-TOKEN-smoke-only-0123456789abcdef';

// ---------- mock 桥 ----------
function startMockBridge() {
  const seen = [];
  /** @type {Map<string, {status:number, body:object} | 'hang'>} */
  const routes = new Map();
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const u = new URL(req.url, 'http://127.0.0.1');
      const query = Object.fromEntries(u.searchParams.entries());
      const rawBody = Buffer.concat(chunks).toString('utf8');
      const record = {
        method: req.method,
        pathname: u.pathname,
        query,
        tokenHeader: req.headers['x-task-bridge-token'],
        body: rawBody ? JSON.parse(rawBody) : null,
      };
      seen.push(record);
      const key = `${req.method} ${u.pathname}`;
      const route = routes.get(key);
      if (route === 'hang') return; // 挂起不响应：测客户端超时
      if (route) {
        res.writeHead(route.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(route.body));
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, code: 'no-such-route', error: `mock 未配置路由 ${key}` }));
    });
  });
  return {
    seen,
    /** 配置一条路由响应；'hang' 表示挂起。 */
    on(method, path, status, body) { routes.set(`${method} ${path}`, { status, body }); },
    hang(method, path) { routes.set(`${method} ${path}`, 'hang'); },
    start() {
      return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
        resolve(`http://127.0.0.1:${server.address().port}`);
      }));
    },
    close() {
      return new Promise((r) => {
        server.closeAllConnections?.(); // 清掉 hang 路由留下的悬挂连接，避免 close 等待
        server.close(r);
      });
    },
  };
}

// ---------- MCP 层辅助 ----------
function makeCtx(client) { return { client }; }

async function callTool(name, args, ctx) {
  const resp = await handleRpcMessage(
    { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name, arguments: args } },
    ctx,
  );
  assert.equal(resp.jsonrpc, '2.0');
  assert.equal(resp.id, 7);
  return resp.result;
}

function toolText(result) {
  assert.ok(Array.isArray(result.content) && result.content[0]?.type === 'text', 'tool result 应含 text content');
  return result.content[0].text;
}

/** 默认环境：显式注入假 token env，绝不碰 process.env 的真实变量。 */
const fakeEnv = () => ({ TASK_BRIDGE_TOKEN: FAKE_TOKEN });

// ---------- 测试 ----------
test('mock 桥 + 全工具打通：请求形状、token 头、回执透传', async (t) => {
  const mock = startMockBridge();
  const baseUrl = await mock.start();
  t.after(() => mock.close());

  // 典型 ok:true 回执（字段形状对齐桥端 README 端点对照表）
  mock.on('POST', '/v1/spawn', 200, {
    ok: true, sessionId: 'sess-spawn-1', shortId: '0909', title: '0909｜功能｜测试',
    team: 'bridge-mvp', cwd: 'D:/x', workspace: { id: 'w1', title: 'W1' },
    placement: 'exact-match', model: 'test-model-x', modelSource: 'explicit',
    started: true, correlationId: 'task-coord-abc', depth: 1,
  });
  mock.on('POST', '/v1/send', 200, {
    ok: true, delivered: true, targetId: 'sess-1', mode: 'steer', messageId: 'msg-9',
    queueDepth: { nextTurn: 1, nextStep: 0 }, placement: 'next-step', targetStatus: 'running',
  });
  mock.on('GET', '/v1/progress', 200, {
    ok: true, agentState: 'idle', updatedAt: '2026-09-10T00:00:00Z', queue: 0,
    recent: ['r1'], todos: [], seq: 42,
  });
  mock.on('GET', '/v1/wait', 200, {
    ok: true, settled: true, waitedMs: 120, targets: [{ sessionId: 's', agentState: 'cold-idle' }],
  });
  mock.on('GET', '/v1/list', 200, {
    ok: true, tasks: [{ sessionId: 'sess-1', title: 'T' }], truncated: false,
  });
  mock.on('GET', '/v1/models', 200, {
    ok: true, providers: [{ id: 'p1', models: ['m1'] }], default: { provider: 'p1', model: 'm1' }, pluginDefault: null, failedProviders: [],
  });

  const client = new BridgeClient({ baseUrl, env: fakeEnv() });
  const ctx = makeCtx(client);

  // spawn：请求体 + 回执透传（workspace/placement/modelSource 必在）
  const spawn = await callTool('dsh_task_spawn', { prompt: '做某事', title: '功能｜测试', team: 'bridge-mvp' }, ctx);
  assert.equal(spawn.isError, undefined, 'spawn 成功不应是 tool error');
  const spawnBody = JSON.parse(toolText(spawn));
  assert.equal(spawnBody.sessionId, 'sess-spawn-1');
  assert.deepEqual(spawnBody.workspace, { id: 'w1', title: 'W1' });
  assert.equal(spawnBody.placement, 'exact-match');
  assert.equal(spawnBody.modelSource, 'explicit');
  const spawnReq = mock.seen.find((r) => r.pathname === '/v1/spawn');
  assert.equal(spawnReq.method, 'POST');
  assert.equal(spawnReq.body.prompt, '做某事');
  assert.equal(spawnReq.body.reportBack, undefined, 'spawn 请求不得携带 reportBack（结构性关闭）');
  assert.equal(spawnReq.tokenHeader, FAKE_TOKEN, 'token 头必须注入');

  // send：wire 契约（工具面 message → 桥端 text）+ 回执含 queueDepth
  const send = await callTool('dsh_task_send', { sessionId: 'sess-1', message: '继续', mode: 'steer' }, ctx);
  const sendBody = JSON.parse(toolText(send));
  assert.equal(sendBody.messageId, 'msg-9');
  assert.deepEqual(sendBody.queueDepth, { nextTurn: 1, nextStep: 0 });
  const sendReq = mock.seen.find((r) => r.pathname === '/v1/send');
  assert.equal(sendReq.body.text, '继续', 'wire 字段必须是 text（桥端契约）');
  assert.equal(sendReq.body.message, undefined, 'wire 不得携带 message 字段');
  assert.equal(sendReq.body.mode, 'steer');
  assert.equal(sendReq.tokenHeader, FAKE_TOKEN);

  // progress
  const prog = await callTool('dsh_task_progress', { sessionId: 'sess-1' }, ctx);
  const progBody = JSON.parse(toolText(prog));
  assert.equal(progBody.agentState, 'idle', 'agentState 为桥端三值枚举（idle/running/cold-idle）');
  assert.equal(mock.seen.find((r) => r.pathname === '/v1/progress').query.sessionId, 'sess-1');

  // wait：单 id + mode
  const wait = await callTool('dsh_task_wait', { sessionIds: ['s1', 's2'], mode: 'any' }, ctx);
  assert.equal(JSON.parse(toolText(wait)).settled, true);
  const waitReq = mock.seen.find((r) => r.pathname === '/v1/wait');
  assert.equal(waitReq.query.sessionIds, 's1,s2');
  assert.equal(waitReq.query.mode, 'any');

  // list：query 透传
  const list = await callTool('dsh_task_list', { team: 'bridge-mvp', limit: 10 }, ctx);
  assert.equal(JSON.parse(toolText(list)).truncated, false);
  const listReq = mock.seen.find((r) => r.pathname === '/v1/list');
  assert.equal(listReq.query.team, 'bridge-mvp');
  assert.equal(listReq.query.limit, '10');

  // models
  const models = await callTool('dsh_task_models', {}, ctx);
  const modelsBody = JSON.parse(toolText(models));
  assert.equal(modelsBody.providers[0].id, 'p1');

  // 所有请求都带 token 头，且无一泄漏到 URL/query
  for (const r of mock.seen) {
    assert.equal(r.tokenHeader, FAKE_TOKEN);
    assert.ok(!JSON.stringify(r.query).includes('FAKE-TOKEN'), 'token 不得出现在 query');
  }
});

test('ok:false → MCP tool error：code+error 透传，绝不吞错', async (t) => {
  const mock = startMockBridge();
  const baseUrl = await mock.start();
  t.after(() => mock.close());

  mock.on('POST', '/v1/send', 429, {
    ok: false, code: 'rate-limited', error: 'rate limited: retry after 2000ms', retryAfterMs: 2000,
  });
  mock.on('POST', '/v1/spawn', 200, {
    ok: false, code: 'upstream-error', error: 'kickoff rejected: prompt empty',
    upstreamCode: 'kickoff-rejected', sessionId: 'orphan-sess-1',
  });

  const client = new BridgeClient({ baseUrl, env: fakeEnv() });
  const ctx = makeCtx(client);

  // HTTP 429 + ok:false
  const send = await callTool('dsh_task_send', { sessionId: 's', message: 'x' }, ctx);
  assert.equal(send.isError, true, 'ok:false 必须转成 MCP tool error');
  const sendErr = JSON.parse(toolText(send));
  assert.equal(sendErr.ok, false);
  assert.equal(sendErr.code, 'rate-limited', 'code 必须透传');
  assert.equal(sendErr.error, 'rate limited: retry after 2000ms', 'error 原文必须透传');
  assert.equal(sendErr.httpStatus, 429);
  assert.equal(sendErr.retryAfterMs, 2000, '信封附加字段（retryAfterMs）必须透传');

  // HTTP 200 + ok:false（spawn 失败带孤儿 sessionId）同样转 tool error
  const spawn = await callTool('dsh_task_spawn', { prompt: 'p' }, ctx);
  assert.equal(spawn.isError, true);
  const spawnErr = JSON.parse(toolText(spawn));
  assert.equal(spawnErr.code, 'upstream-error', '桥端稳定枚举 code 透传');
  assert.equal(spawnErr.upstreamCode, 'kickoff-rejected', 'upstreamCode（原始 ops 码）透传');
  assert.equal(spawnErr.sessionId, 'orphan-sess-1', '孤儿 sessionId 必须透传供补救');
});

test('token 缺失：三处来源皆无时报可操作的清晰错误', async (t) => {
  const mock = startMockBridge();
  const baseUrl = await mock.start();
  t.after(() => mock.close());
  mock.on('GET', '/v1/list', 200, { ok: true, tasks: [], truncated: false });

  const tmp = mkdtempSync(join(tmpdir(), 'dsh-bridge-mcp-'));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  // 1) env 无 token + 文件不存在
  const missingFile = join(tmp, 'no-such-token-file');
  const c1 = new BridgeClient({ baseUrl, env: { TASK_BRIDGE_TOKEN_FILE: missingFile } });
  const r1 = await callTool('dsh_task_list', {}, makeCtx(c1));
  assert.equal(r1.isError, true);
  const e1 = JSON.parse(toolText(r1));
  assert.equal(e1.code, 'token-missing');
  assert.match(e1.error, /TASK_BRIDGE_TOKEN/);
  assert.match(e1.error, /task-bridge-token|TOKEN_FILE/, '错误须指明文件来源');
  assert.ok(e1.error.includes(missingFile), '错误须含实际查找路径');

  // 2) token 文件存在但为空
  const emptyFile = join(tmp, 'empty-token');
  writeFileSync(emptyFile, '   \n', 'utf8');
  const c2 = new BridgeClient({ baseUrl, env: { TASK_BRIDGE_TOKEN_FILE: emptyFile } });
  const r2 = await callTool('dsh_task_list', {}, makeCtx(c2));
  assert.equal(r2.isError, true);
  assert.equal(JSON.parse(toolText(r2)).code, 'token-missing');

  // 3) env TASK_BRIDGE_TOKEN 优先于文件
  const realFile = join(tmp, 'file-token');
  writeFileSync(realFile, 'FAKE-TOKEN-from-file', 'utf8');
  const c3 = new BridgeClient({ baseUrl, env: { TASK_BRIDGE_TOKEN: 'FAKE-TOKEN-from-env', TASK_BRIDGE_TOKEN_FILE: realFile } });
  await callTool('dsh_task_list', {}, makeCtx(c3));
  assert.equal(mock.seen.at(-1).tokenHeader, 'FAKE-TOKEN-from-env', 'env token 优先');

  // 4) 缺 env 时回退文件 token
  const c4 = new BridgeClient({ baseUrl, env: { TASK_BRIDGE_TOKEN_FILE: realFile } });
  await callTool('dsh_task_list', {}, makeCtx(c4));
  assert.equal(mock.seen.at(-1).tokenHeader, 'FAKE-TOKEN-from-file', '缺省回退 token 文件');

  // 5) resolveToken 单元级：默认路径（~/.dsh/task-bridge-token）——只验证函数契约，不读真实文件
  const envNoFile = { TASK_BRIDGE_TOKEN: '', TASK_BRIDGE_TOKEN_FILE: 'Z:\\definitely\\missing\\path' };
  assert.throws(() => resolveToken(envNoFile), (err) => err instanceof TokenError && err.code === 'token-missing');
});

test('wait 钳制：timeoutMs 上限 50000、默认 45000、单值/数组归一', async (t) => {
  const mock = startMockBridge();
  const baseUrl = await mock.start();
  t.after(() => mock.close());
  mock.on('GET', '/v1/wait', 200, { ok: true, settled: false, waitedMs: 50000, targets: [] });

  const client = new BridgeClient({ baseUrl, env: fakeEnv() });
  const ctx = makeCtx(client);

  // 超上限 → 钳到 50000
  await callTool('dsh_task_wait', { sessionIds: 's1', timeoutMs: 120000 }, ctx);
  assert.equal(mock.seen.at(-1).query.timeoutMs, String(WAIT_MAX_MS), '120000 必须钳到 50000');

  // 不传 → 默认 45000
  await callTool('dsh_task_wait', { sessionIds: 's1' }, ctx);
  assert.equal(mock.seen.at(-1).query.timeoutMs, String(WAIT_DEFAULT_MS), '缺省 45000');

  // 合法小值 → 原样
  await callTool('dsh_task_wait', { sessionIds: 's1', timeoutMs: 1000 }, ctx);
  assert.equal(mock.seen.at(-1).query.timeoutMs, '1000');

  // 单字符串归一
  await callTool('dsh_task_wait', { sessionIds: 'solo' }, ctx);
  assert.equal(mock.seen.at(-1).query.sessionIds, 'solo');

  // 缺 sessionIds → invalid-params
  const bad = await callTool('dsh_task_wait', {}, ctx);
  assert.equal(bad.isError, true);
  assert.equal(JSON.parse(toolText(bad)).code, 'invalid-params');
});

test('超时与不可达：bridge-timeout / bridge-unreachable 映射', async (t) => {
  // 挂起端点 → bridge-timeout（客户端 fetch 超时）
  const mock = startMockBridge();
  const baseUrl = await mock.start();
  t.after(() => mock.close());
  mock.hang('GET', '/v1/progress');

  const client = new BridgeClient({ baseUrl, defaultTimeoutMs: 300, env: fakeEnv() });
  const r = await callTool('dsh_task_progress', { sessionId: 's' }, makeCtx(client));
  assert.equal(r.isError, true);
  const e = JSON.parse(toolText(r));
  assert.equal(e.code, 'bridge-timeout');
  assert.match(e.error, /bridge-timeout/);

  // 断言异常类型与 client 层映射（单元级）
  await assert.rejects(
    client.request('GET', '/v1/progress', { query: { sessionId: 's' }, timeoutMs: 200 }),
    (err) => err instanceof BridgeClientError && err.code === 'bridge-timeout',
  );
});

test('桥不可达（连接被拒）→ bridge-unreachable，文案含 base URL 指引', async (t) => {
  // 起一个 server 拿端口后立刻关闭，用这个几乎必然未监听的端口
  const probe = http.createServer(() => {});
  const port = await new Promise((resolve) => probe.listen(0, '127.0.0.1', () => resolve(probe.address().port)));
  await new Promise((r) => probe.close(r));

  const client = new BridgeClient({ baseUrl: `http://127.0.0.1:${port}`, env: fakeEnv() });
  const r = await callTool('dsh_task_list', {}, makeCtx(client));
  assert.equal(r.isError, true);
  const e = JSON.parse(toolText(r));
  assert.equal(e.code, 'bridge-unreachable');
  assert.match(e.error, /TASK_BRIDGE_URL/, '错误须提示 base URL 可配置');
  await assert.rejects(
    client.request('GET', '/v1/list'),
    (err) => err instanceof BridgeClientError && err.code === 'bridge-unreachable',
  );
});

test('HTTP 非 2xx 且无 ok:false 信封 → bridge-http-error', async (t) => {
  const mock = startMockBridge();
  const baseUrl = await mock.start();
  t.after(() => mock.close());
  mock.on('GET', '/v1/models', 503, { detail: 'coordinator disabled' }); // 非 {ok:false} 形状

  const client = new BridgeClient({ baseUrl, env: fakeEnv() });
  const r = await callTool('dsh_task_models', {}, makeCtx(client));
  assert.equal(r.isError, true);
  assert.equal(JSON.parse(toolText(r)).code, 'bridge-http-error');
});

test('JSON-RPC 协议分支：initialize / tools/list / notifications / ping / 未知方法 / 未知工具', async (t) => {
  const mock = startMockBridge();
  const baseUrl = await mock.start();
  t.after(() => mock.close());
  mock.on('GET', '/v1/list', 200, { ok: true, tasks: [], truncated: false });
  const ctx = makeCtx(new BridgeClient({ baseUrl, env: fakeEnv() }));

  // initialize：协议版本回显 + instructions + serverInfo
  const init = await handleRpcMessage(
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {} } },
    ctx,
  );
  assert.equal(init.result.protocolVersion, '2025-06-18');
  assert.equal(init.result.serverInfo.name, 'dsh-task-bridge-mcp');
  assert.equal(init.result.serverInfo.version, '0.1.1');
  assert.ok(init.result.instructions.length > 200, 'instructions 必须载拉模型纪律');
  for (const kw of ['拉', '串行', 'policy-gated', 'retryAfterMs', 'settled:false', 'queueDepth', 'progress', 'dsh_task_models']) {
    assert.ok(INSTRUCTIONS.includes(kw), `instructions 须覆盖纪律关键词：${kw}`);
  }

  // initialize：未知协议版本 → 回服务器支持的最高版
  const init2 = await handleRpcMessage(
    { jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '1999-01-01' } },
    ctx,
  );
  assert.equal(init2.result.protocolVersion, '2025-06-18');

  // tools/list：6 工具齐全；spawn 不暴露 reportBack
  const listResp = await handleRpcMessage({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} }, ctx);
  const names = listResp.result.tools.map((x) => x.name);
  assert.deepEqual(names.sort(), [
    'dsh_task_list', 'dsh_task_models', 'dsh_task_progress',
    'dsh_task_send', 'dsh_task_spawn', 'dsh_task_wait',
  ], '工具集必须镜像桥 MVP 6 端点');
  const spawnTool = listResp.result.tools.find((x) => x.name === 'dsh_task_spawn');
  assert.equal(spawnTool.inputSchema.properties.reportBack, undefined, 'spawn 不得暴露 reportBack');
  assert.ok(spawnTool.description.includes('workspace') && spawnTool.description.includes('placement') && spawnTool.description.includes('modelSource'));
  const sendTool = listResp.result.tools.find((x) => x.name === 'dsh_task_send');
  assert.ok(sendTool.description.includes('queueDepth'));

  // 通知 → null（无响应）
  assert.equal(await handleRpcMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }, ctx), null);
  assert.equal(await handleRpcMessage({ jsonrpc: '2.0', method: 'initialized' }, ctx), null);
  assert.equal(await handleRpcMessage({ jsonrpc: '2.0', method: 'some/unknown/notification' }, ctx), null);

  // ping → {}
  const ping = await handleRpcMessage({ jsonrpc: '2.0', id: 4, method: 'ping' }, ctx);
  assert.deepEqual(ping.result, {});

  // 未知方法（有 id）→ -32601
  const unknown = await handleRpcMessage({ jsonrpc: '2.0', id: 5, method: 'resources/list' }, ctx);
  assert.equal(unknown.error.code, -32601);

  // 未知工具 → -32602
  const unknownTool = await handleRpcMessage(
    { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'dsh_task_cancel', arguments: {} } },
    ctx,
  );
  assert.equal(unknownTool.error.code, -32602, '未提供的工具（cancel 属桥第二批）必须明确报错');

  // 缺必填参数 → isError:true + invalid-params（模型可读可自纠）
  const noPrompt = await callTool('dsh_task_spawn', {}, ctx);
  assert.equal(noPrompt.isError, true);
  assert.equal(JSON.parse(toolText(noPrompt)).code, 'invalid-params');
});

test('BridgeApiError 异常类型契约（单元级）', () => {
  const e = new BridgeApiError('target-not-found', 'no such session', 404);
  assert.equal(e.code, 'target-not-found');
  assert.equal(e.bridgeError, 'no such session');
  assert.equal(e.httpStatus, 404);
  assert.equal(e.message, 'no such session');
});

test('stdio 循环回归：真实子进程 + 管道，stdin EOF 后在途 tools/call 响应不得丢失', async (t) => {
  const mock = startMockBridge();
  const baseUrl = await mock.start();
  t.after(() => mock.close());
  mock.on('GET', '/v1/list', 200, { ok: true, tasks: [{ sessionId: 'stdio-1' }], truncated: false });

  // 起真实 server 子进程（真实 readline 循环 + stdout 写出）。
  let child;
  try {
    child = spawn(process.execPath, [join(repoDir, 'src', 'server.mjs')], {
      env: {
        ...process.env,
        TASK_BRIDGE_URL: baseUrl,
        TASK_BRIDGE_TOKEN: FAKE_TOKEN,
        TASK_BRIDGE_TOKEN_FILE: '', // 防泄漏真实文件：显式 env token 已足够
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (err) {
    t.skip(`受限环境无法 spawn 子进程（${err?.code ?? err}），跳过 stdio 循环回归`);
    return;
  }

  const stdoutLines = [];
  let stderrText = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (d) => { stdoutLines.push(...d.split('\n').filter(Boolean)); });
  child.stderr.on('data', (d) => { stderrText += d; });

  const exitCode = await new Promise((resolve, reject) => {
    child.on('error', (err) => reject(err));
    child.on('exit', (code) => resolve(code));
    // 关键序列：写完全部请求后立即关 stdin——tools/call 的 fetch 仍在途。
    // server 必须等在途请求落定并写出响应后才退出（不能提前 process.exit）。
    child.stdin.write(
      '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}\n' +
      '{"jsonrpc":"2.0","method":"notifications/initialized"}\n' +
      '{"jsonrpc":"2.0","id":2,"method":"tools/list"}\n' +
      '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"dsh_task_list","arguments":{}}}\n',
    );
    child.stdin.end();
  });

  assert.equal(exitCode, 0, `server 退出码应为 0（stderr: ${stderrText.slice(0, 300)}）`);
  assert.equal(stdoutLines.length, 3, '应恰好 3 条响应（initialize + tools/list + tools/call；通知无响应）');
  const responses = stdoutLines.map((l) => JSON.parse(l));
  const [init, list, call] = responses;
  assert.equal(init.id, 1);
  assert.equal(init.result.serverInfo.name, 'dsh-task-bridge-mcp');
  assert.ok(init.result.instructions.length > 200);
  assert.equal(list.id, 2);
  assert.equal(list.result.tools.length, 6);
  assert.equal(call.id, 3);
  assert.equal(call.result.isError, undefined, 'tools/call 应成功');
  const payload = JSON.parse(call.result.content[0].text);
  assert.equal(payload.ok, true);
  assert.equal(payload.tasks[0].sessionId, 'stdio-1');
});
