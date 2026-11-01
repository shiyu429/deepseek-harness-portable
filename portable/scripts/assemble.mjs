/** Assemble the production closure after a successful official build. */
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { resolve, relative, isAbsolute } from 'node:path';
import { project, work, upstream, pnpm, buildEnvironment } from './environment.mjs';
const env = { ...await buildEnvironment(), DSH_DESKTOP_TARGET_PLATFORM: 'win32', DSH_DESKTOP_TARGET_ARCH: 'x64', DSH_DESKTOP_UNSIGNED: '1', DSH_DESKTOP_APP_ID: 'community.dsh.portable' };
const packed = resolve(upstream, 'apps/desktop/.desktop-build/targets/win-x64/packed');
const rest = relative(work, packed);
if (!rest || rest.startsWith('..') || isAbsolute(rest)) throw new Error('Packing paths escape the build workspace.');
async function run(args) {
  console.log('Assembling:', args.slice(0, 4).join(' '));
  await new Promise((done, reject) => {
    const child = spawn(process.execPath, [pnpm, ...args], { cwd: upstream, env, stdio: 'inherit', windowsHide: true });
    child.once('error', reject); child.once('exit', code => code === 0 ? done() : reject(new Error('Assembly failed with code ' + code)));
  });
}
await run(['--dir', 'apps/desktop-host', 'pack', '--pack-destination', resolve(packed, 'dsh')]);
await run(['run', 'release:pack', '--family', 'vendor', '--out', resolve(packed, 'vendor'), '--concurrency', '6']);
await mkdir(resolve(packed, 'landlock'), { recursive: true });
await run(['--dir', 'native/system', 'run', 'build:ts']);
await run(['--dir', 'native/system/packages/entry', 'pack', '--pack-destination', resolve(packed, 'landlock')]);
await run(['--dir', 'apps/desktop', 'run', 'prepare:packages']);
await run(['--dir', 'apps/desktop', 'run', 'prepare:dsh']);
console.log('Production runtime closure prepared.');
