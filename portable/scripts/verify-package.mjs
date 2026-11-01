/** Verify an immutable portable directory and the actual bundled interpreters. */
import { readdir, lstat, readFile, mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { resolve, join, relative } from 'node:path';
import { project, work, buildEnvironment } from './environment.mjs';
const root = resolve(process.argv[2] || join(work, 'packed-app/win-unpacked'));
const required = ['DSH Portable.exe', 'portable.json', 'resources/runtime/cli/bin/dsh.cmd', 'resources/app.asar', 'resources/portable/native-helper.exe', 'resources/portable/core.cjs', 'resources/portable/maintenance.cjs', 'resources/runtime/primary-runtime/runtime.json', 'resources/runtime/powershell/pwsh.exe'];
for (const filename of required) if (!(await lstat(join(root, filename))).isFile()) throw new Error('Missing portable file: ' + filename);
let files = 0, bytes = 0;
async function scan(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const filename = join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error('Machine-bound link in distribution: ' + relative(root, filename));
    if (entry.isDirectory()) await scan(filename);
    else if (entry.isFile()) { files++; bytes += (await lstat(filename)).size; }
    else throw new Error('Unsupported distribution entry: ' + filename);
  }
}
await scan(root);
const scratch = join(work, 'qa', 'package-verifier');
await mkdir(scratch, { recursive: true });
const env = { ...await buildEnvironment(), HOME: scratch, USERPROFILE: scratch, APPDATA: scratch, LOCALAPPDATA: scratch, TEMP: scratch, TMP: scratch,
  npm_config_userconfig: join(scratch,'npmrc'), npm_config_globalconfig: join(scratch,'npmrc-global'), ELECTRON_RUN_AS_NODE: '1' };
delete env.NODE_OPTIONS;
delete env.NODE_PATH;
await new Promise((done, reject) => {
  const child = spawn(join(root, 'DSH Portable.exe'), ['--expose-internals', join(project, 'scripts/verify-packaged.cjs'), root], { env, windowsHide: true, stdio: 'inherit' });
  child.once('error', reject);
  child.once('exit', code => code === 0 ? done() : reject(new Error('Packaged runtime verification exited ' + code)));
});
console.log(JSON.stringify({ ok: true, distributionFiles: files, uncompressedBytes: bytes }));
