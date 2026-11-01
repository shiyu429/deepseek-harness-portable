/** Add verified npm and basic Python packaging/PDF/HTTP dependencies to the production payload. */
import { readFile, writeFile, mkdir, cp, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { work, project, upstream } from './environment.mjs';
const require = createRequire(join(upstream, 'package.json'));
const extractZip = require('extract-zip');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
export async function installRuntimeExtras(output) {
  const dependencies = join(output, 'resources/runtime/primary-runtime/dependencies');
  const runtimeLock = JSON.parse(await readFile(join(upstream, 'scripts/primary-runtime/lock.json'), 'utf8'));
  const nodeHash = runtimeLock.targets['win-x64'].nodeSha256;
  const archive = join(upstream, 'apps/desktop/.desktop-build/downloads', nodeHash);
  if (sha(await readFile(archive)) !== nodeHash) throw new Error('Node/npm archive checksum mismatch');
  const npmStage = join(work, 'tmp/npm-' + runtimeLock.nodeVersion);
  await mkdir(npmStage, { recursive: true });
  if (!(await readdir(npmStage)).length) await extractZip(archive, { dir: npmStage });
  const npmSource = join(npmStage, 'node-v' + runtimeLock.nodeVersion + '-win-x64/node_modules/npm');
  const npmTarget = join(dependencies, 'node/bin/node_modules/npm');
  await cp(npmSource, npmTarget, { recursive: true });
  for (const [command, script] of [['npm','npm-cli.js'], ['npx','npx-cli.js']]) {
    await writeFile(join(dependencies, 'node/bin', command + '.cmd'), '@echo off\r\n"%~dp0node.exe" "%~dp0node_modules\\npm\\bin\\' + script + '" %*\r\nexit /b %errorlevel%\r\n');
  }
  const wheels = JSON.parse(await readFile(join(project, 'extra-wheels.lock.json'), 'utf8'));
  const cache = join(work, 'cache/extra-wheels'); await mkdir(cache, { recursive: true });
  const files = [];
  for (const record of wheels) {
    const file = join(cache, record.file);
    let bytes;
    try { bytes = await readFile(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!bytes || sha(bytes) !== record.sha256) {
      const response = await fetch(record.url, {signal:AbortSignal.timeout(180000)});
      if (!response.ok) throw new Error('Wheel download failed: ' + record.file);
      bytes = Buffer.from(await response.arrayBuffer());
      if (sha(bytes) !== record.sha256) throw new Error('Wheel checksum mismatch: ' + record.file);
      await writeFile(file, bytes);
    }
    files.push(file);
  }
  const env = {...process.env, PYTHONDONTWRITEBYTECODE:'1'};
  delete env.PIP_TARGET; delete env.PYTHONPATH; delete env.PYTHONHOME;
  execFileSync(join(dependencies, 'python/python.exe'), ['-I','-B','-m','pip','install','--no-index','--no-deps','--disable-pip-version-check',...files],
    {env,stdio:'inherit',windowsHide:true});
  execFileSync(join(dependencies,'python/python.exe'),['-I','-B',join(project,'scripts/relativize-python-scripts.py')],{env,stdio:'inherit',windowsHide:true});
  const manifestFile = join(output,'resources/runtime/primary-runtime/runtime.json');
  const manifest = JSON.parse(await readFile(manifestFile,'utf8'));
  for (const wheel of wheels) manifest.pythonPackages[wheel.name.toLowerCase().replaceAll('_','-')] = wheel.version;
  await writeFile(manifestFile,JSON.stringify(manifest,null,2)+'\n');
  await cp(join(project,'extra-wheels.lock.json'),join(output,'resources/portable/extra-wheels.lock.json'));
}
