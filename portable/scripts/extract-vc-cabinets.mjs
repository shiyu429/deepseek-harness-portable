/** Extract Microsoft's signed redistributable containers without executing its installer. */
import { mkdir, readFile, writeFile, readdir, stat, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve, join, relative, isAbsolute } from 'node:path';
import { work } from './environment.mjs';
const source = resolve(process.argv[2] || join(work, 'tools/VC_redist.classic.x64.exe'));
const output = resolve(work, 'tools/vc-extracted');
const boundary = relative(resolve(work, 'tools'), output);
if (!boundary || boundary.startsWith('..') || isAbsolute(boundary)) throw new Error('Cabinet output escapes the build workspace');
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
let count = 0;
async function scan(filename, prefix) {
  const bytes = await readFile(filename);
  for (let offset = bytes.indexOf('MSCF'); offset >= 0; offset = bytes.indexOf('MSCF', offset + 4)) {
    if (offset + 36 > bytes.length || bytes.readUInt32LE(offset + 4) !== 0 || bytes[offset + 24] !== 3 || bytes[offset + 25] !== 1) continue;
    const size = bytes.readUInt32LE(offset + 8);
    if (size < 36 || offset + size > bytes.length) continue;
    if (prefix === 'payload' && !bytes.subarray(offset, offset + size).includes(Buffer.from('.dll_amd64'))) continue;
    const folder = join(output, prefix + '-' + count++); await mkdir(folder, { recursive: true });
    const cabinet = folder + '.cab'; await writeFile(cabinet, bytes.subarray(offset, offset + size));
    execFileSync('expand.exe', ['-F:*', cabinet, folder], { windowsHide: true, stdio: 'inherit' });
    console.log('CABINET', folder);
  }
}
await scan(source, 'outer');
const initial = await readdir(output, { withFileTypes: true });
for (const dir of initial) {
  if (!dir.isDirectory()) continue;
  const parent = join(output, dir.name);
  for (const entry of await readdir(parent, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const filename = join(parent, entry.name);
    if ((await stat(filename)).size > 36) await scan(filename, 'payload');
  }
}
console.log('Extracted cabinets:', count);
