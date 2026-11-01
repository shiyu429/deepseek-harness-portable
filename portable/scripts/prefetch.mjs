/** Prefetch verified runtime archives while the source is being compiled. */
import { readFile, mkdir, stat, rename, rm, writeFile } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { upstream, work, project } from './environment.mjs';

const cache = resolve(upstream, 'apps/desktop/.desktop-build/downloads');
await mkdir(cache, { recursive: true });
const lock = JSON.parse(await readFile(resolve(upstream, 'scripts/primary-runtime/lock.json'), 'utf8'));
const target = lock.targets['win-x64'];
const records = [];
async function checksum(filename) { const hash = createHash('sha256'); for await (const chunk of createReadStream(filename)) hash.update(chunk); return hash.digest('hex'); }
async function download(url, sha256, destination) {
  try { await stat(destination); if (await checksum(destination) === sha256) { console.log('Verified cached archive:', new URL(url).pathname.split('/').at(-1)); return; } }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const temp = destination + '.' + randomUUID() + '.tmp';
  try {
    console.log('Downloading runtime:', new URL(url).pathname.split('/').at(-1));
    await new Promise((done, reject) => {
      const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', resolve(project, 'scripts/download.ps1'), '-Url', url, '-Destination', temp], { stdio: 'inherit', windowsHide: true });
      child.on('error', reject);
      child.on('exit', code => code === 0 ? done() : reject(new Error(`Runtime download failed: ${url}`)));
    });
    if (await checksum(temp) !== sha256) throw new Error(`Runtime checksum mismatch: ${url}`);
    await rename(temp, destination);
  } finally { await rm(temp, { force: true }); }
}
const pythonName = `cpython-${lock.pythonVersion}+${lock.pythonRelease}-${target.pythonTarget}-install_only_stripped.tar.gz`;
const assets = [
  { url: `https://nodejs.org/dist/v${lock.nodeVersion}/node-v${lock.nodeVersion}-${target.nodeArchive}`, sha256: target.nodeSha256 },
  { url: `https://github.com/astral-sh/python-build-standalone/releases/download/${lock.pythonRelease}/${encodeURIComponent(pythonName)}`, sha256: target.pythonSha256 },
  ...target.wheels, ...lock.wheels,
];
let next = 0;
await Promise.all(Array.from({ length: 4 }, async () => {
  for (;;) { const asset = assets[next++]; if (!asset) return; await download(asset.url, asset.sha256, resolve(cache, asset.sha256)); }
}));
const portableLock = JSON.parse(await readFile(resolve(project, 'upstream.lock.json'), 'utf8'));
const pshName = `PowerShell-${portableLock.powershell}-win-x64.zip`;
const pshUrl = `https://github.com/PowerShell/PowerShell/releases/download/v${portableLock.powershell}/${pshName}`;
const pshHash = portableLock.powershellSha256;
if (!/^[a-f0-9]{64}$/.test(pshHash)) throw new Error('PowerShell archive checksum is missing from the portable lock');
const destination = resolve(work, 'tools', pshName);
await download(pshUrl, pshHash, destination);
records.push({ component: 'PowerShell', version: portableLock.powershell, url: pshUrl, sha256: pshHash });
const electronName = `electron-v${portableLock.electron}-win32-x64.zip`;
const electronUrl = `https://github.com/electron/electron/releases/download/v${portableLock.electron}/${electronName}`;
await download(electronUrl, portableLock.electronSha256, resolve(work, 'tools', electronName));
records.push({ component: 'Electron', version: portableLock.electron, url: electronUrl, sha256: portableLock.electronSha256 });
const msvc = JSON.parse(await readFile(resolve(project, 'msvc.lock.json'), 'utf8'));
await download(msvc.url, msvc.sha256, resolve(work, 'tools/msvc-redist.exe'));
records.push(msvc);
const extraWheels = JSON.parse(await readFile(resolve(project, 'extra-wheels.lock.json'), 'utf8'));
for (const wheel of extraWheels) records.push({ component: 'Python extra: ' + wheel.name, version: wheel.version, url: wheel.url, sha256: wheel.sha256 });
await writeFile(resolve(project, 'resources.lock.json'), JSON.stringify(records, null, 2) + '\n');
console.log('Runtime archives verified.');
