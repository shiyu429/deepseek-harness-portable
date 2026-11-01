/** Maintainer operation for an intentional source change; ordinary builds retain the frozen lock. */
import { spawn } from 'node:child_process';
import { copyFile, rm, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { upstream, project, work, pnpm, buildEnvironment } from './environment.mjs';
if (!process.argv.includes('--refresh-lock')) throw new Error('Use --refresh-lock only after reviewing an intentional source or dependency change.');
const env = await buildEnvironment();
const packed = resolve(upstream, 'apps/desktop/.desktop-build/targets/win-x64/packed/dsh');
async function run(args) {
  await new Promise((done, reject) => {
    const child = spawn(process.execPath, [pnpm, ...args], { cwd: upstream, env, windowsHide: true, stdio: 'inherit' });
    child.once('error', reject); child.once('exit', code => code === 0 ? done() : reject(new Error('Runtime refresh failed: ' + code)));
  });
}
await run(['--dir', 'apps/desktop-host', 'pack', '--pack-destination', packed]);
await run(['--dir', 'apps/desktop', 'run', 'prepare:packages']);
await mkdir(resolve(work, 'qa'), { recursive: true });
await copyFile(resolve(project, 'production-pnpm-lock.yaml'), resolve(work, 'qa', 'production-lock-before-refresh.yaml'));
await rm(resolve(project, 'production-pnpm-lock.yaml'));
await run(['--dir', 'apps/desktop', 'run', 'prepare:dsh']);
