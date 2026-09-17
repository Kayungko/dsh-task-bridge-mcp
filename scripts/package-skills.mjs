#!/usr/bin/env node
// Prepare an isolated artifact; never install it or copy user configuration.
import { constants } from 'node:fs';
import { copyFile, lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const within = (parent, child) => { const rel = relative(parent, child); return !rel || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`)); };
async function canonical(path) {
  try { return await realpath(path); }
  catch (e) { if (e.code !== 'ENOENT') throw e; const parent = dirname(path); if (parent === path) throw e; return join(await canonical(parent), relative(parent, path)); }
}
async function filesIn(dir) {
  const files = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new Error('Bundle inputs must not be symbolic links.');
    if (entry.isDirectory()) files.push(...(await filesIn(join(dir, entry.name))).map(p => join(entry.name, p)));
    else if (entry.isFile()) files.push(entry.name);
  }
  return files.sort();
}

export async function buildSkillBundle(output) {
  if (!output || !isAbsolute(output)) throw new Error('--out must be an absolute path to an empty staging directory.');
  const out = resolve(output), actual = await canonical(out);
  const forbidden = [repo, join(homedir(), '.agents', 'skills'), join(homedir(), '.codex', 'skills'),
    join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'skills'), join(homedir(), '.dsh'),
    ...(process.env.DSH_HOME ? [resolve(process.env.DSH_HOME)] : [])];
  for (const path of forbidden) {
    if (within(await canonical(resolve(path)), actual)) throw new Error('Staging output must be outside source and active skill/DSH directories.');
  }
  try {
    const info = await lstat(out);
    if (!info.isDirectory() || info.isSymbolicLink() || (await readdir(out)).length) throw new Error('Staging output must be an empty ordinary directory.');
  } catch (e) { if (e.code !== 'ENOENT') throw e; }

  const mapping = new Map([
    ['skills/dsh-orchestration/SKILL.md', 'SKILL.md'],
    ['skills/dsh-task-bridge/SKILL.md', 'references/bridge-protocol.md'],
    ...['cli-operations', 'local-monitor', 'workflow-v1', 'workflow-agent-template', 'codex-integration']
      .map(name => [`docs/${name}.md`, `references/${name}.md`]),
  ].map(([src, dest]) => [resolve(repo, src), dest]));
  // Validate and rewrite references before creating the artifact.
  const docs = [];
  for (const [source, dest] of mapping) {
    const body = (await readFile(source, 'utf8')).replace(/(\[[^\]\n]+\]\()([^\s)]+)(\))/g, (match, start, target, end) => {
      if (/^[a-z][a-z\d+.-]*:|^#/i.test(target)) return match;
      const [path, fragment] = target.split('#');
      const mapped = mapping.get(resolve(dirname(source), path));
      if (!mapped) throw new Error(`Unmapped skill reference: ${target}`);
      return start + relative(dirname(dest), mapped).split(sep).join('/') + (fragment ? `#${fragment}` : '') + end;
    });
    docs.push([dest, body]);
  }
  const root = join(out, 'dsh-orchestration');
  await mkdir(root, { recursive: true });
  for (const [dest, body] of docs) { await mkdir(dirname(join(root, dest)), { recursive: true }); await writeFile(join(root, dest), body, { flag: 'wx' }); }
  const copy = async (source, dest) => { await mkdir(dirname(dest), { recursive: true }); await copyFile(source, dest, constants.COPYFILE_EXCL); };
  await copy(join(repo, 'skills/dsh-orchestration/scripts/dshq.mjs'), join(root, 'scripts/dshq.mjs'));
  const runtime = join(root, 'runtime/toolkit');
  await copy(join(repo, 'package.json'), join(runtime, 'package.json'));
  await copy(join(repo, 'cli/dshq.mjs'), join(runtime, 'cli/dshq.mjs'));
  for (const folder of ['src', 'cli/lib']) {
    for (const name of await filesIn(join(repo, folder))) {
      if (name.endsWith('.mjs')) await copy(join(repo, folder, name), join(runtime, folder, name));
    }
  }
  const files = [];
  for (const path of await filesIn(root)) files.push({ path: `dsh-orchestration/${path.split(sep).join('/')}`, sha256: createHash('sha256').update(await readFile(join(root, path))).digest('hex') });
  const manifest = { kind: 'prepared-skill-bundle', version: 1, toolkitVersion: JSON.parse(await readFile(join(repo, 'package.json'), 'utf8')).version, files };
  await writeFile(join(out, 'bundle-manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
  return { output: out, skill: root, fileCount: files.length };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 4 || process.argv[2] !== '--out') throw new Error('Usage: node scripts/package-skills.mjs --out <absolute-empty-staging-directory>');
    process.stdout.write(JSON.stringify(await buildSkillBundle(process.argv[3])) + '\n');
  } catch (e) { process.stderr.write(e.message + '\n'); process.exitCode = 1; }
}
