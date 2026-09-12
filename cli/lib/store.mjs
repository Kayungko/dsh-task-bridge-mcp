import * as fs from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { CliError } from './errors.mjs';

const localError = (message, details = {}) => new CliError('local-state-error', message, {
  advice: '检查 ~/.dshq 状态及占用；保留原文件，不自动重建损坏数据或重复派发。', ...details,
});
export const validSession = value => typeof value === 'string' && /^session-\S+$/.test(value);

export class Store {
  constructor({ home = homedir(), redact = String, io = fs } = {}) {
    this.root = resolve(home, '.dshq');
    this.redact = redact;
    this.io = io; // File operations can be injected to test failures before rename.
  }
  async stat(path) {
    try { return await this.io.lstat(path); }
    catch (e) { if (e.code === 'ENOENT') return null; throw localError('无法检查本地状态文件。'); }
  }
  async checkFile(path) {
    const info = await this.stat(path);
    if (info && (info.isSymbolicLink() || !info.isFile() || info.nlink > 1)) {
      throw localError('状态目标必须是普通独占文件，拒绝链接或目录。');
    }
  }
  async guard() {
    // Refuse state roots within any checkout, including injected test homes.
    for (let p = this.root; ; p = dirname(p)) {
      if (await this.stat(join(p, '.git'))) throw localError('拒绝在 Git 仓库中写用户级状态。');
      if (p === dirname(p)) break;
    }
    for (const path of [this.root, join(this.root, 'outbox')]) {
      const info = await this.stat(path);
      if (info && (info.isSymbolicLink() || !info.isDirectory())) throw localError('状态目录不能是链接或普通文件。');
    }
  }
  async text(name, fallback) {
    const path = join(this.root, name);
    await this.guard();
    await this.checkFile(path);
    try { return await this.io.readFile(path, 'utf8'); }
    catch (e) { if (e.code === 'ENOENT') return fallback; throw localError('读取本地状态失败。'); }
  }
  async json(name, fallback) {
    const raw = await this.text(name, null);
    if (raw === null) return fallback;
    try { return JSON.parse(raw.replace(/^\uFEFF/, '')); }
    catch { throw localError(`${name} 已损坏；拒绝覆盖。`); }
  }
  async aliases() {
    const data = await this.json('aliases.json', {});
    if (!data || Array.isArray(data) || typeof data !== 'object' || Object.values(data).some(v => !validSession(v))) {
      throw localError('aliases.json 格式不合法。');
    }
    return data;
  }
  async waves() {
    const data = await this.json('waves.json', []);
    if (!Array.isArray(data) || data.some(v => !v || !validSession(v.sessionId) ||
      typeof v.shortId !== 'string' || typeof v.title !== 'string' || typeof v.team !== 'string' ||
      typeof v.promptExcerpt !== 'string' || !Number.isFinite(Date.parse(v.spawnedAt)) ||
      (v.ref !== undefined && typeof v.ref !== 'string'))) throw localError('waves.json 格式不合法。');
    return data;
  }
  async locked(action) {
    await this.guard();
    await this.io.mkdir(this.root, { recursive: true });
    const lock = join(this.root, '.write-lock');
    const until = Date.now() + 3000;
    while (true) {
      try { await this.io.mkdir(lock); break; }
      catch (e) {
        if (e.code !== 'EEXIST') throw localError('无法取得状态写锁。');
        if (Date.now() >= until) throw localError('状态正被占用；若此前进程异常退出，请先核对遗留 .write-lock。');
        await sleep(40);
      }
    }
    try { return await action(); }
    finally { await this.io.rmdir(lock); }
  }
  async atomic(name, content) {
    const path = join(this.root, name);
    await this.guard();
    await this.io.mkdir(dirname(path), { recursive: true });
    await this.checkFile(path);
    const temp = `${path}.${randomUUID()}.tmp`;
    let file;
    try {
      file = await this.io.open(temp, 'wx', 0o600);
      await file.writeFile(content, 'utf8');
      await file.sync(); await file.close(); file = null;
      for (let attempt = 0; ; attempt++) {
        try { await this.io.rename(temp, path); break; }
        catch (error) {
          if (attempt >= 3 || !['EBUSY', 'EPERM', 'EACCES'].includes(error?.code)) throw error;
          await sleep(40 * (attempt + 1));
        }
      }
    } catch (error) {
      throw localError('原子写入未完成；原文件保留，不得据此重复派发。',
        /^[A-Z0-9_]+$/.test(error?.code ?? '') ? { ioCode: error.code } : {});
    } finally {
      if (file) await file.close();
      await this.io.unlink(temp).catch(e => { if (e.code !== 'ENOENT') throw localError('临时文件清理失败。'); });
    }
  }
  async pin(alias, sessionId) {
    if (!alias.trim() || /[\r\n\x00-\x1f]/.test(alias) || !validSession(sessionId)) throw localError('别名或 sessionId 不合法。');
    return this.locked(async () => {
      const pins = await this.aliases();
      const previous = Object.hasOwn(pins, alias) ? pins[alias] : null;
      Object.defineProperty(pins, alias, { value: sessionId, enumerable: true, writable: true, configurable: true });
      await this.atomic('aliases.json', this.redact(JSON.stringify(pins, null, 2)) + '\n');
      return { ok: true, alias, sessionId, previous };
    });
  }
  async unpin(alias) {
    return this.locked(async () => {
      const pins = await this.aliases();
      if (!Object.hasOwn(pins, alias)) throw new CliError('alias-not-found', '别名不存在。');
      const sessionId = pins[alias]; delete pins[alias];
      await this.atomic('aliases.json', JSON.stringify(pins, null, 2) + '\n');
      return { ok: true, alias, sessionId };
    });
  }
  async record(receipt, prompt, ref) {
    if (!validSession(receipt.sessionId)) throw localError('spawn 回执缺少合法 sessionId，未记账。');
    return this.locked(async () => {
      const waves = await this.waves();
      const entry = { sessionId: receipt.sessionId,
        shortId: receipt.shortId ?? receipt.sessionId.replace(/^session-/, '').slice(0, 8),
        team: receipt.team ?? '', title: receipt.title ?? '', spawnedAt: new Date().toISOString(),
        promptExcerpt: [...this.redact(prompt)].slice(0, 80).join(''), ...(ref ? { ref } : {}) };
      waves.push(entry);
      await this.atomic('waves.json', this.redact(JSON.stringify(waves.slice(-500), null, 2)) + '\n');
      return entry;
    });
  }
}

export function waveMatches(entries, query) {
  const needle = query.toLowerCase();
  return entries.filter(e => [e.team, e.title, e.sessionId, e.ref].some(v => v?.toLowerCase().includes(needle)));
}

export async function liveWaves(store, client, team) {
  const entries = (await store.waves()).filter(e => team === undefined || e.team === team)
    .sort((a, b) => b.spawnedAt.localeCompare(a.spawnedAt));
  const tasks = [];
  let unreachable;
  for (const entry of entries) {
    try {
      if (unreachable) throw unreachable;
      const p = await client.request('/v1/progress', { query: { sessionId: entry.sessionId } });
      const todos = Array.isArray(p.todos) ? p.todos : p.todos?.items;
      const summary = typeof p.todos === 'string' ? p.todos.match(/^(\d+)\/(\d+) done$/) : null;
      const pending = p.pendingTodos ?? (Array.isArray(todos) ? todos.filter(t => !['completed', 'done'].includes(t.status)).length :
        (summary ? Number(summary[2]) - Number(summary[1]) : null));
      tasks.push({ ...entry, status: p.agentState, pendingTodos: pending,
        falseIdle: ['idle', 'cold-idle'].includes(p.agentState) && pending > 0,
        todos: p.todos, goal: p.goal, stale: false, ...(p.externalRef ? { externalRef: p.externalRef } : {}) });
    } catch (e) {
      if (!['bridge-unreachable', 'bridge-timeout', 'token-missing', 'upstream-error', 'not-found'].includes(e.payload?.code)) throw e;
      if (['bridge-unreachable', 'bridge-timeout', 'token-missing'].includes(e.payload.code)) unreachable = e;
      tasks.push({ ...entry, status: 'unknown', stale: true, stateError: e.payload.code });
    }
  }
  return { ok: true, stale: tasks.some(t => t.stale), tasks,
    groups: [...new Set(tasks.map(t => t.team))].map(team => ({ team, tasks: tasks.filter(t => t.team === team) })) };
}
