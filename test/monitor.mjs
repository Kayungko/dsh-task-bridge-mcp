import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { Monitor } from '../cli/lib/monitor.mjs';
import { Store } from '../cli/lib/store.mjs';
import { run, parse } from '../cli/lib/run.mjs';
import { CliError } from '../cli/lib/errors.mjs';
import http from 'node:http';

const id = 'session-one';
const message = n => ({ role: 'assistant', text: `result ${n}`, seq: n, messageId: `m-${n}`, truncated: false });
const progress = (seq = 0, messages = [], state = 'running', coverage = 'complete') => ({ ok: true, sessionId: id,
  seq, agentState: state, todos: [], feedback: { messages, coverage, hasMore: false, nextCursor: `cursor-${seq}` } });
async function setup(t) {
  const home = await fs.mkdtemp(join(tmpdir(), 'monitor-test-'));
  t.after(async () => {
    if (!resolve(home).startsWith(resolve(tmpdir()) + sep)) throw Error('unsafe test cleanup');
    await fs.rm(home, { recursive: true, force: true });
  });
  let time = 1000000, current = progress();
  const calls = [];
  const client = { timeout: 1000, async request(path, options) {
    calls.push({ path, options });
    if (path === '/v1/capabilities') return { ok: true, coordinatorEnabled: true, capabilities: { progressCursor: true } };
    assert.equal(path, '/v1/progress', 'monitor must never send/spawn or call a model');
    if (current instanceof Error) throw current;
    return typeof current === 'function' ? current(path, options) : current;
  } };
  const store = new Store({ home });
  const make = (owner = 'thread-a') => new Monitor({ store, owner, name: 'wave', now: () => time });
  return { home, store, make, client, calls, set: value => { current = value; }, advance: ms => { time += ms; } };
}

test('persistent baseline, incremental cursor and replay dedup survive monitor restarts', async t => {
  const h = await setup(t);
  await h.make().run(h.client, [id], { once: true });
  assert.equal((await h.make().read()).count, 0);
  h.set(progress(1, [message(1)]));
  await h.make().run(h.client, [], { once: true });
  assert.equal(h.calls.at(-1).options.query.cursor, 'cursor-0');
  const first = await h.make().read();
  assert.equal(first.count, 1);
  assert.equal(first.entries[0].summary.text, 'result 1');
  assert.equal((await h.make().read()).count, 1, 'read must not ack');
  await h.make().ack([first.entries[0].id]);
  await h.make().run(h.client, [], { once: true }); // deliberately replay same message/cursor
  assert.equal((await h.make().read()).count, 0);
});
test('merged summaries get new identities; stale acknowledgments cannot clear newer events', async t => {
  const h = await setup(t), m = h.make();
  await m.run(h.client, [id], { once: true });
  h.set(progress(1, [message(1)])); await m.run(h.client, [], { once: true });
  const old = (await m.read()).entries[0];
  h.set(progress(2, [message(2)], 'idle')); await m.run(h.client, [], { once: true });
  const latest = (await m.read()).entries[0];
  assert.notEqual(latest.id, old.id);
  assert.equal(latest.messageCount, 2);
  assert.deepEqual(latest.reasons, ['feedback', 'idle']);
  await assert.rejects(m.ack([old.id]), e => e.payload.code === 'monitor-ack-stale');
  assert.equal((await m.read()).entries[0].id, latest.id);
  await m.ack([latest.id]);
  assert.equal((await m.read()).count, 0);
});
test('owner and target scope are isolated and damaged state is never overwritten', async t => {
  const h = await setup(t), m = h.make();
  await m.run(h.client, [id], { once: true });
  await assert.rejects(h.make('thread-b').read(), e => e.payload.code === 'monitor-not-found');
  await assert.rejects(m.run(h.client, ['session-other'], { once: true }), e => e.payload.code === 'monitor-target-mismatch');
  const path = join(h.store.root, m.file);
  await fs.writeFile(path, '{broken');
  await assert.rejects(m.run(h.client, [id], { once: true }), e => e.payload.code === 'local-state-error');
  assert.equal(await fs.readFile(path, 'utf8'), '{broken');
  assert.throws(() => new Monitor({ store: h.store, name: 'wave' }), e => e.payload.code === 'monitor-owner-missing');
  assert.throws(() => new Monitor({ store: h.store, owner: 'thread-a', name: '../bad' }));
});
test('errors and stalls alert once until recovery or progress, including after ack', async t => {
  const h = await setup(t), m = h.make();
  await m.run(h.client, [id], { once: true });
  h.advance(60000); await m.run(h.client, [], { once: true, staleMs: 60000 });
  let entry = (await m.read()).entries[0];
  assert.deepEqual(entry.reasons, ['stalled']); await m.ack([entry.id]);
  h.advance(60000); await m.run(h.client, [], { once: true, staleMs: 60000 });
  assert.equal((await m.read()).count, 0);
  h.set(new CliError('bridge-unreachable', 'PRIVATE-ERROR'));
  await m.run(h.client, [], { once: true }); entry = (await m.read()).entries[0];
  assert.equal(entry.state, 'unknown');
  assert.doesNotMatch(JSON.stringify(entry), /PRIVATE-ERROR/);
  await m.ack([entry.id]); await m.run(h.client, [], { once: true });
  assert.equal((await m.read()).count, 0);
  h.set(progress(1)); await m.run(h.client, [], { once: true });
  assert.ok((await m.read()).entries[0].reasons.includes('recovered'));
});
test('a bounded multi-cycle monitor stays quiet and stops on a local stop request', async t => {
  const h = await setup(t), m = h.make(); let ticks = 0;
  const result = await m.run(h.client, [id], { intervalMs: 10000, maxMinutes: 20,
    pause: async ms => { h.advance(ms); if (++ticks === 15) await m.stop(); } });
  assert.equal(result.exit, 'stopped');
  assert.equal(result.cycles, 15);
  assert.equal((await m.read()).count, 0);
  assert.equal((await m.status()).runner, 'not-leased');
  assert.equal(h.calls.filter(c => c.path === '/v1/capabilities').length, 1);
});
test('active lease rejects duplicate runners; failed writes preserve unacknowledged data', async t => {
  const h = await setup(t), m = h.make();
  let started, release;
  const entered = new Promise(resolve => { started = resolve; });
  h.set(async () => { started(); await new Promise(resolve => { release = resolve; }); return progress(1, [message(1)], 'idle'); });
  const first = m.run(h.client, [id], { once: true }); await entered;
  await assert.rejects(h.make().run(h.client, [id], { once: true }), e => e.payload.code === 'monitor-busy');
  release(); await first;
  const pending = (await m.read()).entries[0];
  const faulty = new Monitor({ owner: 'thread-a', name: 'wave', store: new Store({ home: h.home,
    io: { ...fs, rename: async () => { throw Error('write failure'); } } }) });
  await assert.rejects(faulty.ack([pending.id]), e => e.payload.code === 'local-state-error');
  assert.equal((await m.read()).entries[0].id, pending.id);
});
test('unavailable capabilities do not create state or use legacy whole-history polling', async t => {
  const h = await setup(t), m = h.make(); let requests = 0;
  await assert.rejects(m.run({ request: async () => { requests++; return { coordinatorEnabled: true, capabilities: {} }; } }, [id], { once: true }),
    e => e.payload.code === 'monitor-capability-unavailable');
  assert.equal(requests, 1);
  assert.equal(await m.load(false), null);
});
test('transient replacement retries are bounded; failed event commits do not advance the cursor', async t => {
  const h = await setup(t);
  let renames = 0;
  const retrying = new Store({ home: h.home, io: { ...fs, rename: async (...args) => {
    if (++renames < 3) { const error = new Error('busy'); error.code = 'EBUSY'; throw error; }
    return fs.rename(...args);
  } } });
  await retrying.atomic('retry-probe.json', '{}');
  assert.equal(renames, 3);
  renames = 0;
  const broken = new Monitor({ owner: 'thread-a', name: 'wave', store: new Store({ home: h.home,
    io: { ...fs, rename: async (...args) => {
      if (++renames === 4) throw Error('failed event transaction');
      return fs.rename(...args);
    } } }) });
  h.set(progress(1, [message(1)], 'idle'));
  await assert.rejects(broken.run(h.client, [id], { once: true }), e => e.payload.code === 'local-state-error');
  const preserved = await h.make().load();
  assert.equal(preserved.targets[0].cursor, null);
  assert.equal(preserved.pending.length, 0);
  await h.make().run(h.client, [], { once: true });
  assert.equal((await h.make().read()).entries[0].summary.text, 'result 1');
});
test('batch results are compact, unread pagination is explicit, and missing feedback remains unknown', async t => {
  const h = await setup(t), m = h.make();
  const ids = ['session-one', 'session-two'];
  h.set((_path, options) => ({ ...progress(1, [message(1)], 'idle'), sessionId: options.query.sessionId }));
  await m.run(h.client, ids, { once: true });
  const read = await m.read(1);
  assert.equal(read.count, 2); assert.equal(read.remaining, 1);
  await m.ack([read.entries[0].id]);
  assert.equal((await m.read()).count, 1);
  h.set((_path, options) => ({ ...progress(1, [], 'running', 'unavailable'), sessionId: options.query.sessionId,
    feedback: { messages: [], nextCursor: null, hasMore: false, coverage: 'unavailable' } }));
  await m.run(h.client, ids, { once: true });
  assert.ok((await m.read()).entries.every(e => e.coverage === 'unavailable'));
  const after = (await m.read()).entries.map(e => e.id); await m.ack(after);
  await m.run(h.client, ids, { once: true });
  assert.equal((await m.read()).count, 0);
});
test('CLI is silent until its final receipt; read/ack/status operate offline without implicit writes', async t => {
  const h = await setup(t); let requests = 0;
  const server = http.createServer((req, res) => {
    requests++; assert.equal(req.method, 'GET');
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(req.url === '/v1/capabilities' ? { ok: true, coordinatorEnabled: true, capabilities: { progressCursor: true } } : progress(1, [message(1)], 'idle')));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const env = { CODEX_THREAD_ID: 'thread-cli', TASK_BRIDGE_TOKEN: 'FAKE-MONITOR-TOKEN', TASK_BRIDGE_URL: `http://127.0.0.1:${server.address().port}` };
  const invoke = async args => {
    let out = '', err = '';
    const code = await run([...args, '--json'], { env, home: h.home, stdout: { write: s => { out += s; } }, stderr: { write: s => { err += s; } } });
    assert.equal(err, ''); assert.equal(out.trim().split('\n').length, 1);
    return { code, data: JSON.parse(out) };
  };
  const result = await invoke(['monitor','run','wave',id,'--once']);
  assert.equal(result.code, 0); assert.equal(result.data.pendingCount, 1);
  const networkCount = requests;
  const read = await invoke(['monitor','read','wave']);
  assert.equal(read.data.count, 1);
  await invoke(['monitor','ack','wave',read.data.entries[0].id]);
  assert.equal((await invoke(['monitor','read','wave'])).data.count, 0);
  assert.equal((await invoke(['monitor','status','wave'])).data.runner, 'not-leased');
  assert.equal(requests, networkCount);
  assert.throws(() => parse(['monitor','ack','wave']));
  assert.throws(() => parse(['monitor','read','wave','--once']));
});
