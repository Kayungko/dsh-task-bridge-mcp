// Offline only: all credentials are synthetic; all HTTP targets are loopback mocks.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from '../lib/run.mjs';
import { Client } from '../lib/client.mjs';

const scratchParent = resolve(process.env.DSHQ_TEST_TMPDIR ?? tmpdir());
await mkdir(scratchParent, { recursive: true });
const scratch = await mkdtemp(join(scratchParent, 'dshq-smoke-'));
const cli = fileURLToPath(new URL('../dshq.mjs', import.meta.url));
const id = 'session-12345678-1111-4111-8111-111111111111';
const id2 = 'session-87654321-2222-4222-8222-222222222222';
const fake = 'FAKE-TOKEN-dshq-smoke';
const tasks = [
  { sessionId: id, title: 'Alpha 编排', team: 'wave', status: 'running', updatedAt: Date.now(), pendingTodos: 0 },
  { sessionId: id2, title: 'Beta 编排', team: 'wave', status: 'idle', updatedAt: Date.now(), pendingTodos: 2 },
  { sessionId: 'session-blank', title: null, status: 'blank', updatedAt: 1, pendingTodos: 0 },
];
const recent = [
  { role: 'assistant', text: '早期回复' }, { role: 'user', text: '不属于回信' },
  { role: 'assistant', text: '【L2→L1】离线回信原文。\n\n后续 … (+123 chars)' },
];
let requests = [];
let responder;
let expectedToken = fake;
let mockFailure;
function defaults(req) {
  switch (req.path) {
    case '/v1/list': return { ok: true, count: tasks.length, truncated: false, tasks };
    case '/v1/models': return { ok: true, default: { provider: 'p', model: 'm' }, pluginDefault: null,
      providers: [{ id: 'p', models: [{ id: 'm', efforts: ['high'] }] }] };
    case '/v1/progress': return { ok: true, sessionId: req.query.sessionId, agentState: 'idle', queue: [],
      todos: null, goal: null, recent, seq: 1 };
    case '/v1/send': return { ok: true, delivered: true, targetId: req.body.sessionId,
      mode: req.body.mode, messageId: 'fake-message', queueDepth: { nextTurn: 2, nextStep: 0 } };
    case '/v1/spawn': return { ok: true, sessionId: id, shortId: '12345678', workspace: { id: 'w', title: 'mock' },
      placement: 'exact-match', modelSource: 'plugin-default', started: true };
    case '/v1/wait': return { ok: true, settled: true, waitedMs: 0,
      targets: req.query.sessionIds.split(',').map(sessionId => ({ sessionId, idle: true, agentState: 'idle' })) };
    default: throw new Error('unexpected endpoint');
  }
}
const server = createServer(async (req, res) => {
  try {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const url = new URL(req.url, 'http://127.0.0.1');
    const record = { path: url.pathname, method: req.method, query: Object.fromEntries(url.searchParams),
      body: raw ? JSON.parse(raw) : undefined, headers: req.headers };
    assert.equal(req.headers['x-task-bridge-token'], expectedToken);
    if (record.body) assert.equal(req.headers['content-type'], 'application/json');
    requests.push(record);
    const response = responder ? await responder(record, res) : defaults(record);
    if (response === undefined) return;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(response));
  } catch (error) {
    mockFailure = error;
    res.statusCode = 500;
    res.end(JSON.stringify({ ok: false, code: 'upstream-error', error: 'mock assertion failed' }));
  }
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${server.address().port}`;
const env = { TASK_BRIDGE_URL: base, TASK_BRIDGE_TOKEN: fake };
let passed = 0;
async function check(name, fn) {
  requests = []; responder = undefined; expectedToken = fake; mockFailure = undefined;
  await fn();
  if (mockFailure) throw mockFailure;
  passed++;
  console.log(`ok ${passed} - ${name}`);
}
async function invoke(args, options = {}) {
  let stdout = '', stderr = '';
  const code = await run(args, { env, home: scratch, ...options,
    stdout: { write: s => { stdout += s; } }, stderr: { write: s => { stderr += s; } } });
  assert.equal((stdout + stderr).includes(expectedToken), false, 'credential must not be echoed');
  return { code, stdout, stderr, data: args.includes('--json') ? JSON.parse(stdout) : undefined };
}
async function child(args) {
  const childEnv = { ...process.env, ...env, TASK_BRIDGE_TOKEN_FILE: join(scratch, 'unused') };
  const processChild = spawn(process.execPath, [cli, ...args], { env: childEnv, windowsHide: true });
  let stdout = '', stderr = '';
  processChild.stdout.on('data', b => { stdout += b; });
  processChild.stderr.on('data', b => { stderr += b; });
  const [code] = await once(processChild, 'close');
  return { code, stdout, stderr };
}

try {
  await check('完整 ID 直通且 progress --json 保留信封', async () => {
    const r = await invoke(['progress', id, '--json']);
    assert.equal(r.code, 0); assert.equal(r.data.sessionId, id); assert.deepEqual(r.data.recent, recent);
    assert.equal(requests.length, 1);
    assert.deepEqual([requests[0].method, requests[0].path, requests[0].query], ['GET', '/v1/progress', { sessionId: id }]);
  });
  await check('8 位短 ID 使用 limit=500；标题/team 忽略大小写', async () => {
    for (const query of ['12345678', 'ALPHA']) {
      const r = await invoke(['progress', query, '--json']);
      assert.equal(r.data.sessionId, id);
    }
    assert.deepEqual(requests[0].query, { limit: '500' });
    assert.equal((await invoke(['send', 'WAVE', '不应投递', '--json'])).code, 3);
    assert.equal(requests.some(r => r.path === '/v1/send'), false);
  });
  await check('歧义候选与真实子进程退出 3；零命中退 1', async () => {
    const r = await child(['progress', '编排', '--json']);
    assert.equal(r.code, 3); assert.equal(JSON.parse(r.stdout).candidates.length, 2);
    const human = await invoke(['progress', '编排']);
    assert.match(human.stderr, /shortId \| title \| team \| status/); assert.ok(human.stderr.includes(id2));
    const none = await invoke(['progress', '不存在', '--json']);
    assert.equal(none.code, 1); assert.match(none.data.advice, /dshq list/);
  });
  await check('短 ID 碰撞及截断列表不允许假定唯一目标', async () => {
    responder = req => req.path === '/v1/list' ? { ok: true, tasks: [tasks[0], { ...tasks[1], shortId: '12345678' }], truncated: false } : defaults(req);
    assert.equal((await invoke(['send', '12345678', 'x', '--json'])).code, 3);
    responder = () => ({ ok: true, tasks: [tasks[0]], truncated: true });
    assert.equal((await invoke(['send', 'Alpha', 'x', '--json'])).data.code, 'incomplete-list');
    assert.equal(requests.some(r => r.path === '/v1/send'), false);
  });
  await check('status：running / 假空闲 / 24h 统计', async () => {
    const r = await invoke(['status', '--json']);
    assert.equal(r.data.total, 3); assert.equal(r.data.active24h, 2);
    assert.equal(r.data.running.length, 1); assert.equal(r.data.pendingIdle[0].pendingTodos, 2);
    assert.deepEqual(requests[0].query, { limit: '500' });
  });
  await check('list 默认隐藏 blank、--all 及过滤请求形状', async () => {
    const r = await invoke(['list', '--team', 'wave', '--filter', '编排', '--ungrouped', '--json']);
    assert.equal(r.data.tasks.length, 2);
    assert.deepEqual(requests[0].query, { limit: '500', team: 'wave', filter: '编排', ungrouped: 'true' });
    assert.equal((await invoke(['--json', 'list', '--all'])).data.tasks.length, 3);
    assert.equal(requests[1].query.all, undefined);
  });
  await check('find 查询态列出全部候选而不执行操作', async () => {
    const r = await invoke(['find', 'wave', '--json']);
    assert.equal(r.code, 0); assert.equal(r.data.tasks.length, 2);
    assert.equal(requests.length, 1); assert.equal(requests[0].path, '/v1/list');
  });
  await check('reply 按 assistant 尾部条数筛选并保留截断提示', async () => {
    const r = await invoke(['reply', id, '--lines', '1', '--json']);
    assert.deepEqual(r.data.recent, [recent[2]]); assert.match(r.data.notes[0], /请 DSH 重发短回信/);
    const text = await invoke(['reply', id]);
    assert.ok(text.stdout.includes(recent[2].text)); assert.ok(!text.stdout.includes('不属于回信'));
    responder = req => ({ ...defaults(req), recent: [] });
    assert.match((await invoke(['reply', id])).stdout, /v0.24.1/);
    responder = req => ({ ...defaults(req), recent: [recent[1]] });
    assert.match((await invoke(['reply', id])).stdout, /没有 assistant/);
  });
  await check('spawn 所有选项的 wire 形状，无 reportBack', async () => {
    const r = await invoke(['spawn', '自包含任务', '--title', '探索｜测试', '--team', 'wave', '--cwd', 'D:/mock', '--model', 'provider/vendor/model', '--json']);
    assert.equal(r.data.sessionId, id);
    assert.equal(requests[0].method, 'POST'); assert.equal(requests[0].path, '/v1/spawn');
    assert.deepEqual(requests[0].body, { prompt: '自包含任务', title: '探索｜测试', team: 'wave', cwd: 'D:/mock', provider: 'provider', model: 'vendor/model' });
  });
  await check('send wire 字段必须是 text；queue/steer/reference 与补救文案', async () => {
    let r = await invoke(['send', id, '消息正文', '--reference', 'ref', '--steer', '--json']);
    assert.equal(r.code, 0);
    assert.deepEqual(requests[0].body, { sessionId: id, text: '消息正文', mode: 'steer', reference: 'ref' });
    assert.match(r.stderr, /深度 2 ≈ 2 轮/); assert.match(r.stderr, /延长当前回合/);
    r = await invoke(['send', id, '排队']);
    assert.equal(requests[1].body.mode, 'queue'); assert.equal(requests[1].body.message, undefined);
  });
  await check('models/version 使用 GET models，version 只显示 token 来源', async () => {
    assert.equal((await invoke(['models', '--json'])).data.providers[0].id, 'p');
    const r = await invoke(['version', '--json']);
    assert.equal(r.data.tokenSource, 'env:TASK_BRIDGE_TOKEN'); assert.equal(r.data.bridgeReachable, true);
    for (const req of requests) { assert.equal(req.path, '/v1/models'); assert.equal(req.method, 'GET'); assert.deepEqual(req.query, {}); }
  });
  await check('八个桥错误码映射退出 2、补救字段保留', async () => {
    const cases = [
      ['unauthorized', 401, /token/], ['forbidden-body', 413, /JSON/], ['bad-request', 405, /参数/],
      ['policy-gated', 429, /等待/], ['rate-limited', 429, /不自动重发/], ['queue-full', 429, /watch/],
      ['not-found', 404, /dshq list/], ['upstream-error', 503, /coordinator/],
    ];
    for (const [code, status, advice] of cases) {
      responder = (req, res) => { res.statusCode = status;
        return { ok: false, code, error: '合成桥错误', retryAfterMs: 1000, sessionId: id }; };
      const r = await invoke(['models', '--json']);
      assert.equal(r.code, 2); assert.equal(r.data.code, code); assert.equal(r.data.httpStatus, status);
      assert.match(r.data.advice, advice); assert.equal(r.data.sessionId, id);
    }
    assert.equal((await child(['models', '--json'])).code, 2);
  });
  await check('token 三来源及优先级；同一 Client 每请求重读文件', async () => {
    await mkdir(join(scratch, '.dsh'), { recursive: true });
    const tokenFile = join(scratch, 'explicit-token');
    await writeFile(tokenFile, 'FAKE-file-one');
    await writeFile(join(scratch, '.dsh', 'task-bridge-token'), 'FAKE-default');
    let r = await invoke(['version', '--json'], { env: { ...env, TASK_BRIDGE_TOKEN_FILE: tokenFile } });
    assert.equal(r.data.tokenSource, 'env:TASK_BRIDGE_TOKEN');
    expectedToken = 'FAKE-file-one';
    r = await invoke(['version', '--json'], { env: { TASK_BRIDGE_URL: base, TASK_BRIDGE_TOKEN_FILE: tokenFile } });
    assert.equal(r.data.tokenSource, 'env:TASK_BRIDGE_TOKEN_FILE');
    const client = new Client({ base, env: { TASK_BRIDGE_TOKEN_FILE: tokenFile }, home: scratch });
    await client.request('/v1/models');
    await writeFile(tokenFile, 'FAKE-file-two'); expectedToken = 'FAKE-file-two';
    await client.request('/v1/models');
    expectedToken = 'FAKE-default';
    r = await invoke(['version', '--json'], { env: { TASK_BRIDGE_URL: base } });
    assert.equal(r.data.tokenSource, 'default-file');
    const missing = await invoke(['version', '--json'], { env: { TASK_BRIDGE_URL: base, TASK_BRIDGE_TOKEN_FILE: join(scratch, 'missing') } });
    assert.equal(missing.code, 1); assert.equal(missing.data.code, 'token-missing');
  });
  await check('watch all/any、全 ID 回显、单次≤50s、末尾拉结果', async () => {
    const r = await invoke(['watch', id, id2, '--mode', 'any', '--until-idle', '--json']);
    assert.equal(r.data.settled, true); assert.equal(r.data.progress.length, 2);
    assert.deepEqual(requests[0].query, { sessionIds: `${id},${id2}`, mode: 'any', timeoutMs: '45000' });
    assert.equal(requests.filter(r => r.path === '/v1/progress').length, 2);
    assert.match(r.stderr, /心跳 1/);
    await invoke(['watch', id, '--timeout', '90000', '--json']);
    assert.ok(Number(requests.findLast(r => r.path === '/v1/wait').query.timeoutMs) <= 50000);
  });
  await check('watch false 心跳后 settled；spawn --watch 联动', async () => {
    let waits = 0;
    responder = req => req.path === '/v1/wait' ? { ...defaults(req), settled: ++waits > 1 } : defaults(req);
    const r = await invoke(['spawn', '一句话', '--watch', '--json']);
    assert.equal(r.data.spawn.sessionId, id); assert.equal(r.data.watch.rounds, 2);
    assert.match(r.stderr, /settled=false/); assert.match(r.stderr, /settled=true/);
    assert.deepEqual(requests.map(r => r.path), ['/v1/spawn', '/v1/wait', '/v1/wait', '/v1/progress']);
  });
  await check('watch 预算耗尽退 1，保留最新 progress，非桥错误', async () => {
    responder = req => req.path === '/v1/wait' ? { ...defaults(req), settled: false } : defaults(req);
    const r = await invoke(['watch', id, '--max-min', '0.001', '--json']);
    assert.equal(r.code, 1); assert.equal(r.data.code, 'watch-timeout'); assert.equal(r.data.timedOut, true);
    assert.equal(r.data.progress[0].sessionId, id); assert.ok(Number(requests[0].query.timeoutMs) <= 60);
  });
  await check('policy-gated 自动重试上限 3 次，rate-limited 不重试', async () => {
    let calls = 0;
    responder = req => ++calls <= 3 ? { ok: false, code: 'policy-gated', error: '测试限额', retryAfterMs: 1 } : defaults(req);
    assert.equal((await invoke(['spawn', 'x', '--auto-retry', '--json'])).code, 0); assert.equal(calls, 4);
    calls = 0;
    responder = () => { calls++; return { ok: false, code: 'policy-gated', error: '测试限额', retryAfterMs: 1 }; };
    assert.equal((await invoke(['spawn', 'x', '--auto-retry', '--json'])).code, 2); assert.equal(calls, 4);
    calls = 0;
    responder = () => { calls++; return { ok: false, code: 'rate-limited', error: '测试限频', retryAfterMs: 1 }; };
    assert.equal((await invoke(['spawn', 'x', '--auto-retry', '--json'])).code, 2); assert.equal(calls, 1);
  });
  await check('本地参数错误不发请求；global JSON；--base 优先于 env', async () => {
    for (const args of [['send', id], ['reply', id, '--lines', '0'], ['watch', id, '--mode', 'bad'],
      ['spawn', 'x', '--model', 'bad'], ['status', '--token', 'FAKE-no-argv'], ['status', '--watch'], ['status', '--timeout', '-1']]) {
      assert.equal((await invoke([...args, '--json'])).code, 1);
    }
    assert.equal(requests.length, 0);
    assert.equal((await invoke(['--json', '--base', base, 'version'], { env: { ...env, TASK_BRIDGE_URL: 'http://invalid' } })).code, 0);
    assert.equal((await child(['--help'])).code, 0);
  });
  await check('输出脱敏覆盖成功、桥错误、原始坏响应与重定向', async () => {
    responder = () => ({ ok: true, echo: fake, nested: { hex: 'a'.repeat(64) } });
    let r = await invoke(['models', '--json']); assert.equal(r.data.echo, '[REDACTED]');
    assert.equal(r.data.nested.hex, '[REDACTED-64HEX]');
    responder = () => ({ ok: false, code: 'upstream-error', error: fake, detail: fake });
    r = await invoke(['models', '--json']); assert.equal(r.code, 2); assert.equal(r.data.detail, '[REDACTED]');
    responder = (req, res) => { res.end(fake); };
    assert.equal((await invoke(['models', '--json'])).data.code, 'bridge-invalid-response');
    responder = (req, res) => { res.writeHead(302, { location: '/unexpected' }); res.end(); };
    const before = requests.length;
    assert.equal((await invoke(['models', '--json'])).code, 1); assert.equal(requests.length, before + 1);
  });
  await check('请求超时覆盖响应 body 阶段；网络失败退出 1', async () => {
    responder = (req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.write('{'); };
    assert.equal((await invoke(['models', '--timeout', '50', '--json'])).data.code, 'bridge-timeout');
    const offline = createServer(); offline.listen(0, '127.0.0.1'); await once(offline, 'listening');
    const port = offline.address().port; await new Promise(resolve => offline.close(resolve));
    assert.equal((await invoke(['version', '--base', `http://127.0.0.1:${port}`, '--json'])).data.code, 'bridge-unreachable');
    assert.equal((await invoke(['version', '--base', 'http://example.com', '--json'])).code, 1);
  });
  console.log(`PASS ${passed} offline smoke checks`);
} finally {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  // Only remove the unique directory just created beneath the verified scratch parent.
  if (!resolve(scratch).startsWith(scratchParent + '\\') && !resolve(scratch).startsWith(scratchParent + '/')) {
    throw new Error('scratch cleanup containment failed');
  }
  await rm(scratch, { recursive: true, force: true });
}
