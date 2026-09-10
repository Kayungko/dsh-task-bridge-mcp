import { CliError } from './errors.mjs';

export const shortId = task => task.shortId || task.sessionId?.replace(/^session-/, '').slice(0, 8) || '?';

export function matches(tasks, query) {
  const needle = query.toLowerCase();
  if (/^session-.+/i.test(query)) return tasks.filter(t => t.sessionId === query);
  if (/^[a-f0-9]{8}$/i.test(query)) {
    return tasks.filter(t => shortId(t).toLowerCase() === needle ||
      t.sessionId?.toLowerCase().endsWith(needle));
  }
  return tasks.filter(t => [t.title, t.team].some(v => v?.toLowerCase().includes(needle)));
}

export function resolver(client, { store, note = () => {} } = {}) {
  let listing;
  async function candidates(query) {
    listing ??= client.request('/v1/list', { query: { limit: 500 } });
    const data = await listing;
    if (!Array.isArray(data.tasks)) throw new CliError('bridge-invalid-response', 'list 缺少 tasks 数组。');
    // Never select a supposedly unique target from an incomplete list before a write.
    if (data.truncated) throw new CliError('incomplete-list', '任务列表超过 500 条，无法可靠消歧。', {
      advice: '用 dshq list --filter 或 --team 缩小范围，再复制完整 sessionId。',
    });
    return matches(data.tasks, query);
  }
  return {
    candidates,
    async resolve(query) {
      const aliases = store ? await store.aliases() : {};
      if (Object.hasOwn(aliases, query)) {
        note(`${query} → ${aliases[query]}`);
        return aliases[query];
      }
      if (/^session-\S+$/.test(query)) return query;
      const found = await candidates(query);
      if (found.length > 1) throw new CliError('ambiguous-session', '会话匹配不唯一。', {
        exitCode: 3, candidates: found, advice: '从候选中复制完整 sessionId 再执行。',
      });
      if (!found.length) throw new CliError('session-not-found', '未匹配到会话。', {
        advice: '用 dshq list 查找当前会话。',
      });
      return found[0].sessionId;
    },
  };
}
