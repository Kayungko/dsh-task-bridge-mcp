import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { BridgeClient } from '../src/client.mjs';
import { Client } from '../cli/lib/client.mjs';
import { TOOLS, INSTRUCTIONS } from '../src/tools.mjs';
import { handleRpcMessage } from '../src/server.mjs';

const fake = 'FAKE-TOKEN-improvements';
async function serve(t, handler) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  return `http://127.0.0.1:${server.address().port}`;
}
test('both transports reject unsafe destinations before looking up credentials', async () => {
  for (const base of ['https://example.invalid', 'http://user:secret@localhost', 'http://localhost/?x=1', 'file:///tmp']) {
    let reads = 0;
    await assert.rejects(async () => {
      const client = new BridgeClient({ baseUrl: base, resolveTokenFn: () => { reads++; return fake; } });
      await client.request('GET', '/v1/models');
    }, error => error.code === 'invalid-params');
    const cli = new Client({ base, env: {} });
    cli.token = async () => { reads++; return { value: fake }; };
    await assert.rejects(cli.request('/v1/models'), error => error.payload.code === 'invalid-params');
    assert.equal(reads, 0);
  }
});
test('both transports refuse redirects without sending credentials to the destination', async t => {
  let destinationRequests = 0;
  const target = await serve(t, (_q, r) => { destinationRequests++; r.end('{"ok":true}'); });
  const base = await serve(t, (_q, r) => { r.writeHead(302, { location: target + '/v1/models' }); r.end(); });
  await assert.rejects(new BridgeClient({ baseUrl: base, env: { TASK_BRIDGE_TOKEN: fake } }).request('GET', '/v1/models'));
  await assert.rejects(new Client({ base, env: { TASK_BRIDGE_TOKEN: fake } }).request('/v1/models'));
  assert.equal(destinationRequests, 0);
});
test('body stalls are timed out after headers on both surfaces', async t => {
  const base = await serve(t, (_q, r) => { r.writeHead(200, { 'content-type': 'application/json' }); r.flushHeaders(); r.write('{'); });
  await assert.rejects(new BridgeClient({ baseUrl: base, env: { TASK_BRIDGE_TOKEN: fake }, defaultTimeoutMs: 40 }).request('GET', '/v1/models'), e => e.code === 'bridge-timeout');
  await assert.rejects(new Client({ base, env: { TASK_BRIDGE_TOKEN: fake }, timeout: 40 }).request('/v1/models'), e => e.payload.code === 'bridge-timeout');
});
test('raw error bodies and echoed credentials never become MCP output', async t => {
  const base = await serve(t, (q, r) => {
    if (q.url.includes('models')) r.end(JSON.stringify({ ok: false, code: 'upstream-error', error: fake, detail: { secret: fake } }));
    else { r.writeHead(500); r.end('PRIVATE-RAW-' + fake); }
  });
  const ctx = { client: new BridgeClient({ baseUrl: base, env: { TASK_BRIDGE_TOKEN: fake } }) };
  for (const name of ['dsh_task_models', 'dsh_task_list']) {
    const response = await handleRpcMessage({ id: 1, method: 'tools/call', params: { name } }, ctx);
    assert.equal(response.result.isError, true);
    assert.equal(response.result.structuredContent.ok, false);
    assert.doesNotMatch(JSON.stringify(response), /FAKE-TOKEN-improvements|PRIVATE-RAW/);
  }
});
test('spawn ref and progress cursor survive MCP mapping, invalid ref fails before dispatch', async () => {
  const seen = [];
  const client = { request: async (method, path, options) => { seen.push({ method, path, options }); return { ok: true }; } };
  const spawn = TOOLS.find(t => t.name === 'dsh_task_spawn');
  await spawn.handler(client, { prompt: 'offline', externalRef: ' ref:wave ' });
  assert.equal(seen[0].options.body.externalRef, 'ref:wave');
  for (const ref of [42, 'x'.repeat(201)]) await assert.rejects(spawn.handler(client, { prompt: 'offline', externalRef: ref }));
  assert.equal(seen.length, 1);
  await TOOLS.find(t => t.name === 'dsh_task_progress').handler(client, { sessionId: 's', cursor: 'abc', messageId: 'm' });
  assert.deepEqual(seen[1].options.query, { sessionId: 's', cursor: 'abc', messageId: 'm' });
});
test('MCP cancellation aborts only the corresponding in-flight request', async () => {
  const signals = [];
  const ctx = { client: { request: async (_m, _p, options) => {
    signals.push(options.signal);
    await new Promise(resolve => options.signal.addEventListener('abort', resolve, { once: true }));
    return { ok: true };
  } } };
  const pending = handleRpcMessage({ id: 3, method: 'tools/call', params: { name: 'dsh_task_wait', arguments: { sessionIds: ['s'] } } }, ctx);
  handleRpcMessage({ method: 'notifications/cancelled', params: { requestId: 4 } }, ctx);
  assert.equal(signals[0].aborted, false);
  handleRpcMessage({ method: 'notifications/cancelled', params: { requestId: 3 } }, ctx);
  await pending;
  assert.equal(signals[0].aborted, true);
  assert.equal(ctx.requests.size, 0);
});
test('discovery marks reads and writes accurately; routing guidance is self-contained', () => {
  const discovered = handleRpcMessage({ id: 1, method: 'tools/list' }, {}).result.tools;
  for (const tool of discovered) assert.equal(tool.annotations.readOnlyHint, !['dsh_task_spawn', 'dsh_task_send'].includes(tool.name));
  assert.ok(discovered.some(t => t.name === 'dsh_task_capabilities'));
  for (const word of ['授权', 'cwd', 'externalRef', 'settled', '对账']) assert.ok(INSTRUCTIONS.slice(0, 512).includes(word));
});
