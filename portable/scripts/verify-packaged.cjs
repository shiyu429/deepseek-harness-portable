'use strict';
/** Runs under the packaged Electron Node runtime so ASAR and native extraction use production paths. */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
const { spawnSync } = require('node:child_process');
const root = path.resolve(process.argv[2]);
const archive = path.join(root, 'resources/app.asar');
const dsh = path.join(archive, 'dsh');
const manifest = JSON.parse(fs.readFileSync(path.join(archive, 'package.json'), 'utf8'));
const descriptor = JSON.parse(fs.readFileSync(path.join(dsh, 'desktop-runtime.json'), 'utf8'));
const requireDsh = createRequire(path.join(dsh, 'package.json'));
const portable = JSON.parse(fs.readFileSync(path.join(root, 'portable.json'), 'utf8'));
async function main() {
  if (manifest.main !== 'portable/bootstrap.mjs' || manifest.dshMandatoryUpdatePolicy !== undefined) throw new Error('Portable entry or update policy mismatch');
  if (descriptor.release.version !== portable.upstreamVersion || descriptor.platform !== 'win32' || descriptor.arch !== 'x64') throw new Error('Desktop runtime identity mismatch');
  const remaining = descriptor.files.values();
  let checked = 0;
  await Promise.all(Array.from({ length: 8 }, async () => {
    for (const file of remaining) {
      if (typeof file.path !== 'string' || file.path.includes('..') || file.path.includes(':') || file.path.includes('\\')) throw new Error('Unsafe runtime path');
      const bytes = await fs.promises.readFile(path.join(dsh, file.path));
      if (bytes.length !== file.bytes || crypto.createHash('sha256').update(bytes).digest('hex') !== file.sha256) throw new Error('Runtime integrity mismatch: ' + file.path);
      checked++;
    }
  }));
  const nativeModules = {};
  for (const name of ['koffi', 'sharp', 'node-pty']) { requireDsh(name); nativeModules[name] = true; }
  function execute(executable, args) {
    const result = spawnSync(executable, args, { env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined }, encoding: 'utf8', windowsHide: true, timeout: 60000 });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(path.basename(executable) + ': ' + result.stderr);
    return result.stdout.trim();
  }
  const primary = path.join(root, 'resources/runtime/primary-runtime');
  const node = path.join(primary, 'dependencies/node/bin/node.exe');
  const python = path.join(primary, 'dependencies/python/python.exe');
  const versions = {
    electron: process.versions.electron,
    node: execute(node, ['--version']),
    pnpm: execute(node, [path.join(primary, 'dependencies/pnpm/bin/pnpm.mjs'), '--version']),
    npm: execute(node, [path.join(primary, 'dependencies/node/bin/node_modules/npm/bin/npm-cli.js'), '--version']),
    python: execute(python, ['-I', '-B', '-c', 'import sys,json,docx,pptx,openpyxl,numpy,pandas,PIL,lxml,xlsxwriter; print(json.dumps({"python":sys.version.split()[0],"docx":docx.__version__,"pptx":pptx.__version__,"openpyxl":openpyxl.__version__,"numpy":numpy.__version__,"pandas":pandas.__version__,"pillow":PIL.__version__,"lxml":lxml.__version__,"xlsxwriter":xlsxwriter.__version__}))']),
    powershell: execute(path.join(root, 'resources/runtime/powershell/pwsh.exe'), ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.ToString()']),
  };
  const extras = execute(python, ['-I','-B','-c','import importlib.metadata as m; import requests,pypdf,setuptools,wheel; print({n:m.version(n) for n in ["requests","pypdf","setuptools","wheel"]})']);
  const dependencies = execute(python,['-I','-B','-m','pip','check']);
  console.log(JSON.stringify({ ok: true, checkedRuntimeFiles: checked, nativeModules, versions, extras, dependencies, noInstallerPolicy: true }));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
