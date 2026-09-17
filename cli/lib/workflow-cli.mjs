import { open } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { Workflow, sendWorkflow } from './workflow.mjs';
import { pollWorkflow } from './workflow-adapter.mjs';
import { Client } from './client.mjs';
import { check, fail } from './workflow-contract.mjs';

export const WORKFLOW_ACTIONS = Object.freeze({
  create: 'create', policy: 'configure', add: 'add', approve: 'approve', claim: 'claim', finish: 'finish', revise: 'revise',
  resume: 'resume', wait: 'wait', cancel: 'cancel', event: 'ingest', 'mark-notices': 'markNotices', rebind: 'rebind', handoff: 'handoff', reconcile: 'reconcile',
  next: 'next', status: 'status', notices: 'notices', poll: 'poll', send: 'send',
});
export const WORKFLOW_READ_ACTIONS = ['next', 'status', 'notices', 'poll'];
export async function workflowCommand(args, flags, { store, env, home }) {
  const [action, workflowId] = args;
  check(Object.hasOwn(WORKFLOW_ACTIONS, action));
  check(args.length === (action === 'create' ? 1 : 2));
  if (flags.base !== undefined) fail('invalid', 'workflow 连接地址来自版本化绑定，不能用 --base 临时替换。');
  check(flags.limit === undefined || ['next','notices'].includes(action), '--limit 仅用于 next/notices。');
  check(flags.cursor === undefined || action === 'next', '--cursor 仅用于 next。');
  const principal = { platform: flags['actor-platform'] ?? 'codex', hostId: flags['host-id'] ?? 'local', sessionId: flags.owner ?? env.CODEX_THREAD_ID };
  const workflow = new Workflow({ store, actor: principal, workflowId: workflowId ?? randomUUID() });
  let input;
  if (!WORKFLOW_READ_ACTIONS.includes(action)) {
    check(typeof flags['input-file'] === 'string', '此操作需要 --input-file JSON 文件。');
    const file = await open(flags['input-file'], 'r');
    try {
      const info = await file.stat(); check(info.isFile() && info.size <= 256 * 1024, '输入必须是最多 256KB 的普通文件。');
      const buffer = Buffer.alloc(256 * 1024 + 1);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0); check(bytesRead <= 256 * 1024, '输入文件过大。');
      try { input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytesRead))); } catch { fail('invalid', '输入文件不是 UTF-8 JSON。'); }
    } finally { await file.close(); }
  } else check(flags['input-file'] === undefined, '只读查询不接受输入文件。');
  const clients = b => new Client({ base: b.baseUrl, env, home, timeout: flags.timeout });
  if (action === 'send') return sendWorkflow(workflow, input, clients);
  if (action === 'poll') return pollWorkflow(workflow, clients);
  if (action === 'next' || action === 'notices') return workflow[WORKFLOW_ACTIONS[action]]({ ...(flags.limit !== undefined ? { limit: Number(flags.limit) } : {}), ...(flags.cursor !== undefined ? { cursor: flags.cursor } : {}) });
  return workflow[WORKFLOW_ACTIONS[action]](input);
}
