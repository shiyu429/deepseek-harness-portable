/** Run the pinned pnpm through real Node with project-local, link-free storage. */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync, lstatSync, openSync, fsyncSync, closeSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, resolve, join, parse, relative, isAbsolute, sep } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
let directory = process.cwd();
let command;
const valueOptions = new Set(['--filter','-F','--reporter','--registry','--userconfig','--globalconfig','--config-dir','--store-dir','--cache-dir','--state-dir','--node-linker','--package-import-method']);
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--') break;
  if (['--dir', '-C'].includes(args[i]) && args[i + 1]) directory = resolve(directory, args[++i]);
  else if (args[i].startsWith('--dir=')) directory = resolve(directory, args[i].slice(6));
  else if (valueOptions.has(args[i])) i++;
  else if (!args[i].startsWith('-') && command === undefined) command = args[i];
}
// pnpm's project registry needs a junction if its store is outside lockfileDir.
// Keep the store below the actual workspace, also on FAT32/exFAT.
let project = directory;
for (let candidate = directory; ; candidate = dirname(candidate)) {
  if (existsSync(join(candidate, 'pnpm-workspace.yaml'))) { project = candidate; break; }
  if (candidate === parse(candidate).root) break;
}
const state = join(project, '.dsh-cache', 'pnpm');
const changesDependencies = ['add','install','i','update','up','remove','rm','uninstall','unlink','import','fetch'].includes(command);
function atomic(file, text) {
  const temporary = file + '.' + randomUUID() + '.tmp';
  let fd;
  try { fd=openSync(temporary,'wx'); writeFileSync(fd,text); fsyncSync(fd); closeSync(fd); fd=undefined; renameSync(temporary,file); }
  finally { if(fd!==undefined)closeSync(fd); rmSync(temporary,{force:true}); }
}
if (changesDependencies) {
  const marker = join(state,'portable-project.json');
  mkdirSync(state,{recursive:true});
  if (existsSync(marker)) {
    const old = JSON.parse(readFileSync(marker,'utf8'));
    if (old.format !== 1 || typeof old.project !== 'string') throw new Error('Invalid portable pnpm project record: '+marker);
    if (old.project !== project) {
      const modules = join(project,'node_modules/.modules.yaml');
      if (existsSync(modules)) {
        if (lstatSync(modules).isSymbolicLink()) throw new Error('Cannot relocate linked pnpm metadata: '+modules);
        const text = readFileSync(modules,'utf8');
        // pnpm writes JSON, but the desktop's relocation repair and older
        // pnpm versions also write YAML. Both are legitimate modules manifests.
        const yaml = createRequire(import.meta.url)('../dist/node_modules/yaml');
        const metadata = yaml.parse(text);
        if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) throw new Error('Invalid pnpm modules manifest: '+modules);
        let changed = false;
        for (const key of ['storeDir','virtualStoreDir']) {
          const previous = key === 'storeDir' ? join(old.project,'.dsh-cache/pnpm/store') : join(old.project,'node_modules');
          const current = key === 'storeDir' ? join(state,'store') : join(project,'node_modules');
          const stored = metadata[key];
          if (typeof stored !== 'string' || !isAbsolute(stored)) continue;
          const suffix = relative(previous,stored);
          if (isAbsolute(suffix) || suffix === '..' || suffix.startsWith('..'+sep)) continue;
          const next = join(current,suffix);
          if (next !== stored) { metadata[key] = next; changed = true; }
        }
        if (changed) atomic(modules,JSON.stringify(metadata,null,2)+'\n');
      }
    }
  }
  atomic(marker,JSON.stringify({format:1,project})+'\n');
}
const options = changesDependencies ? ['--store-dir=' + join(state, 'store'), '--cache-dir=' + join(state, 'cache'),
  '--node-linker=hoisted', '--package-import-method=copy'] : [];
const env = { ...process.env, npm_config_cache: join(state, 'npm-cache'),
  PNPM_CONFIG_STORE_DIR: join(state,'store'), PNPM_CONFIG_CACHE_DIR: join(state,'cache'), PNPM_CONFIG_STATE_DIR: join(state, 'state') };
for (const key of Object.keys(env)) if (/^npm_config_(store_dir|cache_dir|state_dir|node_linker|package_import_method)$/i.test(key)) delete env[key];
delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS; delete env.NODE_PATH;
const child = spawn(resolve(here, '../../node/bin/node.exe'), [join(here, 'pnpm-real.mjs'), ...options, ...args],
  { cwd: process.cwd(), env, stdio: 'inherit', windowsHide: true });
child.on('error', error => { process.stderr.write('pnpm: ' + error.message + '\n'); process.exitCode = 1; });
child.on('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
