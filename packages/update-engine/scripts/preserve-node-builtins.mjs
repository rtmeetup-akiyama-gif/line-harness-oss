import { builtinModules } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const builtins = builtinModules
  .filter((name) => !name.startsWith('node:'))
  .sort((a, b) => b.length - a.length);

const builtinPattern = builtins.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');

const importFromPattern = new RegExp(`\\bfrom\\s+(["'])(${builtinPattern})\\1`, 'g');
const sideEffectImportPattern = new RegExp(`\\bimport\\s+(["'])(${builtinPattern})\\1`, 'g');
const requirePattern = new RegExp(`\\brequire\\(\\s*(["'])(${builtinPattern})\\1\\s*\\)`, 'g');
const dynamicImportPattern = new RegExp(`\\bimport\\(\\s*(["'])(${builtinPattern})\\1\\s*\\)`, 'g');

export function preserveNodeBuiltinSpecifiers(source) {
  return source
    .replace(importFromPattern, 'from $1node:$2$1')
    .replace(sideEffectImportPattern, 'import $1node:$2$1')
    .replace(requirePattern, 'require($1node:$2$1)')
    .replace(dynamicImportPattern, 'import($1node:$2$1)');
}

export function findBareNodeBuiltinSpecifiers(source) {
  const matches = [
    ...source.matchAll(importFromPattern),
    ...source.matchAll(sideEffectImportPattern),
    ...source.matchAll(requirePattern),
    ...source.matchAll(dynamicImportPattern),
  ];
  return [...new Set(matches.map((match) => match[2]))].sort();
}

function rewriteFile(path) {
  const original = readFileSync(path, 'utf8');
  const rewritten = preserveNodeBuiltinSpecifiers(original);
  if (rewritten !== original) {
    writeFileSync(path, rewritten);
  }

  const remaining = findBareNodeBuiltinSpecifiers(rewritten);
  if (remaining.length > 0) {
    throw new Error(`${path} still contains bare Node built-in imports: ${remaining.join(', ')}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const here = dirname(fileURLToPath(import.meta.url));
  const packageRoot = join(here, '..');
  rewriteFile(join(packageRoot, 'dist/index.mjs'));
  rewriteFile(join(packageRoot, 'dist/index.cjs'));
}
