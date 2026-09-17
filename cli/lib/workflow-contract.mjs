import { createHash } from 'node:crypto';
import { CliError } from './errors.mjs';

export const VERSION = 1;
export const ITEM_STATES = ['ready', 'running', 'waiting', 'blocked', 'completed', 'cancelled'];
export const EVENT_KINDS = ['progress', 'result_ready', 'review_requested', 'input_required', 'failed'];
export const fail = (code, message) => { throw new CliError(`workflow-${code}`, message, {
  advice: '读取 workflow status/next，核对事项版本、授权和动作回执；结果不确定时对账，勿盲目重发。',
}); };
export function check(condition, message = '参数或持久化状态不合法。') { if (!condition) fail('invalid', message); }
export function object(value, keys, required = keys) {
  check(value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value)));
  check(Object.keys(value).every(k => keys.includes(k)) && required.every(k => Object.hasOwn(value, k)), '未知字段或缺少必填字段。');
  return value;
}
export function text(value, max = 300) { check(typeof value === 'string' && value.trim().length > 0 && value.length <= max && !/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value)); return value; }
export function id(value) { text(value, 100); check(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(value), 'ID 必须是稳定标识，不能包含路径。'); return value; }
export function integer(value, min = 0, max = Number.MAX_SAFE_INTEGER) { check(Number.isSafeInteger(value) && value >= min && value <= max); return value; }
export function strings(value, max = 100) { check(Array.isArray(value) && value.length <= max); value.forEach(v => text(v)); check(new Set(value).size === value.length); return value; }
export function actor(value) { object(value, ['platform', 'hostId', 'sessionId']); ['platform', 'hostId', 'sessionId'].forEach(k => id(value[k])); return value; }
export const keyOf = value => JSON.stringify([value.platform, value.hostId, value.sessionId]);
export const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('base64url');
export function evidence(value) {
  check(Array.isArray(value) && value.length > 0 && value.length <= 20, '结论必须引用证据。');
  value.forEach(e => { object(e, ['ref', 'version']); text(e.ref, 2000); text(e.version, 200); });
  return value;
}
export function binding(value) {
  object(value, ['id', 'platform', 'hostId', 'sessionId', 'baseUrl', 'epoch', 'cursor']);
  id(value.id); id(value.hostId); id(value.sessionId); check(value.platform === 'dsh'); integer(value.epoch, 1);
  let url; try { url = new URL(text(value.baseUrl, 300)); } catch { fail('invalid', '绑定地址无效。'); }
  check(['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash &&
    ['', '/'].includes(url.pathname) && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), '首版只支持本机回环 DSH 连接。');
  check(value.cursor === null || (typeof value.cursor === 'string' && value.cursor.length <= 2048));
}
export function policy(value) {
  object(value, ['revision', 'mode', 'actions', 'resources', 'bindings', 'expiresAt', 'authorizationRef', 'maxConcurrent', 'maxAttempts', 'maxEffects']);
  integer(value.revision, 1); check(['observe', 'assist', 'managed'].includes(value.mode));
  strings(value.actions); strings(value.resources); strings(value.bindings); integer(value.expiresAt);
  integer(value.maxConcurrent, 1, 16); integer(value.maxAttempts, 1, 100); integer(value.maxEffects, 1, 2000);
  check(value.authorizationRef === null || typeof value.authorizationRef === 'string');
  if (value.mode !== 'observe') text(value.authorizationRef, 2000);
}
export function itemInput(value) {
  object(value, ['id', 'title', 'kind', 'action', 'resource', 'subjectVersion', 'bindingId', 'dependsOn', 'completion']);
  id(value.id); text(value.title); id(value.kind); id(value.action); text(value.resource); text(value.subjectVersion, 200);
  check(value.bindingId === null || typeof value.bindingId === 'string');
  strings(value.dependsOn, 256); value.dependsOn.forEach(id);
  check(['evidence', 'handoff'].includes(value.completion));
}
export function eventInput(value) {
  object(value, ['sourceEventId', 'bindingId', 'bindingEpoch', 'itemId', 'itemRevision', 'kind', 'summary', 'evidence', 'subjectVersion']);
  text(value.sourceEventId, 200); id(value.bindingId); integer(value.bindingEpoch, 1);
  id(value.itemId); integer(value.itemRevision, 1); check(EVENT_KINDS.includes(value.kind)); text(value.summary, 2000);
  check(Array.isArray(value.evidence)); if (value.evidence.length) evidence(value.evidence);
  check(value.subjectVersion === null || typeof value.subjectVersion === 'string');
  if (['result_ready', 'review_requested'].includes(value.kind)) { text(value.subjectVersion, 200); evidence(value.evidence); }
}

export function assertState(s) {
  object(s, ['version', 'id', 'title', 'controller', 'ownerEpoch', 'observers', 'policy', 'bindings', 'items', 'runs', 'effects', 'events', 'seen', 'approvals', 'revision', 'createdAt', 'updatedAt']);
  check(s.version === VERSION); id(s.id); text(s.title); actor(s.controller); integer(s.ownerEpoch, 1); integer(s.revision, 1);
  integer(s.createdAt); integer(s.updatedAt); policy(s.policy);
  for (const [name, max] of [['bindings', 32], ['items', 256], ['runs', 2000], ['effects', 2000], ['events', 10000], ['approvals', 2000], ['observers', 32], ['seen', 33]]) {
    check(Array.isArray(s[name]) && s[name].length <= max, `${name} 容量超限或类型错误。`);
  }
  s.observers.forEach(actor); check(new Set(s.observers.map(keyOf)).size === s.observers.length); s.bindings.forEach(binding);
  for (const name of ['bindings', 'items', 'runs', 'effects', 'events']) check(new Set(s[name].map(v => v.id)).size === s[name].length, '重复 ID。');
  for (const i of s.items) {
    object(i, ['id', 'title', 'kind', 'action', 'resource', 'subjectVersion', 'bindingId', 'dependsOn', 'completion', 'revision', 'status', 'runId', 'result', 'updatedAt', 'reason']);
    itemInput(Object.fromEntries(['id', 'title', 'kind', 'action', 'resource', 'subjectVersion', 'bindingId', 'dependsOn', 'completion'].map(k => [k, i[k]])));
    integer(i.revision, 1); integer(i.updatedAt); check(i.reason === null || typeof i.reason === 'string'); check(ITEM_STATES.includes(i.status));
    check(i.bindingId === null || s.bindings.some(b => b.id === i.bindingId));
    check(i.runId === null || s.runs.some(r => r.id === i.runId && r.itemId === i.id && r.itemRevision === i.revision));
    check(i.status !== 'running' || i.runId !== null);
    check(i.dependsOn.every(dep => dep !== i.id && s.items.some(other => other.id === dep)));
    if (i.result !== null) { object(i.result, ['outcome', 'evidence']); check(['accepted', 'needs_changes', 'failed'].includes(i.result.outcome)); evidence(i.result.evidence); }
    check(i.status !== 'completed' || i.result?.outcome === 'accepted');
  }
  const visiting = new Set(), done = new Set();
  const walk = id => { check(!visiting.has(id), '依赖形成循环。'); if (done.has(id)) return; visiting.add(id); s.items.find(i => i.id === id).dependsOn.forEach(walk); visiting.delete(id); done.add(id); };
  s.items.forEach(i => walk(i.id));
  for (const r of s.runs) {
    object(r, ['id', 'claimId', 'itemId', 'itemRevision', 'ownerEpoch', 'policyRevision', 'bindingEpoch', 'expiresAt', 'status', 'actor', 'approvalRef']);
    id(r.id); id(r.claimId); actor(r.actor); integer(r.itemRevision, 1); integer(r.ownerEpoch, 1); integer(r.policyRevision, 1); integer(r.expiresAt);
    check(r.bindingEpoch === null || (Number.isSafeInteger(r.bindingEpoch) && r.bindingEpoch >= 1)); text(r.approvalRef, 2000);
    check(s.items.some(i => i.id === r.itemId)); check(['running', 'finished', 'waiting', 'expired', 'invalidated'].includes(r.status));
  }
  for (const e of s.effects) {
    object(e, ['id', 'runId', 'itemId', 'itemRevision', 'purpose', 'fingerprint', 'binding', 'status', 'receipt', 'evidence']);
    id(e.id); integer(e.itemRevision, 1); text(e.fingerprint); binding(e.binding);
    check(['dispatch', 'handoff'].includes(e.purpose) && ['prepared', 'sending', 'unknown', 'delivered', 'not_delivered'].includes(e.status));
    check(s.runs.some(r => r.id === e.runId && r.itemId === e.itemId && r.itemRevision === e.itemRevision));
    if (e.receipt !== null) { object(e.receipt, ['targetId', 'messageId', 'verifiedBy']); text(e.receipt.targetId); text(e.receipt.messageId); check(['transport', 'operator'].includes(e.receipt.verifiedBy)); }
    check(e.status !== 'delivered' || (e.receipt !== null && e.receipt.targetId === e.binding.sessionId)); check(Array.isArray(e.evidence)); if (e.evidence.length) evidence(e.evidence);
  }
  for (const e of s.events) {
    object(e, ['id', 'type', 'itemId', 'itemRevision', 'sourceKey', 'fingerprint', 'subjectVersion', 'summary', 'evidence', 'stale', 'at']);
    id(e.id); text(e.type); check(e.subjectVersion === null || typeof e.subjectVersion === 'string'); text(e.summary, 2000); integer(e.at); check(typeof e.stale === 'boolean');
    check(e.itemId === null || s.items.some(i => i.id === e.itemId)); if (e.evidence.length) evidence(e.evidence);
  }
  for (const row of s.seen) { object(row, ['actor', 'eventIds']); actor(row.actor); strings(row.eventIds, 10000); check(row.eventIds.every(id => s.events.some(e => e.id === id))); }
  for (const a of s.approvals) {
    object(a, ['itemId', 'revision', 'policyRevision', 'ref', 'expiresAt']); text(a.ref, 2000); integer(a.expiresAt); integer(a.revision, 1); integer(a.policyRevision, 1);
    check(s.items.some(i => i.id === a.itemId));
  }
  return s;
}
