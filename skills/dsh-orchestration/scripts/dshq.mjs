#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Resolve a declared runtime, never a guessed machine-specific development path.
const here = dirname(fileURLToPath(import.meta.url));
const embedded = resolve(here, '../runtime/toolkit');
const source = resolve(here, '../../..');
const root = process.env.DSHQ_HOME ?? (existsSync(join(embedded, 'package.json')) ? embedded : source);
try {
  if (!isAbsolute(root)) throw Error();
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  if (pkg.name !== 'dsh-task-bridge-mcp' || !existsSync(join(root, 'cli/lib/run.mjs'))) throw Error();
} catch {
  process.stderr.write('DSHQ_RUNTIME_MISSING: 找不到有效工具包；请使用完整技能包或明确配置 DSHQ_HOME。\n');
  process.exit(1);
}
const { run } = await import(pathToFileURL(join(root, 'cli/lib/run.mjs')).href);
process.exitCode = await run(process.argv.slice(2));
