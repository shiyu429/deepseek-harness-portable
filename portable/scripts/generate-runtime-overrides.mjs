/** Pin the production dependency graph to the versions already recorded by the upstream lock. */
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { project, upstream } from './environment.mjs';
const require = createRequire(resolve(upstream, 'package.json'));
const yaml = require('js-yaml');
const lock = yaml.load(await readFile(resolve(upstream, 'pnpm-lock.yaml'), 'utf8'));
function parts(key) {
  const base = key.split('(')[0], at = base.lastIndexOf('@');
  return at > 0 ? [base.slice(0, at), base.slice(at + 1)] : undefined;
}
const versions = new Map();
for (const key of Object.keys(lock.packages)) {
  const pair = parts(key);
  if (!pair || !/^\d/.test(pair[1])) continue;
  const set = versions.get(pair[0]) || new Set(); set.add(pair[1]); versions.set(pair[0], set);
}
const overrides = {};
const ambiguous = new Set();
for (const [name, candidates] of versions) overrides[name] = [...candidates].sort().join(' || ');
for (const [key, snapshot] of Object.entries(lock.snapshots)) {
  const pair = parts(key); if (!pair || !/^\d/.test(pair[1])) continue;
  for (const [child, resolution] of Object.entries({ ...snapshot.dependencies, ...snapshot.optionalDependencies })) {
    if (typeof resolution !== 'string' || !/^\d/.test(resolution)) continue;
    const selected = resolution.split('(')[0];
    const selector = `${pair[0]}@${pair[1]}>${child}`;
    if (ambiguous.has(selector)) continue;
    if (overrides[selector] && overrides[selector] !== selected) { delete overrides[selector]; ambiguous.add(selector); continue; }
    overrides[selector] = selected;
  }
}
for (const [directory, importer] of Object.entries(lock.importers)) {
  if (directory === '.') continue;
  let manifest;
  try { manifest = JSON.parse(await readFile(resolve(upstream, directory, 'package.json'), 'utf8')); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
  if (typeof manifest.name !== 'string' || typeof manifest.version !== 'string' || !/^\d/.test(manifest.version)) continue;
  for (const [child, record] of Object.entries({ ...importer.devDependencies, ...importer.dependencies, ...importer.optionalDependencies })) {
    if (!record || typeof record.version !== 'string' || !/^\d/.test(record.version)) continue;
    overrides[`${manifest.name}@${manifest.version}>${child}`] = record.version.split('(')[0];
  }
}
const sorted = Object.fromEntries(Object.entries(overrides).sort(([a], [b]) => a.localeCompare(b)));
await writeFile(resolve(project, 'runtime-overrides.json'), JSON.stringify(sorted, null, 2) + '\n');
console.log(`Pinned ${Object.keys(sorted).length} production dependency selections to the upstream lock.`);
