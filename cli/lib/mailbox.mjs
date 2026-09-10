import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { CliError } from './errors.mjs';

const mailError = message => new CliError('mailbox-error', message, {
  advice: '检查信件 frontmatter、文件名和 CODEX_THREAD_ID；不要猜收件人或改写其他文件。',
});
export function recipient(value) {
  return String(value).replace(/^codex:\/\/threads\//, '');
}
export function threadIdentity(env) {
  const id = env.CODEX_THREAD_ID?.trim();
  if (!id) throw mailError('无法识别本 thread；可用 mailbox --all 查看，禁止自动猜测身份。');
  return recipient(id);
}
export function parseMail(raw, filename) {
  const match = raw.match(/^(?:\uFEFF)?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) throw mailError(`信件 ${filename} 缺少 frontmatter。`);
  const meta = Object.create(null);
  for (const line of match[1].split(/\r?\n/)) {
    if (!line.trim()) continue;
    const field = line.match(/^([A-Za-z][\w-]*):[ \t]*(.*)$/);
    if (!field || Object.hasOwn(meta, field[1])) throw mailError(`信件 ${filename} 字段格式错误或重复。`);
    let value = field[2];
    if (value.startsWith('"')) {
      try { value = JSON.parse(value); } catch { throw mailError(`信件 ${filename} 引号格式错误。`); }
    } else if (value.startsWith("'")) {
      if (!value.endsWith("'")) throw mailError(`信件 ${filename} 引号格式错误。`);
      value = value.slice(1, -1).replace(/''/g, "'");
    }
    if (typeof value !== 'string') throw mailError(`信件 ${filename} 字段必须是字符串。`);
    meta[field[1]] = value;
  }
  if (['to', 'from', 'subject', 'written'].some(k => !meta[k]?.trim()) ||
      !['unread', 'acked'].includes(meta.status) || !Number.isFinite(Date.parse(meta.written))) {
    throw mailError(`信件 ${filename} 缺少必填字段或字段值不合法。`);
  }
  return { ...meta, filename, header: match[0], body: raw.slice(match[0].length), raw };
}

export class Mailbox {
  constructor(store, env) { this.store = store; this.env = env; }
  safeName(filename) {
    if (!filename.endsWith('.md') || /[\\/:\x00-\x1f]/.test(filename) || filename.startsWith('.')) {
      throw mailError('必须提供 outbox 内的 Markdown 文件名，拒绝路径穿越。');
    }
    return `outbox/${filename}`;
  }
  async all() {
    await this.store.guard();
    let filenames;
    try { filenames = await this.store.io.readdir(join(this.store.root, 'outbox')); }
    catch (e) { if (e.code === 'ENOENT') return []; throw mailError('无法读取 outbox。'); }
    const messages = [];
    for (const filename of filenames.filter(n => n.endsWith('.md')).sort()) {
      const raw = await this.store.text(this.safeName(filename), null);
      if (raw !== null) messages.push({ ...parseMail(raw, filename), index: messages.length + 1 });
    }
    return messages;
  }
  async list(all = false) {
    const identity = all ? null : threadIdentity(this.env);
    return (await this.all()).filter(m => all || (m.status === 'unread' &&
      (recipient(m.to) === identity || m.to === 'broadcast')));
  }
  async filename(selector) {
    if (!/^\d+$/.test(selector)) { this.safeName(selector); return selector; }
    const message = (await this.all()).find(m => m.index === Number(selector));
    if (!message) throw mailError('信件序号不存在；请重新 mailbox 列表并优先使用完整文件名。');
    return message.filename;
  }
  async read(selector) {
    const filename = await this.filename(selector);
    const raw = await this.store.text(this.safeName(filename), null);
    if (raw === null) throw mailError('信件不存在；请重新查信箱。');
    return parseMail(raw, filename);
  }
  async ack(selector) {
    // Resolve numeric selection once, then reread the same file inside the write lock.
    const filename = await this.filename(selector);
    return this.store.locked(async () => {
      const mail = await this.read(filename);
      if (mail.status === 'acked') return { ok: true, filename, status: 'acked', changed: false };
      const header = mail.header.replace(/^status:[^\r\n]*$/m, 'status: acked');
      if (header === mail.header) throw mailError('未找到唯一 status 行，拒绝修改。');
      await this.store.atomic(this.safeName(filename), header + mail.body);
      return { ok: true, filename, status: 'acked', changed: true };
    });
  }
  async send(to, subject, bodyFile) {
    const from = `codex://threads/${threadIdentity(this.env)}`;
    if (!to.trim() || !subject.trim() || /[\r\n\x00-\x1f]/.test(to + subject)) throw mailError('收件人和主题必须是非空单行文本。');
    const aliases = await this.store.aliases();
    const target = Object.hasOwn(aliases, to) ? aliases[to] : to;
    let body = '';
    if (bodyFile !== undefined) {
      try { body = await readFile(bodyFile, 'utf8'); } catch { throw mailError('无法读取 --body-file。'); }
    }
    const written = new Date().toISOString();
    const d = new Date();
    const pad = n => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
    const slug = encodeURIComponent(recipient(target));
    if (slug.length > 160) throw mailError('收件人过长，无法生成安全文件名。');
    const filename = `${stamp}-${slug}.md`;
    return this.store.locked(async () => {
      const name = this.safeName(filename);
      if (await this.store.stat(join(this.store.root, name))) throw mailError('同秒同收件人信件已存在；稍后再试，不覆盖旧信。');
      const fields = { to: target, from, subject, status: 'unread', written };
      const raw = '---\n' + Object.entries(fields).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join('\n') + '\n---\n\n' + body;
      await this.store.atomic(name, this.store.redact(raw));
      return { ok: true, filename, ...fields };
    });
  }
}

export function mailTable(messages) {
  const cell = v => String(v).replace(/\s+/g, ' ');
  return ['序号 | 文件名 | to | from | subject | status | written', ...messages.map(m =>
    [m.index, m.filename, m.to, m.from, m.subject, m.status, m.written].map(cell).join(' | '))].join('\n');
}
