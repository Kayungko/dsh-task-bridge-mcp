import { parseArgs } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import { Client } from './client.mjs';
import { CliError } from './errors.mjs';
import { resolver } from './resolve.mjs';
import { table, fleet, fleetText, progressText, replies, replyText } from './format.mjs';

export const VERSION = '0.1.0';
const OPTIONS = {
  json: 'boolean', base: 'string', timeout: 'string', help: 'boolean', team: 'string',
  filter: 'string', ungrouped: 'boolean', all: 'boolean', lines: 'string', title: 'string',
  cwd: 'string', model: 'string', watch: 'boolean', 'auto-retry': 'boolean', steer: 'boolean',
  reference: 'string', mode: 'string', 'until-idle': 'boolean', 'max-min': 'string',
};
const ALLOWED = {
  status: [], list: ['team', 'filter', 'ungrouped', 'all'], find: [], progress: [], reply: ['lines'],
  spawn: ['title', 'team', 'cwd', 'model', 'watch', 'auto-retry'], send: ['steer', 'reference'],
  watch: ['mode', 'until-idle', 'max-min'], models: [], version: [],
};
export const HELP = `dshq ${VERSION} — Node.js ≥18.17，无 npm 依赖
用法：node D:/git/DHS-Tool/bridge-mcp/cli/dshq.mjs <命令> [参数]
全局：--json --base <回环URL> --timeout <ms> --help
status
list [--team T] [--filter S] [--ungrouped] [--all]
find <子串>
progress <会话>
reply <会话> [--lines N]
spawn <prompt> [--title T] [--team M] [--cwd D] [--model P/M] [--watch] [--auto-retry]
send <会话> <text> [--steer] [--reference R]
watch <会话…> [--mode all|any] [--until-idle] [--max-min M]
models
version
会话：完整 session-… / 8 位短 ID / title、team 子串；歧义退出 3。
watch 默认等到空闲（--until-idle 显式同义），最多 10 分钟；预算耗尽退出 1。
--json stdout 为一个 JSON 对象，心跳与中途回执写 stderr。
token 只读环境变量或文件，绝不放 argv。`;

function positive(value, name, fallback, integer = true) {
  if (value === undefined) return fallback;
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0 || number > 2147483647 || (integer && !Number.isInteger(number))) {
    throw new CliError('invalid-params', `${name} 必须是有效正${integer ? '整数' : '数'}。`);
  }
  return number;
}

export function parse(argv) {
  let parsed;
  try { parsed = parseArgs({ args: argv, allowPositionals: true, strict: true,
    options: Object.fromEntries(Object.entries(OPTIONS).map(([k, type]) => [k, { type }])) }); }
  catch { throw new CliError('invalid-params', '未知选项或缺少选项值；token 不能经 argv 传入。'); }
  const { values: flags, positionals: [command, ...args] } = parsed;
  if (flags.help) return { command: 'help', flags, args };
  if (!Object.hasOwn(ALLOWED, command ?? '')) throw new CliError('invalid-params', '缺少或未知命令。');
  for (const key of Object.keys(flags)) {
    if (!['json', 'base', 'timeout', 'help', ...ALLOWED[command]].includes(key)) {
      throw new CliError('invalid-params', `该命令不支持 --${key}。`);
    }
  }
  const count = { find: 1, progress: 1, reply: 1, spawn: 1, send: 2 }[command] ?? 0;
  if ((command === 'watch' ? args.length < 1 : args.length !== count) || args.some(x => !x.trim())) {
    throw new CliError('invalid-params', '位置参数数量错误或内容为空。');
  }
  flags.waitTimeout = positive(flags.timeout, '--timeout', 45000);
  flags.timeout = positive(flags.timeout, '--timeout', 30000);
  if (flags.lines !== undefined) flags.lines = positive(flags.lines, '--lines', 3);
  flags.maxMinutes = positive(flags['max-min'], '--max-min', 10, false);
  if (flags.mode && !['all', 'any'].includes(flags.mode)) throw new CliError('invalid-params', '--mode 只能是 all 或 any。');
  if (flags.model !== undefined && !/^[^/\s]+\/\S+$/.test(flags.model)) {
    throw new CliError('invalid-params', '--model 必须是目录中的 provider/model；先用 dshq models 查真实 ID。');
  }
  return { command, flags, args };
}

async function watch(client, ids, flags, note) {
  const deadline = Date.now() + flags.maxMinutes * 60000;
  let last = { ok: true, settled: false, targets: [] };
  let rounds = 0;
  while (Date.now() < deadline) {
    const remaining = Math.max(1, Math.ceil(deadline - Date.now()));
    const waitMs = Math.max(1, Math.min(45000, remaining, flags.timeout));
    const started = Date.now();
    last = await client.request('/v1/wait', { query: {
      sessionIds: ids.join(','), mode: flags.mode ?? 'all', timeoutMs: waitMs,
    }, timeout: Math.min(55000, waitMs + 5000) });
    if (typeof last.settled !== 'boolean') throw new CliError('bridge-invalid-response', 'wait 缺少 settled 布尔值。');
    rounds++;
    note(`心跳 ${rounds}: settled=${last.settled}，waitedMs=${last.waitedMs ?? Date.now() - started}；${ids.join(', ')}`);
    if (last.settled) break;
    // Normal bridge wait blocks. Back off anomalously immediate false responses too.
    if (Date.now() - started < 1000) await sleep(Math.max(0, Math.min(1000, deadline - Date.now())));
  }
  const progress = [];
  for (const sessionId of ids) progress.push(await client.request('/v1/progress', { query: { sessionId } }));
  const result = { ...last, sessionIds: ids, rounds, timedOut: !last.settled, progress };
  if (!last.settled) throw new CliError('watch-timeout', '等待预算已耗尽，目标尚未全部达到所选空闲条件。', {
    ...result, advice: '当前轮未完成；读取 progress 后按需继续 dshq watch，勿重复派发或假定完成。',
  });
  return result;
}

function watchText(data) {
  return [`settled=${data.settled}; rounds=${data.rounds}`, ...data.progress.map(p => replyText(replies(p, 1)))].join('\n\n');
}

export async function run(argv, { env = process.env, home, stdout = process.stdout, stderr = process.stderr } = {}) {
  const client = new Client({ env, home });
  let json = argv.includes('--json');
  const out = text => stdout.write(client.redact(text) + '\n');
  const note = text => stderr.write(client.redact(text) + '\n');
  try {
    const { command, flags, args } = parse(argv);
    json = !!flags.json;
    if (command === 'help') { out(json ? JSON.stringify({ ok: true, help: HELP }) : HELP); return 0; }
    client.base = flags.base ?? client.base;
    client.timeout = flags.timeout;
    const ids = resolver(client);
    const output = (data, text) => out(json ? JSON.stringify(data) : text ?? JSON.stringify(data, null, 2));
    switch (command) {
      case 'version': {
        const bridge = await client.request('/v1/models');
        const data = { ok: true, cliVersion: VERSION, bridgeReachable: bridge.ok, tokenSource: client.tokenSource };
        output(data, `dshq ${VERSION}\n桥可达: ${bridge.ok}\ntoken 来源: ${data.tokenSource}`);
        break;
      }
      case 'models': {
        output(await client.request('/v1/models'));
        break;
      }
      case 'status': {
        const data = fleet(await client.request('/v1/list', { query: { limit: 500 } }));
        output(data, fleetText(data));
        break;
      }
      case 'list': {
        const data = await client.request('/v1/list', { query: {
          limit: 500, team: flags.team, filter: flags.filter, ungrouped: flags.ungrouped,
        } });
        const tasks = data.tasks.filter(t => flags.all || t.status !== 'blank');
        output({ ...data, tasks, visibleCount: tasks.length }, `${table(tasks)}${data.truncated ? '\n列表已截断。' : ''}`);
        break;
      }
      case 'find': {
        const tasks = await ids.candidates(args[0]);
        output({ ok: true, count: tasks.length, tasks }, tasks.length ? table(tasks) : '无匹配；请用 dshq list 查看。');
        break;
      }
      case 'progress':
      case 'reply': {
        const sessionId = await ids.resolve(args[0]);
        const raw = await client.request('/v1/progress', { query: { sessionId } });
        if (command === 'progress') output(raw, progressText(raw));
        else { const data = replies(raw, flags.lines); output(data, replyText(data)); }
        break;
      }
      case 'send': {
        const sessionId = await ids.resolve(args[0]);
        const data = await client.request('/v1/send', { body: {
          sessionId, text: args[1], mode: flags.steer ? 'steer' : 'queue',
          ...(flags.reference === undefined ? {} : { reference: flags.reference }),
        } });
        output(data);
        note(`sessionId: ${sessionId}；queueDepth=${JSON.stringify(data.queueDepth ?? {})}；投递不等于消费。`);
        const depth = data.queueDepth?.nextTurn ?? 0;
        if (depth > 0) note(`深度 ${depth} ≈ ${depth} 轮后被读；晚一步=白干一步时用 --steer，否则等一轮。`);
        if (flags.steer) note('steer：运行中下一步生效、延长当前回合；空闲/abort 收尾期降级为 next-turn，不能强停正在执行的工具。');
        break;
      }
      case 'spawn': {
        const body = { prompt: args[0] };
        for (const key of ['title', 'team', 'cwd']) if (flags[key] !== undefined) body[key] = flags[key];
        if (flags.model) {
          const slash = flags.model.indexOf('/');
          body.provider = flags.model.slice(0, slash); body.model = flags.model.slice(slash + 1);
        }
        let receipt;
        for (let attempt = 0; ; attempt++) {
          try { receipt = await client.request('/v1/spawn', { body }); break; }
          catch (error) {
            const delay = error.payload?.retryAfterMs;
            if (!flags['auto-retry'] || error.payload?.code !== 'policy-gated' || attempt >= 3 ||
                error.payload?.upstreamCode === 'spawn-depth-exceeded' || !Number.isFinite(delay) || delay < 0) throw error;
            note(`policy-gated: retryAfterMs=${delay}；等待后重试 ${attempt + 1}/3。`);
            // Chunk long delays to avoid Node's timer overflow and show continued waiting.
            let left = Math.max(1, delay);
            while (left > 0) { const chunk = Math.min(left, 45000); await sleep(chunk); left -= chunk;
              if (left > 0) note(`策略闸退避中，剩余 ${left}ms。`); }
          }
        }
        if (!flags.watch) { output(receipt); break; }
        note(`spawn 回执: ${JSON.stringify(receipt)}`);
        if (!receipt.sessionId) throw new CliError('bridge-invalid-response', 'spawn 回执缺少 sessionId；不要重复派发。');
        const data = await watch(client, [receipt.sessionId], { ...flags, timeout: flags.waitTimeout }, note);
        output({ ok: true, spawn: receipt, watch: data }, `${JSON.stringify(receipt, null, 2)}\n${watchText(data)}`);
        break;
      }
      case 'watch': {
        const sessionIds = [];
        for (const query of args) sessionIds.push(await ids.resolve(query));
        const data = await watch(client, [...new Set(sessionIds)], { ...flags, timeout: flags.waitTimeout }, note);
        output(data, watchText(data));
        break;
      }
    }
    return 0;
  } catch (error) {
    const failure = error instanceof CliError ? error : new CliError('internal-error', 'CLI 内部错误；请报告用户。');
    if (json) out(JSON.stringify(failure.payload));
    else {
      note(`${failure.payload.code}: ${failure.message}\n补救: ${failure.payload.advice}`);
      if (failure.payload.candidates) note(table(failure.payload.candidates));
      if (failure.payload.sessionId) note(`sessionId: ${failure.payload.sessionId}`);
      if (failure.payload.progress) note(watchText(failure.payload));
    }
    return failure.exitCode;
  }
}
