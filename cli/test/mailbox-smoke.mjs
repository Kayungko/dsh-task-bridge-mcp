import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { Store } from '../lib/store.mjs';
import { Mailbox, parseMail } from '../lib/mailbox.mjs';
import { normalizeRef } from '../lib/run.mjs';

// Reuse the mock and output capture, but isolate each test's user home and all state.
export async function mailboxSmoke({ scratch, check, invoke, requests, setResponder, defaults, id, id2, base, fake }) {
  let serial = 0;
  async function context() {
    const home = join(scratch, `ledger-${++serial}`);
    const env = { TASK_BRIDGE_URL: base, TASK_BRIDGE_TOKEN: fake, CODEX_THREAD_ID: 'thread-unit' };
    const call = args => invoke(args, { home, env });
    return { home, env, call, store: new Store({ home }) };
  }
  const mail = (to, status = 'unread', body = '# 正文\r\nstatus: unread\r\n不应改正文') =>
    `---\r\nto: ${to}\r\nfrom: DSH总控 ${id}\r\nsubject: 测试：完整原文\r\nstatus: ${status}\r\nwritten: 2026-09-10T13:20:47+08:00\r\n---\r\n\r\n${body}`;

  await check('台账自动记账、80 字摘要、no-ledger 与 ref 缺省不造假', async () => {
    const { call, store } = await context();
    const prompt = '文'.repeat(90);
    assert.equal((await call(['spawn', prompt, '--team', 'wave', '--ref', '  thread:wave  ', '--json'])).code, 0);
    let entries = await store.waves();
    assert.equal(entries.length, 1); assert.equal([...entries[0].promptExcerpt].length, 80);
    assert.equal(entries[0].ref, 'thread:wave'); assert.equal(requests()[0].body.externalRef, 'thread:wave');
    await call(['spawn', '不记账', '--no-ledger', '--json']);
    assert.equal((await store.waves()).length, 1); assert.ok(!Object.hasOwn(requests()[1].body, 'externalRef'));
    await call(['spawn', '缺省 ref', '--ref', '   ', '--json']);
    entries = await store.waves();
    assert.ok(!Object.hasOwn(entries[1], 'ref')); assert.ok(!Object.hasOwn(requests()[2].body, 'externalRef'));
    setResponder(() => ({ ok: false, code: 'upstream-error', error: '测试失败' }));
    assert.equal((await call(['spawn', '失败不记账', '--json'])).code, 2);
    assert.equal((await store.waves()).length, 2);
  });
  await check('500 条 FIFO 淘汰；并行记账不丢失', async () => {
    const { store } = await context();
    const entries = Array.from({ length: 500 }, (_, i) => ({ sessionId: `session-${i}`, shortId: String(i),
      title: '', team: 'fifo', spawnedAt: new Date(i).toISOString(), promptExcerpt: '' }));
    await store.locked(() => store.atomic('waves.json', JSON.stringify(entries)));
    await store.record({ sessionId: id }, '最新');
    const waves = await store.waves();
    assert.equal(waves.length, 500); assert.equal(waves[0].sessionId, 'session-1'); assert.equal(waves[499].sessionId, id);
    const other = await context();
    await Promise.all([other.store.record({ sessionId: id }, 'a'), other.store.record({ sessionId: id2 }, 'b')]);
    assert.equal((await other.store.waves()).length, 2);
  });
  await check('recall 每行完整 ID、无匹配退出非零并列候选 team', async () => {
    const { store, call } = await context();
    await store.record({ sessionId: id, team: 'wave-a', title: 'Alpha' }, 'a');
    await store.record({ sessionId: id2, team: 'wave-b', title: 'Beta' }, 'b');
    const r = await call(['recall', 'WAVE']);
    assert.equal(r.stdout, `${id}\n${id2}\n`); assert.equal(requests().length, 0);
    const missing = await call(['recall', 'missing', '--json']);
    assert.equal(missing.code, 1); assert.deepEqual(missing.data.teams, ['wave-a', 'wave-b']);
  });
  await check('别名精确优先于全ID/短ID/标题；覆盖、pins、unpin', async () => {
    const { call } = await context();
    assert.equal((await call(['pin', id, '总控', '--json'])).code, 0);
    let r = await call(['reply', '总控', '--json']);
    assert.equal(r.data.sessionId, id); assert.match(r.stderr, /总控 → session-/);
    r = await call(['pin', id2, '总控', '--json']);
    assert.equal(r.data.previous, id); assert.ok(r.stderr.includes(id));
    for (const alias of [id, '12345678', 'Alpha']) {
      await call(['pin', id2, alias, '--json']);
      assert.equal((await call(['progress', alias, '--json'])).data.sessionId, id2);
      await call(['unpin', alias, '--json']);
    }
    // The other three precedence levels retain their original resolution after unpin.
    for (const target of [id, '12345678', 'Alpha']) assert.equal((await call(['progress', target, '--json'])).data.sessionId, id);
    assert.equal((await call(['pins', '--json'])).data.aliases['总控'], id2);
    await call(['unpin', '总控', '--json']);
    assert.equal((await call(['unpin', '总控', '--json'])).code, 1);
    await call(['pin', id, '__proto__', '--json']);
    assert.equal((await call(['progress', '__proto__', '--json'])).data.sessionId, id);
  });
  await check('waves 每条实时 progress、分组倒序、假空闲及 ref 列', async () => {
    const { call, store } = await context();
    await store.record({ sessionId: id, team: 'a', title: 'Alpha' }, 'a', 'thread:one');
    await store.record({ sessionId: id2, team: 'b', title: 'Beta' }, 'b');
    setResponder(req => ({ ...defaults(req), agentState: req.query.sessionId === id ? 'running' : 'idle',
      todos: req.query.sessionId === id ? [] : [{ status: 'pending' }, { status: 'completed' }] }));
    const r = await call(['waves', '--json']);
    assert.equal(r.data.stale, false); assert.equal(r.data.groups.length, 2);
    assert.equal(r.data.tasks.find(t => t.sessionId === id2).falseIdle, true);
    assert.equal(requests().filter(r => r.path === '/v1/progress').length, 2);
    assert.equal((await call(['waves', '--team', 'a', '--json'])).data.tasks.length, 1);
    assert.match((await call(['waves', '--team', 'a'])).stdout, /thread:one/);
  });
  await check('桥不可达时 waves 明示 stale，不伪造实时状态', async () => {
    const { store, home, env } = await context();
    await store.record({ sessionId: id, team: 'wave' }, 'snapshot');
    // A malformed protocol is not silently downgraded; a network failure is.
    const r = await invoke(['waves', '--base', 'http://127.0.0.1:1', '--json'], { home, env });
    assert.equal(r.code, 0); assert.equal(r.data.stale, true);
    assert.equal(r.data.tasks[0].status, 'unknown'); assert.equal(r.data.tasks[0].promptExcerpt, 'snapshot');
  });
  await check('mailbox 默认 thread/URI/broadcast 未读过滤，all 与缺身份', async () => {
    const { call, store, home, env } = await context();
    const texts = [mail('codex://threads/thread-unit'), mail('thread-unit'), mail('broadcast'), mail('someone-else'), mail('thread-unit', 'acked')];
    await store.locked(async () => { for (let i = 0; i < texts.length; i++) await store.atomic(`outbox/20260910-13200${i}-test.md`, texts[i]); });
    assert.equal((await call(['mailbox', '--json'])).data.count, 3);
    assert.equal((await call(['mailbox', '--all', '--json'])).data.count, 5);
    const r = await invoke(['mailbox', '--json'], { home, env: { ...env, CODEX_THREAD_ID: '' } });
    assert.equal(r.code, 1); assert.match(r.data.error, /thread/);
  });
  await check('mailbox read 全文、序号读取、ack 仅改 status 且幂等', async () => {
    const { call, store } = await context();
    const raw = '\uFEFF' + mail('thread-unit');
    const filename = '20260910-132000-thread.md';
    await store.locked(() => store.atomic(`outbox/${filename}`, raw));
    const r = await call(['mailbox', 'read', '1', '--json']);
    assert.equal(r.data.content, raw);
    assert.equal((await call(['mailbox', 'ack', '1', '--json'])).data.changed, true);
    const after = await store.text(`outbox/${filename}`);
    assert.equal(after, raw.replace('\r\nstatus: unread\r\nwritten:', '\r\nstatus: acked\r\nwritten:'));
    assert.equal((await call(['mailbox', '--json'])).data.count, 0);
    assert.equal((await call(['mailbox', 'ack', filename, '--json'])).data.changed, false);
    assert.equal((await call(['mailbox', 'read', '../escape.md', '--json'])).code, 1);
    assert.equal((await call(['mailbox', 'ack', 'missing.md', '--json'])).code, 1);
  });
  await check('ack rename 失败保留字节、清理临时文件；重复 frontmatter 拒绝', async () => {
    const { store, home, env } = await context();
    const filename = '20260910-132000-thread.md';
    const raw = mail('thread-unit');
    await store.locked(() => store.atomic(`outbox/${filename}`, raw));
    let renames = 0;
    const failing = new Store({ home, io: { ...fs, rename: async () => { renames++; throw new Error('synthetic rename failure'); } } });
    await assert.rejects(new Mailbox(failing, env).ack(filename));
    assert.equal(renames, 1); assert.equal(await store.text(`outbox/${filename}`), raw);
    assert.deepEqual(await fs.readdir(join(store.root, 'outbox')), [filename]);
    assert.throws(() => parseMail(raw.replace('status: unread', 'status: unread\r\nstatus: acked'), filename));
  });
  await check('mailbox send 双向共用 outbox、别名收件人、body-file 和脱敏', async () => {
    const { call, store, home } = await context();
    await call(['pin', id, '总控', '--json']);
    const bodyFile = join(home, 'body.md');
    await fs.writeFile(bodyFile, `完整正文\n${fake}\n${'a'.repeat(64)}`);
    const sent = await call(['mailbox', 'send', '总控', '施工：报告', '--body-file', bodyFile, '--json']);
    assert.equal(sent.code, 0); assert.equal(sent.data.to, id);
    const raw = await store.text(`outbox/${sent.data.filename}`);
    assert.ok(raw.includes('codex://threads/thread-unit')); assert.ok(raw.includes('完整正文'));
    assert.ok(!raw.includes(fake)); assert.ok(!raw.includes('a'.repeat(64)));
    assert.equal(requests().length, 0);
    const empty = await call(['mailbox', 'send', 'broadcast', '空正文', '--json']);
    assert.equal(empty.code, 0);
    assert.equal(parseMail(await store.text(`outbox/${empty.data.filename}`), empty.data.filename).body.trim(), '');
  });
  await check('拒绝仓内状态、路径穿越、损坏 JSON；派发成功记账失败保留回执', async () => {
    const { home, env, store } = await context();
    await fs.mkdir(join(home, '.git'), { recursive: true });
    let r = await invoke(['pin', id, '总控', '--json'], { home, env });
    assert.equal(r.code, 1); await assert.rejects(fs.stat(store.root), { code: 'ENOENT' });
    r = await invoke(['spawn', '已派发但禁写仓内', '--json'], { home, env });
    assert.equal(r.code, 1); assert.equal(r.data.code, 'ledger-write-failed'); assert.equal(r.data.receipt.sessionId, id);
    await assert.rejects(fs.stat(store.root), { code: 'ENOENT' });
    const other = await context();
    await fs.mkdir(other.store.root, { recursive: true });
    await fs.writeFile(join(other.store.root, 'aliases.json'), '{broken');
    assert.equal((await other.call(['pin', id, 'x', '--json'])).code, 1);
    assert.equal(await fs.readFile(join(other.store.root, 'aliases.json'), 'utf8'), '{broken');
  });
  await check('externalRef trim/200边界/非字符串，list --ref 只本地过滤', async () => {
    const { call } = await context();
    assert.throws(() => normalizeRef(42));
    assert.equal(normalizeRef('   '), undefined); assert.equal(normalizeRef('x'.repeat(200)).length, 200);
    let r = await call(['spawn', 'x', '--ref', 'x'.repeat(201), '--json']);
    assert.equal(r.code, 1); assert.equal(r.data.code, 'bad-request'); assert.equal(requests().length, 0);
    setResponder(req => req.path === '/v1/list' ? { ok: true, truncated: false, tasks: [
      { sessionId: id, externalRef: 'Thread:wave' }, { sessionId: id2 },
    ] } : defaults(req));
    r = await call(['list', '--ref', 'thread:', '--json']);
    assert.equal(r.data.tasks.length, 1); assert.ok(!Object.hasOwn(requests()[0].query, 'externalRef'));
    assert.ok(!Object.hasOwn(requests()[0].query, 'ref'));
    assert.match((await call(['list', '--ref', 'thread:'])).stdout, /\| ref/);
  });
}
