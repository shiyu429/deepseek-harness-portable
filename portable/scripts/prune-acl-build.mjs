/** Remove unreachable chunks and declarations left by previous incremental ACL builds. */
import { readFile, readdir, unlink, access } from 'node:fs/promises';
import { join, relative, isAbsolute, dirname, resolve } from 'node:path';
import { upstream } from './environment.mjs';
import { pathToFileURL } from 'node:url';
export async function pruneAclBuild() {
  const root = join(upstream,'packages/sandbox/sandbox-windows-acl');
  const lib = join(root,'lib');
  const reachable = new Set(), pending = ['index.js','runner.js'];
  while (pending.length) {
    const name = pending.pop(); if (reachable.has(name)) continue;
    const file = resolve(lib,name), part = relative(lib,file);
    if (!part || part.startsWith('..') || isAbsolute(part)) throw new Error('Invalid compiled module path');
    reachable.add(part);
    const text = await readFile(file,'utf8');
    for (const match of text.matchAll(/["'](\.\/[^"']+\.js)["']/g)) pending.push(join(dirname(part),match[1]));
  }
  const removed = [];
  for (const name of await readdir(lib)) {
    if (/^types-.*\.js$/.test(name) && !reachable.has(name)) removed.push(name);
  }
  for (const name of await readdir(join(lib,'types'))) {
    if (!name.endsWith('.d.ts')) continue;
    try { await access(join(root,'src',name.slice(0,-5)+'.ts')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; removed.push(join('types',name)); }
  }
  for (const name of removed) await unlink(join(lib,name));
  return removed.map(name=>'lib/'+name.replaceAll('\\','/'));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) console.log('Removed stale ACL outputs:',await pruneAclBuild());
