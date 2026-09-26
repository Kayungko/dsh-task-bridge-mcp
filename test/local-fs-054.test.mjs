// local-fs-054.test.mjs —— 0.5.4 四项修复的回归钉子。
//
// 这四项与 0.5.3 修的 P1、op fail-open 出自同一批交叉校验，但属**不同缺陷**，
// 已在 0.5.3 代码上重跑 `.tmpfiles/xcheck-fulldisk/repro.mjs` 复核确认仍然存在，
// 不是从 0.5.2 的结论直接搬过来的。
//
// 用户已定语义（缺陷①②）：目录名命中凭据保护清单时**连带保护整个子树**，
// 且可用 `DSH_BRIDGE_FS_DENY_CREDENTIALS=0` 解除——与既有第③层语义一致，
// 不新增「不可解除」级别（那一级只留给本链路自己的凭据）。
//
// 独立成文件而非追加进 local-fs.test.mjs：后者已 2000+ 行，且本批断言自带
// helper 需求（注入 fs 替身、造受保护目录名现场），分开更好维护。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync,
  readdirSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  canonical,
  createLocalTools,
  guardPath,
  guardWalkEntry,
  isProtectedByDefault,
  resolveLocalConfig,
  PROTECTED_NAME_PATTERNS,
} from '../src/local-fs.mjs';

function makeTempDir() {
  return mkdtempSync(join(tmpdir(), 'dsh-local-fs-054-'));
}
function cleanup(dir) {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* 尽力清理 */ }
}

/** 造一组只在临时目录里活动、日志可捕获的实现。`deps` 用于注入 fs 替身。 */
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

/** 造一个「受保护 basename 当目录名」的现场，返回目录路径与其子文件。 */
function makeProtectedNameDir(root, dirName) {
  const protDir = join(root, dirName);
  mkdirSync(join(protDir, 'nested'), { recursive: true });
  const inner = join(protDir, 'nested', 'leak.txt');
  writeFileSync(inner, 'SYNTHETIC-NOT-A-REAL-SECRET', 'utf8');
  return { protDir, inner };
}

// ---------------------------------------------------------------------------
// ① 受保护 basename 当目录名：子树连带保护，两侧判定一致
// ---------------------------------------------------------------------------

test('0.5.4 ①：受保护 basename 当目录名时，子树必须连带保护且两侧判定一致', (t) => {
  const dir = makeTempDir();
  t.after(() => cleanup(dir));
  const { protDir, inner } = makeProtectedNameDir(dir, 'auth.json');
  const env = { DSH_BRIDGE_LOCAL_FS: '1' };
  const { impl } = makeImpl(env);

  // 目录自身命中（0.5.3 就已是 true），子文件此前是 false —— 缺陷就在这里
  assert.equal(isProtectedByDefault(protDir), true, '名为 auth.json 的目录自身应受保护');
  assert.equal(isProtectedByDefault(inner), true,
    '受保护目录的**后代**也必须受保护（0.5.3 返回 false，导致直读放行）');

  // 两侧判定必须一致：guardPath（直读路径）与 guardWalkEntry（遍历路径）
  assert.equal(guardWalkEntry(inner, { env }), null, '遍历侧应跳过');
  assert.throws(() => guardPath(inner, { env, op: 'read' }),
    (e) => e.code === 'credential-protected',
    '直读侧必须给出与遍历侧**相同**的答案（0.5.3 放行，形成「直读能读、遍历搜不到」）');
  assert.throws(() => impl.readFile({ path: inner }),
    (e) => e.code === 'credential-protected', 'readFile 端到端必须被拒');

  // 遍历侧仍跳过整个目录（不因新语义重复计数或改变行为）
  const listed = impl.listDir({ path: dir, recursive: true });
  assert.equal(listed.skippedProtected, 1, '受保护目录应作为 1 个条目被跳过');
  assert.ok(!listed.entries.some((e) => e.name === 'leak.txt'), '子文件不得出现在列举结果里');
});

test('0.5.4 ①：深层嵌套同样连带（不止直接子级）', (t) => {
  const dir = makeTempDir();
  t.after(() => cleanup(dir));
  const deep = join(dir, 'credentials', 'a', 'b', 'c', 'token.txt');
  mkdirSync(join(dir, 'credentials', 'a', 'b', 'c'), { recursive: true });
  writeFileSync(deep, 'SYNTHETIC', 'utf8');
  const env = { DSH_BRIDGE_LOCAL_FS: '1' };

  assert.equal(isProtectedByDefault(deep), true, '任意深度的后代都须受保护');
  assert.throws(() => guardPath(deep, { env, op: 'read' }),
    (e) => e.code === 'credential-protected');
});

// ---------------------------------------------------------------------------
// ② writeFile 不得借「按需建父目录」造出名为 .env 的目录
// ---------------------------------------------------------------------------

test('0.5.4 ②：writeFile 不得借「按需建父目录」造出名为 .env 的目录', (t) => {
  const dir = makeTempDir();
  t.after(() => cleanup(dir));
  const { impl } = makeImpl({ DSH_BRIDGE_LOCAL_FS: '1' });

  const target = join(dir, '.env', 'sub', 'notes.txt');
  assert.throws(() => impl.writeFile({ path: target, content: 'hello' }),
    (e) => e.code === 'credential-protected',
    '写入受保护目录名下的路径必须被拒（0.5.3 放行并创建了真实的 .env 目录）');
  assert.ok(!existsSync(join(dir, '.env')),
    '.env 目录不得被创建——0.5.3 会造出一个 isDirectory() 为 true 的 .env');

  // 对照：名为 .env 的**文件**本来就该被拒（0.5.2 已正确），确认没被新语义改坏
  assert.throws(() => impl.writeFile({ path: join(dir, 'd2', '.env'), content: 'x' }),
    (e) => e.code === 'credential-protected');
  // 对照：不命中清单的普通目录名仍可正常按需创建
  const ok = impl.writeFile({ path: join(dir, 'plain', 'sub', 'a.txt'), content: 'x' });
  assert.equal(ok.ok, true, '普通目录名不受影响');
  assert.ok(existsSync(join(dir, 'plain', 'sub', 'a.txt')));
});

// ---------------------------------------------------------------------------
// ①② 的解除口：用户选定的语义是「连带保护但可配置解除」
// ---------------------------------------------------------------------------

test('0.5.4 ①② 可解除：DSH_BRIDGE_FS_DENY_CREDENTIALS=0 后子树恢复可访问', (t) => {
  const dir = makeTempDir();
  t.after(() => cleanup(dir));
  const { protDir, inner } = makeProtectedNameDir(dir, 'credentials');
  const env = { DSH_BRIDGE_LOCAL_FS: '1', DSH_BRIDGE_FS_DENY_CREDENTIALS: '0' };
  const { impl, logs } = makeImpl(env);

  assert.equal(isProtectedByDefault(inner), true, '清单判定本身不因开关而变');
  const read = impl.readFile({ path: inner });
  assert.ok(String(read.content).includes('SYNTHETIC-NOT-A-REAL-SECRET'),
    '显式解除后应可读（这是用户选定的语义：连带保护但可配置解除）');
  assert.ok(logs.warn.some((w) => /DSH_BRIDGE_FS_DENY_CREDENTIALS/.test(w)),
    '解除时必须打强告警，与第③层既有行为一致');

  // 但本链路自己的凭据仍**强制**不可读——解除开关不得连带打开那一级
  const forced = join(protDir, 'task-bridge-token');
  assert.throws(
    () => guardPath(forced, { env: { ...env, TASK_BRIDGE_TOKEN_FILE: forced }, op: 'read' }),
    (e) => e.code === 'credential-protected', '强制保护那一级不受解除开关影响');
});

// ---------------------------------------------------------------------------
// ③ listDir 统计 readdir 失败；truncated 口径与 grep 对齐
// ---------------------------------------------------------------------------

test('0.5.4 ③：listDir 必须统计 readdir 失败，并把 truncated 用作「结果不完整」', (t) => {
  const dir = makeTempDir();
  t.after(() => cleanup(dir));
  mkdirSync(join(dir, 'ok'), { recursive: true });
  writeFileSync(join(dir, 'ok', 'f.txt'), 'abc', 'utf8');
  const badDir = join(dir, 'bad');
  mkdirSync(badDir, { recursive: true });
  writeFileSync(join(badDir, 'hidden.txt'), 'SECRET-NEEDLE', 'utf8');

  const realReaddir = readdirSync;
  const patchedFs = {
    readFileSync, writeFileSync, appendFileSync, statSync, mkdirSync,
    readdirSync: (p, o) => {
      if (canonical(String(p)) === canonical(badDir)) {
        const e = new Error('EACCES: permission denied'); e.code = 'EACCES'; throw e;
      }
      return realReaddir(p, o);
    },
  };
  const { impl } = makeImpl({ DSH_BRIDGE_LOCAL_FS: '1' }, { fs: patchedFs });
  const r = impl.listDir({ path: dir, recursive: true });

  assert.ok('skippedUnreadable' in r, '回执必须有 skippedUnreadable 字段（0.5.3 没有）');
  assert.equal(r.skippedUnreadable, 1, '一个不可读目录应计 1');
  assert.equal(r.skippedProtected, 0, '不可读与受保护是两种不同原因，不得混计');
  assert.equal(r.truncated, true,
    '有子树没列出来时 truncated 必须为 true（口径与 local_grep 一致；0.5.3 是 false）');
  assert.equal(r.limitTruncated, false, 'limitTruncated 才是「被 limit 截断」的狭义标志');
  assert.match(String(r.note), /不可读/, 'note 必须说明不完整的原因');

  // grep 对同一棵树本来就有 unreadable 计数——两个工具口径必须一致
  const g = impl.grep({ path: dir, pattern: 'NEEDLE' });
  assert.equal(g.skipped.unreadable, 1, 'grep 侧计数应与 listDir 一致');
  assert.equal(g.truncated, true);
});

test('0.5.4 ③ 回归：正常目录不得因新语义谎报不完整', (t) => {
  const dir = makeTempDir();
  t.after(() => cleanup(dir));
  mkdirSync(join(dir, 'a', 'b'), { recursive: true });
  writeFileSync(join(dir, 'a', 'b', 'f.txt'), 'x', 'utf8');
  const { impl } = makeImpl({ DSH_BRIDGE_LOCAL_FS: '1' });

  const r = impl.listDir({ path: dir, recursive: true });
  assert.equal(r.truncated, false, '一切可读且不触顶时不得置 truncated');
  assert.equal(r.limitTruncated, false);
  assert.equal(r.depthLimited, false);
  assert.equal(r.skippedProtected, 0);
  assert.equal(r.skippedUnreadable, 0);
  assert.equal(r.note, undefined, '完整列举不该带「结果不完整」的 note');
  assert.ok(r.count >= 2);
});

test('0.5.4 ③：limit 截断时 limitTruncated 与 truncated 都为真，原因可区分', (t) => {
  const dir = makeTempDir();
  t.after(() => cleanup(dir));
  for (let i = 0; i < 5; i += 1) writeFileSync(join(dir, `f${i}.txt`), 'x', 'utf8');
  const { impl } = makeImpl({ DSH_BRIDGE_LOCAL_FS: '1' });

  const r = impl.listDir({ path: dir, limit: 2 });
  assert.equal(r.count, 2);
  assert.equal(r.limitTruncated, true, '狭义标志须为真');
  assert.equal(r.truncated, true, '广义标志也须为真');
  assert.equal(r.skippedUnreadable, 0, '原因不得混计成不可读');
  assert.match(String(r.note), /limit=2/);
});

// ---------------------------------------------------------------------------
// ④ 落盘失败的写也留审计行
// ---------------------------------------------------------------------------

test('0.5.4 ④：落盘失败的写必须留审计行（含 result=FAILED 与 errorCode）', (t) => {
  const dir = makeTempDir();
  t.after(() => cleanup(dir));
  const auditFile = join(dir, 'audit.log');
  const failingFs = {
    readFileSync, appendFileSync, readdirSync, statSync, mkdirSync,
    writeFileSync: () => { const e = new Error('EACCES: permission denied'); e.code = 'EACCES'; throw e; },
  };
  const { impl, logs } = makeImpl(
    { DSH_BRIDGE_LOCAL_FS: '1', DSH_BRIDGE_AUDIT_FILE: auditFile },
    { fs: failingFs },
  );

  assert.throws(() => impl.writeFile({ path: join(dir, 'x.txt'), content: 'payload' }),
    (e) => e.code === 'EACCES', '错误仍须如实冒泡给调用方');

  // 0.5.3：审计文件根本没被创建、logger 收到 0 行 —— 失败的写尝试毫无痕迹
  assert.ok(existsSync(auditFile), '失败的写也必须创建审计文件');
  const line = readFileSync(auditFile, 'utf8').trim();
  assert.match(line, /^AUDIT local_write_file /, '审计行格式须与成功路径一致');
  assert.match(line, /result=FAILED/, '必须标明失败');
  assert.match(line, /errorCode="EACCES"/, '必须记录失败原因（经 auditField 转义）');
  assert.match(line, /intendedBytes=7/, '应记录**意图**写入的字节数');
  assert.ok(!/payload/.test(line), '审计绝不得记录文件内容');
  assert.ok(logs.info.some((l) => /result=FAILED/.test(l)), '审计走 logger 与落盘双通道');
});

test('0.5.4 ④：成功的写仍留审计，且带 result=ok（两条路径可区分）', (t) => {
  const dir = makeTempDir();
  t.after(() => cleanup(dir));
  const auditFile = join(dir, 'audit.log');
  const { impl } = makeImpl({ DSH_BRIDGE_LOCAL_FS: '1', DSH_BRIDGE_AUDIT_FILE: auditFile });

  impl.writeFile({ path: join(dir, 'ok.txt'), content: 'hello' });
  const line = readFileSync(auditFile, 'utf8').trim();
  assert.match(line, /result=ok/);
  assert.match(line, /writtenBytes=5/);
  assert.ok(!/hello/.test(line), '成功路径同样不得记录内容');
});

test('0.5.4 ④：mkdirSync 失败同样留审计（父目录建不出来也是失败的写尝试）', (t) => {
  const dir = makeTempDir();
  t.after(() => cleanup(dir));
  const auditFile = join(dir, 'audit.log');
  const failingFs = {
    readFileSync, appendFileSync, readdirSync, statSync, writeFileSync,
    mkdirSync: () => { const e = new Error('EACCES: permission denied'); e.code = 'EACCES'; throw e; },
  };
  const { impl } = makeImpl(
    { DSH_BRIDGE_LOCAL_FS: '1', DSH_BRIDGE_AUDIT_FILE: auditFile },
    { fs: failingFs },
  );

  assert.throws(() => impl.writeFile({ path: join(dir, 'sub', 'x.txt'), content: 'p' }));
  assert.match(readFileSync(auditFile, 'utf8'), /result=FAILED/, 'mkdir 失败也须留痕');
});

test('0.5.4 ④：审计行对 errorCode 做防注入转义', (t) => {
  const dir = makeTempDir();
  t.after(() => cleanup(dir));
  const auditFile = join(dir, 'audit.log');
  const evil = 'EACCES\nAUDIT local_exec command="rm -rf /" exit=0';
  const failingFs = {
    readFileSync, appendFileSync, readdirSync, statSync, mkdirSync,
    writeFileSync: () => { const e = new Error(evil); e.code = evil; throw e; },
  };
  const { impl } = makeImpl(
    { DSH_BRIDGE_LOCAL_FS: '1', DSH_BRIDGE_AUDIT_FILE: auditFile },
    { fs: failingFs },
  );
  assert.throws(() => impl.writeFile({ path: join(dir, 'y.txt'), content: 'z' }));

  const text = readFileSync(auditFile, 'utf8');
  assert.equal(text.trim().split('\n').length, 1, '换行不得伪造出第二条审计记录');
  assert.ok(!/^AUDIT local_exec/m.test(text), '注入的 local_exec 记录不得成为独立一行');
});

// ---------------------------------------------------------------------------
// 合并正则未被收紧（保护静默变窄比漏计更危险，因为它不报错）
// ---------------------------------------------------------------------------

test('0.5.4 合并正则未被收紧：逐条模式仍命中（含三条 substring 语义）', () => {
  const dir = makeTempDir();
  try {
    // isProtectedByDefault 内部改用预编译合并正则以控制递归遍历开销（每条目 × 路径深度）。
    // 合并时若误加外层 ^…$，三条 substring 模式（\.(pem|p12|pfx|key|ppk)$、
    // (^|[^a-z])credentials?\.(json|ya?ml)$、(^|[\\/\.])(kubeconfig|netrc|…)$）会被收紧成
    // 「整段完全匹配」，于是 foo.pem / x-credentials.json 这类**本该命中**的名字静默漏掉。
    const mustProtect = [
      '.env', '.env.local', '.env.production', 'id_rsa', 'id_ed25519', 'id_ecdsa.pub',
      'id_dsa', 'server.pem', 'my.p12', 'k.pfx', 'tls.key', 'putty.ppk',
      'credentials.json', 'credentials.yaml', 'credentials.yml', 'x-credentials.json',
      'sub.credentials.yaml', 'kubeconfig', 'netrc', '_netrc', 'pgpass', 'npmrc', 'pypirc',
      'my.kubeconfig', '.npmrc', '.git-credentials', 'auth.json', 'credentials',
      'credentials.db', 'credentials.tfrc.json', 'secret.yaml', 'secrets.json',
      'secret.yml', 'rclone.conf', '.bash_history', '.zsh_history', '.sh_history',
      '.ksh_history', '.fish_history', '.psql_history', '.mysql_history',
      '.rediscli_history', '.python_history', '.node_repl_history', '.sqlite_history',
      '.lesshst', 'Login Data', 'Login Data-journal', 'Local State',
    ];
    for (const name of mustProtect) {
      assert.equal(isProtectedByDefault(join(dir, name)), true, `${name} 必须仍受保护`);
    }
    assert.ok(mustProtect.length >= PROTECTED_NAME_PATTERNS.length,
      '样本数应不少于模式数，确保每条模式都被 exercised');

    // 误伤仍是缺陷：这些普通名必须可访问（0.5.2 就把误伤当缺陷测过）
    const mustAllow = [
      'tokens.json', 'auth.spec.ts', 'credentials.yaml.example', 'state.json', 'Dockerfile',
      'package.json', 'README.md', 'env.js', '.envrc', 'mycredentials', 'credential',
      'pemfile', 'key.txt', 'auth.json.bak', 'notsecret.yaml', 'rclone.conf.example',
      'history.txt', 'login.dat', 'localstate', 'index.ts', 'config.yaml',
    ];
    for (const name of mustAllow) {
      assert.equal(isProtectedByDefault(join(dir, name)), false, `${name} 不得被误伤`);
    }
  } finally {
    cleanup(dir);
  }
});

// ---------------------------------------------------------------------------
// 过度拒绝检查：连带子树语义不得波及普通目录
// ---------------------------------------------------------------------------

test('0.5.4 过度拒绝检查：普通目录名不因连带子树语义受影响', (t) => {
  const dir = makeTempDir();
  t.after(() => cleanup(dir));
  const { impl } = makeImpl({ DSH_BRIDGE_LOCAL_FS: '1' });

  // 真实项目里常见的目录名，含与保护模式**形近但不命中**的
  const ordinary = [
    'src', 'node_modules', 'config', 'test-fixtures', 'auth.spec', 'env',
    'credentials-example', 'docs', 'assets', 'lib', 'scripts', 'build-output',
  ];
  for (const d of ordinary) {
    const p = join(dir, d, 'nested', 'deep', 'f.txt');
    assert.equal(isProtectedByDefault(p), false, `${d}/ 不得被判为受保护`);
    const r = impl.writeFile({ path: p, content: 'ok' });
    assert.equal(r.ok, true, `${d}/ 下的文件必须可写`);
  }
});
