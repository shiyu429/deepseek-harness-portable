/** Materialize app-local Microsoft DLLs from a hash-pinned signed redistributable, without installing it. */
import { readFile, readdir, mkdir, cp, writeFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { project, work } from './environment.mjs';
const lock = JSON.parse(await readFile(join(project, 'msvc.lock.json'), 'utf8'));
export async function prepareMsvc() {
  const archive = resolve(work, 'tools/msvc-redist.exe');
  const bytes = await readFile(archive);
  if (createHash('sha256').update(bytes).digest('hex') !== lock.sha256) throw new Error('Microsoft runtime archive integrity mismatch');
  const directory = resolve(work, 'tools/msvc');
  await mkdir(directory, { recursive: true });
  let ready = false;
  try { ready = JSON.parse(await readFile(join(directory, 'source.json'), 'utf8')).sha256 === lock.sha256; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (ready) return directory;
  execFileSync(process.execPath, [join(project, 'scripts/extract-vc-cabinets.mjs'), archive], { stdio: 'inherit', windowsHide: true });
  const extracted = resolve(work, 'tools/vc-extracted');
  let copied = 0;
  for (const entry of await readdir(extracted, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    for (const name of await readdir(join(extracted, entry.name))) {
      if (!/^(?:concrt140|msvcp140(?:_[a-z0-9_]+)?|vcruntime140(?:_[a-z0-9_]+)?|vcomp140|vcamp140|vccorlib140)\.dll_amd64$/i.test(name)) continue;
      const file = join(extracted, entry.name, name), dll = await readFile(file);
      if (dll.readUInt16LE(dll.readUInt32LE(0x3c) + 4) !== 0x8664) throw new Error('Unexpected runtime DLL architecture');
      await cp(file, join(directory, name.replace(/_amd64$/i, ''))); copied++;
    }
  }
  for (const name of ['msvcp140.dll', 'msvcp140_1.dll', 'msvcp140_2.dll', 'vcruntime140.dll', 'vcruntime140_1.dll']) await stat(join(directory, name));
  await cp(join(extracted, 'outer-0/u4'), join(directory, 'LICENSE-en.rtf'));
  await cp(join(extracted, 'outer-0/u28'), join(directory, 'LICENSE-zh-CN.rtf'));
  await writeFile(join(directory, 'source.json'), JSON.stringify({ ...lock, dllCount: copied }, null, 2) + '\n');
  return directory;
}
export async function installMsvc(output) {
  const directory = await prepareMsvc();
  const common = join(output, 'resources/runtime/msvc');
  await mkdir(common, { recursive: true });
  const office = join(output, 'resources/app.asar.unpacked/dsh/node_modules/@deepseek-ai/libreoffice-kit-win32-x64/bin');
  const pnpm = join(output, 'resources/runtime/primary-runtime/dependencies/pnpm/dist/node_modules/@reflink/reflink-win32-x64-msvc');
  await stat(join(office, 'libreoffice-kit.exe')); await stat(join(pnpm, 'reflink.win32-x64-msvc.node'));
  const files = [];
  for (const name of await readdir(directory)) {
    if (!name.endsWith('.dll')) continue;
    const bytes = await readFile(join(directory, name));
    await cp(join(directory, name), join(office, name));
    await cp(join(directory, name), join(common, name));
    files.push({ file: name, sha256: createHash('sha256').update(bytes).digest('hex') });
  }
  await cp(join(directory, 'vcruntime140.dll'), join(pnpm, 'vcruntime140.dll'));
  await cp(join(directory, 'LICENSE-en.rtf'), join(output, 'LICENSE-Microsoft-VC-Runtime-en.rtf'));
  await cp(join(directory, 'LICENSE-zh-CN.rtf'), join(output, 'LICENSE-Microsoft-VC-Runtime-zh-CN.rtf'));
  await writeFile(join(output, 'resources/portable/msvc-files.json'), JSON.stringify({ ...lock, files }, null, 2) + '\n');
  console.log('Application-local Microsoft runtime installed into the portable package only.');
}
if (process.argv.includes('--install')) await installMsvc(resolve(process.argv.at(-1)));
else if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) await prepareMsvc();
