/** Run a named upstream operation with workspace-scoped tools and caches. */
import { spawn } from 'node:child_process';
import { pnpm, upstream, buildEnvironment } from './environment.mjs';

const args = process.argv.slice(2);
if (!args.length) throw new Error('Supply pnpm arguments');
const child = spawn(process.execPath, [pnpm, ...args], { cwd: upstream, env: await buildEnvironment(), stdio: 'inherit', windowsHide: true });
child.on('error', error => { console.error(error); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
