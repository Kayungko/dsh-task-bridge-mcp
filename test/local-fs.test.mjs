// local-fs.test.mjs —— 本地文件/命令工具（0.5.0）离线回归。
// 真 fs + mkdtemp 独占临时目录（不碰用户 ~/.dsh、不碰仓库）；exec 用真跑临时脚本，
// 因为 shell 行为在 Windows(cmd.exe) 与 POSIX 上不同，mock 会掩盖真实差异。
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { basename, delimiter, join } from 'node:path';

import {
  buildLocalTools,
  buildLocalInstructions,
  buildExecEnv,
  allowRoots,
  auditField,
  canonical,
  createLocalTools,
  displayPath,
  guardPath,
  guardWalkEntry,
  isProtectedByDefault,
  protectedAlways,
  resolveLocalConfig,
  selfPackageRoot,
  writeProtectedPaths,
  LocalToolError,
  DEFAULT_MAX_BYTES,
  DEFAULT_EXEC_TIMEOUT_MS,
  DEFAULT_EXEC_MAX_CONCURRENT,
  DEFAULT_GREP_TIMEOUT_MS,
} from '../src/local-fs.mjs';
import { handleRpcMessage } from '../src/server.mjs';
import { TOOLS } from '../src/tools.mjs';

const TMP = mkdtempSync(join(tmpdir(), 'dsh-local-fs-'));
after(() => { try { rmSync(TMP, { recursive: true, force: true }); } catch { /* 尽力清理 */ } });

/** 造一组只在临时目录里活动、日志可捕获的实现。`deps` 用于注入 selfRoot 等测试替身。 */
function makeImpl(envOverrides = {}, deps = {}) {
  const logs = { info: [], warn: [] };
  const env = { DSH_BRIDGE_LOCAL_FS: '1', ...envOverrides };
  const impl = createLocalTools({
    env,
    config: resolveLocalConfig(env),
    logger: { info: (m) => logs.info.push(m), warn: (m) => logs.warn.push(m) },
    ...deps,
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
  // 0.5.2：自由文本字段（path / command）改为 JSON-string 兼容的带引号转义形式，
  // 防止命令或路径里的换行伪造额外审计行。大小写不变量仍然成立（`"C:` 而非 `"c:`）。
  assert.match(logs.info[0], /^AUDIT local_write_file path="C:/u, '路径须保留 OS 正确大小写，不能是 canonical 的小写形式');
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
  // 不注入 logger。注意 0.5.1 时这是**必需**的：落盘挂在默认 logger 的 info 里，注入
  // logger 就会静默丢掉审计。0.5.2 起审计走独立通道，注入与否都落盘（另有专门用例钉住）。
  const impl = createLocalTools({ env, config: resolveLocalConfig(env) });

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

// ---------------------------------------------------------------------------
// 0.5.2 回归钉子：ReDoS 的硬时间上界（vm.runInContext timeout）
//
// 缺陷：0.5.1 的 grep 对 pattern 只有文件数/深度/命中数三重上界，**没有任何时间上界**。
// 正则的灾难性回溯与文件数无关——一条 `(a+)+$` 配 33 字符输入就能冻住单线程 event loop。
// bridge-mcp 是常驻 stdio server，event loop 一冻，7 个桥工具一起不可用。
// 实测（Node v24.13.1）：原生跑过 15000ms 需外部 taskkill 才收场。
//
// 修法与选型都有实测依据，不是推断：vm 的 timeout 能中断回溯（402/404ms 抛出，抛错后
// 同 context 与父进程 JS 均正常）；worker_threads 虽也能 terminate，但默认选项下子进程
// stdout 会原样出现在父进程 stdout 上，而本进程 stdout 就是 JSON-RPC 信道，故不选。
// ---------------------------------------------------------------------------

const CATASTROPHIC = '(a+)+$';
const REDOS_INPUT = `${'a'.repeat(32)}!`;

test('0.5.2 灾难性回溯被时间预算中断，且中断后 server 仍能继续服务', (t) => {
  const dir = makeTempDir();
  t.after(() => cleanup(dir));
  writeFileSync(join(dir, 'victim.txt'), `before\n${REDOS_INPUT}\nafter\n`, 'utf8');
  const { impl } = makeImpl({ DSH_BRIDGE_GREP_TIMEOUT_MS: '300' });

  const t0 = Date.now();
  const r = impl.grep({ pattern: CATASTROPHIC, path: join(dir, 'victim.txt') });
  const elapsed = Date.now() - t0;

  // 关键断言：阻塞**有上界**。修复前这里会挂到测试框架超时（原生实测 >15000ms）。
  assert.ok(elapsed < 2500, `必须在预算量级内返回，实测 ${elapsed}ms（预算 300ms；修复前 >15000ms）`);
  assert.equal(r.regexTimedOut, true, '必须如实标记正则被中断');
  assert.equal(r.wallTimedOut, false, '这是正则中断，不是整次预算耗尽，两个标志不得混用');
  assert.equal(r.truncated, true, '结果不完整必须可见');
  assert.equal(r.skipped.regexTimeout, 1, '被中断的文件要计数，不能静默');
  assert.match(r.note ?? '', /灾难性回溯/, 'note 要能指导调用方改写 pattern');
  assert.equal(r.grepTimeoutMs, 300, '回执要带出生效的预算值');
  assert.ok(Number.isInteger(r.elapsedMs) && r.elapsedMs >= 0, '回执要带实测耗时');

  // 「7 个桥工具不会一起死」的直接证据：中断之后同实例仍能正常完成一次搜索。
  const after = impl.grep({ pattern: 'before|after', path: join(dir, 'victim.txt') });
  assert.equal(after.matchCount, 2);
  assert.equal(after.regexTimedOut, false);
});

test('0.5.2 首个文件超时即停止遍历，不逐个文件把预算烧光', (t) => {
  const dir = makeTempDir();
  t.after(() => cleanup(dir));
  mkdirSync(join(dir, 'tree'), { recursive: true });
  for (let i = 0; i < 8; i += 1) writeFileSync(join(dir, 'tree', `f${i}.txt`), `x\n${REDOS_INPUT}\n`, 'utf8');
  const { impl } = makeImpl({ DSH_BRIDGE_GREP_TIMEOUT_MS: '300' });

  const t0 = Date.now();
  const r = impl.grep({ pattern: CATASTROPHIC, path: join(dir, 'tree') });
  const elapsed = Date.now() - t0;

  assert.ok(elapsed < 2500, `8 个文件的树总耗时应接近单个预算，实测 ${elapsed}ms`);
  assert.equal(r.skipped.regexTimeout, 1, '中断一个文件后即收手；若为 8 说明逐文件各烧一次预算');
  assert.equal(r.regexTimedOut, true);
});

test('0.5.2 limitTruncated 仍只表示 limit 截断，不被超时污染', (t) => {
  const dir = makeTempDir();
  t.after(() => cleanup(dir));
  writeFileSync(join(dir, 'v.txt'), REDOS_INPUT, 'utf8');
  const { impl } = makeImpl({ DSH_BRIDGE_GREP_TIMEOUT_MS: '300' });
  const r = impl.grep({ pattern: CATASTROPHIC, path: join(dir, 'v.txt') });
  // 0.5.1 的 limitTruncated 语义是「命中数或文件数触顶」。若把超时也算进去，
  // 调用方会误以为「收紧 limit 就能解决」，而真因是 pattern。
  assert.equal(r.limitTruncated, false);
  assert.equal(r.truncated, true);
});

test('0.5.2 预算不足一个合法 vm 时间片时走 wallTimedOut，绝不把 <=0 传给 vm', (t) => {
  const dir = makeTempDir();
  t.after(() => cleanup(dir));
  writeFileSync(join(dir, 'a.txt'), 'hello world\n', 'utf8');
  const { impl } = makeImpl({ DSH_BRIDGE_GREP_TIMEOUT_MS: '1' });
  const r = impl.grep({ pattern: 'hello', path: join(dir, 'a.txt') });
  // vm 的 timeout 传 0/负数语义不明确；实现必须在剩余预算过小时**直接停**而不是交给 vm。
  assert.equal(r.wallTimedOut, true);
  assert.equal(r.regexTimedOut, false, '树太大与正则爆炸是两种结论，必须分开');
  assert.equal(r.truncated, true);
  assert.match(r.note ?? '', /预算内未跑完/);
});

test('0.5.2 正常 pattern 的正则语义零回归（锚点/量词/大小写/行号）', (t) => {
  const dir = makeTempDir();
  t.after(() => cleanup(dir));
  writeFileSync(join(dir, 'code.js'), 'const value_1 = 1;\n  const VALUE_2 = 2;\n', 'utf8');
  const { impl } = makeImpl({});

  const anchored = impl.grep({ pattern: '^const value_\\d+', path: join(dir, 'code.js') });
  assert.equal(anchored.matchCount, 1, '锚点在 vm 内语义不变');
  assert.equal(anchored.matches[0].line, 1, '行号仍为 1 基');

  const ci = impl.grep({ pattern: '^\\s*const value_2', path: join(dir, 'code.js'), caseInsensitive: true });
  assert.equal(ci.matchCount, 1, 'caseInsensitive 仍生效');

  const quant = impl.grep({ pattern: 'value_\\d{1}', path: join(dir, 'code.js') });
  assert.equal(quant.matchCount, 1);

  let threw = null;
  try { impl.grep({ pattern: '([', path: dir }); } catch (e) { threw = e; }
  assert.equal(threw?.code, 'invalid-params', '非法正则仍由主线程预编译挡下');
  assert.match(threw?.message ?? '', /正则不合法/);
});

test('0.5.2 onlyMatching 片段必须截到 500 字符（0.5.1 不截，一条命中可带回整行）', (t) => {
  const dir = makeTempDir();
  t.after(() => cleanup(dir));
  writeFileSync(join(dir, 'long.txt'), `${'z'.repeat(3000)}NEEDLE${'z'.repeat(3000)}`, 'utf8');
  const { impl } = makeImpl({});

  const exact = impl.grep({ pattern: 'NEEDLE', path: join(dir, 'long.txt'), onlyMatching: true });
  assert.equal(exact.matches[0].text, 'NEEDLE', '短片段不受截断影响');

  const wide = impl.grep({ pattern: 'z+', path: join(dir, 'long.txt'), onlyMatching: true });
  assert.equal(wide.matches[0].text.length, 500, `实际 ${wide.matches[0].text.length}；×maxMatches 就是几十 MB 回执`);
});

test('0.5.2 pattern 只作为数据进入 vm，注入型 pattern 不构成代码执行', (t) => {
  const dir = makeTempDir();
  t.after(() => cleanup(dir));
  writeFileSync(join(dir, 'p.txt'), 'hello\n', 'utf8');
  const { impl } = makeImpl({ DSH_BRIDGE_GREP_TIMEOUT_MS: '2000' });

  // 若实现把 pattern 字符串插值进脚本文本，这里就会执行 process.exit 并带走测试进程。
  let threw = null;
  let r = null;
  try {
    r = impl.grep({ pattern: '")); process.exit(3); ("', path: join(dir, 'p.txt') });
  } catch (e) { threw = e; }
  assert.equal(threw?.code, 'invalid-params', '注入型 pattern 应止步于「正则不合法」');
  assert.equal(r, null);

  const ok = impl.grep({ pattern: 'hello', path: join(dir, 'p.txt') });
  assert.equal(ok.matchCount, 1, '进程仍然存活且功能正常');
});

test('0.5.2 grepTimeoutMs 可配置，非法值回退默认而非猜测', () => {
  assert.equal(resolveLocalConfig({}).grepTimeoutMs, DEFAULT_GREP_TIMEOUT_MS);
  assert.equal(resolveLocalConfig({ DSH_BRIDGE_GREP_TIMEOUT_MS: '1234' }).grepTimeoutMs, 1234);
  for (const bad of ['0', '-5', 'abc', '', '1.5']) {
    assert.equal(
      resolveLocalConfig({ DSH_BRIDGE_GREP_TIMEOUT_MS: bad }).grepTimeoutMs,
      DEFAULT_GREP_TIMEOUT_MS,
      `非法值 ${JSON.stringify(bad)} 必须回退默认`,
    );
  }
});

// ---------------------------------------------------------------------------
// 0.5.2 回归钉子：默认凭据保护清单补漏
//
// 缺陷：0.5.1 的清单是凭直觉列的常见项，漏掉多个**本机真实存在**的凭据位置。
// 独立验证脚本实测本机 `.bash_history`、Chrome `Login Data`、Chrome `Local State`
// 均存在且 0.5.1 下可读——网页会话一条 local_read_file 就能取走。
//
// 这批用例同时钉住「不误伤」：保护清单越宽越容易把正常文件挡死，而挡死的代价是
// 用户以为工具坏了。tokens.json（设计系统）、auth.spec.ts、credentials.yaml.example
// 之类必须仍然可读。
// ---------------------------------------------------------------------------

test('0.5.2 多段目录项（含分隔符）生效，且不误伤其父目录', () => {
  const home = homedir();
  // PROTECTED_DIRS 从 0.5.1 的单段名扩到可含分隔符；join+canonical 组合此前从未被验证。
  for (const sub of ['gh', 'gcloud', 'rclone', 'op']) {
    assert.equal(
      isProtectedByDefault(join(home, '.config', sub, 'anything.yml'), home),
      true,
      `~/.config/${sub} 下的文件必须被拦`,
    );
  }
  assert.equal(isProtectedByDefault(join(home, '.config'), home), false,
    '~/.config 本身不能被拦，否则一切搜索都做不了');
  assert.equal(isProtectedByDefault(join(home, '.config', 'git', 'config'), home), false,
    '~/.config 下未列名的子目录不能被误伤');
  // 既有单段项未被多段改动破坏
  assert.equal(isProtectedByDefault(join(home, '.ssh', 'id_rsa'), home), true);
  assert.equal(isProtectedByDefault(join(home, '.dsh', 'settings.yaml'), home), true);
});

test('0.5.2 评审点名的凭据位置逐项被拦', () => {
  const home = homedir();
  const cases = [
    ['Codex CLI auth.json', join(home, '.codex', 'auth.json')],
    ['Claude Code settings.json', join(home, '.claude', 'settings.json')],
    ['Claude Code 会话转写', join(home, '.claude', 'projects', 'x', 'session.jsonl')],
    ['OpenViking ov.conf', join(home, '.openviking', 'ov.conf')],
    ['GitHub CLI hosts.yml', join(home, '.config', 'gh', 'hosts.yml')],
    ['git credential store', join(home, '.git-credentials')],
    ['Docker registry auth', join(home, '.docker', 'config.json')],
    ['bash history', join(home, '.bash_history')],
    ['zsh history', join(home, '.zsh_history')],
    ['psql history', join(home, '.psql_history')],
    ['node repl history', join(home, '.node_repl_history')],
    ['lesshst', join(home, '.lesshst')],
    ['Chromium 密码库', join(home, 'AppData', 'Local', 'Google', 'Chrome', 'User Data', 'Default', 'Login Data')],
    ['Chromium 解密密钥', join(home, 'AppData', 'Local', 'Google', 'Chrome', 'User Data', 'Local State')],
    ['Terraform Cloud token', join(home, '.terraform.d', 'credentials.tfrc.json')],
    ['RubyGems 无扩展名凭据', join(home, '.gem', 'credentials')],
    ['gcloud 凭据库', join(home, '.config', 'gcloud', 'credentials.db')],
    ['PuTTY 私钥', join(home, 'keys', 'mykey.ppk')],
    ['k8s/helm secrets', join(home, 'proj', 'secrets.yaml')],
    ['rclone.conf 任意位置', join(home, 'elsewhere', 'rclone.conf')],
    ['auth.json 任意位置', join(home, 'proj', 'auth.json')],
  ];
  for (const [label, p] of cases) {
    assert.equal(isProtectedByDefault(p, home), true, `${label} 必须被默认保护拦住：${p}`);
  }
});

test('0.5.2 补漏不得误伤常见正常文件名', () => {
  const home = homedir();
  const dir = join(home, 'some-project');
  const benign = [
    'auth.spec.ts', 'authService.ts', 'authentication.md', 'author.json',
    'credentials_test.go', 'mycredentials.txt', 'credentials.yaml.example',
    'env.d.ts', 'environment.json', 'token.md',
    'tokens.json',        // 设计系统的 design tokens，是常见合法文件，刻意不纳入保护
    'secret_notes.md', 'history.md', 'browserhistory.csv',
    'state.json', 'localState.ts', 'loginData.ts', 'data.json',
    'README.md', 'package.json', 'index.mjs', 'config.yaml',
    'gh.md', 'Dockerfile', 'terraform.tf', 'main.tf', 'codex.md', 'rclone.md',
  ];
  for (const name of benign) {
    assert.equal(isProtectedByDefault(join(dir, name), home), false, `${name} 不该被拦`);
  }
});

test('0.5.2 新增项走「默认保护」语义：可显式解除，但强制保护不受影响', () => {
  const home = homedir();
  const codexAuth = join(home, '.codex', 'auth.json');
  const bridgeToken = join(home, '.dsh', 'task-bridge-token');

  try {
    guardPath(codexAuth, { env: {}, op: 'read', home });
    assert.fail('新增项默认应被拒');
  } catch (e) {
    assert.equal(e.code, 'credential-protected');
    assert.match(e.message, /DSH_BRIDGE_FS_DENY_CREDENTIALS=0/, '文案必须告诉用户如何解除');
  }
  // 默认保护可解除——这是它与 PROTECTED_ALWAYS 的语义边界，不能被补漏改动搞混
  assert.equal(typeof guardPath(codexAuth, { env: { DSH_BRIDGE_FS_DENY_CREDENTIALS: '0' }, op: 'read', home }), 'string');
  // 强制保护不因同一个开关而解除
  assert.throws(
    () => guardPath(bridgeToken, { env: { DSH_BRIDGE_FS_DENY_CREDENTIALS: '0' }, op: 'read', home }),
    (e) => e.code === 'credential-protected',
    '本链路凭据的保护不可通过配置解除',
  );
});

test('0.5.2 新增保护在递归遍历中同样生效（不只作用于根）', (t) => {
  // 0.5.1 修的是「walk 内逐条目 guard」；补漏的清单必须走同一条路径才算真生效。
  const dir = makeTempDir();
  t.after(() => cleanup(dir));
  writeFileSync(join(dir, '.git-credentials'), 'https://user:SYNTHETIC-FAKE-TOKEN@github.com\n', 'utf8');
  writeFileSync(join(dir, '.bash_history'), 'export SYNTHETIC_FAKE_SECRET=1\n', 'utf8');
  writeFileSync(join(dir, 'normal.txt'), 'visible content\n', 'utf8');
  const { impl } = makeImpl({ DSH_BRIDGE_LOCAL_FS: '1' });

  const g = impl.grep({ pattern: 'SYNTHETIC', path: dir });
  assert.equal(g.matchCount, 0, '受保护文件的内容绝不能出现在命中里');
  assert.ok(!JSON.stringify(g).includes('SYNTHETIC-FAKE-TOKEN'), '回执任何字段都不得含秘密片段');
  assert.equal(g.skipped.protected, 2, '.git-credentials 与 .bash_history 两个跳过都要计数');

  const l = impl.listDir({ path: dir });
  const names = l.entries.map((e) => e.name);
  assert.ok(!names.includes('.git-credentials'), '列举不得暴露受保护文件的路径');
  assert.ok(!names.includes('.bash_history'));
  assert.ok(names.includes('normal.txt'), '正常文件仍要列出');
  assert.equal(l.skippedProtected, 2);
});

// ---------------------------------------------------------------------------
// 0.5.2 回归钉子：自身完整性保护（禁止改写 bridge-mcp 自己的源码与审计文件）
//
// 缺陷：生产 profile 的 command 直接指向工作树的 src/server.mjs，所以一次
// local_write_file 改写本包源码，会在下次进程重启后被原样加载——那不是破坏，是**持久化**。
//
// 作用域边界（实测得出，不是推断）：local_exec 开着时这层保护拦不住 `echo > src/...`，
// 因为攻击者有 shell。所以它真正防的是「只开 LOCAL_FS 不开 shell」这个更窄配置下
// write_file 这条唯一通道。README 同样写明这条边界。
//
// ⚠️ 用例一律只断言「抛错」，绝不对真实包源码执行写入；需要验证「解除后确实能写」时
//    用注入的临时 selfRoot。
// ---------------------------------------------------------------------------

test('0.5.2 改写本包源码被拒，且文件字节与 mtime 均未变', () => {
  const selfRoot = selfPackageRoot();
  const src = join(selfRoot, 'src', 'local-fs.mjs');
  const before = readFileSync(src);
  const beforeMtime = statSync(src).mtimeMs;
  const { impl } = makeImpl({ DSH_BRIDGE_LOCAL_FS: '1' });

  let threw = null;
  try { impl.writeFile({ path: src, content: '// backdoored\n' }); } catch (e) { threw = e; }

  assert.equal(threw?.code, 'self-write-protected');
  assert.match(threw?.message ?? '', /持久化/, '文案要说清这是持久化风险而不是普通拒绝');
  assert.match(threw?.message ?? '', /DSH_BRIDGE_FS_ALLOW_SELF_WRITE=1/, '文案要给出解除办法');
  assert.ok(readFileSync(src).equals(before), '文件内容必须一字未改');
  assert.equal(statSync(src).mtimeMs, beforeMtime, '连 mtime 都不能动');
});

test('0.5.2 包内任意路径（含新建文件、append 模式）均被拒', () => {
  const selfRoot = selfPackageRoot();
  const { impl } = makeImpl({ DSH_BRIDGE_LOCAL_FS: '1' });
  for (const rel of ['src/server.mjs', 'package.json', 'src/NEW-BACKDOOR.mjs', 'test/local-fs.test.mjs']) {
    let threw = null;
    try { impl.writeFile({ path: join(selfRoot, rel), content: 'x' }); } catch (e) { threw = e; }
    assert.equal(threw?.code, 'self-write-protected', `${rel} 必须被拒`);
  }
  // append 也要拦：否则可往源码尾部追加而不触发「覆盖」直觉
  let threwAppend = null;
  try {
    impl.writeFile({ path: join(selfRoot, 'src', 'local-fs.mjs'), content: '\n// appended\n', mode: 'append' });
  } catch (e) { threwAppend = e; }
  assert.equal(threwAppend?.code, 'self-write-protected');
});

test('0.5.2 读自身源码仍放行（本包是公开仓库，挡读只妨碍正常使用）', () => {
  const selfRoot = selfPackageRoot();
  const { impl } = makeImpl({ DSH_BRIDGE_LOCAL_FS: '1' });
  const r = impl.readFile({ path: join(selfRoot, 'src', 'local-fs.mjs'), limit: 5 });
  assert.equal(r.ok, true);
  assert.ok(r.returnedLines > 0);
  assert.ok(impl.grep({ pattern: 'writeProtectedPaths', path: join(selfRoot, 'src') }).matchCount > 0);
  assert.ok(impl.listDir({ path: join(selfRoot, 'src') }).count > 0);
  // op=read 不得触发写保护
  assert.equal(typeof guardPath(join(selfRoot, 'src', 'local-fs.mjs'), { env: {}, op: 'read' }), 'string');
});

test('0.5.2 路径变形不得绕过写保护（大小写 / ADS / UNC / 目录本身 / 尾分隔符）', () => {
  const selfRoot = selfPackageRoot();
  const src = join(selfRoot, 'src', 'local-fs.mjs');
  const { impl } = makeImpl({ DSH_BRIDGE_LOCAL_FS: '1' });
  const variants = [
    src.toUpperCase(),
    `${src}::$DATA`,
    `\\\\?\\${src}`,
    selfRoot,
    `${selfRoot}\\`,
  ];
  for (const v of variants) {
    let threw = null;
    try { impl.writeFile({ path: v, content: 'x' }); } catch (e) { threw = e; }
    assert.equal(threw?.code, 'self-write-protected', `变形未被拦：${v}`);
  }
});

test('0.5.2 注入的 selfRoot 必须被 canonical（否则保护静默失效——本批次实测踩到的坑）', (t) => {
  // writeProtectedPaths 一度只对 auditFile 做 canonical、selfRoot 原样入清单；
  // 而 guardPath 拿来比的 abs 是 canonical（Windows 下小写），于是注入路径**永不相等**。
  // 默认路径侥幸没事（selfPackageRoot 自己返回 canonical），注入路径全线失效。
  // 0.5.1 的 guardWalkEntry 栽过同一个坑，这是第二次复发，所以单独钉一条。
  const dir = makeTempDir();
  t.after(() => cleanup(dir));
  mkdirSync(join(dir, 'src'), { recursive: true });
  const target = join(dir, 'src', 'x.mjs');
  writeFileSync(target, 'original\n', 'utf8');

  // 故意传**非 canonical**（混合大小写）的 selfRoot
  const mixedCase = dir.toUpperCase();
  const { impl } = makeImpl({ DSH_BRIDGE_LOCAL_FS: '1' }, { selfRoot: mixedCase });

  let threw = null;
  try { impl.writeFile({ path: target, content: 'pwned\n' }); } catch (e) { threw = e; }
  assert.equal(threw?.code, 'self-write-protected', '混合大小写的注入 selfRoot 也必须拦住');
  assert.equal(readFileSync(target, 'utf8'), 'original\n', '文件不得被改写');

  // 清单里的路径必须是 canonical 形式
  const list = writeProtectedPaths({ env: {}, selfRoot: mixedCase });
  assert.equal(list[0].path, canonical(mixedCase), '清单条目必须已 canonical');
});

test('0.5.2 DSH_BRIDGE_FS_ALLOW_SELF_WRITE=1 解除写保护并打强告警', (t) => {
  const dir = makeTempDir();
  t.after(() => cleanup(dir));
  mkdirSync(join(dir, 'src'), { recursive: true });
  const target = join(dir, 'src', 'x.mjs');
  writeFileSync(target, 'original\n', 'utf8');

  const { impl, logs } = makeImpl({ DSH_BRIDGE_LOCAL_FS: '1', DSH_BRIDGE_FS_ALLOW_SELF_WRITE: '1' }, { selfRoot: dir });
  assert.ok(logs.warn.some((w) => /ALLOW_SELF_WRITE=1/.test(w) && /持久化/.test(w)),
    '解除是不可逆的风险放大，必须在日志里可见');

  const r = impl.writeFile({ path: target, content: 'overwritten\n' });
  assert.equal(r.ok, true);
  assert.equal(readFileSync(target, 'utf8'), 'overwritten\n');
  assert.equal(writeProtectedPaths({ env: { DSH_BRIDGE_FS_ALLOW_SELF_WRITE: '1' } }).length, 0);
});

test('0.5.2 审计文件写保护不可被 ALLOW_SELF_WRITE 解除（销毁留痕不算能力）', (t) => {
  const dir = makeTempDir();
  t.after(() => cleanup(dir));
  const auditFile = join(dir, 'audit.log');
  writeFileSync(auditFile, 'AUDIT pre-existing evidence\n', 'utf8');

  const { impl } = makeImpl(
    { DSH_BRIDGE_LOCAL_FS: '1', DSH_BRIDGE_FS_ALLOW_SELF_WRITE: '1', DSH_BRIDGE_AUDIT_FILE: auditFile },
    { selfRoot: dir },
  );
  let threw = null;
  try { impl.writeFile({ path: auditFile, content: '' }); } catch (e) { threw = e; }
  assert.equal(threw?.code, 'self-write-protected');
  assert.match(threw?.message ?? '', /不可通过配置解除/);
  assert.equal(readFileSync(auditFile, 'utf8'), 'AUDIT pre-existing evidence\n', '审计内容不得被清空');

  const list = writeProtectedPaths({ env: { DSH_BRIDGE_FS_ALLOW_SELF_WRITE: '1' }, auditFile });
  assert.equal(list.length, 1, '解除自身写保护后审计文件仍应在清单里');
  assert.equal(list[0].overridable, false);

  // 但审计功能本身照常：写别的文件仍会追加审计行
  impl.writeFile({ path: join(dir, 'legit.txt'), content: 'hello\n' });
  assert.match(readFileSync(auditFile, 'utf8'), /AUDIT local_write_file/);
});

test('0.5.2 包外正常写入零回归，包根上层目录不被误伤', () => {
  const { impl } = makeImpl({ DSH_BRIDGE_LOCAL_FS: '1' });
  const selfRoot = selfPackageRoot();
  // 上层目录（本仓库其它文件）：只校验不落盘，免得测试真去改仓库
  assert.doesNotThrow(() => guardPath(join(selfRoot, '..', 'README.md'), { env: {}, op: 'write' }));
});

// ---------------------------------------------------------------------------
// 0.5.2 回归钉子：审计行防注入 + local_exec 并发闸
// ---------------------------------------------------------------------------

test('0.5.2 auditField 转义换行/制表/引号/反斜杠，且输出可被 JSON.parse 还原', () => {
  const cases = [
    ['plain', 'plain'],
    ['换行', 'a\nb'],
    ['回车', 'a\rb'],
    ['制表', 'a\tb'],
    ['双引号', 'a"b'],
    ['反斜杠', 'C:\\dir\\file'],
    ['尾部反斜杠', 'C:\\'],
    ['伪造审计行', 'dir\nAUDIT local_exec exit=0 command=rm -rf /'],
  ];
  for (const [label, raw] of cases) {
    const encoded = auditField(raw);
    assert.ok(encoded.startsWith('"') && encoded.endsWith('"'), `${label} 必须带引号`);
    assert.ok(!encoded.slice(1, -1).includes('\n'), `${label} 编码后不得含裸换行`);
    assert.ok(!encoded.slice(1, -1).includes('\r'), `${label} 编码后不得含裸回车`);
    assert.equal(JSON.parse(encoded), raw, `${label} 必须可无损还原`);
  }
});

test('0.5.2 命令里的换行不能伪造额外审计行', async (t) => {
  const dir = makeTempDir();
  t.after(() => cleanup(dir));
  const auditFile = join(dir, 'audit.log');
  const { impl, logs } = makeImpl({ DSH_BRIDGE_LOCAL_EXEC: '1', DSH_BRIDGE_AUDIT_FILE: auditFile });

  const evil = `node -e "process.stdout.write('x')"\nAUDIT local_exec cwd=fake exit=0 timedOut=false command="rm -rf /"`;
  await impl.exec({ command: evil, cwd: dir, timeoutMs: 15000 });

  // 落盘审计必须只有一行，注入的假行不得成为独立记录
  const lines = readFileSync(auditFile, 'utf8').replace(/\n$/, '').split('\n');
  assert.equal(lines.length, 1, `注入换行后应仍只有 1 条审计，实际 ${lines.length}`);
  assert.match(lines[0], /^AUDIT local_exec /);
  // 原文仍可无损还原（取证价值不因转义而丢失）
  const m = lines[0].match(/command="(.*)"$/);
  assert.ok(m, '审计行必须带 command 字段');
  assert.equal(JSON.parse(`"${m[1]}"`), evil.trim(), '命令原文要能还原，包括其中的换行');
  assert.equal(logs.info.filter((l) => l.startsWith('AUDIT ')).length, 1);
});

test('0.5.2 审计落盘与 logger 是否被注入无关（0.5.1 注入即静默丢失）', (t) => {
  const dir = makeTempDir();
  t.after(() => cleanup(dir));
  const auditFile = join(dir, 'audit.log');
  const env = { DSH_BRIDGE_LOCAL_FS: '1', DSH_BRIDGE_AUDIT_FILE: auditFile };
  // 故意注入一个「什么都不做」的 logger：0.5.1 下审计会随之消失
  const impl = createLocalTools({
    env,
    config: resolveLocalConfig(env),
    logger: { info: () => {}, warn: () => {} },
  });
  impl.writeFile({ path: join(dir, 'x.txt'), content: 'hello' });
  assert.ok(existsSync(auditFile), '即便 logger 被注入且丢弃一切，审计仍必须落盘');
  assert.match(readFileSync(auditFile, 'utf8'), /^AUDIT local_write_file path="/);
});

test('0.5.2 exec 并发闸：超限立即报 exec-busy，结束后额度归还', async (t) => {
  const dir = makeTempDir();
  t.after(() => cleanup(dir));
  const sleeper = writeScript('sleep-250.mjs', 'setTimeout(()=>{},250);');
  const { impl } = makeImpl({ DSH_BRIDGE_LOCAL_EXEC: '1', DSH_BRIDGE_EXEC_MAX_CONCURRENT: '2' });

  const p1 = impl.exec({ command: `node "${sleeper}"`, cwd: TMP, timeoutMs: 10000 });
  const p2 = impl.exec({ command: `node "${sleeper}"`, cwd: TMP, timeoutMs: 10000 });
  // 第三条必须**同步**被拒（不是排队）：排队会让调用方以为命令在跑
  let threw = null;
  try { impl.exec({ command: `node "${sleeper}"`, cwd: TMP, timeoutMs: 10000 }); } catch (e) { threw = e; }
  assert.equal(threw?.code, 'exec-busy', '超出并发上限必须报 exec-busy');
  assert.match(threw?.message ?? '', /DSH_BRIDGE_EXEC_MAX_CONCURRENT/);
  assert.match(threw?.message ?? '', /local_read_file/, '文案要给出替代路径');

  const [r1, r2] = await Promise.all([p1, p2]);
  assert.equal(r1.exitCode, 0);
  assert.equal(r2.exitCode, 0);

  // 额度必须归还：close 与 exit 都会触发 finish，重复归还会让计数变负、闸门失效
  const p3 = impl.exec({ command: `node "${sleeper}"`, cwd: TMP, timeoutMs: 10000 });
  const p4 = impl.exec({ command: `node "${sleeper}"`, cwd: TMP, timeoutMs: 10000 });
  const [r3, r4] = await Promise.all([p3, p4]);
  assert.equal(r3.exitCode, 0);
  assert.equal(r4.exitCode, 0);
});

test('0.5.2 超时/输出超限路径同样归还并发额度（不泄漏）', async (t) => {
  const sleeper = writeScript('sleep-1200.mjs', 'setTimeout(()=>{},1200);');
  const { impl } = makeImpl({ DSH_BRIDGE_LOCAL_EXEC: '1', DSH_BRIDGE_EXEC_MAX_CONCURRENT: '1' });

  const timed = await impl.exec({ command: `node "${sleeper}"`, cwd: TMP, timeoutMs: 200 });
  assert.equal(timed.timedOut, true, '前置条件：这条必须真的超时');

  // 若超时路径漏了 release，这里会直接 exec-busy
  const after = await impl.exec({ command: 'node -e "process.stdout.write(\'ok\')"', cwd: TMP, timeoutMs: 10000 });
  assert.equal(after.exitCode, 0, '超时之后额度必须已归还');
  assert.match(after.stdout, /ok/);
});

test('0.5.2 execMaxConcurrent 可配置，非法值回退默认而非猜测', () => {
  assert.equal(resolveLocalConfig({}).execMaxConcurrent, DEFAULT_EXEC_MAX_CONCURRENT);
  assert.equal(resolveLocalConfig({ DSH_BRIDGE_EXEC_MAX_CONCURRENT: '7' }).execMaxConcurrent, 7);
  for (const bad of ['0', '-1', 'abc', '', '2.5']) {
    assert.equal(resolveLocalConfig({ DSH_BRIDGE_EXEC_MAX_CONCURRENT: bad }).execMaxConcurrent,
      DEFAULT_EXEC_MAX_CONCURRENT, `非法值 ${JSON.stringify(bad)} 必须回退默认`);
  }
});

// ---------------------------------------------------------------------------
// 0.5.2 回归钉子：DSH_BRIDGE_FS_ALLOW 白名单模式
//
// 白名单最容易写错的不是「拦不住外面」，而是：① 它会不会**放宽**别的保护；
// ② 递归遍历里生不生效（0.5.0 就是只在根上生效，被一次 grep 打穿）；
// ③ 能不能用 `..` / 路径变形 / 「不传 cwd」绕过去。三条都单独钉住。
// ---------------------------------------------------------------------------

test('0.5.2 allowRoots 解析：未设/空/纯分隔符均为 null（= 不启用，零回归）', () => {
  assert.equal(allowRoots({}), null);
  assert.equal(allowRoots({ DSH_BRIDGE_FS_ALLOW: '' }), null);
  assert.equal(allowRoots({ DSH_BRIDGE_FS_ALLOW: '   ' }), null);
  assert.equal(allowRoots({ DSH_BRIDGE_FS_ALLOW: `${delimiter}${delimiter}` }), null);
  const one = allowRoots({ DSH_BRIDGE_FS_ALLOW: TMP });
  assert.equal(one.length, 1);
  assert.equal(one[0], canonical(TMP), '根必须是 canonical 形式，否则与 abs 永不相等');
});

test('0.5.2 白名单外一律 path-not-allowed，白名单内正常', (t) => {
  const inside = makeTempDir();
  const outside = makeTempDir();
  t.after(() => { cleanup(inside); cleanup(outside); });
  writeFileSync(join(inside, 'keep.txt'), 'inside\n', 'utf8');
  writeFileSync(join(outside, 'gone.txt'), 'outside\n', 'utf8');
  const { impl } = makeImpl({ DSH_BRIDGE_LOCAL_FS: '1', DSH_BRIDGE_LOCAL_EXEC: '1', DSH_BRIDGE_FS_ALLOW: inside });

  assert.equal(impl.readFile({ path: join(inside, 'keep.txt') }).ok, true);
  assert.equal(impl.listDir({ path: inside }).ok, true);
  assert.equal(impl.grep({ pattern: 'inside', path: inside }).matchCount, 1);
  assert.equal(impl.writeFile({ path: join(inside, 'new.txt'), content: 'x' }).ok, true);

  for (const [label, fn] of [
    ['readFile', () => impl.readFile({ path: join(outside, 'gone.txt') })],
    ['writeFile', () => impl.writeFile({ path: join(outside, 'pwn.txt'), content: 'x' })],
    ['listDir', () => impl.listDir({ path: outside })],
    ['grep', () => impl.grep({ pattern: 'outside', path: outside })],
    ['exec(cwd)', () => impl.exec({ command: 'node -v', cwd: outside })],
  ]) {
    assert.throws(fn, (e) => e.code === 'path-not-allowed', `${label} 对白名单外必须报 path-not-allowed`);
  }
});

test('0.5.2 白名单**只收窄不放宽**：覆盖 home 也不解除凭据保护', () => {
  // 这是白名单最危险的写法错误：若白名单是「替代」而非「AND」，把 home 加进去
  // 就等于一键解除全部凭据保护，这个开关本身会变成自毁按钮。
  const home = homedir();
  const env = { DSH_BRIDGE_LOCAL_FS: '1', DSH_BRIDGE_FS_ALLOW: home };
  for (const [label, p] of [
    ['强制保护：桥 token', join(home, '.dsh', 'task-bridge-token')],
    ['强制保护：DSH 凭据', join(home, '.dsh', '.credentials.yaml')],
    ['默认保护：ssh 私钥', join(home, '.ssh', 'id_rsa')],
    ['默认保护：Codex 令牌', join(home, '.codex', 'auth.json')],
    ['默认保护：shell history', join(home, '.bash_history')],
  ]) {
    assert.throws(
      () => guardPath(p, { env, op: 'read', home }),
      (e) => e.code === 'credential-protected',
      `${label} 在白名单内仍必须被凭据保护拦住`,
    );
  }
  // 自身写保护同理：白名单覆盖到本包也不能改写本包源码
  const selfSrc = join(selfPackageRoot(), 'src', 'local-fs.mjs');
  assert.throws(
    () => guardPath(selfSrc, { env: { DSH_BRIDGE_FS_ALLOW: selfPackageRoot() }, op: 'write' }),
    (e) => e.code === 'self-write-protected',
    '拒绝原因必须是更具体的 self-write-protected，而不是被白名单挡下',
  );
});

test('0.5.2 `..` 穿越以 canonical 为准：逃不出去', (t) => {
  const root = makeTempDir();
  const inside = join(root, 'proj');
  mkdirSync(inside, { recursive: true });
  const outside = makeTempDir();
  t.after(() => { cleanup(root); cleanup(outside); });
  writeFileSync(join(outside, 'secret.txt'), 'TOP-SECRET\n', 'utf8');
  const { impl } = makeImpl({ DSH_BRIDGE_LOCAL_FS: '1', DSH_BRIDGE_FS_ALLOW: inside });

  // inside/../../<outside> 精确指向白名单外的真实文件
  const escape = join(inside, '..', '..', outside.split(/[\\/]/).pop(), 'secret.txt');
  assert.throws(() => impl.readFile({ path: escape }), (e) => e.code === 'path-not-allowed',
    '`..` 穿越必须在 canonical 之后判定，否则字符串前缀匹配会被绕过');
  // 反斜杠写法同样
  assert.throws(
    () => impl.readFile({ path: `${inside}\\..\\..\\${outside.split(/[\\/]/).pop()}\\secret.txt` }),
    (e) => e.code === 'path-not-allowed',
  );
});

test('0.5.2 路径变形不得进出白名单；白名单根写成大写仍然匹配', (t) => {
  const inside = makeTempDir();
  const outside = makeTempDir();
  t.after(() => { cleanup(inside); cleanup(outside); });
  writeFileSync(join(inside, 'keep.txt'), 'x\n', 'utf8');
  const outsideFile = join(outside, 'gone.txt');
  writeFileSync(outsideFile, 'y\n', 'utf8');

  const { impl } = makeImpl({ DSH_BRIDGE_LOCAL_FS: '1', DSH_BRIDGE_FS_ALLOW: inside });
  for (const variant of [outsideFile.toUpperCase(), `${outsideFile}::$DATA`, `\\\\?\\${outsideFile}`]) {
    assert.throws(() => impl.readFile({ path: variant }), (e) => e.code === 'path-not-allowed',
      `变形不得绕过白名单：${variant}`);
  }
  // 用户常从资源管理器复制到大写盘符路径；根写成大写时内部正常路径必须仍可访问
  const { impl: upper } = makeImpl({ DSH_BRIDGE_LOCAL_FS: '1', DSH_BRIDGE_FS_ALLOW: inside.toUpperCase() });
  assert.equal(upper.readFile({ path: join(inside, 'keep.txt') }).ok, true, '白名单根的大小写变体必须等价');
});

test('0.5.2 递归遍历内部逐条目遵守白名单（0.5.0 的同一条纪律）', (t) => {
  const root = makeTempDir();
  t.after(() => cleanup(root));
  const inside = join(root, 'in');
  const outside = join(root, 'out');
  mkdirSync(inside, { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(inside, 'a.txt'), 'MARK\n', 'utf8');
  writeFileSync(join(outside, 'b.txt'), 'MARK\n', 'utf8');

  // 白名单只含 inside，但搜索根给 root（root 本身在白名单外 → 根就被拒）
  const { impl } = makeImpl({ DSH_BRIDGE_LOCAL_FS: '1', DSH_BRIDGE_FS_ALLOW: inside });
  assert.throws(() => impl.grep({ pattern: 'MARK', path: root }), (e) => e.code === 'path-not-allowed');

  // 白名单给 root（两个子目录都在内），但用 FS_DENY 拉黑 outside：
  // walk 必须逐条目生效，只搜到 inside 的那一处
  const { impl: both } = makeImpl({
    DSH_BRIDGE_LOCAL_FS: '1', DSH_BRIDGE_FS_ALLOW: root, DSH_BRIDGE_FS_DENY: outside,
  });
  const g = both.grep({ pattern: 'MARK', path: root });
  assert.equal(g.matchCount, 1, '只能命中白名单内且未被拉黑的那一处');
  assert.equal(g.skipped.protected, 1, '被拉黑的条目要计数');
  const l = both.listDir({ path: root, recursive: true });
  assert.ok(!l.entries.some((e) => e.path.includes('b.txt')), '递归列举同样不得越界');

  // guardWalkEntry 层面直接断言
  assert.equal(guardWalkEntry(join(inside, 'a.txt'), { env: { DSH_BRIDGE_FS_ALLOW: inside } }) !== null, true);
  assert.equal(guardWalkEntry(join(outside, 'b.txt'), { env: { DSH_BRIDGE_FS_ALLOW: inside } }), null);
  assert.equal(guardWalkEntry(join(outside, 'b.txt'), { env: {} }) !== null, true, '未启用白名单时零回归');
});

test('0.5.2 「不传 cwd/path」不得成为绕过白名单的后门', async (t) => {
  const inside = makeTempDir();
  const outside = makeTempDir();
  t.after(() => { cleanup(inside); cleanup(outside); });
  const { impl } = makeImpl({
    DSH_BRIDGE_LOCAL_FS: '1',
    DSH_BRIDGE_LOCAL_EXEC: '1',
    DSH_BRIDGE_FS_ALLOW: inside,
    DSH_BRIDGE_LOCAL_CWD: outside, // 默认 cwd 故意指向白名单外
  });
  // 0.5.1 只在 args.cwd 存在时才 guard，于是「不传 cwd」直接把 defaultCwd 原样交给子进程
  assert.throws(() => impl.exec({ command: 'node -v' }), (e) => e.code === 'path-not-allowed',
    'exec 不传 cwd 时默认 cwd 也必须过白名单');
  assert.throws(() => impl.grep({ pattern: 'x' }), (e) => e.code === 'path-not-allowed',
    'grep 不传 path 时默认根也必须过白名单');

  const { impl: ok } = makeImpl({
    DSH_BRIDGE_LOCAL_FS: '1', DSH_BRIDGE_LOCAL_EXEC: '1',
    DSH_BRIDGE_FS_ALLOW: inside, DSH_BRIDGE_LOCAL_CWD: inside,
  });
  const r = await ok.exec({ command: 'node -e "process.stdout.write(\'ok\')"', timeoutMs: 15000 });
  assert.equal(r.exitCode, 0, '默认 cwd 在白名单内时正常执行');
});

test('0.5.2 白名单支持多根（path.delimiter 分隔）', (t) => {
  const a = makeTempDir();
  const b = makeTempDir();
  const c = makeTempDir();
  t.after(() => { cleanup(a); cleanup(b); cleanup(c); });
  for (const [d, n] of [[a, 'a.txt'], [b, 'b.txt'], [c, 'c.txt']]) writeFileSync(join(d, n), 'x\n', 'utf8');
  const { impl } = makeImpl({ DSH_BRIDGE_LOCAL_FS: '1', DSH_BRIDGE_FS_ALLOW: [a, b].join(delimiter) });
  assert.equal(allowRoots({ DSH_BRIDGE_FS_ALLOW: [a, b].join(delimiter) }).length, 2);
  assert.equal(impl.readFile({ path: join(a, 'a.txt') }).ok, true);
  assert.equal(impl.readFile({ path: join(b, 'b.txt') }).ok, true);
  assert.throws(() => impl.readFile({ path: join(c, 'c.txt') }), (e) => e.code === 'path-not-allowed');
});

test('0.5.2 白名单启用时启动日志声明范围，并说明它拦不住什么', () => {
  const { logs } = makeImpl({ DSH_BRIDGE_LOCAL_FS: '1', DSH_BRIDGE_FS_ALLOW: TMP });
  const line = logs.info.find((m) => /DSH_BRIDGE_FS_ALLOW 白名单已启用/.test(m));
  assert.ok(line, '必须声明白名单已生效，否则操作者无法确认开关真的起作用了');
  assert.match(line, /不解除任何凭据保护/, '必须说明是 AND 关系');
  assert.match(line, /管不住 local_exec/, '必须说明 exec 用绝对路径仍可越界，避免误以为设了白名单就安全');
});

// ---------------------------------------------------------------------------
// 0.5.2 回归钉子：POSIX 进程组终止分支
//
// 诚实边界：本机是 Windows，且 `wsl.exe -l -v` 返回「没有已安装的分发版」，
// 所以**Linux 内核语义无法实测**。以下用例通过注入 platform/killFn 覆盖代码路径
// （detached、负 pid、SIGKILL、兜底 kill、不去 spawn taskkill），把「未测死代码」
// 降级为「分支已测、内核语义未验证」。后者才是能如实写进文档的表述。
// ---------------------------------------------------------------------------

/** 造一个只记录事件的假子进程；close 晚于超时定时器，确保 treeKill 一定被调用。 */
function fakeTreeChild(events, pid = 4242) {
  return {
    stdout: { on() {}, destroy() {} },
    stderr: { on() {}, destroy() {} },
    on: (ev, fn) => { if (ev === 'close') setTimeout(() => fn(null, 'SIGKILL'), 30); },
    kill: () => events.push('child.kill'),
    pid,
  };
}

test('0.5.2 POSIX 分支：detached:true + kill(-pid, SIGKILL) + 兜底 kill，且不 spawn taskkill', async () => {
  const events = [];
  let spawnOpts = null;
  const env = { DSH_BRIDGE_LOCAL_EXEC: '1', DSH_BRIDGE_EXEC_TIMEOUT_MS: '1000' };
  const impl = createLocalTools({
    env, config: resolveLocalConfig(env), logger: { info() {}, warn() {} },
    platform: 'linux',
    killFn: (pid, signal) => events.push(`kill(${pid},${signal})`),
    spawnFn: (cmd, opts) => { spawnOpts = opts; return fakeTreeChild(events); },
    treeKillFn: () => { events.push('UNEXPECTED-taskkill'); return { on() {}, stdout: { resume() {} }, stderr: { resume() {} } }; },
  });

  const r = await impl.exec({ command: 'sleep 10', timeoutMs: 1 });

  assert.equal(spawnOpts.detached, true, 'POSIX 上必须 detached:true，否则 child.pid 不是 PGID，kill(-pid) 会 ESRCH');
  assert.ok(events.includes('kill(-4242,SIGKILL)'),
    `必须对**负 pid**（进程组）发 SIGKILL；正 pid 只杀 shell、孙进程成孤儿。实际 ${JSON.stringify(events)}`);
  assert.ok(events.includes('child.kill'), '进程组信号之后仍要兜底 kill 直接子进程');
  assert.ok(!events.includes('UNEXPECTED-taskkill'), 'POSIX 分支不得去 spawn Windows 的 taskkill');
  assert.equal(r.timedOut, true);
});

test('0.5.2 win32 分支仍走 taskkill，不误用进程组信号、detached 为 false', async () => {
  const events = [];
  let spawnOpts = null;
  const env = { DSH_BRIDGE_LOCAL_EXEC: '1', DSH_BRIDGE_EXEC_TIMEOUT_MS: '1000' };
  const impl = createLocalTools({
    env, config: resolveLocalConfig(env), logger: { info() {}, warn() {} },
    platform: 'win32',
    killFn: (pid, signal) => events.push(`kill(${pid},${signal})`),
    spawnFn: (cmd, opts) => { spawnOpts = opts; return fakeTreeChild(events); },
    treeKillFn: (cmd, args) => {
      events.push(`taskkill:${cmd}:${args.join(' ')}`);
      const handlers = {};
      const tk = { on: (ev, fn) => { handlers[ev] = fn; }, stdout: { resume() {} }, stderr: { resume() {} } };
      setImmediate(() => handlers.close?.(0));
      return tk;
    },
  });

  await impl.exec({ command: 'anything', timeoutMs: 1 });

  assert.equal(spawnOpts.detached, false, 'win32 上 detached 无意义且可能改变控制台归属');
  assert.ok(events.some((e) => e.startsWith('taskkill:taskkill:/pid 4242 /T /F')),
    `win32 必须用 taskkill /T /F 杀树，实际 ${JSON.stringify(events)}`);
  assert.ok(!events.some((e) => e.startsWith('kill(-')), 'win32 不得走进程组信号分支');
});

// ---------------------------------------------------------------------------
// 0.5.3 P1：junction/symlink 祖先 + **不存在的叶子** → 判定路径与落盘路径分叉
// ---------------------------------------------------------------------------
// 成因（0.5.1 引入，0.5.2 仍在）：displayPath 为还原 OS 正确大小写加了「叶子不存在时逐级
// 上溯到最近存在祖先做 realpath」，却**没有**同步给 canonical——后者在 realpath 失败时退回
// 纯字符串 resolve()，不解析祖先链接。而 guardPath 用 canonical **判定**、writeFile 用
// displayPath **落盘**，于是检查在一个路径上、写入在另一个路径上。
//
// 后果：经 junction 写入 protectedAlways **强制保护**（不可配置解除）的凭据文件成功，三级
// 凭据保护连同「不可解除」那一级全部穿透。Windows 自带 `C:\Documents and Settings` →
// `C:\Users` junction，**零前置条件**可利用；`~/.ssh/authorized_keys` 通常不存在，恰好满足
// 「叶子不存在」这个前提。实测脚本见仓库外 `.tmpfiles/verify-052/n1-junction.mjs`（15/15）。
//
// 为什么 0.5.1/0.5.2 的 109 例没抓到：既有的 symlink 用例（见「四类路径变形」）链接的是
// **已存在**的文件，走的是 realpath 成功分支，根本不经过祖先上溯那段代码。
//
// 修法：抽 resolveWithAncestors 让 canonical 与 displayPath 共用，两者只在大小写上不同；
// 并在 guardPath 末尾加恒等式自校验，对解析后的真实路径重跑全部五级判定（recheck 防递归）。

/** canonical 与 displayPath 的唯一合法差异是大小写；POSIX 区分大小写，故须完全相等。 */
function sameModuloCase(canon, display) {
  return process.platform === 'win32' || process.platform === 'darwin'
    ? canon === display.toLowerCase()
    : canon === display;
}

/** 在 dir 下建一个指向 target 的 junction（POSIX 上 type 被忽略，退化为普通 symlink）。 */
function makeJunction(dir, name, target) {
  const lnk = join(dir, name);
  symlinkSync(target, lnk, 'junction');
  return lnk;
}

test('0.5.3 「junction 祖先 + 不存在的叶子」下 canonical 与 displayPath 必须收敛', (t) => {
  const juncParent = makeTempDir();
  const target = makeTempDir();
  t.after(() => { cleanup(juncParent); cleanup(target); });

  const lnk = makeJunction(juncParent, 'lnk-to-target', target);
  assert.ok(statSync(target).isDirectory(), '前置：junction 目标目录存在');

  const leaf = join(lnk, 'brand-new-file.txt');   // 叶子**不存在**——缺陷的触发前提
  assert.ok(!existsSync(leaf), '前置：叶子确实不存在');

  const c = canonical(leaf);
  const d = displayPath(leaf);
  assert.ok(sameModuloCase(c, d),
    `判定路径与落盘路径必须指向同一物理位置，实际 canonical=${c} displayPath=${d}`);
  assert.ok(!c.includes('lnk-to-target'),
    `叶子不存在时 canonical 也必须解析祖先 junction，实际 ${c}`);

  // 对照：叶子存在时 canonical 本来就正确——证明缺陷只在「新建」路径上，修复没动既有行为
  writeFileSync(join(target, 'already-there.txt'), 'x', 'utf8');
  const existing = join(lnk, 'already-there.txt');
  assert.ok(!canonical(existing).includes('lnk-to-target'), '叶子存在时必须解析 junction');
  assert.ok(sameModuloCase(canonical(existing), displayPath(existing)), '叶子存在时也必须收敛');
});

test('0.5.3 P1：经 junction 写「强制保护」的凭据文件必须被拒（端到端查落盘）', (t) => {
  const juncParent = makeTempDir();
  const protDir = makeTempDir();
  t.after(() => { cleanup(juncParent); cleanup(protDir); });

  // 故意**不创建**：模拟攻击者新建受保护文件，也正是缺陷的触发前提
  const protectedToken = join(protDir, 'task-bridge-token');
  const env = { DSH_BRIDGE_LOCAL_FS: '1', TASK_BRIDGE_TOKEN_FILE: protectedToken };
  const { impl } = makeImpl(env);

  // 前置自证：该路径确实在「不可配置解除」那一层里，否则本用例什么都测不到
  assert.ok(protectedAlways(env).includes(canonical(protectedToken)),
    '前置：合成 token 必须在 protectedAlways 清单内');

  // 直接路径被拒——证明保护本身有效，不是靠别的分支偶然挡住
  assert.throws(() => guardPath(protectedToken, { env, op: 'write' }),
    (e) => e.code === 'credential-protected', '直接写必须被拒');

  const lnk = makeJunction(juncParent, 'lnk-to-prot', protDir);
  const attackPath = join(lnk, 'task-bridge-token');   // 叶子不存在
  assert.equal(canonical(attackPath), canonical(protectedToken),
    '前置：修复后攻击路径必须 canonical 到受保护的真实路径');

  assert.throws(() => guardPath(attackPath, { env, op: 'write' }),
    (e) => e.code === 'credential-protected',
    '经 junction 的同一目标必须同样被拒（0.5.2 在此放行并返回真实路径）');
  assert.throws(() => impl.writeFile({ path: attackPath, content: 'ATTACKER-CONTROLLED-VALUE' }),
    (e) => e.code === 'credential-protected', 'writeFile 必须被拒');
  assert.ok(!existsSync(protectedToken),
    `受保护路径不得被创建/写入，实际内容=${existsSync(protectedToken) ? readFileSync(protectedToken, 'utf8') : 'n/a'}`);
});

test('0.5.3 Windows 自带 junction 不得成为零前置条件的绕过通道', (t) => {
  if (process.platform !== 'win32') { t.skip('仅 Windows 有 Documents and Settings junction'); return; }
  const builtin = 'C:\\Documents and Settings';
  let isLink = false;
  try { isLink = lstatSync(builtin).isSymbolicLink(); } catch { t.skip(`${builtin} 不可 stat`); return; }
  if (!isLink) { t.skip(`${builtin} 不是 junction`); return; }

  // authorized_keys 通常不存在 → 满足「叶子不存在」前提；这正是可植入 SSH 公钥的现实路径
  const probe = join(builtin, basename(homedir()), '.ssh', 'authorized_keys');
  const c = canonical(probe);
  assert.ok(sameModuloCase(c, displayPath(probe)),
    `自带 junction 下两者必须收敛，实际 canonical=${c} displayPath=${displayPath(probe)}`);
  assert.ok(!c.includes('documents and settings'),
    `canonical 必须解析到真实的 C:\\Users 下，实际 ${c}`);
});

test('0.5.3 guardPath 恒等式：返回的落盘路径必须与入参 canonical 相等（含 junction）', (t) => {
  const dir = makeTempDir();
  const juncParent = makeTempDir();
  const target = makeTempDir();
  t.after(() => { cleanup(dir); cleanup(juncParent); cleanup(target); });
  const env = { DSH_BRIDGE_LOCAL_FS: '1' };

  // 无链接的三种形态：已存在文件 / 多层不存在的新建路径 / 目录本身
  const plain = [join(dir, 'a.txt'), join(dir, 'no', 'such', 'deep', 'b.txt'), dir];

  // 有链接的形态：junction 下的已存在叶子与**不存在**的叶子（后者正是 0.5.2 分叉的那条）
  const lnk = makeJunction(juncParent, 'lnk-identity', target);
  writeFileSync(join(target, 'there.txt'), 'x', 'utf8');
  const linked = [
    join(lnk, 'there.txt'),
    join(lnk, 'brand-new.txt'),                      // 叶子不存在
    join(lnk, 'deep', 'deeper', 'brand-new2.txt'),   // 叶子与父目录都不存在
  ];

  for (const p of [...plain, ...linked]) {
    const shown = guardPath(p, { env, op: 'write' });
    assert.equal(canonical(shown), canonical(p),
      `guardPath 返回值必须与入参指向同一物理位置：${shown} vs ${p}`);
  }
  // 链接形态还须**真的解析掉** junction——否则上面的恒等式会因两侧都没解析而侥幸成立
  for (const p of linked) {
    assert.ok(!canonical(p).includes('lnk-identity'),
      `canonical 必须解析 junction，不得保留链接名：${canonical(p)}`);
  }
});

test('0.5.3 op 白名单 fail-closed：未知或**缺失**的 op 一律抛 invalid-params', () => {
  const dir = makeTempDir();
  const env = { DSH_BRIDGE_LOCAL_FS: '1' };
  const p = join(dir, 'x.txt');

  // 第四级自身写保护原先用 `op === 'write'` 精确匹配，任何非该字面量都**静默跳过整级**，
  // 而拒绝文案照样说「拒绝写入」——判定与文案语义相反，且把未知输入默认成放行。
  for (const bad of ['WRITE', 'Write', 'overwrite', 'put', 'delete', '', null, 0, 1, {}, [], NaN]) {
    assert.throws(() => guardPath(p, { env, op: bad }),
      (e) => e.code === 'invalid-params', `op=${JSON.stringify(bad)} 必须被拒`);
  }
  // 漏传 / undefined：曾经签名里写 `op = 'read'`，解构默认值把 undefined 悄悄换成最宽松的
  // read，于是白名单永远拦不到它——白名单看着 fail-closed，实际被默认值绕过。
  assert.throws(() => guardPath(p, { env }),
    (e) => e.code === 'invalid-params', '漏传 op 必须被拒，不得默认成 read');
  assert.throws(() => guardPath(p, { env, op: undefined }),
    (e) => e.code === 'invalid-params', 'op=undefined 必须被拒');
  for (const good of ['read', 'write', 'exec']) {
    assert.doesNotThrow(() => guardPath(p, { env, op: good }), `op=${good} 必须仍被接受`);
  }
});

test('0.5.3 过度拒绝检查：junction 指向的非受保护目录仍须可读写', (t) => {
  const juncParent = makeTempDir();
  const target = makeTempDir();
  t.after(() => { cleanup(juncParent); cleanup(target); });

  const lnk = makeJunction(juncParent, 'lnk-ok', target);
  const { impl } = makeImpl({});
  const viaLink = join(lnk, 'legit.txt');

  const ret = impl.writeFile({ path: viaLink, content: 'LEGIT-VIA-JUNCTION' });
  assert.ok(existsSync(join(target, 'legit.txt')), '写入必须真的落在 junction 目标目录');
  assert.equal(readFileSync(join(target, 'legit.txt'), 'utf8'), 'LEGIT-VIA-JUNCTION');
  if (process.platform === 'win32') {
    assert.match(String(ret.path), /[A-Z]/,
      '回执 path 须保留 OS 正确大小写（0.5.1 的回执修复不得因本次收敛而回退）');
  }
  assert.ok(String(impl.readFile({ path: viaLink }).content).includes('LEGIT-VIA-JUNCTION'),
    '经 junction 读回内容必须正确');
});


