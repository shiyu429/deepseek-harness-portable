/** Reproduce the portable build without installing software into the target computer. */
import { spawn } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { project, work, upstream, pnpm, buildEnvironment } from './environment.mjs';

if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Build this Windows x64 package on Windows x64.');
const environment = { ...await buildEnvironment(), DSH_DESKTOP_TARGET_PLATFORM: 'win32', DSH_DESKTOP_TARGET_ARCH: 'x64', DSH_DESKTOP_APP_ID: 'community.dsh.portable', DSH_DESKTOP_UNSIGNED: '1' };
const lock = JSON.parse(await readFile(resolve(project, 'upstream.lock.json'), 'utf8'));
const manifest = JSON.parse(await readFile(resolve(upstream, 'package.json'), 'utf8'));
if (manifest.version !== lock.version) throw new Error('Upstream source version differs from the build lock.');
await mkdir(resolve(work, 'logs'), { recursive: true });
async function run(command, args, cwd = upstream) {
  await new Promise((done, reject) => {
    const child = spawn(command, args, { cwd, env: environment, stdio: 'inherit', windowsHide: true });
    child.on('error', reject);
    child.on('exit', code => code === 0 ? done() : reject(new Error(`Build operation exited ${code}: ${args.join(' ')}`)));
  });
}
await run(process.execPath, [resolve(project, 'scripts/bootstrap.mjs')], project);
await run(process.execPath, [resolve(project, 'scripts/prefetch.mjs')], project);
await run(process.execPath, [pnpm, 'install', '--frozen-lockfile', '--reporter', 'append-only']);
await run(process.execPath, [pnpm, 'run', 'build:official']);
await run(process.execPath, [resolve(project, 'scripts/prune-acl-build.mjs')], project);
await run(process.execPath, [resolve(project, 'scripts/generate-runtime-overrides.mjs')], project);
await run(process.execPath, [pnpm, 'exec', 'tsx', resolve(project, 'scripts/prepare-runtime.mjs')]);
const packed = resolve(upstream, 'apps/desktop/.desktop-build/targets/win-x64/packed');
await run(process.execPath, [pnpm, 'run', 'release:pack', '--family', 'dsh', '--out', resolve(packed, 'dsh'), '--concurrency', '6']);
await run(process.execPath, [pnpm, '--dir', 'apps/desktop-host', 'pack', '--pack-destination', resolve(packed, 'dsh')]);
await run(process.execPath, [pnpm, 'run', 'release:pack', '--family', 'vendor', '--out', resolve(packed, 'vendor'), '--concurrency', '6']);
await mkdir(resolve(packed, 'landlock'), { recursive: true });
await run(process.execPath, [pnpm, '--dir', 'native/system', 'run', 'build:ts']);
await run(process.execPath, [pnpm, '--dir', 'native/system/packages/entry', 'pack', '--pack-destination', resolve(packed, 'landlock')]);
await run(process.execPath, [pnpm, '--dir', 'apps/desktop', 'run', 'prepare:packages']);
await run(process.execPath, [pnpm, '--dir', 'apps/desktop', 'run', 'prepare:dsh']);
await run(process.execPath, [resolve(project, 'scripts/package.mjs')], project);
await run(process.execPath, [resolve(project, 'scripts/release.mjs'), '--stage-only', '--out=' + resolve(work, 'delivery/metadata')], project);
