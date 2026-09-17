import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildSkillBundle } from '../scripts/package-skills.mjs';

const exec = promisify(execFile);
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
async function scratch(t) {
  const root = await fs.mkdtemp(join(tmpdir(), 'skill package '));
  t.after(async () => { assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep)); await fs.rm(root, { recursive: true, force: true }); });
  return root;
}
test('prepared skill is portable, linked, fingerprinted and contains no user state', async t => {
  const root = await scratch(t), bundle = await buildSkillBundle(join(root, 'prepared bundle'));
  const manifest = JSON.parse(await fs.readFile(join(bundle.output, 'bundle-manifest.json'), 'utf8'));
  assert.equal(manifest.kind, 'prepared-skill-bundle');
  assert.equal(manifest.files.filter(f => f.path.endsWith('/SKILL.md')).length, 1);
  for (const file of manifest.files) {
    assert.doesNotMatch(file.path, /\.dshq|node_modules|\.git|test\/|config\.toml/);
    const path = join(bundle.output, file.path), body = await fs.readFile(path);
    assert.equal(createHash('sha256').update(body).digest('hex'), file.sha256);
    if (path.endsWith('.md')) {
      for (const [, target] of body.toString().matchAll(/\[[^\]\n]+\]\(([^\s)]+)\)/g)) {
        if (/^[a-z][a-z\d+.-]*:|^#/i.test(target)) continue;
        const linked = resolve(dirname(path), target.split('#')[0]);
        assert.ok(linked.startsWith(bundle.skill + sep));
        assert.ok((await fs.stat(linked)).isFile());
      }
    }
  }
  const env = { ...process.env }; delete env.DSHQ_HOME;
  const help = await exec(process.execPath, [join(bundle.skill, 'scripts/dshq.mjs'), '--help'], { cwd: root, env });
  assert.match(help.stdout, /workflow/); assert.match(help.stdout, /monitor/);
  const { run } = await import(pathToFileURL(join(bundle.skill, 'runtime/toolkit/cli/lib/run.mjs')).href);
  const input = join(root, 'create.json'); await fs.writeFile(input, JSON.stringify({ title: 'Offline portable workflow', observers: [], bindings: [] }));
  const invoke = async args => {
    let stdout = '', stderr = '';
    const code = await run([...args, '--json'], { home: join(root, 'isolated home'), env: { CODEX_THREAD_ID: 'packaging-test' },
      stdout: { write: s => { stdout += s; } }, stderr: { write: s => { stderr += s; } } });
    assert.equal(code, 0, stdout + stderr); assert.equal(stderr, ''); return JSON.parse(stdout);
  };
  const created = await invoke(['workflow', 'create', '--input-file', input]);
  assert.equal(created.mode, 'observe');
  assert.equal((await invoke(['workflow', 'next', created.workflowId])).readyCount, 0);
});

test('source wrapper works and a missing explicit runtime fails without path guessing', async t => {
  const root = await scratch(t), script = join(repo, 'skills/dsh-orchestration/scripts/dshq.mjs');
  const env = { ...process.env }; delete env.DSHQ_HOME;
  assert.match((await exec(process.execPath, [script, '--help'], { env })).stdout, /workflow/);
  await assert.rejects(exec(process.execPath, [script, '--help'], { env: { ...env, DSHQ_HOME: join(root, 'missing') } }), e => {
    assert.equal(e.code, 1); assert.match(e.stderr, /^DSHQ_RUNTIME_MISSING:/); assert.equal(e.stdout, ''); return true;
  });
});

test('packaging refuses source, active destinations and nonempty output without replacing files', async t => {
  const root = await scratch(t), sentinel = join(root, 'keep.txt'); await fs.writeFile(sentinel, 'preserve');
  await assert.rejects(buildSkillBundle(root), /empty ordinary directory/);
  assert.equal(await fs.readFile(sentinel, 'utf8'), 'preserve');
  for (const target of [join(repo, 'prepared'), join(homedir(), '.agents/skills/prepared'), join(homedir(), '.codex/skills/prepared'), join(homedir(), '.dsh/profiles/prepared')]) {
    await assert.rejects(buildSkillBundle(target), /outside source and active/);
  }
  const junction = join(root, 'source-link');
  await fs.symlink(repo, junction, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(buildSkillBundle(join(junction, 'prepared')), /outside source and active/);
  // Remove the junction itself before recursive scratch cleanup.
  await fs.unlink(junction);
});
