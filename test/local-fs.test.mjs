// local-fs.test.mjs —— 本地文件/命令工具（0.5.0）离线回归。
// 真 fs + mkdtemp 独占临时目录（不碰用户 ~/.dsh、不碰仓库）；exec 用真跑临时脚本，
// 因为 shell 行为在 Windows(cmd.exe) 与 POSIX 上不同，mock 会掩盖真实差异。
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';

import {
  buildLocalTools,
  buildLocalInstructions,
  buildExecEnv,
  canonical,
  createLocalTools,
  guardPath,
  guardWalkEntry,
  isProtectedByDefault,
  protectedAlways,
  resolveLocalConfig,
  LocalToolError,
  DEFAULT_MAX_BYTES,
  DEFAULT_EXEC_TIMEOUT_MS,
} from '../src/local-fs.mjs';
import { handleRpcMessage } from '../src/server.mjs';
import { TOOLS } from '../src/tools.mjs';

const TMP = mkdtempSync(join(tmpdir(), 'dsh-local-fs-'));
after(() => { try { rmSync(TMP, { recursive: true, force: true }); } catch { /* 尽力清理 */ } });

/** 造一组只在临时目录里活动、日志可捕获的实现。 */
function makeImpl(envOverrides = {}) {
  const logs = { info: [], warn: [] };
  const env = { DSH_BRIDGE_LOCAL_FS: '1', ...envOverrides };
  const impl = createLocalTools({
    env,
    config: resolveLocalConfig(env),
    logger: { info: (m) => logs.info.push(m), warn: (m) => logs.warn.push(m) },
  });
  return { impl, logs, env };
}

// ---------------------------------------------------------------------------
// env 门控：默认关闭 = 既有链路零变化
// ---------------------------------------------------------------------------

test('门控：不设任何 env 时一个本地工具都不注册', () => {
  assert.deepEqual(buildLocalTools({ env: {} }), []);
  assert.deepEqual(buildLocalTools({ env: { DSH_BRIDGE_LOCAL_FS: '0', DSH_BRIDGE_LOCAL_EXEC: '0' } }), []);
  // 空字符串 / 其他真值都不算启用：只认字面 '1'，避免 "true"/"yes" 之类被误判
  assert.deepEqual(buildLocalTools({ env: { DSH_BRIDGE_LOCAL_FS: 'true' } }), []);
  assert.deepEqual(buildLocalTools({ env: { DSH_BRIDGE_LOCAL_FS: '' } }), []);
});

test('门控：DSH_BRIDGE_LOCAL_FS=1 只给文件四件套，不含 exec', () => {
  const names = buildLocalTools({ env: { DSH_BRIDGE_LOCAL_FS: '1' } }).map((t) => t.name);
  assert.deepEqual(names, ['local_read_file', 'local_write_file', 'local_list_dir', 'local_grep']);
});

test('门控：DSH_BRIDGE_LOCAL_EXEC=1 单独只给 local_exec（可只开 shell 不开文件）', () => {
  const names = buildLocalTools({ env: { DSH_BRIDGE_LOCAL_EXEC: '1' } }).map((t) => t.name);
  assert.deepEqual(names, ['local_exec']);
});

test('门控：两个都开给 5 个，且都带 input/outputSchema', () => {
  const tools = buildLocalTools({ env: { DSH_BRIDGE_LOCAL_FS: '1', DSH_BRIDGE_LOCAL_EXEC: '1' } });
  assert.equal(tools.length, 5);
  for (const t of tools) {
    assert.equal(typeof t.description, 'string');
    assert.ok(t.description.length > 40, `${t.name} 的 description 太短，模型读不懂`);
    assert.equal(t.inputSchema.type, 'object');
    assert.equal(t.outputSchema.type, 'object', `${t.name} 缺 outputSchema`);
    assert.equal(typeof t.handler, 'function');
  }
});

test('门控：配置默认值与非法值回退', () => {
  const d = resolveLocalConfig({});
  assert.equal(d.maxBytes, DEFAULT_MAX_BYTES);
  assert.equal(d.execTimeoutMs, DEFAULT_EXEC_TIMEOUT_MS);
  assert.equal(d.denyCredentials, true);
  // 非法值回退默认，不猜测
  const bad = resolveLocalConfig({ DSH_BRIDGE_FS_MAX_BYTES: 'abc', DSH_BRIDGE_EXEC_TIMEOUT_MS: '-5' });
  assert.equal(bad.maxBytes, DEFAULT_MAX_BYTES);
  assert.equal(bad.execTimeoutMs, DEFAULT_EXEC_TIMEOUT_MS);
  const good = resolveLocalConfig({ DSH_BRIDGE_FS_MAX_BYTES: '1024', DSH_BRIDGE_EXEC_TIMEOUT_MS: '5000' });
  assert.equal(good.maxBytes, 1024);
  assert.equal(good.execTimeoutMs, 5000);
});

test('门控：instructions 按启用集合动态拼接，未启用不提本地工具', () => {
  assert.deepEqual(buildLocalInstructions(resolveLocalConfig({})), []);
  const fsOnly = buildLocalInstructions(resolveLocalConfig({ DSH_BRIDGE_LOCAL_FS: '1' }));
  assert.equal(fsOnly.length, 2);
  assert.ok(fsOnly.some((l) => l.includes('local_write_file')));
  assert.ok(!fsOnly.some((l) => l.includes('local_exec')), '只开文件时不得提 exec，否则诱导模型调不存在的工具');
  const both = buildLocalInstructions(resolveLocalConfig({ DSH_BRIDGE_LOCAL_FS: '1', DSH_BRIDGE_LOCAL_EXEC: '1' }));
  assert.equal(both.length, 3);
  assert.ok(both.some((l) => l.includes('破坏性命令')), 'exec 纪律必须点名破坏性命令需先确认');
});

test('门控：解除默认凭据保护时启动打强告警', () => {
  const { logs } = makeImpl({ DSH_BRIDGE_FS_DENY_CREDENTIALS: '0' });
  assert.equal(logs.warn.length, 1);
  assert.match(logs.warn[0], /DSH_BRIDGE_FS_DENY_CREDENTIALS=0/);
  assert.match(logs.warn[0], /\.ssh/);
  // 默认（保护开启）不该有这条告警
  assert.equal(makeImpl().logs.warn.length, 0);
});

// ---------------------------------------------------------------------------
// local_read_file
// ---------------------------------------------------------------------------

test('readFile：返回带行号内容（cat -n 风格）与行数元信息', () => {
  const { impl } = makeImpl();
  const f = join(TMP, 'read-basic.txt');
  writeFileSync(f, 'alpha\nbeta\ngamma\n', 'utf8');

  const r = impl.readFile({ path: f });

  assert.equal(r.ok, true);
  assert.equal(r.path, f);
  assert.equal(r.totalLines, 4); // 尾换行产生一个空行
  assert.equal(r.returnedLines, 4);
  assert.equal(r.truncatedByLimit, false);
  assert.match(r.content, /^1\talpha\n2\tbeta\n3\tgamma\n4\t$/u);
});

test('readFile：offset/limit 分页正确且如实报告 truncatedByLimit', () => {
  const { impl } = makeImpl();
  const f = join(TMP, 'read-page.txt');
  writeFileSync(f, Array.from({ length: 10 }, (_, i) => `line${i + 1}`).join('\n'), 'utf8');

  const page = impl.readFile({ path: f, offset: 3, limit: 2 });
  assert.equal(page.returnedLines, 2);
  assert.match(page.content, /^4\tline4\n5\tline5$/u, '行号必须是绝对行号，不是分页内序号');
  assert.equal(page.truncatedByLimit, true);

  const tail = impl.readFile({ path: f, offset: 8, limit: 100 });
  assert.equal(tail.returnedLines, 2);
  assert.equal(tail.truncatedByLimit, false, '取到末尾就不算被 limit 截断');
});

test('readFile：不存在 → not-found；目录 → is-directory', () => {
  const { impl } = makeImpl();
  try {
    impl.readFile({ path: join(TMP, 'nope.txt') });
    assert.fail('应当抛出');
  } catch (e) {
    assert.ok(e instanceof LocalToolError);
    assert.equal(e.code, 'not-found');
  }
  try {
    impl.readFile({ path: TMP });
    assert.fail('应当抛出');
  } catch (e) {
    assert.equal(e.code, 'is-directory');
    assert.match(e.message, /local_list_dir/, '要告诉模型改用哪个工具');
  }
});

test('readFile：二进制文件拒绝返回内容（含 NUL 即判）', () => {
  const { impl } = makeImpl();
  const f = join(TMP, 'binary.bin');
  writeFileSync(f, Buffer.from([0x50, 0x4b, 0x00, 0x01, 0x00, 0xff]));

  try {
    impl.readFile({ path: f });
    assert.fail('应当抛出');
  } catch (e) {
    assert.equal(e.code, 'binary-file');
    assert.match(e.message, /local_exec/, '要给出替代路径');
    assert.ok(!e.message.includes('PK'), '错误消息不得回吐文件内容');
  }
});

test('readFile：超过 maxBytes → too-large 并提示分页', () => {
  const env = { DSH_BRIDGE_LOCAL_FS: '1', DSH_BRIDGE_FS_MAX_BYTES: '64' };
  const impl = createLocalTools({ env, config: resolveLocalConfig(env), logger: { info() {}, warn() {} } });
  const f = join(TMP, 'big.txt');
  writeFileSync(f, 'x'.repeat(200), 'utf8');

  try {
    impl.readFile({ path: f });
    assert.fail('应当抛出');
  } catch (e) {
    assert.equal(e.code, 'too-large');
    assert.match(e.message, /offset\/limit/);
    assert.match(e.message, /200 字节/);
  }
});

test('readFile：缺 path / path 非字符串 → invalid-params', () => {
  const { impl } = makeImpl();
  for (const bad of [{}, { path: '' }, { path: '   ' }, { path: 42 }]) {
    try {
      impl.readFile(bad);
      assert.fail(`应当抛出：${JSON.stringify(bad)}`);
    } catch (e) {
      assert.equal(e.code, 'invalid-params');
    }
  }
});

// ---------------------------------------------------------------------------
// 凭据保护（本套件的核心安全断言）
// ---------------------------------------------------------------------------

test('保护：桥自己的 token 文件强制不可读，且不可通过 env 解除', () => {
  const tokenPath = join(homedir(), '.dsh', 'task-bridge-token');
  // 注意：guardPath 在 stat 之前拒绝，所以这条断言不会真的读到用户 token 内容
  for (const env of [{ DSH_BRIDGE_LOCAL_FS: '1' }, { DSH_BRIDGE_LOCAL_FS: '1', DSH_BRIDGE_FS_DENY_CREDENTIALS: '0' }]) {
    const impl = createLocalTools({ env, config: resolveLocalConfig(env), logger: { info() {}, warn() {} } });
    try {
      impl.readFile({ path: tokenPath });
      assert.fail('token 文件必须被拒绝');
    } catch (e) {
      assert.equal(e.code, 'credential-protected');
      assert.match(e.message, /不可通过配置解除/);
    }
  }
  // protectedAlways 返回 canonical（小写 + 解析真实路径）形式，比较必须两侧同形
  assert.ok(protectedAlways({}).includes(canonical(tokenPath)), `应含 ${tokenPath}`);
});

test('保护：TASK_BRIDGE_TOKEN_FILE 指向的自定义路径同样受强制保护', () => {
  const custom = join(TMP, 'custom-token.txt');
  writeFileSync(custom, 'super-secret-value', 'utf8');
  const env = { DSH_BRIDGE_LOCAL_FS: '1', TASK_BRIDGE_TOKEN_FILE: custom };
  const impl = createLocalTools({ env, config: resolveLocalConfig(env), logger: { info() {}, warn() {} } });

  try {
    impl.readFile({ path: custom });
    assert.fail('自定义 token 路径也必须被拒绝');
  } catch (e) {
    assert.equal(e.code, 'credential-protected');
  }
  // 写方向同样拒绝：不能通过覆写来篡改凭据
  try {
    impl.writeFile({ path: custom, content: 'pwned' });
    assert.fail('写方向也必须拒绝');
  } catch (e) {
    assert.equal(e.code, 'credential-protected');
  }
  assert.equal(readFileSync(custom, 'utf8'), 'super-secret-value', '文件内容必须原样未被触碰');
});

test('保护：DSH 宿主凭据 .credentials.yaml 强制不可读', () => {
  const credPath = join(homedir(), '.dsh', '.credentials.yaml');
  assert.ok(protectedAlways({}).includes(canonical(credPath)), `应含 ${credPath}`);
  const { impl } = makeImpl();
  try {
    impl.readFile({ path: credPath });
    assert.fail('应当抛出');
  } catch (e) {
    assert.equal(e.code, 'credential-protected');
  }
});

test('保护：默认凭据模式命中 .env / 私钥 / pem / ~/.ssh', () => {
  const home = homedir();
  assert.equal(isProtectedByDefault(join(home, '.ssh', 'id_rsa'), home), true);
  assert.equal(isProtectedByDefault(join(home, '.ssh', 'config'), home), true, '~/.ssh 整棵树都保护');
  assert.equal(isProtectedByDefault(join(home, '.aws', 'credentials'), home), true);
  assert.equal(isProtectedByDefault('/proj/.env', home), true);
  assert.equal(isProtectedByDefault('/proj/.env.production', home), true);
  assert.equal(isProtectedByDefault('/proj/server.pem', home), true);
  assert.equal(isProtectedByDefault('/proj/id_ed25519', home), true);
  // 正常代码文件不受影响
  assert.equal(isProtectedByDefault('/proj/src/index.mjs', home), false);
  assert.equal(isProtectedByDefault('/proj/.env.example', home), true, '.env.* 一律视为可能含真值，宁可严');
  assert.equal(isProtectedByDefault('/proj/environment.ts', home), false, '不得误伤 environment.ts 这类正常文件名');
});

test('保护：默认保护可被 DSH_BRIDGE_FS_DENY_CREDENTIALS=0 显式解除', () => {
  const f = join(TMP, '.env');
  writeFileSync(f, 'API_KEY=dummy-for-test\n', 'utf8');

  const strict = makeImpl();
  try {
    strict.impl.readFile({ path: f });
    assert.fail('默认必须拒绝 .env');
  } catch (e) {
    assert.equal(e.code, 'credential-protected');
    assert.match(e.message, /DSH_BRIDGE_FS_DENY_CREDENTIALS=0/, '拒绝理由要告诉用户怎么解除');
  }

  const loose = makeImpl({ DSH_BRIDGE_FS_DENY_CREDENTIALS: '0' });
  const r = loose.impl.readFile({ path: f });
  assert.equal(r.ok, true, '显式解除后应当可读');
  assert.match(r.content, /API_KEY=dummy-for-test/);
});

test('保护：DSH_BRIDGE_FS_DENY 用户黑名单按目录前缀生效', () => {
  const secretDir = join(TMP, 'vault');
  mkdirSync(secretDir, { recursive: true });
  const secretFile = join(secretDir, 'notes.txt');
  writeFileSync(secretFile, 'private', 'utf8');
  const env = { DSH_BRIDGE_LOCAL_FS: '1', DSH_BRIDGE_FS_DENY: secretDir };
  const impl = createLocalTools({ env, config: resolveLocalConfig(env), logger: { info() {}, warn() {} } });

  try {
    impl.readFile({ path: secretFile });
    assert.fail('子文件也应被目录前缀规则拒绝');
  } catch (e) {
    assert.equal(e.code, 'path-denied');
    assert.match(e.message, /DSH_BRIDGE_FS_DENY/);
  }
  // 黑名单外的路径不受影响
  const other = join(TMP, 'read-basic.txt');
  assert.equal(impl.readFile({ path: other }).ok, true);
});

test('保护：路径含 NUL 字节一律拒绝', () => {
  assert.throws(() => guardPath(join(TMP, 'a\0b.txt'), {}), (e) => e.code === 'invalid-params');
});

// ---------------------------------------------------------------------------
// local_write_file
// ---------------------------------------------------------------------------

test('writeFile：新建文件、递归建父目录、回执如实报告 existed/size', () => {
  const { impl, logs } = makeImpl();
  const f = join(TMP, 'nested', 'deep', 'written.txt');
  assert.equal(existsSync(f), false);

  const r = impl.writeFile({ path: f, content: 'hello world' });

  assert.equal(r.ok, true);
  assert.equal(r.existed, false);
  assert.equal(r.previousSize, 0);
  assert.equal(r.newSize, 11);
  assert.equal(readFileSync(f, 'utf8'), 'hello world');
  // 审计日志：记路径与字节数，绝不记内容
  assert.equal(logs.info.length, 1);
  assert.match(logs.info[0], /^AUDIT local_write_file /u);
  // 0.5.1：审计行**前置于 statSync**，所以记的是 writtenBytes（按内容算，无需 stat）而非 newSize。
  // 这样「写已落盘但 stat 抛错」时审计行不会丢——0.5.0 在该场景下 0 条审计。
  assert.match(logs.info[0], /mode=overwrite existed=false previousSize=0 writtenBytes=11/);
  assert.match(logs.info[0], /^AUDIT local_write_file path=C:/u, '路径须保留 OS 正确大小写，不能是 canonical 的小写形式');
  assert.ok(!logs.info[0].includes('hello world'), '审计日志不得含文件内容');
});

test('writeFile：overwrite 覆盖既有文件并报告 previousSize', () => {
  const { impl } = makeImpl();
  const f = join(TMP, 'overwrite.txt');
  writeFileSync(f, 'original-long-content', 'utf8');

  const r = impl.writeFile({ path: f, content: 'new' });

  assert.equal(r.existed, true);
  assert.equal(r.previousSize, 21);
  assert.equal(r.newSize, 3);
  assert.equal(readFileSync(f, 'utf8'), 'new');
});

test('writeFile：append 追加不覆盖', () => {
  const { impl, logs } = makeImpl();
  const f = join(TMP, 'append.log');
  writeFileSync(f, 'first\n', 'utf8');

  const r = impl.writeFile({ path: f, content: 'second\n', mode: 'append' });

  assert.equal(r.mode, 'append');
  assert.equal(readFileSync(f, 'utf8'), 'first\nsecond\n');
  assert.match(logs.info[0], /mode=append/);
});

test('writeFile：写空文件合法（content 为 ""）；缺 content 或非字符串则拒绝', () => {
  const { impl } = makeImpl();
  const f = join(TMP, 'empty.txt');
  assert.equal(impl.writeFile({ path: f, content: '' }).newSize, 0);

  for (const bad of [{ path: join(TMP, 'x.txt') }, { path: join(TMP, 'x.txt'), content: 42 }, { path: join(TMP, 'x.txt'), content: null }]) {
    try {
      impl.writeFile(bad);
      assert.fail(`应当抛出：${JSON.stringify(bad)}`);
    } catch (e) {
      assert.equal(e.code, 'invalid-params');
      assert.match(e.message, /content/, '要指明是 content 参数的问题');
    }
  }
});

// ---------------------------------------------------------------------------
// local_list_dir
// ---------------------------------------------------------------------------

test('listDir：单层列举区分 file/dir/symlink 类型', () => {
  const { impl } = makeImpl();
  const dir = join(TMP, 'list-single');
  mkdirSync(join(dir, 'sub'), { recursive: true });
  writeFileSync(join(dir, 'a.txt'), 'a', 'utf8');

  const r = impl.listDir({ path: dir });

  assert.equal(r.ok, true);
  assert.equal(r.recursive, false);
  assert.equal(r.count, 2);
  const byName = Object.fromEntries(r.entries.map((e) => [e.name, e.type]));
  assert.equal(byName['a.txt'], 'file');
  assert.equal(byName.sub, 'dir');
});

test('listDir：recursive 递归但跳过隐藏目录', () => {
  const { impl } = makeImpl();
  const dir = join(TMP, 'list-recursive');
  mkdirSync(join(dir, 'src', 'deep'), { recursive: true });
  mkdirSync(join(dir, '.hidden'), { recursive: true });
  writeFileSync(join(dir, 'src', 'deep', 'x.mjs'), 'x', 'utf8');
  writeFileSync(join(dir, '.hidden', 'secret.txt'), 's', 'utf8');

  const r = impl.listDir({ path: dir, recursive: true });

  const paths = r.entries.map((e) => e.name);
  assert.ok(paths.includes('x.mjs'), '应递归到 src/deep');
  assert.ok(!paths.includes('secret.txt'), '不得递归进隐藏目录');
});

test('listDir：limit 截断如实报告 truncated', () => {
  const { impl } = makeImpl();
  const dir = join(TMP, 'list-limit');
  mkdirSync(dir, { recursive: true });
  for (let i = 0; i < 10; i += 1) writeFileSync(join(dir, `f${i}.txt`), 'x', 'utf8');

  const r = impl.listDir({ path: dir, limit: 3 });
  assert.equal(r.count, 3);
  assert.equal(r.truncated, true);
});

test('listDir：不是目录 → not-directory；不存在 → not-found', () => {
  const { impl } = makeImpl();
  try {
    impl.listDir({ path: join(TMP, 'read-basic.txt') });
    assert.fail('应当抛出');
  } catch (e) {
    assert.equal(e.code, 'not-directory');
  }
  try {
    impl.listDir({ path: join(TMP, 'ghost-dir') });
    assert.fail('应当抛出');
  } catch (e) {
    assert.equal(e.code, 'not-found');
  }
});

// ---------------------------------------------------------------------------
// local_grep
// ---------------------------------------------------------------------------

test('grep：命中返回 path/line/text，行号正确', () => {
  const { impl } = makeImpl();
  const dir = join(TMP, 'grep-basic');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'a.mjs'), 'const foo = 1;\nconst bar = 2;\n', 'utf8');
  writeFileSync(join(dir, 'b.txt'), 'nothing here\n', 'utf8');

  const r = impl.grep({ pattern: 'bar', path: dir });

  assert.equal(r.ok, true);
  assert.equal(r.matchCount, 1);
  assert.equal(r.matches[0].line, 2);
  assert.match(r.matches[0].text, /const bar = 2/);
  assert.equal(r.filesScanned, 2);
});

test('grep：caseInsensitive 与 onlyMatching 生效', () => {
  const { impl } = makeImpl();
  const dir = join(TMP, 'grep-flags');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'c.mjs'), 'FooBar\n', 'utf8');

  assert.equal(impl.grep({ pattern: 'foobar', path: dir }).matchCount, 0);
  assert.equal(impl.grep({ pattern: 'foobar', path: dir, caseInsensitive: true }).matchCount, 1);
  const only = impl.grep({ pattern: 'Bar', path: dir, onlyMatching: true });
  assert.equal(only.matches[0].text, 'Bar', 'onlyMatching 只返回命中片段');
});

test('grep：limit 截断如实报告 truncated', () => {
  const { impl } = makeImpl();
  const dir = join(TMP, 'grep-limit');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'many.mjs'), Array.from({ length: 20 }, () => 'hit').join('\n'), 'utf8');

  const r = impl.grep({ pattern: 'hit', path: dir, limit: 5 });
  assert.equal(r.matchCount, 5);
  assert.equal(r.truncated, true);
});

test('grep：跳过 node_modules/.git 与二进制文件', () => {
  const { impl } = makeImpl();
  const dir = join(TMP, 'grep-skip');
  mkdirSync(join(dir, 'node_modules', 'pkg'), { recursive: true });
  mkdirSync(join(dir, '.git'), { recursive: true });
  writeFileSync(join(dir, 'node_modules', 'pkg', 'index.js'), 'hit-in-deps\n', 'utf8');
  writeFileSync(join(dir, '.git', 'config'), 'hit-in-git\n', 'utf8');
  writeFileSync(join(dir, 'real.mjs'), 'hit-in-src\n', 'utf8');
  writeFileSync(join(dir, 'blob.bin'), Buffer.from([0x68, 0x00, 0x69, 0x74]));

  const r = impl.grep({ pattern: 'hit', path: dir });
  assert.equal(r.matchCount, 1, '只应命中 src 里的那一处');
  assert.match(r.matches[0].text, /hit-in-src/);
});

test('grep：单文件模式（path 指向文件而非目录）', () => {
  const { impl } = makeImpl();
  const f = join(TMP, 'read-basic.txt');
  const r = impl.grep({ pattern: 'beta', path: f });
  assert.equal(r.matchCount, 1);
  assert.equal(r.matches[0].line, 2);
});

test('grep：空 pattern / 非法正则 → invalid-params', () => {
  const { impl } = makeImpl();
  for (const bad of [{ pattern: '' }, { pattern: '   ' }, {}, { pattern: '(unclosed' }]) {
    try {
      impl.grep({ ...bad, path: TMP });
      assert.fail(`应当抛出：${JSON.stringify(bad)}`);
    } catch (e) {
      assert.equal(e.code, 'invalid-params');
    }
  }
});

// ---------------------------------------------------------------------------
// local_exec（真跑，因为 shell 行为跨平台不同，mock 会掩盖差异）
// ---------------------------------------------------------------------------

/** 写一个跨平台可靠的 node 脚本，避免 cmd.exe / sh 的引号差异污染断言。 */
function writeScript(name, body) {
  const f = join(TMP, name);
  writeFileSync(f, body, 'utf8');
  return f;
}

test('exec：成功命令回 exitCode 0 与 stdout', async () => {
  const { impl, logs } = makeImpl({ DSH_BRIDGE_LOCAL_EXEC: '1' });
  const script = writeScript('exec-ok.mjs', 'process.stdout.write("out-line\\n");process.stderr.write("err-line\\n");');

  const r = await impl.exec({ command: `node "${script}"`, cwd: TMP });

  assert.equal(r.ok, true);
  assert.equal(r.exitCode, 0);
  assert.match(r.stdout, /out-line/);
  assert.match(r.stderr, /err-line/);
  assert.equal(r.timedOut, false);
  // 审计：记命令原文与退出码，不记输出内容（输出可能含敏感数据）
  assert.equal(logs.info.length, 1);
  assert.match(logs.info[0], /^AUDIT local_exec /u);
  assert.match(logs.info[0], /exit=0/);
  assert.ok(logs.info[0].includes('exec-ok.mjs'), '审计要能还原执行了什么');
  assert.ok(!logs.info[0].includes('out-line'), '审计日志不得含命令输出');
});

test('exec：非零退出码如实报告 ok:false 并带 note', async () => {
  const { impl } = makeImpl({ DSH_BRIDGE_LOCAL_EXEC: '1' });
  const script = writeScript('exec-fail.mjs', 'process.stderr.write("boom\\n");process.exit(3);');

  const r = await impl.exec({ command: `node "${script}"`, cwd: TMP });

  assert.equal(r.ok, false);
  assert.equal(r.exitCode, 3);
  assert.match(r.stderr, /boom/);
  assert.match(r.note, /退出码 3/);
});

test('exec：超时被杀并置 timedOut', async () => {
  const env = { DSH_BRIDGE_LOCAL_EXEC: '1', DSH_BRIDGE_EXEC_TIMEOUT_MS: '500' };
  const impl = createLocalTools({ env, config: resolveLocalConfig(env), logger: { info() {}, warn() {} } });
  const script = writeScript('exec-slow.mjs', 'setTimeout(() => process.stdout.write("late"), 30000);');

  const started = Date.now();
  const r = await impl.exec({ command: `node "${script}"`, cwd: TMP });
  const elapsed = Date.now() - started;

  assert.equal(r.timedOut, true, '必须识别为超时');
  assert.ok(elapsed < 10000, `应当在超时上限附近返回，实际 ${elapsed}ms`);
});

test('exec：timeoutMs 入参被钳制到配置上限，不能无限延长', () => {
  // 注入 spawnFn 捕获 spawn 选项；钳制后的实际超时值经审计日志观测
  // （超时由模块内的 setTimeout 实现，不再是 spawn 的 timeout 选项——见 killTree 注释）。
  const captured = [];
  const logs = [];
  const fakeChild = {
    stdout: { on() {} }, stderr: { on() {} },
    on: (ev, fn) => { if (ev === 'close') setImmediate(() => fn(0, null)); },
    kill() {},
  };
  const env = { DSH_BRIDGE_LOCAL_EXEC: '1', DSH_BRIDGE_EXEC_TIMEOUT_MS: '1000' };
  const impl = createLocalTools({
    env,
    config: resolveLocalConfig(env),
    logger: { info: (m) => logs.push(m), warn() {} },
    spawnFn: (cmd, opts) => { captured.push({ cmd, opts }); return fakeChild; },
  });

  return impl.exec({ command: 'anything', timeoutMs: 999999 }).then((r) => {
    assert.equal(r.ok, true);
    assert.equal(captured.length, 1);
    assert.equal(captured[0].opts.shell, true, 'Windows 上必须经 shell，否则 .cmd 与内置命令不可用');
    assert.equal(captured[0].opts.windowsHide, true, '不得弹出控制台窗口');
    assert.equal(captured[0].opts.timeout, undefined, '不得再依赖 spawn 的 timeout：它杀不掉 shell 的孙进程');
    assert.match(logs[0], /timeoutMs=1000/, '生效值必须是钳制后的 1000，而非入参的 999999');
    assert.ok(!logs[0].includes('999999'));
  });
});

test('exec：timeoutMs 小于上限时采信入参', () => {
  const logs = [];
  const fakeChild = {
    stdout: { on() {} }, stderr: { on() {} },
    on: (ev, fn) => { if (ev === 'close') setImmediate(() => fn(0, null)); },
    kill() {},
  };
  const env = { DSH_BRIDGE_LOCAL_EXEC: '1', DSH_BRIDGE_EXEC_TIMEOUT_MS: '30000' };
  const impl = createLocalTools({
    env, config: resolveLocalConfig(env), logger: { info: (m) => logs.push(m), warn() {} },
    spawnFn: () => fakeChild,
  });

  return impl.exec({ command: 'anything', timeoutMs: 250 }).then((r) => {
    assert.equal(r.ok, true);
    assert.match(logs[0], /timeoutMs=250/, '小于上限时应当采信入参值');
  });
});

test('exec：输出超限即杀并置 outputTruncated', async () => {
  const env = { DSH_BRIDGE_LOCAL_EXEC: '1', DSH_BRIDGE_FS_MAX_BYTES: '2048' };
  const impl = createLocalTools({ env, config: resolveLocalConfig(env), logger: { info() {}, warn() {} } });
  const script = writeScript('exec-spew.mjs', 'process.stdout.write("x".repeat(100000));');

  const r = await impl.exec({ command: `node "${script}"`, cwd: TMP });

  assert.equal(r.outputTruncated, true);
  assert.ok(r.stdout.length <= 2048, `stdout 必须被裁到上限内，实际 ${r.stdout.length}`);
});

test('exec：cwd 缺省用配置默认；显式 cwd 生效', async () => {
  const sub = join(TMP, 'exec-cwd');
  mkdirSync(sub, { recursive: true });
  const env = { DSH_BRIDGE_LOCAL_EXEC: '1', DSH_BRIDGE_LOCAL_CWD: sub };
  const impl = createLocalTools({ env, config: resolveLocalConfig(env), logger: { info() {}, warn() {} } });
  const script = writeScript('exec-pwd.mjs', 'process.stdout.write(process.cwd());');

  const r = await impl.exec({ command: `node "${script}"` });
  assert.equal(r.cwd, sub);
});

test('exec：收口时销毁 stdio 流（防句柄泄漏：不销毁则宿主悬挂到子进程自然退出）', async () => {
  // 回归钉子：实测过 500ms 超时 + 30s 脚本时，不 destroy 会让宿主进程多活满 30s
  // （被 taskkill 终止的进程树仍留有管道句柄）。常驻 server 上这就是句柄泄漏。
  const destroyed = [];
  const makeStream = (name) => ({ on() {}, destroy: () => destroyed.push(name) });
  const fakeChild = {
    stdout: makeStream('stdout'),
    stderr: makeStream('stderr'),
    on: (ev, fn) => { if (ev === 'close') setImmediate(() => fn(0, null)); },
    kill() {},
  };
  const env = { DSH_BRIDGE_LOCAL_EXEC: '1' };
  const impl = createLocalTools({
    env, config: resolveLocalConfig(env), logger: { info() {}, warn() {} },
    spawnFn: () => fakeChild,
  });

  const r = await impl.exec({ command: 'anything' });

  assert.equal(r.ok, true);
  assert.deepEqual(destroyed, ['stdout', 'stderr'], '两条流都必须显式销毁');
});

test('exec：stdio 已关闭时 destroy 抛错不影响收口', async () => {
  const fakeChild = {
    stdout: { on() {}, destroy: () => { throw new Error('already destroyed'); } },
    stderr: { on() {}, destroy: () => { throw new Error('already destroyed'); } },
    on: (ev, fn) => { if (ev === 'close') setImmediate(() => fn(0, null)); },
    kill() {},
  };
  const env = { DSH_BRIDGE_LOCAL_EXEC: '1' };
  const impl = createLocalTools({
    env, config: resolveLocalConfig(env), logger: { info() {}, warn() {} },
    spawnFn: () => fakeChild,
  });

  const r = await impl.exec({ command: 'anything' });
  assert.equal(r.ok, true, 'destroy 抛错必须被吞掉，不能让工具调用失败');
});

test('exec：exit 先于 close 时由 exit 兜底收口，不永久挂起', async () => {
  // 回归钉子：Windows + shell:true 下 child.kill 只杀 shell，孙进程仍持有管道，
  // 于是 exit 触发而 close 永不触发。只听 close 会让 Promise 挂死（实测 30s）。
  const fakeChild = {
    stdout: { on() {}, destroy() {} },
    stderr: { on() {}, destroy() {} },
    on: (ev, fn) => { if (ev === 'exit') setImmediate(() => fn(1, 'SIGKILL')); }, // 只发 exit，永不发 close
    kill() {},
  };
  const env = { DSH_BRIDGE_LOCAL_EXEC: '1' };
  const impl = createLocalTools({
    env, config: resolveLocalConfig(env), logger: { info() {}, warn() {} },
    spawnFn: () => fakeChild,
  });

  const t0 = Date.now();
  const r = await impl.exec({ command: 'anything' });

  assert.equal(r.ok, false);
  assert.equal(r.exitCode, 1);
  assert.ok(Date.now() - t0 < 2000, `exit 兜底应在 250ms 缓冲后收口，实际 ${Date.now() - t0}ms`);
});

test('exec：空 command / 非字符串 → invalid-params', async () => {
  const { impl } = makeImpl({ DSH_BRIDGE_LOCAL_EXEC: '1' });
  for (const bad of [{}, { command: '' }, { command: '   ' }, { command: 42 }]) {
    try {
      await impl.exec(bad);
      assert.fail(`应当抛出：${JSON.stringify(bad)}`);
    } catch (e) {
      assert.equal(e.code, 'invalid-params');
    }
  }
});

// ---------------------------------------------------------------------------
// server 层集成：分发与错误映射
// ---------------------------------------------------------------------------

test('server：门控关闭时 tools/list 仍是原 7 个（既有链路零变化）', () => {
  const res = handleRpcMessage({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, { tools: TOOLS });
  assert.equal(res.result.tools.length, 7);
  assert.ok(!res.result.tools.some((t) => t.name.startsWith('local_')));
});

test('server：门控开启时 tools/list 含本地工具，且桥侧 7 个一个不少', () => {
  const local = buildLocalTools({ env: { DSH_BRIDGE_LOCAL_FS: '1', DSH_BRIDGE_LOCAL_EXEC: '1' } });
  const all = [...TOOLS, ...local];
  const res = handleRpcMessage({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, { tools: all });
  assert.equal(res.result.tools.length, 12);
  const names = res.result.tools.map((t) => t.name);
  assert.ok(names.includes('dsh_task_capabilities'), '桥侧工具不得因新增本地工具而丢失');
  assert.ok(names.includes('local_read_file'));
  assert.ok(names.includes('local_exec'));
});

test('server：tools/call 能分发到本地工具并返回 structuredContent', async () => {
  const local = buildLocalTools({ env: { DSH_BRIDGE_LOCAL_FS: '1' } });
  const all = [...TOOLS, ...local];
  const f = join(TMP, 'read-basic.txt');

  const res = await handleRpcMessage(
    { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'local_read_file', arguments: { path: f, limit: 1 } } },
    { tools: all },
  );

  assert.equal(res.result.isError, undefined);
  assert.equal(res.result.structuredContent.ok, true);
  assert.match(res.result.structuredContent.content, /^1\talpha$/u);
  assert.equal(res.result.content[0].type, 'text');
});

test('server：LocalToolError 映射为 isError:true 且 code 透传（不吞成 internal-error）', async () => {
  const local = buildLocalTools({ env: { DSH_BRIDGE_LOCAL_FS: '1' } });
  const all = [...TOOLS, ...local];
  const tokenPath = join(homedir(), '.dsh', 'task-bridge-token');

  const res = await handleRpcMessage(
    { jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'local_read_file', arguments: { path: tokenPath } } },
    { tools: all },
  );

  assert.equal(res.result.isError, true);
  assert.equal(res.result.structuredContent.ok, false);
  assert.equal(res.result.structuredContent.code, 'credential-protected', '必须透传具体 code，不能退化成 internal-error');
  assert.match(res.result.structuredContent.error, /不可通过配置解除/);
});

test('server：未知工具仍回 -32602（不因新增工具而改变错误语义）', () => {
  const res = handleRpcMessage(
    { jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'local_nope', arguments: {} } },
    { tools: TOOLS },
  );
  assert.equal(res.error.code, -32602);
});

test('server：initialize 的 instructions 随启用集合变化', () => {
  const base = handleRpcMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }, { instructions: 'BASE' });
  assert.equal(base.result.instructions, 'BASE');

  const withLocal = handleRpcMessage(
    { jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
    { instructions: ['BASE', 'local_read_file 纪律'].join('\n') },
  );
  assert.match(withLocal.result.instructions, /local_read_file 纪律/);
});

// ---------------------------------------------------------------------------
// 0.5.1 回归钉子：四路评审发现的缺陷，每条一个用例
//
// 元教训：0.5.0 的 51 个用例全绿却给出**假信心**——所有凭据保护断言都只走
// readFile/writeFile，没有任何用例断言 grep/listDir 的递归遍历也遵守保护。
// 于是「一次 local_grep(path=父目录) 读出 token 原文」这条最短攻击路径完全漏网。
// 以下用例逐条钉住评审复现成立的缺陷。
// ---------------------------------------------------------------------------

// 本文件既有的隔离设施是模块级 TMP + writeScript；0.5.1 这批用例需要「每例独占目录」，
// 因为递归遍历类断言对目录内容敏感（任何其他用例的残留文件都会污染 skipped 计数）。
function makeTempDir() {
  return mkdtempSync(join(tmpdir(), 'dsh-local-fs-051-'));
}
function cleanup(dir) {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* 尽力清理 */ }
}

test('0.5.1 递归遍历必须遵守凭据保护：grep 不得读出受保护文件内容', (t) => {
  // 这是 0.5.0 最严重的缺陷（安全与正确性评审各自独立复现）：guardPath 只作用于搜索根，
  // walk 内对发现的文件从不检查，且 README 推荐的「只开文件不开 shell」恰恰是绕过生效的配置。
  const dir = makeTempDir();
  t.after(() => cleanup(dir));
  const secretFile = join(dir, 'task-bridge-token');
  writeFileSync(secretFile, 'SYNTHETIC-FAKE-SECRET-must-not-leak', 'utf8');
  const env = { DSH_BRIDGE_LOCAL_FS: '1', TASK_BRIDGE_TOKEN_FILE: secretFile };
  const { impl } = makeImpl(env);

  const r = impl.grep({ pattern: 'SYNTHETIC-FAKE-SECRET', path: dir });

  assert.equal(r.matchCount, 0, '受保护文件的内容绝不能出现在命中里');
  assert.ok(!JSON.stringify(r.matches).includes('must-not-leak'), '回执任何字段都不得含秘密片段');
  assert.equal(r.skipped.protected, 1, '必须如实报告「因保护跳过 1 个」，不能静默');
  assert.equal(r.truncated, true, '有跳过即结果不完整，truncated 必须为 true');
  assert.match(r.note, /凭据保护 1/, 'note 要说明跳过原因与数量');
});

test('0.5.1 递归遍历必须遵守默认保护与用户黑名单（.env / DSH_BRIDGE_FS_DENY）', (t) => {
  const dir = makeTempDir();
  t.after(() => cleanup(dir));
  writeFileSync(join(dir, '.env'), 'DB_PASSWORD=SYNTHETIC-FAKE-999', 'utf8');
  writeFileSync(join(dir, 'normal.mjs'), 'DB_PASSWORD=public-default', 'utf8');
  const vault = join(dir, 'vault');
  mkdirSync(vault, { recursive: true });
  writeFileSync(join(vault, 'notes.txt'), 'SYNTHETIC-FAKE-vault', 'utf8');

  const env = { DSH_BRIDGE_LOCAL_FS: '1', DSH_BRIDGE_FS_DENY: vault };
  const { impl } = makeImpl(env);
  const r = impl.grep({ pattern: 'SYNTHETIC-FAKE|DB_PASSWORD', path: dir });

  const paths = r.matches.map((m) => m.path);
  assert.ok(!paths.some((p) => p.endsWith('.env')), '.env 不得被递归搜出');
  assert.ok(!paths.some((p) => p.includes('vault')), '黑名单目录下的文件不得被搜出');
  assert.ok(paths.some((p) => p.endsWith('normal.mjs')), '正常文件仍要能搜到（不能因加固而失能）');
  assert.equal(r.skipped.protected, 2, '.env + vault/notes.txt 两个跳过都要计数');
});

test('0.5.1 listDir 递归不得暴露受保护文件路径', (t) => {
  const dir = makeTempDir();
  t.after(() => cleanup(dir));
  const secretFile = join(dir, 'task-bridge-token');
  writeFileSync(secretFile, 'SYNTHETIC-FAKE', 'utf8');
  const env = { DSH_BRIDGE_LOCAL_FS: '1', TASK_BRIDGE_TOKEN_FILE: secretFile };
  const { impl } = makeImpl(env);

  const r = impl.listDir({ path: dir, recursive: true });

  assert.ok(!r.entries.some((e) => e.name === 'task-bridge-token'), '路径本身就是信息，不得列出');
  assert.equal(r.skippedProtected, 1);
  assert.match(r.note, /凭据保护\/黑名单被跳过/);
});

test('0.5.1 不得把受保护目录当搜索根（祖先前缀匹配）', (t) => {
  // 0.5.0 的 protectedAlways 只做精确匹配，于是 guardPath(~/.dsh) 放行，
  // 攻击者可直接把 token 所在目录当 grep 根。
  const dshDir = join(homedir(), '.dsh');
  assert.throws(() => guardPath(dshDir, { op: 'read' }), (e) => e.code === 'credential-protected',
    '受保护目录本身必须被拒（它包含强制保护的凭据文件）');
});

test('0.5.1 canonical 化挡住四类路径变形（大小写 / ADS / UNC / symlink）', (t) => {
  const dir = makeTempDir();
  t.after(() => cleanup(dir));
  const secretFile = join(dir, 'fake-token.txt');
  writeFileSync(secretFile, 'SYNTHETIC-FAKE-canonical', 'utf8');
  const env = { DSH_BRIDGE_LOCAL_FS: '1', TASK_BRIDGE_TOKEN_FILE: secretFile };
  const { impl } = makeImpl(env);

  // canonical 的语义：同一文件的不同写法收敛成唯一形式
  assert.equal(canonical(join(dir, 'FAKE-TOKEN.TXT')), canonical(secretFile), '大小写变形必须收敛');
  assert.equal(canonical(`${secretFile}::$DATA`), canonical(secretFile), 'NTFS 备用数据流必须被剥掉');

  const denied = (label, p) => {
    try {
      const r = impl.readFile({ path: p });
      assert.fail(`${label} 应当被拒，实际读到：${String(r.content).slice(0, 40)}`);
    } catch (e) {
      assert.equal(e.code, 'credential-protected', `${label} 应回 credential-protected，实际 ${e.code}`);
    }
  };
  denied('文件名大写', secretFile.replace('fake-token.txt', 'FAKE-TOKEN.TXT'));
  denied('全小写', secretFile.toLowerCase());
  denied('ADS ::$DATA', `${secretFile}::$DATA`);
  denied('UNC \\\\?\\', `\\\\?\\${secretFile}`);

  // symlink：链接自身路径与目标字面不同，必须靠 realpath 解析后拦截
  const link = join(dir, 'link-to-secret');
  try {
    symlinkSync(secretFile, link);
    denied('symlink', link);
  } catch (e) {
    if (e.code !== 'credential-protected' && e.code !== 'EPERM' && e.code !== 'EACCES') throw e;
    // Windows 无管理员权限/未开发者模式时创建 symlink 会 EPERM——此时跳过而非失败
  }
});

test('0.5.1 写方向同样挡住变形路径（不能覆写凭据劫持链路）', (t) => {
  const dir = makeTempDir();
  t.after(() => cleanup(dir));
  const secretFile = join(dir, 'fake-token.txt');
  writeFileSync(secretFile, 'SYNTHETIC-FAKE-original', 'utf8');
  const env = { DSH_BRIDGE_LOCAL_FS: '1', TASK_BRIDGE_TOKEN_FILE: secretFile };
  const { impl } = makeImpl(env);

  for (const variant of [secretFile.replace('fake-token.txt', 'FAKE-TOKEN.TXT'), `${secretFile}::$DATA`]) {
    try {
      impl.writeFile({ path: variant, content: 'HIJACKED' });
      assert.fail(`写方向必须拒绝变形路径：${variant}`);
    } catch (e) {
      assert.equal(e.code, 'credential-protected');
    }
  }
  assert.equal(readFileSync(secretFile, 'utf8'), 'SYNTHETIC-FAKE-original', '原文件必须未被触碰');
});

test('0.5.1 buildExecEnv 剔除桥凭据、本插件配置与秘密模式键', () => {
  const out = buildExecEnv({
    PATH: '/usr/bin', SystemRoot: 'C:\\Windows', USERPROFILE: 'C:\\Users\\x',
    TASK_BRIDGE_TOKEN: 'super-secret', TASK_BRIDGE_TOKEN_FILE: '/x/y',
    DSH_BRIDGE_LOCAL_FS: '1', DSH_READBACK_DISABLED: '1',
    MANA_API_KEY: 'k1', MOONTONTECH_API_KEY: 'k2',
    AWS_SECRET_ACCESS_KEY: 'k3', GITHUB_TOKEN: 'k4', DB_PASSWORD: 'k5',
    SOME_RANDOM_VAR: 'ok',
  });

  assert.equal(out.PATH, '/usr/bin', '命令必需的系统变量要保留');
  assert.equal(out.SystemRoot, 'C:\\Windows');
  assert.equal(out.SOME_RANDOM_VAR, undefined, '白名单外一律不放行');
  for (const blocked of ['TASK_BRIDGE_TOKEN', 'TASK_BRIDGE_TOKEN_FILE', 'DSH_BRIDGE_LOCAL_FS',
    'DSH_READBACK_DISABLED', 'MANA_API_KEY', 'MOONTONTECH_API_KEY', 'AWS_SECRET_ACCESS_KEY',
    'GITHUB_TOKEN', 'DB_PASSWORD']) {
    assert.equal(out[blocked], undefined, `${blocked} 绝不能传给子进程`);
  }
});

test('0.5.1 exec 不把桥 token 交给子进程（0.5.0 一条命令即可读出）', async () => {
  // 0.5.0 用 env: {...process.env} 全量继承，评审双方独立实测：
  // local_exec{command:'node -e "console.log(process.env.TASK_BRIDGE_TOKEN)"'} 直接把 token 送进云端记录。
  const { impl } = makeImpl({ DSH_BRIDGE_LOCAL_EXEC: '1' });
  const script = writeScript('exec-envleak.mjs',
    'process.stdout.write(JSON.stringify({t:process.env.TASK_BRIDGE_TOKEN??null,f:process.env.FAKE_INJECTED??null}));');

  const r = await impl.exec({ command: `node "${script}"`, cwd: TMP, timeoutMs: 15000 });

  const seen = JSON.parse(r.stdout || '{}');
  assert.equal(seen.t, null, '子进程不得看到 TASK_BRIDGE_TOKEN');
  assert.equal(seen.f, null, '白名单外的变量一律不可见');
});

test('0.5.1 treeKillFn 的 spawn 失败不得崩掉宿主（必须挂 error 监听）', async () => {
  // 0.5.0：try/catch 只捕获同步抛出，而 spawn 失败是异步 'error' 事件 →
  // EventEmitter 抛未捕获异常，整个 MCP server 崩溃，连带 7 个桥工具一起不可用
  // （评审实测 exit=9 UNCAUGHT:spawn taskkill ENOENT）。
  const fakeChild = {
    stdout: { on() {}, destroy() {} }, stderr: { on() {}, destroy() {} },
    // close 必须晚于 1ms 的超时定时器：setImmediate 会在 setTimeout(1) 之前触发，
    // 那样 finish 先收口、treeKill 根本不会被调用，断言就变成假失败。
    on: (ev, fn) => { if (ev === 'close') setTimeout(() => fn(null, 'SIGKILL'), 200); },
    kill() {}, pid: 4242,
  };
  let errorListenerAttached = false;
  const env = { DSH_BRIDGE_LOCAL_EXEC: '1', DSH_BRIDGE_EXEC_TIMEOUT_MS: '1000' };
  const impl = createLocalTools({
    env, config: resolveLocalConfig(env), logger: { info() {}, warn() {} },
    spawnFn: () => fakeChild,
    treeKillFn: () => {
      // 返回一个"会异步抛 error"的假子进程，模拟 taskkill ENOENT/EACCES
      const handlers = {};
      const tk = {
        on: (ev, fn) => { handlers[ev] = fn; if (ev === 'error') errorListenerAttached = true; },
        stdout: { resume() {} }, stderr: { resume() {} },
      };
      setImmediate(() => handlers.error?.(Object.assign(new Error('spawn taskkill ENOENT'), { code: 'ENOENT' })));
      return tk;
    },
  });

  const r = await impl.exec({ command: 'anything', timeoutMs: 1 });
  assert.equal(errorListenerAttached, true, 'treeKill 必须给 taskkill 子进程挂 error 监听器，否则宿主崩溃');
  assert.equal(r.timedOut, true, '即便杀树失败也要如实收口');
});

test('0.5.1 treeKill 不得在 taskkill 之后立刻同步 kill（否则 taskkill 查不到 PID）', async () => {
  // 0.5.0 的顺序错误：同步 child.kill 先把 shell 杀掉，等异步的 taskkill 去查 PID 时
  // 进程已不存在 → 实测 taskkill exit=128「没有找到进程」，孙进程活到自然结束，
  // 而回执 note 却声称「已杀整棵进程树」。
  const events = [];
  const fakeChild = {
    stdout: { on() {}, destroy() {} }, stderr: { on() {}, destroy() {} },
    on: (ev, fn) => { if (ev === 'close') setTimeout(() => fn(null, 'SIGKILL'), 30); },
    kill: () => events.push('child.kill'),
    pid: 4242,
  };
  const env = { DSH_BRIDGE_LOCAL_EXEC: '1', DSH_BRIDGE_EXEC_TIMEOUT_MS: '1000' };
  const impl = createLocalTools({
    env, config: resolveLocalConfig(env), logger: { info() {}, warn() {} },
    spawnFn: () => fakeChild,
    treeKillFn: () => {
      events.push('taskkill-spawn');
      const handlers = {};
      const tk = { on: (ev, fn) => { handlers[ev] = fn; }, stdout: { resume() {} }, stderr: { resume() {} } };
      setImmediate(() => { events.push('taskkill-close'); handlers.close?.(0, null); });
      return tk;
    },
  });

  await impl.exec({ command: 'anything', timeoutMs: 1 });
  assert.ok(events.indexOf('taskkill-spawn') < events.indexOf('child.kill'),
    `必须先 taskkill 再兜底 kill，实际顺序：${events.join(' → ')}`);
  assert.ok(events.includes('taskkill-close'), 'child.kill 应由 taskkill 的 close 回调触发');
});

test('0.5.1 exec 输出按字节计上限（CJK 不得突破 maxBytes 3 倍）', async () => {
  // 0.5.0 用 stdout.length（UTF-16 码元）比较与裁剪，实测 10 万汉字 = 100005 码元 /
  // 300015 字节，而声明上限 262144 —— 多字节内容下上限被突破约 3 倍。
  const env = { DSH_BRIDGE_LOCAL_EXEC: '1', DSH_BRIDGE_FS_MAX_BYTES: '3000' };
  const impl = createLocalTools({ env, config: resolveLocalConfig(env), logger: { info() {}, warn() {} } });
  const script = writeScript('exec-cjk.mjs', 'process.stdout.write("中".repeat(5000));');

  const r = await impl.exec({ command: `node "${script}"`, cwd: TMP, timeoutMs: 20000 });

  const outBytes = Buffer.byteLength(r.stdout, 'utf8');
  assert.ok(outBytes <= 3000, `stdout 字节数必须 ≤ maxBytes，实际 ${outBytes}`);
  assert.equal(r.outputTruncated, true);
  assert.ok(Number.isInteger(r.stdoutBytes), '回执要给出真实字节数');
});

test('0.5.1 grep 单文件模式必须受 maxBytes 与二进制闸门约束', (t) => {
  // 0.5.0 的单文件分支没有 size 也没有 NUL 检查：实测 maxBytes=1024 时仍把 200MB 文件
  // 整体读入堆（rss +392MB），含 NUL 的文件也照搜并把乱码灌进上下文。
  const dir = makeTempDir();
  t.after(() => cleanup(dir));
  const big = join(dir, 'big.txt');
  writeFileSync(big, 'x'.repeat(200_000), 'utf8');
  const bin = join(dir, 'blob.bin');
  writeFileSync(bin, Buffer.from([0x68, 0x00, 0x69, 0x74, 0x2d, 0x62, 0x69, 0x6e]));

  const env = { DSH_BRIDGE_LOCAL_FS: '1', DSH_BRIDGE_FS_MAX_BYTES: '1024' };
  const { impl } = makeImpl(env);

  const bigR = impl.grep({ pattern: 'x', path: big });
  assert.equal(bigR.matchCount, 0, '超限文件不得被搜索');
  assert.equal(bigR.skipped.oversize, 1, '必须如实计入超限跳过');

  const binR = impl.grep({ pattern: 'hit', path: bin });
  assert.equal(binR.matchCount, 0, '二进制文件不得被搜索');
  assert.equal(binR.skipped.binary, 1);
});

test('0.5.1 grep 深度到顶必须报告 depthLimited（不得静默截断）', (t) => {
  const dir = makeTempDir();
  t.after(() => cleanup(dir));
  // 造一条深于上限的链：depth 上限设 2，实际造 4 层
  let cur = dir;
  for (let i = 0; i < 4; i += 1) { cur = join(cur, `d${i}`); mkdirSync(cur, { recursive: true }); }
  writeFileSync(join(cur, 'deep.txt'), 'hit-deep', 'utf8');
  writeFileSync(join(dir, 'top.txt'), 'hit-top', 'utf8');

  const env = { DSH_BRIDGE_LOCAL_FS: '1', DSH_BRIDGE_GREP_MAX_DEPTH: '2' };
  const { impl } = makeImpl(env);
  const r = impl.grep({ pattern: 'hit', path: dir });

  assert.equal(r.depthLimited, true, '深度到顶必须置标志：0.5.0 静默停止下潜，truncated:false 被读成「搜全了」');
  assert.ok(r.matches.some((m) => m.path.endsWith('top.txt')), '浅层命中仍要在');
  assert.ok(!r.matches.some((m) => m.path.endsWith('deep.txt')), '深层命中确实没搜到——所以才必须报告');
});

test('0.5.1 readFile 读回后复检字节数（TOCTOU / 增长中的日志）', (t) => {
  // 0.5.0 只校验 stat.size，读回的 buf 从不再比对上限：用 fs 注入 seam 可确定性证明
  // stat 报 100 字节而实际返回 500 万字符。真实场景是读一个正被追加的日志。
  const dir = makeTempDir();
  t.after(() => cleanup(dir));
  const f = join(dir, 'lying.txt');
  writeFileSync(f, 'short', 'utf8');
  const env = { DSH_BRIDGE_LOCAL_FS: '1', DSH_BRIDGE_FS_MAX_BYTES: '1024' };
  const impl = createLocalTools({
    env, config: resolveLocalConfig(env), logger: { info() {}, warn() {} },
    fs: {
      statSync: (p, o) => ({ isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false, size: 100, mtime: new Date() }),
      readFileSync: () => Buffer.from('x'.repeat(5_000_000)),
      writeFileSync, appendFileSync, readdirSync, mkdirSync, chmodSync: () => {},
    },
  });

  try {
    impl.readFile({ path: f });
    assert.fail('读回后必须复检字节数');
  } catch (e) {
    assert.equal(e.code, 'too-large');
    assert.match(e.message, /实际读取字节数/);
  }
});

test('0.5.1 审计可落盘（DSH_BRIDGE_AUDIT_FILE）——stderr 在生产部署下不进 tunnel-client 日志', (t) => {
  // 安全评审实测：3.9MB debug 日志、两次 tunnel-client 启动，对 bridge-mcp 的 stderr 零命中
  // （profile 的 mcp.commands[] 没有 stderr 重定向字段）。所以「写与执行都留审计」这条
  // 无人在环风险的唯一补偿性控制，在主要部署形态下根本不落盘。
  const dir = makeTempDir();
  t.after(() => cleanup(dir));
  const auditFile = join(dir, 'audit.log');
  const target = join(dir, 'written.txt');
  const env = { DSH_BRIDGE_LOCAL_FS: '1', DSH_BRIDGE_AUDIT_FILE: auditFile };
  const impl = createLocalTools({ env, config: resolveLocalConfig(env) }); // 不注入 logger，用默认（含落盘）

  impl.writeFile({ path: target, content: 'audit-me' });

  assert.ok(existsSync(auditFile), '审计文件必须被创建');
  const lines = readFileSync(auditFile, 'utf8').trim().split('\n');
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^AUDIT local_write_file path=/);
  assert.ok(!lines[0].includes('audit-me'), '落盘审计同样不得含文件内容');
});

test('0.5.1 writeFile 在 stat 失败时仍留审计行（写已落盘不得无痕）', (t) => {
  // 0.5.0 把 statSync 放在审计行之前且不在 try 内：写已落盘但 stat 抛错时
  // 审计 0 条、回执退化成 internal-error —— 文件被改了却无痕。
  const dir = makeTempDir();
  t.after(() => cleanup(dir));
  const f = join(dir, 'w.txt');
  const infos = [];
  let statCalls = 0;
  const env = { DSH_BRIDGE_LOCAL_FS: '1' };
  const impl = createLocalTools({
    env, config: resolveLocalConfig(env), logger: { info: (m) => infos.push(m), warn() {} },
    fs: {
      statSync: (p, o) => { statCalls += 1; if (statCalls > 1) { const e = new Error('EACCES'); e.code = 'EACCES'; throw e; } return statSync(p, o); },
      readFileSync, writeFileSync, appendFileSync, readdirSync, mkdirSync, chmodSync: () => {},
    },
  });

  const r = impl.writeFile({ path: f, content: 'written-anyway' });

  assert.equal(infos.length, 1, '审计行必须在 stat 之前发出');
  assert.match(infos[0], /writtenBytes=14/);
  assert.equal(r.ok, true);
  assert.equal(r.statUnavailable, true, '必须如实标注 stat 不可用，而非谎报大小');
  assert.equal(readFileSync(f, 'utf8'), 'written-anyway', '写确实发生了');
});

test('0.5.1 limit 入参必须 clamp（回执体积不得由调用方决定）', (t) => {
  // 0.5.0 的 limit 无上限：实测 limit=1e8 时 grep 单文件模式回执 JSON 达 6.70MB，
  // listDir 递归 4008 条 / 476KB，与 maxBytes 完全脱钩。
  const dir = makeTempDir();
  t.after(() => cleanup(dir));
  for (let i = 0; i < 30; i += 1) writeFileSync(join(dir, `f${i}.txt`), 'hit', 'utf8');
  const { impl } = makeImpl();

  const listed = impl.listDir({ path: dir, limit: 1e8 });
  assert.ok(listed.count <= 5000, `listDir 条目必须 clamp，实际 ${listed.count}`);

  const grepped = impl.grep({ pattern: 'hit', path: dir, limit: 1e8 });
  assert.ok(grepped.matchCount <= 5000, `grep 命中必须 clamp，实际 ${grepped.matchCount}`);
});

test('0.5.1 五个工具都必须带 annotations（MCP 客户端据此加机械闸门）', () => {
  const tools = buildLocalTools({ env: { DSH_BRIDGE_LOCAL_FS: '1', DSH_BRIDGE_LOCAL_EXEC: '1' } });
  assert.equal(tools.length, 5);
  const expect = {
    local_read_file: { readOnlyHint: true, destructiveHint: false },
    local_write_file: { readOnlyHint: false, destructiveHint: true },
    local_list_dir: { readOnlyHint: true, destructiveHint: false },
    local_grep: { readOnlyHint: true, destructiveHint: false },
    local_exec: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  };
  for (const t of tools) {
    assert.ok(t.annotations, `${t.name} 缺 annotations —— 只写在 description 里是纪律不是防线`);
    for (const [k, v] of Object.entries(expect[t.name])) {
      assert.equal(t.annotations[k], v, `${t.name}.annotations.${k}`);
    }
  }
});

test('0.5.1 buildLocalTools 必须真正采用注入的 config（0.5.0 是死参数）', () => {
  const cfg = resolveLocalConfig({ DSH_BRIDGE_LOCAL_FS: '1', DSH_BRIDGE_FS_MAX_BYTES: '777' });
  const tools = buildLocalTools({ env: {}, config: cfg }); // env 故意不含开关
  assert.equal(tools.length, 4, '注入的 config 必须生效，而不是被重新解析的空 env 覆盖');
});

test('0.5.1 guardPath 对 op=exec 的拒绝文案不得说「写入」', () => {
  const dir = join(homedir(), '.ssh');
  try {
    guardPath(dir, { op: 'exec' });
    assert.fail('受保护目录作 cwd 应被拒');
  } catch (e) {
    assert.equal(e.code, 'credential-protected');
    assert.match(e.message, /以该路径为工作目录/, '文案要与实际操作相符');
    assert.ok(!e.message.includes('拒绝写入'), '0.5.0 在 exec 场景下误说「拒绝写入」');
  }
});

