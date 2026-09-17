import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { Store } from '../cli/lib/store.mjs';
import { Workflow, sendWorkflow } from '../cli/lib/workflow.mjs';
import { pollWorkflow } from '../cli/lib/workflow-adapter.mjs';
import { run } from '../cli/lib/run.mjs';

const owner = { platform: 'codex', hostId: 'local', sessionId: 'controller-a' };
const observer = { ...owner, sessionId: 'observer-a' };
const worker = { id: 'worker', platform: 'dsh', hostId: 'host-a', sessionId: 'session-worker', baseUrl: 'http://127.0.0.1:43120', epoch: 1, cursor: null };
const proof = [{ ref: 'artifact:report', version: 'revision-1' }];
const item = (id, extra = {}) => ({ id, title: id, kind: 'document', action: 'review', resource: 'project-a', subjectVersion: 'v1',
  bindingId: 'worker', dependsOn: [], completion: 'evidence', ...extra });
async function setup(t, mode = 'managed') {
  const home = await fs.mkdtemp(join(tmpdir(), 'workflow-'));
  t.after(async () => { assert.ok(resolve(home).startsWith(resolve(tmpdir()) + sep)); await fs.rm(home, { recursive: true, force: true }); });
  let now = 1000000;
  const store = new Store({ home });
  const make = (principal = owner) => new Workflow({ store, actor: principal, workflowId: 'workflow-one', now: () => now });
  const w = make();
  await w.create({ title: 'Generic workflow', observers: [observer], bindings: [worker] });
  const policy = { revision: 2, mode, actions: ['review', 'send'], resources: ['project-a'], bindings: ['worker'],
    expiresAt: now + 1000000, authorizationRef: 'user:approved-scope', maxConcurrent: 2, maxAttempts: 10, maxEffects: 30 };
  await w.configure({ expectedPolicyRevision: 1, policy });
  return { home, store, w, make, policy, advance: ms => { now += ms; } };
}
const claim = async (w, id, revision = 1) => (await w.claim({ itemId: id, revision, leaseMs: 30000 })).run;
const finish = (w, r, outcome = 'accepted', more = {}) => w.finish({ runId: r.id, claimId: r.claimId, outcome, evidence: proof, handoffEffectId: null, ...more });
const sendInput = (r, extra = {}) => ({ runId: r.id, claimId: r.claimId, operationId: 'op-1', purpose: 'handoff', text: 'bounded result', mode: 'queue', ...extra });
const reported = (id, sourceEventId, extra = {}) => ({ sourceEventId, bindingId: 'worker', bindingEpoch: 1, itemId: id, itemRevision: 1,
  kind: 'review_requested', summary: 'please review', evidence: proof, subjectVersion: 'v2', ...extra });

test('two independent work items in one session survive notice acknowledgment and restart', async t => {
  const { w, make } = await setup(t);
  await w.add(item('a')); await w.add(item('b'));
  await w.ingest(reported('a', 'source-a')); await w.ingest(reported('b', 'source-b'));
  const notices = await w.notices(); await w.markNotices({ eventIds: notices.events.map(e => e.id) });
  assert.equal((await make().notices()).count, 0);
  assert.equal((await make().next()).readyCount, 2);
  assert.deepEqual((await w.status()).items.map(i => i.status), ['ready', 'ready']);
});
test('notification cursors are per observer; a second controller cannot claim work', async t => {
  const { w, make } = await setup(t); await w.add(item('a'));
  const view = make(observer); const notices = await view.notices(); await view.markNotices({ eventIds: notices.events.map(e => e.id) });
  assert.equal((await view.notices()).count, 0); assert.ok((await w.notices()).count > 0);
  assert.equal((await view.next()).items[0].hold, 'observer');
  await assert.rejects(claim(view, 'a'), e => e.payload.code === 'workflow-controller-required');
  await assert.rejects(make({ ...owner, hostId: 'other-host' }).status());
});
test('observe mode never executes, assist needs a version-bound approval, managed stays within resources', async t => {
  const { w, policy } = await setup(t, 'observe'); await w.add(item('a'));
  await assert.rejects(claim(w, 'a'), e => e.payload.code === 'workflow-authorization-required');
  await w.configure({ expectedPolicyRevision: 2, policy: { ...policy, revision: 3, mode: 'assist' } });
  await assert.rejects(claim(w, 'a'), e => e.payload.code === 'workflow-item-approval-required');
  await w.approve({ itemId: 'a', revision: 1, authorizationRef: 'user:item-a', expiresAt: policy.expiresAt });
  await finish(w, await claim(w, 'a'));
  await w.revise({ itemId: 'a', revision: 1, subjectVersion: 'v2', evidence: proof });
  await assert.rejects(claim(w, 'a', 2), e => e.payload.code === 'workflow-item-approval-required');
  await w.add(item('foreign', { resource: 'project-b' }));
  await w.configure({ expectedPolicyRevision: 3, policy: { ...policy, revision: 4 } });
  await assert.rejects(claim(w, 'foreign'), e => e.payload.code === 'workflow-authorization-required');
});
test('dependency completion gates work; documents need evidence but no Git or build fields', async t => {
  const { w } = await setup(t); await w.add(item('draft')); await w.add(item('publish-report', { dependsOn: ['draft'], bindingId: null }));
  assert.equal((await w.next()).items.find(i => i.id === 'publish-report').hold, 'dependency');
  await assert.rejects(claim(w, 'publish-report'));
  const r = await claim(w, 'draft'); await assert.rejects(finish(w, r, 'accepted', { evidence: [] }));
  await finish(w, r); await finish(w, await claim(w, 'publish-report'));
  assert.equal((await w.next()).readyCount, 0);
  assert.ok((await w.status()).items.every(i => i.status === 'completed'));
});
test('review rejection waits; replay or late old-revision reports do not retrigger work', async t => {
  const { w } = await setup(t); await w.add(item('review'));
  await finish(w, await claim(w, 'review'), 'needs_changes');
  assert.equal((await w.next()).items[0].hold, 'waiting');
  const event = reported('review', 'fix-v2'); const first = await w.ingest(event);
  assert.equal(first.itemRevision, 2); assert.equal((await w.next()).readyCount, 1);
  assert.equal((await w.ingest(event)).duplicate, true);
  await assert.rejects(w.ingest({ ...event, summary: 'different payload' }), e => e.payload.code === 'workflow-event-conflict');
  assert.equal((await w.ingest(reported('review', 'late-v1'))).stale, true);
  assert.equal((await w.status()).items[0].revision, 2);
  await assert.rejects(claim(w, 'review', 1), e => e.payload.code === 'workflow-stale-revision');
});
test('concurrent claims serialize and expired leases fence stale completions', async t => {
  const { w, make, advance } = await setup(t); await w.add(item('a'));
  const attempts = await Promise.allSettled([claim(w, 'a'), claim(make(), 'a')]);
  assert.equal(attempts.filter(r => r.status === 'fulfilled').length, 1);
  const old = attempts.find(r => r.status === 'fulfilled').value;
  advance(31000); const fresh = await claim(make(), 'a');
  await assert.rejects(finish(w, old), e => e.payload.code === 'workflow-stale-lease');
  await finish(w, fresh);
});
test('policy changes invalidate a claim before dispatch; handoff resets authority', async t => {
  const { w, make, policy } = await setup(t); await w.add(item('a')); const r = await claim(w, 'a');
  await w.prepareSend(sendInput(r));
  await w.configure({ expectedPolicyRevision: 2, policy: { ...policy, revision: 3, mode: 'observe', actions: [] } });
  let sends = 0;
  await assert.rejects(sendWorkflow(w, sendInput(r), () => ({ request: async () => { sends++; } })));
  assert.equal(sends, 0);
  const nextOwner = { ...owner, sessionId: 'controller-b' };
  await w.handoff({ expectedOwnerEpoch: 1, controller: nextOwner, authorizationRef: 'user:handoff' });
  await assert.rejects(w.status());
  assert.equal((await make(nextOwner).status()).policy.mode, 'observe');
});
test('rebind retains work identity but invalidates old source epoch and run', async t => {
  const { w } = await setup(t); await w.add(item('a')); const r = await claim(w, 'a');
  await w.rebind({ bindingId: 'worker', expectedEpoch: 1, binding: { ...worker, epoch: 2, sessionId: 'session-replacement' }, authorizationRef: 'user:move' });
  await assert.rejects(finish(w, r));
  assert.equal((await w.ingest(reported('a', 'late-source'))).stale, true);
  assert.equal((await w.status()).items[0].id, 'a');
  await w.resume({ itemId: 'a', revision: 1, reason: 'replacement verified' });
  assert.equal((await claim(w, 'a')).bindingEpoch, 2);
});
test('uncertain sends are durable, never retried, and require explicit reconciliation', async t => {
  const { w, make } = await setup(t); await w.add(item('a')); const r = await claim(w, 'a'); let sends = 0;
  const transport = () => ({ request: async () => { sends++; throw Error('response lost after server accepted'); } });
  await assert.rejects(sendWorkflow(w, sendInput(r), transport), e => e.payload.code === 'workflow-reconciliation-required');
  await assert.rejects(sendWorkflow(make(), sendInput(r), transport)); assert.equal(sends, 1);
  await assert.rejects(sendWorkflow(make(), sendInput(r, { operationId: 'another-id' }), transport)); assert.equal(sends, 1);
  await assert.rejects(finish(w, r));
  assert.deepEqual((await w.next()).unresolvedEffects, ['op-1']);
  await w.reconcile({ operationId: 'op-1', outcome: 'delivered', messageId: 'server-message-1', evidence: proof });
  await finish(w, r);
});
test('confirmed handoff receipt is required and a repeated send reuses its receipt', async t => {
  const { w } = await setup(t); await w.add(item('a', { completion: 'handoff' })); const r = await claim(w, 'a');
  await assert.rejects(finish(w, r)); let sends = 0;
  const transport = () => ({ request: async (path, options) => { sends++; assert.equal(path, '/v1/send'); assert.equal(options.body.reference, 'op-1'); return { delivered: true, targetId: worker.sessionId, messageId: 'message-1' }; } });
  await sendWorkflow(w, sendInput(r), transport);
  assert.equal((await sendWorkflow(w, sendInput(r), transport)).reused, true); assert.equal(sends, 1);
  await assert.rejects(sendWorkflow(w, sendInput(r, { text: 'different' }), transport), e => e.payload.code === 'workflow-operation-conflict');
  await finish(w, r, 'accepted', { handoffEffectId: 'op-1' });
});
test('expiry after sending does not schedule duplicate external work; local cancel is not remote cancel', async t => {
  const { w, advance } = await setup(t); await w.add(item('a')); const r = await claim(w, 'a');
  await sendWorkflow(w, sendInput(r), () => ({ request: async () => ({ delivered: true, targetId: worker.sessionId, messageId: 'm' }) }));
  advance(31000); assert.equal((await w.next()).readyCount, 0); await assert.rejects(claim(w, 'a'));
  const result = await w.cancel({ itemId: 'a', revision: 1, reason: 'user stopped workflow' });
  assert.equal(result.externalWorkCancelled, false); assert.equal((await w.status()).items[0].status, 'cancelled');
});
test('delivery remains factual after in-flight revocation, but cannot complete revoked work', async t => {
  const { w, policy } = await setup(t); await w.add(item('a')); const r = await claim(w, 'a');
  await sendWorkflow(w, sendInput(r), () => ({ request: async () => {
    await w.configure({ expectedPolicyRevision: 2, policy: { ...policy, revision: 3, mode: 'observe', actions: [] } });
    return { delivered: true, targetId: worker.sessionId, messageId: 'm' };
  } }));
  const status = await w.status(); assert.equal(status.effects[0].status, 'delivered'); assert.equal(status.items[0].status, 'blocked');
  await assert.rejects(finish(w, r));
});
test('poll preserves distinct observations and atomically stores its cursor without creating work', async t => {
  const { w } = await setup(t); const requests = [];
  const transport = () => ({ request: async (path, options) => {
    requests.push(path); if (path === '/v1/capabilities') return { coordinatorEnabled: true, capabilities: { progressCursor: true } };
    assert.equal(options.query.sessionId, worker.sessionId);
    return { sessionId: worker.sessionId, feedback: { coverage: 'complete', nextCursor: 'after-2', hasMore: false,
      messages: options.query.cursor ? [] : [{ seq: 1, role: 'assistant', text: 'A needs review' }, { seq: 2, role: 'assistant', text: 'B is progressing' }] } };
  } });
  assert.equal((await pollWorkflow(w, transport)).complete, true);
  assert.equal((await w.status()).items.length, 0);
  const notices = await w.notices(); assert.equal(notices.events.filter(e => e.type === 'observation').length, 2);
  await w.markNotices({ eventIds: notices.events.map(e => e.id) });
  await pollWorkflow(w, transport); assert.equal((await w.notices()).count, 0);
  assert.ok(requests.every(p => ['/v1/progress', '/v1/capabilities'].includes(p)));
});
test('strict inputs, damaged state, failed writes and capacity budgets never produce green work', async t => {
  const { w, store, home, policy } = await setup(t);
  await assert.rejects(w.add({ ...item('a'), unexpected: true }));
  await assert.rejects(w.add(item('a', { dependsOn: ['missing'] })));
  await w.add(item('a'));
  const path = join(store.root, w.file), original = await fs.readFile(path, 'utf8');
  const faulty = new Workflow({ store: new Store({ home, io: { ...fs, rename: async () => { throw Error('disk failure'); } } }), actor: owner, workflowId: w.workflowId });
  await assert.rejects(faulty.add(item('b'))); assert.equal(await fs.readFile(path, 'utf8'), original);
  await w.configure({ expectedPolicyRevision: 2, policy: { ...policy, revision: 3, maxConcurrent: 1, maxAttempts: 1 } });
  const r = await claim(w, 'a'); await w.add(item('b')); await assert.rejects(claim(w, 'b'), e => e.payload.code === 'workflow-budget');
  await finish(w, r, 'failed'); await w.resume({ itemId: 'a', revision: 1, reason: 'checked issue' });
  await assert.rejects(claim(w, 'a'), e => e.payload.code === 'workflow-budget');
  await fs.writeFile(path, '{broken'); await assert.rejects(w.add(item('c'))); assert.equal(await fs.readFile(path, 'utf8'), '{broken');
});
test('CLI supports a generic offline workflow and refuses ambient endpoint substitution', async t => {
  const { home } = await setup(t); let index = 0;
  const invoke = async (args, input) => {
    if (input) { const file = join(home, `input-${++index}.json`); await fs.writeFile(file, JSON.stringify(input)); args = [...args, '--input-file', file]; }
    let out = '', err = ''; const code = await run([...args, '--owner', 'cli-controller', '--json'], { home, env: {}, stdout: { write: v => { out += v; } }, stderr: { write: v => { err += v; } } });
    assert.equal(err, ''); return { code, data: JSON.parse(out) };
  };
  const created = await invoke(['workflow', 'create'], { title: 'Research without a repository', observers: [], bindings: [] });
  assert.equal(created.code, 0); const id = created.data.workflowId;
  await invoke(['workflow', 'add', id], item('research', { bindingId: null, resource: 'research-topic' }));
  const next = await invoke(['workflow', 'next', id]); assert.equal(next.data.readyCount, 0); assert.equal(next.data.items[0].hold, 'authorization-required');
  assert.equal((await invoke(['workflow', 'status', id, '--base', 'http://localhost'])).code, 1);
});

test('a result arriving before wait is retained; late acceptance cannot close a superseded subject', async t => {
  const { w } = await setup(t); await w.add(item('a')); const r = await claim(w, 'a');
  await w.ingest(reported('a', 'early-v2'));
  await assert.rejects(finish(w, r), e => e.payload.code === 'workflow-superseded');
  await w.wait({ runId: r.id, claimId: r.claimId, reason: 'await worker result' });
  const next = await w.next(); assert.equal(next.readyCount, 1); assert.equal(next.items[0].revision, 2); assert.equal(next.items[0].subjectVersion, 'v2');
  await assert.rejects(finish(w, r));
});
test('one report can address two work items; human input blocks active work without granting authority', async t => {
  const { w } = await setup(t); await w.add(item('a')); await w.add(item('b'));
  await w.ingest(reported('a', 'shared-message')); await w.ingest(reported('b', 'shared-message'));
  assert.equal((await w.notices()).events.filter(e => e.type === 'review_requested').length, 2);
  const r = await claim(w, 'a', 2);
  await w.ingest(reported('a', 'need-human', { itemRevision: 2, kind: 'input_required', subjectVersion: null, evidence: [] }));
  assert.equal((await w.status()).items.find(i => i.id === 'a').status, 'blocked');
  await assert.rejects(finish(w, r));
});
test('upstream revisions cannot silently preserve accepted downstream results, including corrupted cycles', async t => {
  const { w, store } = await setup(t); await w.add(item('upstream')); await finish(w, await claim(w, 'upstream'));
  await w.add(item('downstream', { dependsOn: ['upstream'] })); await finish(w, await claim(w, 'downstream'));
  await assert.rejects(w.revise({ itemId: 'upstream', revision: 1, subjectVersion: 'v2', evidence: proof }));
  const state = await w.load(); state.items[0].dependsOn = ['downstream'];
  const path = join(store.root, w.file); await fs.writeFile(path, JSON.stringify(state));
  await assert.rejects(w.status(), e => e.payload.code === 'workflow-invalid');
});
test('failed observation persistence retains both old cursor and event journal for replay', async t => {
  const { w, store, home } = await setup(t); const original = await fs.readFile(join(store.root, w.file), 'utf8');
  const broken = new Workflow({ store: new Store({ home, io: { ...fs, rename: async () => { throw Error('disk failure'); } } }), actor: owner, workflowId: w.workflowId });
  const transport = () => ({ request: async path => path === '/v1/capabilities' ? { coordinatorEnabled: true, capabilities: { progressCursor: true } } :
    { sessionId: worker.sessionId, feedback: { messages: [{ seq: 1, role: 'assistant', text: 'pending review' }], coverage: 'complete', nextCursor: 'cursor-1', hasMore: false } } });
  assert.equal((await pollWorkflow(broken, transport)).complete, false);
  assert.equal(await fs.readFile(join(store.root, w.file), 'utf8'), original);
  assert.equal((await pollWorkflow(w, transport)).complete, true);
  assert.equal((await w.notices()).events.filter(e => e.type === 'observation').length, 1);
});
test('next paginates stable work identities and rejects changed snapshots or foreign cursors', async t => {
  const { w, make, advance } = await setup(t); for (const id of ['a','b','c']) await w.add(item(id));
  const first = await w.next({ limit: 1 }); assert.equal(first.items.length, 1); assert.equal(first.totalItems, 3);
  const second = await w.next({ limit: 1, cursor: first.nextCursor }); assert.equal(second.items[0].id, 'b');
  await assert.rejects(make(observer).next({ cursor: first.nextCursor }));
  await claim(w, 'a'); await assert.rejects(w.next({ cursor: first.nextCursor }));
  const active = await w.next({ limit: 1 }); advance(31000);
  await assert.rejects(w.next({ cursor: active.nextCursor }));
});
