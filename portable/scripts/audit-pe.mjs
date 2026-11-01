/** Inspect Windows import tables without executing optional or foreign-architecture helpers. */
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join, dirname, relative } from 'node:path';
import { work } from './environment.mjs';
const root = resolve(process.argv[2] || join(work, 'packed-app/win-unpacked'));
const files = [], dependencies = [];
async function visit(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) await visit(join(directory, entry.name));
    else if (/\.(?:exe|dll|node)$/i.test(entry.name)) files.push(join(directory, entry.name));
  }
}
await visit(root);
for (const filename of files) {
  const bytes = await readFile(filename);
  if (bytes.length < 128 || bytes.readUInt16LE(0) !== 0x5a4d) continue;
  const pe = bytes.readUInt32LE(0x3c);
  if (pe + 24 >= bytes.length || bytes.readUInt32LE(pe) !== 0x4550) continue;
  const machine = bytes.readUInt16LE(pe + 4), count = bytes.readUInt16LE(pe + 6);
  const optional = pe + 24, size = bytes.readUInt16LE(pe + 20);
  const wide = bytes.readUInt16LE(optional) === 0x20b;
  const directories = optional + (wide ? 112 : 96);
  const rva = bytes.readUInt32LE(directories + 8);
  if (!rva) continue;
  function position(address) {
    for (let i = 0; i < count; i++) {
      const section = optional + size + i * 40;
      const start = bytes.readUInt32LE(section + 12), length = Math.max(bytes.readUInt32LE(section + 8), bytes.readUInt32LE(section + 16));
      if (address >= start && address < start + length) return address - start + bytes.readUInt32LE(section + 20);
    }
    throw new Error('Invalid PE import address: ' + filename);
  }
  const imported = [];
  for (let cursor = position(rva); cursor + 20 <= bytes.length; cursor += 20) {
    const name = bytes.readUInt32LE(cursor + 12); if (!name) break;
    const offset = position(name), end = bytes.indexOf(0, offset);
    imported.push(bytes.toString('ascii', offset, end).toLowerCase());
  }
  dependencies.push({ file: relative(root, filename).replaceAll('\\', '/'), machine, imports: imported });
}
const crt = dependencies.filter(entry => entry.machine === 0x8664).flatMap(entry => entry.imports.filter(name => /^(?:msvcp|vcruntime|concrt|vcomp)\d/i.test(name)).map(name => ({ file: entry.file, dependency: name, adjacent: files.some(filename => dirname(filename).toLowerCase() === dirname(join(root, entry.file)).toLowerCase() && filename.toLowerCase().endsWith('\\' + name)) })));
await writeFile(join(work, 'qa', 'pe-imports.json'), JSON.stringify({ format: 1, files: dependencies, vcRuntimeImports: crt }, null, 2) + '\n');
console.log(JSON.stringify({ peFiles: dependencies.length, vcRuntimeImports: crt }, null, 2));
