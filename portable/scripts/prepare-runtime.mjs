/** Assemble the official self-contained runtime using prefetched, checksum-verified archives. */
import { cp, mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { upstream, work, project } from './environment.mjs';

const require = createRequire(resolve(upstream, 'package.json'));
const extractZip = require('extract-zip');
const lock = JSON.parse(await readFile(resolve(project, 'upstream.lock.json'), 'utf8'));
const target = resolve(upstream, 'apps/desktop/.desktop-build/targets/win-x64');
const electron = join(target, 'electron');
const runtime = join(target, 'runtime');
await mkdir(electron, { recursive: true });
let electronReady = false;
try { electronReady = (await stat(join(electron, 'electron.exe'))).isFile(); } catch (error) { if (error.code !== 'ENOENT') throw error; }
if (!electronReady) await extractZip(resolve(work, 'tools', `electron-v${lock.electron}-win32-x64.zip`), { dir: electron });
const electronVersion = execFileSync(join(electron, 'electron.exe'), ['-p', 'process.versions.electron'], { encoding: 'utf8', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true }).trim();
if (electronVersion !== lock.electron) throw new Error('Electron runtime version mismatch');
const { preparePrimaryRuntime } = await import(pathToFileURL(resolve(upstream, 'apps/desktop/scripts/prepare-primary-runtime.ts')).href);
await preparePrimaryRuntime();
await cp(resolve(upstream, 'apps/desktop/scripts/node-bin'), join(runtime, 'bin'), { recursive: true });
await mkdir(join(runtime, 'cli', 'bin'), { recursive: true });
await cp(resolve(upstream, 'apps/desktop/cli/dsh.cmd'), join(runtime, 'cli', 'bin', 'dsh.cmd'));
await cp(resolve(upstream, 'apps/desktop/lib/command-manager-entry.js'), join(runtime, 'cli', 'command-manager.js'));
await cp(resolve(upstream, 'apps/desktop/scripts/command-path.ps1'), join(runtime, 'cli', 'command-path.ps1'));
const nodeVersion = execFileSync(join(electron, 'electron.exe'), ['-p', 'process.versions.node'], { encoding: 'utf8', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true }).trim();
await writeFile(join(runtime, 'versions.json'), JSON.stringify({ schemaVersion: 1, node: nodeVersion, pnpm: lock.pnpm }, null, 2) + '\n');
const powershell = resolve(work, 'tools', 'powershell');
await mkdir(powershell, { recursive: true });
let pshReady = false;
try { pshReady = (await stat(join(powershell, 'pwsh.exe'))).isFile(); } catch (error) { if (error.code !== 'ENOENT') throw error; }
if (!pshReady) await extractZip(resolve(work, 'tools', `PowerShell-${lock.powershell}-win-x64.zip`), { dir: powershell });
console.log('Official primary runtime and portable PowerShell are prepared.');
