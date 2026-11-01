/** Install the locked upstream workspace into an isolated build store. */
import { spawn } from 'node:child_process';
import { pnpm, upstream, work, buildEnvironment } from './environment.mjs';
import { resolve } from 'node:path';

const child = spawn(process.execPath, [pnpm, 'install', '--frozen-lockfile', '--store-dir', resolve(work, 's'), '--reporter', 'append-only'], {
  cwd: upstream, env: await buildEnvironment(), stdio: 'inherit', windowsHide: true,
});
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
