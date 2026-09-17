import { check, digest, fail } from './workflow-contract.mjs';

// Observation is deliberately separate from work classification and acceptance.
export async function pollWorkflow(workflow, clientFactory) {
  const s = await workflow.load(); workflow.controller(s);
  const results = [], clients = new Map();
  for (const binding of s.bindings) {
    try {
      const connection = JSON.stringify([binding.hostId, binding.baseUrl]);
      if (!clients.has(connection)) {
        const client = clientFactory(binding);
        const caps = await client.request('/v1/capabilities');
        check(caps.coordinatorEnabled === true && caps.capabilities?.progressCursor === true, '运行中的连接不支持增量读取。');
        clients.set(connection, client);
      }
      const client = clients.get(connection);
      let cursor = binding.cursor, pages = 0, more;
      do {
        const p = await client.request('/v1/progress', { query: { sessionId: binding.sessionId, ...(cursor ? { cursor } : {}) } });
        const f = p.feedback;
        check(p.sessionId === binding.sessionId && f && Array.isArray(f.messages) && f.messages.length <= 100 &&
          ['complete', 'partial', 'unavailable'].includes(f.coverage) && typeof f.hasMore === 'boolean');
        check(f.nextCursor === null || (typeof f.nextCursor === 'string' && f.nextCursor.length > 0 && f.nextCursor.length <= 2048));
        check(!f.hasMore || (f.nextCursor && f.nextCursor !== cursor), '增量游标没有推进。');
        check(f.coverage === 'unavailable' || f.nextCursor !== null);
        const previous = cursor;
        await workflow.tx(current => {
          const b = current.bindings.find(b => b.id === binding.id);
          if (!b || b.epoch !== binding.epoch || b.cursor !== previous) fail('stale-binding', '另一个采集者或绑定更新已推进游标。');
          for (const message of f.messages) {
            check(['user', 'assistant'].includes(message.role) && typeof message.text === 'string' && Number.isSafeInteger(message.seq) && message.seq >= 0);
            const sourceKey = JSON.stringify([b.id, b.epoch, 'message', message.seq]);
            const fingerprint = digest([message.role, message.messageId ?? null, message.text]);
            const existing = current.events.find(e => e.sourceKey === sourceKey);
            if (existing) { if (existing.fingerprint !== fingerprint) fail('event-conflict', '同一源事件出现不同内容。'); continue; }
            workflow.event(current, 'observation', null, message.text.slice(0, 1900) || '(empty)', {
              sourceKey, fingerprint,
              evidence: [{ ref: JSON.stringify({ bindingId: b.id, bindingEpoch: b.epoch, sessionId: b.sessionId, messageId: message.messageId ?? null }), version: String(message.seq) }],
            });
          }
          if (f.coverage !== 'complete') {
            const sourceKey = JSON.stringify([b.id, b.epoch, 'coverage', previous, f.coverage]);
            if (!current.events.some(e => e.sourceKey === sourceKey)) workflow.event(current, 'coverage', null, `source coverage: ${f.coverage}`, { sourceKey });
          }
          // Commit source events and their cursor in one local transaction.
          if (f.coverage !== 'unavailable') b.cursor = f.nextCursor;
        });
        if (f.coverage !== 'unavailable') cursor = f.nextCursor;
        more = f.hasMore && f.coverage !== 'unavailable'; pages++;
      } while (more && pages < 4);
      results.push({ bindingId: binding.id, ok: true, pages, hasMore: more });
    } catch (error) {
      results.push({ bindingId: binding.id, ok: false, code: error.payload?.code ?? 'adapter-query-failed' });
    }
  }
  return { ok: true, complete: results.every(r => r.ok && !r.hasMore), bindings: results,
    note: 'observations do not create, complete or authorize work; classify them with explicit work-item IDs' };
}
