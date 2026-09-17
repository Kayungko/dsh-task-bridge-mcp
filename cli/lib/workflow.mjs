import { randomUUID } from 'node:crypto';
import { assertState, actor, binding, check, digest, evidence, eventInput, fail, id, integer, itemInput, keyOf, object, policy, text, VERSION } from './workflow-contract.mjs';

const same = (a, b) => keyOf(a) === keyOf(b);
const unresolved = e => ['sending', 'unknown'].includes(e.status);
const closed = i => ['completed', 'cancelled'].includes(i.status);

/** A local workflow control plane, not a sandbox for arbitrary agent tools. */
export class Workflow {
  constructor({ store, actor: principal, workflowId, now = Date.now, uuid = randomUUID }) {
    actor(principal); id(workflowId);
    Object.assign(this, { store, principal, workflowId, now, uuid });
    this.file = `workflow-${digest(workflowId)}.json`;
  }
  async load() { const s = await this.store.json(this.file, null); if (!s) fail('not-found', '工作流不存在。'); assertState(s); check(s.id === this.workflowId); return s; }
  canRead(s) { check(same(s.controller, this.principal) || s.observers.some(a => same(a, this.principal)), '调用方未绑定到此工作流。'); }
  controller(s) { if (!same(s.controller, this.principal)) fail('controller-required', '只有当前执行总控可改变工作状态。'); }
  async tx(fn) {
    return this.store.locked(async () => {
      const s = await this.load(); this.controller(s); this.recover(s);
      const result = fn(s); s.revision++; s.updatedAt = this.now(); assertState(s);
      await this.store.atomic(this.file, JSON.stringify(s, null, 2) + '\n'); return result;
    });
  }
  event(s, type, item = null, summary = type, extra = {}) {
    if (s.events.length >= 10000) fail('capacity', '事件容量已满；导出并显式迁移，不淘汰未完成事项。');
    const row = { id: this.uuid(), type, itemId: item?.id ?? null, itemRevision: item?.revision ?? null,
      sourceKey: null, fingerprint: null, subjectVersion: item?.subjectVersion ?? null, summary: this.store.redact(summary), evidence: [], stale: false, at: this.now(), ...extra };
    s.events.push(row); return row;
  }
  item(s, itemId, revision) {
    const item = s.items.find(i => i.id === itemId); if (!item) fail('item-not-found', '工作事项不存在。');
    if (revision !== undefined && item.revision !== revision) fail('stale-revision', '事项版本已变化。'); return item;
  }
  activeEffects(s, i) { return s.effects.filter(e => e.itemId === i.id && e.itemRevision === i.revision && unresolved(e)); }
  invalidate(s, reason, predicate = () => true) {
    for (const i of s.items.filter(i => !closed(i) && predicate(i))) {
      const r = s.runs.find(r => r.id === i.runId); if (r) r.status = 'invalidated';
      i.runId = null; i.status = 'blocked'; i.reason = reason;
    }
  }
  recover(s) {
    for (const r of s.runs.filter(r => r.status === 'running' && r.expiresAt <= this.now())) {
      r.status = 'expired'; const i = this.item(s, r.itemId);
      if (i.runId === r.id) { i.runId = null; i.status = s.effects.some(e => e.itemId === i.id && e.itemRevision === i.revision && ['sending','unknown','delivered'].includes(e.status)) ? 'blocked' : 'ready'; i.reason = 'lease-expired'; this.event(s, 'lease-expired', i); }
    }
  }
  permitted(s, i, action = i.action) {
    const p = s.policy;
    if (p.mode === 'observe' || p.expiresAt <= this.now() || !p.actions.includes(action) || !p.resources.includes(i.resource) ||
        (i.bindingId && !p.bindings.includes(i.bindingId))) return 'authorization-required';
    if (p.mode === 'assist' && !s.approvals.some(a => a.itemId === i.id && a.revision === i.revision && a.policyRevision === p.revision && a.expiresAt > this.now())) return 'item-approval-required';
    return null;
  }
  run(s, input) {
    const r = s.runs.find(r => r.id === input.runId); if (!r || r.claimId !== input.claimId) fail('stale-lease', '租约不存在或凭据不符。');
    const i = this.item(s, r.itemId, r.itemRevision), b = s.bindings.find(b => b.id === i.bindingId);
    if (i.status !== 'running' || i.runId !== r.id || r.status !== 'running' || r.expiresAt <= this.now() || r.policyRevision !== s.policy.revision || r.ownerEpoch !== s.ownerEpoch ||
        !same(r.actor, this.principal) || r.bindingEpoch !== (b?.epoch ?? null)) fail('stale-lease', '动作租约或授权/绑定版本已失效。');
    const denied = this.permitted(s, i); if (denied) fail(denied, '当前授权不允许继续此动作。'); return { r, i, b };
  }
  async create(input) {
    object(input, ['title', 'observers', 'bindings']); text(input.title); check(Array.isArray(input.observers) && input.observers.length <= 32); input.observers.forEach(actor);
    check(Array.isArray(input.bindings) && input.bindings.length <= 32); input.bindings.forEach(binding);
    return this.store.locked(async () => {
      if (await this.store.text(this.file, null) !== null) fail('exists', '工作流 ID 已存在。');
      const s = { version: VERSION, id: this.workflowId, title: this.store.redact(input.title), controller: this.principal, ownerEpoch: 1,
        observers: input.observers, bindings: input.bindings, policy: { revision: 1, mode: 'observe', actions: [], resources: [], bindings: [], expiresAt: 0,
          authorizationRef: null, maxConcurrent: 1, maxAttempts: 10, maxEffects: 100 },
        items: [], runs: [], effects: [], events: [], seen: [], approvals: [], revision: 1, createdAt: this.now(), updatedAt: this.now() };
      assertState(s); await this.store.atomic(this.file, JSON.stringify(s, null, 2) + '\n'); return { ok: true, workflowId: s.id, mode: 'observe' };
    });
  }
  async configure(input) {
    object(input, ['expectedPolicyRevision', 'policy']); integer(input.expectedPolicyRevision, 1); policy(input.policy);
    return this.tx(s => {
      if (s.policy.revision !== input.expectedPolicyRevision || input.policy.revision !== s.policy.revision + 1) fail('stale-policy', '授权修订必须基于当前版本。');
      check(input.policy.bindings.every(id => s.bindings.some(b => b.id === id)));
      s.policy = input.policy; this.invalidate(s, 'policy-changed', i => i.status === 'running'); this.event(s, 'policy-changed'); return { ok: true, policyRevision: s.policy.revision };
    });
  }
  async add(input) {
    itemInput(input);
    return this.tx(s => {
      if (s.items.some(i => i.id === input.id)) fail('item-exists', '事项 ID 已存在。');
      const item = { ...input, title: this.store.redact(input.title), revision: 1, status: 'ready', runId: null, result: null, updatedAt: this.now(), reason: null };
      s.items.push(item); this.event(s, 'item-created', item); return { ok: true, item };
    });
  }
  async approve(input) {
    object(input, ['itemId', 'revision', 'authorizationRef', 'expiresAt']); text(input.authorizationRef, 2000); integer(input.expiresAt);
    return this.tx(s => { this.item(s, input.itemId, input.revision); check(input.expiresAt > this.now() && input.expiresAt <= s.policy.expiresAt);
      s.approvals.push({ itemId: input.itemId, revision: input.revision, policyRevision: s.policy.revision, ref: input.authorizationRef, expiresAt: input.expiresAt }); return { ok: true }; });
  }
  async next({ limit = 20, cursor = null } = {}) {
    integer(limit, 1, 100);
    const s = await this.load(); this.canRead(s); const result = [];
    for (const i of s.items.filter(i => !closed(i))) {
      const r = s.runs.find(r => r.id === i.runId);
      const status = r?.status === 'running' && r.expiresAt <= this.now() ? (s.effects.some(e => e.itemId === i.id && e.itemRevision === i.revision && ['sending','unknown','delivered'].includes(e.status)) ? 'blocked' : 'ready') : i.status;
      const hold = !same(s.controller, this.principal) ? 'observer' : this.activeEffects(s, i).length ? 'reconciliation-required' :
        status !== 'ready' ? status : i.dependsOn.some(id => this.item(s, id).status !== 'completed') ? 'dependency' :
          this.permitted(s, i) ?? (s.runs.filter(r => r.itemId === i.id).length >= s.policy.maxAttempts ? 'attempt-budget' : null);
      result.push({ id: i.id, revision: i.revision, title: i.title, kind: i.kind, action: i.action, subjectVersion: i.subjectVersion, status, hold,
        ...(hold === null ? { resource: i.resource, bindingId: i.bindingId } : {}) });
    }
    const active = s.runs.filter(r => r.status === 'running' && r.expiresAt > this.now()).length;
    for (const row of result) if (!row.hold && active >= s.policy.maxConcurrent) row.hold = 'concurrency-budget';
    result.sort((a,b) => Number(a.hold !== null) - Number(b.hold !== null));
    let offset = 0;
    if (cursor !== null) {
      check(typeof cursor === 'string' && cursor.length <= 4096);
      let parsed; try { parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')); } catch { fail('invalid', '游标格式错误。'); }
      check(parsed.id === s.id && parsed.actor === keyOf(this.principal) && parsed.revision === s.revision && parsed.view === digest(result), '游标已过时或不属于本工作流/调用方。');
      offset = integer(parsed.offset, 0, result.length);
    }
    const items = result.slice(offset, offset + limit), hasMore = offset + items.length < result.length;
    return { ok: true, workflowId: s.id, policyRevision: s.policy.revision, unresolvedEffects: s.effects.filter(unresolved).map(e => e.id), items,
      totalItems: result.length, readyCount: result.filter(i => i.hold === null).length, hasMore,
      nextCursor: hasMore ? Buffer.from(JSON.stringify({ id: s.id, actor: keyOf(this.principal), revision: s.revision, view: digest(result), offset: offset + items.length })).toString('base64url') : null };
  }
  async claim(input) {
    object(input, ['itemId', 'revision', 'leaseMs']); integer(input.revision, 1); integer(input.leaseMs, 1000, 3600000);
    return this.tx(s => {
      const i = this.item(s, input.itemId, input.revision); check(i.status === 'ready', '事项尚不可执行。');
      if (this.activeEffects(s, i).length) fail('reconciliation-required', '存在发送结果不确定的动作。');
      check(i.dependsOn.every(id => this.item(s, id).status === 'completed'), '依赖未完成。');
      const denied = this.permitted(s, i); if (denied) fail(denied, '需要当前范围内的明确授权。');
      if (s.runs.filter(r => r.status === 'running').length >= s.policy.maxConcurrent || s.runs.filter(r => r.itemId === i.id).length >= s.policy.maxAttempts) fail('budget', '并发或尝试次数预算已用尽。');
      const b = s.bindings.find(b => b.id === i.bindingId);
      const r = { id: this.uuid(), claimId: this.uuid(), itemId: i.id, itemRevision: i.revision, actor: this.principal, ownerEpoch: s.ownerEpoch,
        policyRevision: s.policy.revision, bindingEpoch: b?.epoch ?? null, expiresAt: Math.min(this.now() + input.leaseMs, s.policy.expiresAt), status: 'running', approvalRef: s.policy.authorizationRef };
      s.runs.push(r); i.status = 'running'; i.runId = r.id; this.event(s, 'claimed', i); return { ok: true, run: r };
    });
  }
  async finish(input) {
    object(input, ['runId', 'claimId', 'outcome', 'evidence', 'handoffEffectId']); evidence(input.evidence); check(['accepted', 'needs_changes', 'failed'].includes(input.outcome));
    return this.tx(s => {
      const { r, i } = this.run(s, input); if (this.activeEffects(s, i).length) fail('reconciliation-required', '先对账不确定的发送。');
      const arrived = [...s.events].reverse().find(e => e.itemId === i.id && e.itemRevision === i.revision && !e.stale && ['result_ready','review_requested'].includes(e.type) && e.subjectVersion && e.subjectVersion !== i.subjectVersion);
      if (arrived && input.outcome === 'accepted') fail('superseded', '已有新版本等待处理，先 wait 释放旧租约并转入新修订，不接受过时结果。');
      if (input.outcome === 'accepted' && i.completion === 'handoff') check(s.effects.some(e => e.id === input.handoffEffectId && e.itemId === i.id && e.itemRevision === i.revision && e.purpose === 'handoff' && e.status === 'delivered'), '缺少此修订的交接回执。');
      i.result = { outcome: input.outcome, evidence: input.evidence }; i.status = input.outcome === 'accepted' ? 'completed' : input.outcome === 'needs_changes' ? 'waiting' : 'blocked';
      i.reason = input.outcome; i.runId = null; r.status = 'finished'; this.event(s, 'result-recorded', i, input.outcome, { evidence: input.evidence });
      if (arrived && i.status === 'waiting') this.applyReadyEvent(s, i, arrived);
      return { ok: true, itemId: i.id, revision: i.revision, status: i.status };
    });
  }
  canRevise(s, i) {
    const affected = new Set([i.id]);
    let grew;
    do { grew = false; for (const other of s.items) if (!affected.has(other.id) && other.dependsOn.some(id => affected.has(id))) { affected.add(other.id); grew = true; } } while (grew);
    return !s.items.some(other => other.id !== i.id && affected.has(other.id) && ['running', 'completed'].includes(other.status));
  }
  applyReadyEvent(s, i, event) {
    if (!this.canRevise(s, i)) { i.status = 'blocked'; i.reason = 'dependency-revision-conflict'; return; }
    i.subjectVersion = event.subjectVersion; i.revision++; i.result = null; i.status = 'ready'; i.reason = null;
  }
  async revise(input) {
    object(input, ['itemId', 'revision', 'subjectVersion', 'evidence']); text(input.subjectVersion, 200); evidence(input.evidence);
    return this.tx(s => { const i = this.item(s, input.itemId, input.revision); check(!['running', 'cancelled'].includes(i.status));
      if (this.activeEffects(s, i).length) fail('reconciliation-required', '先对账旧修订动作。');
      check(this.canRevise(s, i), '修订影响已运行/完成的下游；请建立显式新事项路径。');
      check(input.subjectVersion !== i.subjectVersion, '新修订必须引用新对象版本。');
      i.revision++; i.subjectVersion = input.subjectVersion; i.runId = null; i.result = null; i.status = 'ready'; i.reason = null;
      this.event(s, 'revised', i, 'new subject version', { evidence: input.evidence }); return { ok: true, itemId: i.id, revision: i.revision }; });
  }
  async resume(input) {
    object(input, ['itemId', 'revision', 'reason']); text(input.reason);
    return this.tx(s => { const i = this.item(s, input.itemId, input.revision); check(['blocked', 'waiting'].includes(i.status));
      if (this.activeEffects(s, i).length) fail('reconciliation-required', '先对账不确定动作。');
      i.status = 'ready'; i.reason = null; this.event(s, 'resumed', i, input.reason); return { ok: true }; });
  }
  async wait(input) {
    object(input, ['runId', 'claimId', 'reason']); text(input.reason);
    return this.tx(s => { const { r, i } = this.run(s, input); r.status = 'waiting'; i.runId = null; i.status = 'waiting'; i.reason = input.reason;
      this.event(s, 'waiting', i, input.reason);
      const arrived = [...s.events].reverse().find(e => e.itemId === i.id && e.itemRevision === i.revision && !e.stale && ['result_ready','review_requested'].includes(e.type) && e.subjectVersion && e.subjectVersion !== i.subjectVersion);
      if (arrived) this.applyReadyEvent(s, i, arrived);
      return { ok: true, status: i.status }; });
  }
  async cancel(input) {
    object(input, ['itemId', 'revision', 'reason']); text(input.reason);
    return this.tx(s => { const i = this.item(s, input.itemId, input.revision); check(!closed(i));
      const r = s.runs.find(r => r.id === i.runId); if (r) r.status = 'invalidated';
      i.runId = null; i.status = 'cancelled'; i.reason = input.reason;
      this.event(s, 'cancelled-locally', i, input.reason); return { ok: true, externalWorkCancelled: false, unresolvedEffects: this.activeEffects(s, i).map(e => e.id) }; });
  }
  async ingest(input) {
    eventInput(input);
    return this.tx(s => {
      const i = this.item(s, input.itemId), b = s.bindings.find(b => b.id === input.bindingId); check(b, '未知来源绑定。');
      const sourceKey = JSON.stringify([input.bindingId, input.bindingEpoch, input.sourceEventId, input.itemId]), fingerprint = digest(input);
      const prior = s.events.find(e => e.sourceKey === sourceKey);
      if (prior) { if (prior.fingerprint !== fingerprint) fail('event-conflict', '同一事件 ID 的载荷不同。'); return { ok: true, duplicate: true, eventId: prior.id }; }
      const stale = b.epoch !== input.bindingEpoch || i.bindingId !== b.id || i.revision !== input.itemRevision;
      const e = this.event(s, input.kind, i, input.summary, { sourceKey, fingerprint, subjectVersion: input.subjectVersion, evidence: input.evidence, stale });
      // Reports never grant authority or close work. Fresh version requests reopen only an explicit waiting item.
      if (!stale && ['ready', 'waiting'].includes(i.status) && ['result_ready', 'review_requested'].includes(input.kind) && input.subjectVersion !== i.subjectVersion) {
        this.applyReadyEvent(s, i, e);
      }
      if (!stale && !closed(i) && ['input_required','failed'].includes(input.kind)) this.invalidate(s, input.kind, other => other.id === i.id);
      return { ok: true, eventId: e.id, stale, itemStatus: i.status, itemRevision: i.revision };
    });
  }
  async notices({ limit = 20 } = {}) {
    integer(limit, 1, 50);
    const s = await this.load(); this.canRead(s); const seen = new Set(s.seen.find(row => same(row.actor, this.principal))?.eventIds ?? []);
    const pending = s.events.filter(e => !seen.has(e.id));
    return { ok: true, count: pending.length, events: pending.slice(0, limit), hasMore: pending.length > limit, note: 'notification state never closes work items' };
  }
  async markNotices(input) {
    object(input, ['eventIds']); check(Array.isArray(input.eventIds) && input.eventIds.length <= 50);
    return this.store.locked(async () => { const s = await this.load(); this.canRead(s);
      check(input.eventIds.every(id => s.events.some(e => e.id === id)), '必须使用已返回的事件 ID。');
      let row = s.seen.find(row => same(row.actor, this.principal)); if (!row) { row = { actor: this.principal, eventIds: [] }; s.seen.push(row); }
      row.eventIds = [...new Set([...row.eventIds, ...input.eventIds])]; s.revision++; assertState(s);
      await this.store.atomic(this.file, JSON.stringify(s, null, 2) + '\n'); return { ok: true, marked: input.eventIds, workItemsChanged: false }; });
  }
  async rebind(input) {
    object(input, ['bindingId', 'expectedEpoch', 'binding', 'authorizationRef']); binding(input.binding); text(input.authorizationRef, 2000);
    return this.tx(s => { const b = s.bindings.find(b => b.id === input.bindingId);
      check(b && b.epoch === input.expectedEpoch && input.binding.id === b.id && input.binding.epoch === b.epoch + 1 && input.binding.cursor === null);
      this.invalidate(s, 'binding-changed', i => i.bindingId === b.id); Object.assign(b, input.binding); this.event(s, 'binding-changed'); return { ok: true }; });
  }
  async handoff(input) {
    object(input, ['expectedOwnerEpoch', 'controller', 'authorizationRef']); actor(input.controller); text(input.authorizationRef, 2000);
    return this.tx(s => { check(s.ownerEpoch === input.expectedOwnerEpoch && !same(s.controller, input.controller));
      this.invalidate(s, 'controller-changed'); s.controller = input.controller; s.ownerEpoch++;
      s.policy = { ...s.policy, revision: s.policy.revision + 1, mode: 'observe', actions: [], authorizationRef: null };
      this.event(s, 'controller-changed'); return { ok: true, controller: s.controller, requiresNewPolicy: true }; });
  }
  async prepareSend(input) {
    object(input, ['runId', 'claimId', 'operationId', 'purpose', 'text', 'mode']); id(input.operationId); text(input.text, 20000); check(['dispatch', 'handoff'].includes(input.purpose)); check(['queue', 'steer'].includes(input.mode));
    return this.tx(s => { const { r, i, b } = this.run(s, input); check(b, '发送需要明确会话绑定。');
      const denied = this.permitted(s, i, 'send'); if (denied) fail(denied, '当前范围没有消息发送授权。');
      const target = { ...b, cursor: null };
      const fingerprint = digest([r.id, input.purpose, input.text, input.mode, target]);
      const prior = s.effects.find(e => e.id === input.operationId);
      if (prior) { if (prior.fingerprint !== fingerprint) fail('operation-conflict', '同一 operationId 不能更换请求。'); return { ok: true, effect: prior }; }
      if (this.activeEffects(s, i).length) fail('reconciliation-required', '此事项已有不确定动作，不能换 operationId 绕过对账。');
      if (s.effects.length >= s.policy.maxEffects) fail('budget', '外部动作预算耗尽。');
      const effect = { id: input.operationId, runId: r.id, itemId: i.id, itemRevision: i.revision, purpose: input.purpose, fingerprint, binding: target,
        status: 'prepared', receipt: null, evidence: [] };
      s.effects.push(effect); return { ok: true, effect };
    });
  }
  async admitSend(input) {
    return this.tx(s => { const { r } = this.run(s, input), e = s.effects.find(e => e.id === input.operationId); check(e?.runId === r.id && e.status === 'prepared');
      const i = this.item(s, e.itemId); if (this.activeEffects(s, i).some(other => other.id !== e.id)) fail('reconciliation-required', '同一事项已有在途或不确定动作。'); if (this.permitted(s, i, 'send')) fail('authorization-required', '发送授权已变化。');
      e.status = 'sending'; return structuredClone(e); });
  }
  async recordSend(effect, receipt) {
    // Factual transport results must remain recordable even if authority was revoked in flight.
    return this.store.locked(async () => { const s = await this.load(), e = s.effects.find(e => e.id === effect.id); check(e && e.fingerprint === effect.fingerprint);
      if (receipt) { check(receipt.delivered === true && receipt.targetId === e.binding.sessionId && typeof receipt.messageId === 'string');
        e.status = 'delivered'; e.receipt = { targetId: receipt.targetId, messageId: receipt.messageId, verifiedBy: 'transport' }; }
      else if (e.status === 'sending') e.status = 'unknown';
      s.revision++; assertState(s); await this.store.atomic(this.file, JSON.stringify(s, null, 2) + '\n'); return { ok: true, effect: e }; });
  }
  async reconcile(input) {
    object(input, ['operationId', 'outcome', 'messageId', 'evidence']); evidence(input.evidence); check(['delivered', 'not_delivered'].includes(input.outcome));
    return this.tx(s => { const e = s.effects.find(e => e.id === input.operationId); check(e && unresolved(e), '仅对账不确定的动作。');
      e.status = input.outcome; e.evidence = input.evidence;
      if (input.outcome === 'delivered') { text(input.messageId); e.receipt = { targetId: e.binding.sessionId, messageId: input.messageId, verifiedBy: 'operator' }; }
      return { ok: true, effect: e }; });
  }
  async status() { const s = await this.load(); this.canRead(s); return { ok: true, workflowId: s.id, title: s.title, revision: s.revision, controller: s.controller,
    policy: s.policy, bindings: s.bindings, items: s.items, effects: s.effects.map(({ fingerprint, ...e }) => e), note: 'local routing/policy records are not host authentication or proof that external evidence was verified' }; }
}

export async function sendWorkflow(workflow, input, clientFactory) {
  const { effect } = await workflow.prepareSend(input);
  if (effect.status === 'delivered') return { ok: true, reused: true, effect };
  if (effect.status !== 'prepared') fail('reconciliation-required', '发送结果已不确定或已对账；不自动重发。');
  const admitted = await workflow.admitSend(input);
  try {
    const receipt = await clientFactory(admitted.binding).request('/v1/send', { body: { sessionId: admitted.binding.sessionId, text: input.text, mode: input.mode, reference: admitted.id } });
    return await workflow.recordSend(admitted, receipt);
  } catch {
    await workflow.recordSend(admitted, null);
    fail('reconciliation-required', '发送或回执持久化未完成；可能已生效，必须先对账。');
  }
}
