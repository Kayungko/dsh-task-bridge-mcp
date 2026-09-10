import { shortId } from './resolve.mjs';

const cell = value => String(value ?? '—').replace(/\s+/g, ' ');
export function table(tasks) {
  return ['shortId | title | team | status | todos | sessionId', ...tasks.map(t =>
    [shortId(t), t.title, t.team, t.status ?? t.agentState, typeof t.todos === 'object'
      && t.todos !== null ? JSON.stringify(t.todos) : t.todos, t.sessionId].map(cell).join(' | '))].join('\n');
}

export function replyNotes(recent, messages) {
  const notes = [];
  if (!recent.length) notes.push('recent 为空：可能尚无转录；若应有回复，请确认 DSH 已重启至 task-coordinator v0.24.1+。');
  else if (!messages.length) notes.push('recent 尾部没有 assistant 消息；不能据此推断任务未回复。');
  if (messages.some(m => /\(\+\d+ chars\)/.test(m.text ?? ''))) {
    notes.push('摘录已截断，保留 (+N chars) 标记；请 DSH 重发短回信：独立首段、【L2→L1】置顶、≤200 字。不得猜测被截内容。');
  }
  return notes;
}

export function replies(data, lines = 3) {
  const recent = Array.isArray(data.recent) ? data.recent : [];
  const messages = recent.filter(m => m.role === 'assistant').slice(-lines);
  return { ok: true, sessionId: data.sessionId, recent: messages, notes: replyNotes(recent, messages) };
}

export function replyText(data) {
  return [`sessionId: ${data.sessionId}`, ...data.recent.map(m => m.text ?? ''), ...data.notes].join('\n\n');
}

export function progressText(data) {
  return [`sessionId: ${data.sessionId}`, `title: ${data.title ?? '—'}`, `状态: ${data.agentState}`,
    `队列深度: ${data.queue?.length ?? 0}`, `todos: ${JSON.stringify(data.todos ?? null)}`,
    `goal: ${JSON.stringify(data.goal ?? null)}`, `seq: ${data.seq ?? '—'}`,
    ...(data.inspectError ? [`inspectError: ${data.inspectError}`] : []), 'recent:',
    ...(data.recent ?? []).map(m => `[${m.role}]\n${m.text ?? ''}`),
    ...replyNotes(data.recent ?? [], data.recent ?? [])].join('\n');
}

export function fleet(data, now = Date.now()) {
  const tasks = data.tasks;
  return { ok: true, total: data.count ?? tasks.length, returned: tasks.length, truncated: data.truncated,
    active24h: tasks.filter(t => t.updatedAt >= now - 86400000).length,
    running: tasks.filter(t => t.status === 'running'),
    pendingIdle: tasks.filter(t => t.status === 'idle' && t.pendingTodos > 0) };
}

export function fleetText(data) {
  const rows = tasks => tasks.slice(0, 5).map(t =>
    `${shortId(t)} | ${cell(t.title)} | ${cell(t.team)} | ${Math.max(0, Math.floor((Date.now() - t.updatedAt) / 60000))} 分钟前 | 待办 ${t.pendingTodos ?? 0} | ${t.sessionId}`);
  return [`任务 ${data.total}；running ${data.running.length}；假空闲 ${data.pendingIdle.length}；最近 24h 活跃 ${data.active24h}`,
    '运行中（最多展示 5 条）：', ...rows(data.running), '空闲但仍有待办（最多展示 5 条）：', ...rows(data.pendingIdle),
    ...(data.running.length > 5 || data.pendingIdle.length > 5 ? ['更多条目用 status --json 或 list 查看。'] : []),
    ...(data.truncated ? ['列表被桥截断，状态/24h 统计仅覆盖已返回任务。'] : [])].join('\n');
}
