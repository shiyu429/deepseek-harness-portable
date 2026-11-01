import { spawn } from 'node:child_process';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { project, work, upstream, buildEnvironment } from './environment.mjs';
const root = resolve(process.argv[2] || join(work, 'packed-app/win-unpacked'));
const environment = { ...await buildEnvironment(), ELECTRON_RUN_AS_NODE: '1' };
await new Promise((done, reject) => {
  const child = spawn(join(root, 'DSH Portable.exe'), ['--expose-internals', '--import', pathToFileURL(join(upstream, 'node_modules/tsx/dist/loader.mjs')).href, join(project, 'scripts/packaged-smoke.ts'), root], { env: environment, stdio: 'inherit', windowsHide: true });
  child.once('error', reject); child.once('exit', code => code === 0 ? done() : reject(new Error('Actual packaged smoke failed: ' + code)));
});
