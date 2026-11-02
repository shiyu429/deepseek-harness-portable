/** Assemble user deliverables from the verified immutable directory and tracked source. */
import { mkdir, cp, readdir, readFile, writeFile, stat, rename, access } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { resolve, join, relative, basename, dirname } from 'node:path';
import { project, work, upstream, buildEnvironment } from './environment.mjs';
import { assembleOverwrite } from './assemble-overwrite.mjs';
const outputArgument = process.argv.find(arg => arg.startsWith('--out='));
if (!outputArgument) throw new Error('Choose the deliverable directory explicitly with --out=PATH');
const output = resolve(outputArgument.slice(6));
const distribution = resolve(work, 'packed-app/win-unpacked');
const version = JSON.parse(await readFile(join(project, 'package.json'), 'utf8')).version;
const publicRelease=process.argv.includes('--public');
if(JSON.parse(await readFile(join(distribution,'portable.json'),'utf8')).portableVersion!==version)throw new Error('Packaged version differs from the source version.');
const stage = resolve(work, 'delivery', 'run-' + version + '-' + Date.now());
const productName = 'DSH';
const sourceName = `DSH-Portable-${version}-source`;
const product = join(stage, productName), source = join(stage, sourceName);
await mkdir(stage, { recursive: true }); await mkdir(output, { recursive: true });
await cp(distribution, product, { recursive: true, filter: filename => {
  const name = relative(distribution, filename).replaceAll('\\', '/');
  return !name.startsWith('data/') && !name.startsWith('backups/') && name !== '.maintenance-transaction.json';
} });
if ((await readdir(join(product, 'data'))).length !== 0) throw new Error('Release data must be empty');
for (const name of ['使用说明.md', '测试报告.md']) await cp(join(project, 'docs', name), join(product, name));
await cp(join(project, 'resources.lock.json'), join(product, 'runtime-sources.json'));
const inventory = join(product, '依赖清单.json');
const env = { ...await buildEnvironment(), ELECTRON_RUN_AS_NODE: '1' };
execFileSync(join(product, 'DSH Portable.exe'), [join(project, 'scripts/inventory-packaged.cjs'), product, inventory], { env, stdio: 'inherit', windowsHide: true });

async function hash(filename) {
  const result = createHash('sha256'); for await (const bytes of createReadStream(filename)) result.update(bytes); return result.digest('hex');
}
async function inventoryFiles(root) {
  const names = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const filename = join(directory, entry.name);
      const name = relative(root, filename).replaceAll('\\', '/');
      if (name === 'data' || name === 'backups' || name === 'checksums.json' || name === 'app/checksums.json' || name === 'source-checksums.json') continue;
      if (entry.isSymbolicLink()) throw new Error('Release contains a filesystem link: ' + name);
      if (entry.isDirectory()) await visit(filename);
      else if (entry.isFile()) names.push({ filename, path: name });
      else throw new Error('Unsupported release entry: ' + name);
    }
  }
  await visit(root); names.sort((a, b) => a.path.localeCompare(b.path));
  const remaining = names.values(), records = [];
  await Promise.all(Array.from({ length: 8 }, async () => {
    for (const item of remaining) records.push({ path: item.path, bytes: (await stat(item.filename)).size, sha256: await hash(item.filename) });
  }));
  return records.sort((a, b) => a.path.localeCompare(b.path));
}
await writeFile(join(product, 'checksums.json'), JSON.stringify({ format: 1, algorithm: 'SHA-256', files: await inventoryFiles(product) }, null, 2) + '\n');
const assembled = await assembleOverwrite(product,{publicRelease});
await writeFile(join(product, 'app/checksums.json'), JSON.stringify({ format: 1, algorithm: 'SHA-256', files: await inventoryFiles(product) }, null, 2) + '\n');
if (process.argv.includes('--stage-only')) {
  await mkdir(join(work, 'qa'), { recursive: true });
  const record = JSON.stringify({ root: product, ...assembled }, null, 2);
  await writeFile(join(work, 'qa/overwrite-staged.json'), record);
  await writeFile(join(work, 'delivery/build-result.json'), record);
  console.log('STAGED_OVERWRITE_PACKAGE', product); process.exit(0);
}

await mkdir(join(source, 'upstream'), { recursive: true });
const listed = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: upstream, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).split('\0').filter(name => name && !name.startsWith('apps/desktop/portable/'));
for (const name of listed) {
  const from = resolve(upstream, name), target = resolve(source, 'upstream', name);
  const within = relative(upstream, from);
  if (within.startsWith('..') || relative(join(source, 'upstream'), target).startsWith('..')) throw new Error('Invalid tracked source path');
  try { await access(from); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
  await mkdir(dirname(target), { recursive: true }); await cp(from, target);
}
await cp(project, join(source, 'portable'), { recursive: true, filter: filename => {
  const name = relative(project, filename).replaceAll('\\', '/');
  return name !== 'build' && !name.startsWith('build/') && name !== 'node_modules' && !name.startsWith('node_modules/') && (!publicRelease || (name !== 'PUBLISH-HANDOFF.md' && !name.startsWith('docs/测试报告')));
} });
const powershellBuild = join(source, 'portable/scripts/Build.ps1');
await writeFile(powershellBuild, '\uFEFF' + (await readFile(powershellBuild, 'utf8')).replace(/^\uFEFF/, ''));
await cp(join(project, 'README.md'), join(source, 'README.md'));
if(publicRelease)await writeFile(join(source,'README.md'),(await readFile(join(project,'docs/项目主页.md'),'utf8')).replaceAll('@VERSION@',version));
if(publicRelease){
  await cp(join(upstream,'LICENSE'),join(source,'LICENSE'));
  await writeFile(join(source,'.gitignore'),'node_modules/\nportable/build/\npacked-app/\ndelivery/\ncache/\ntmp/\ntools/\ns/\noutputs/\ndata/\nbackups/\n*.log\n');
}
let patch = execFileSync('git', ['diff', '--binary', '--no-ext-diff', 'HEAD'], { cwd: upstream, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
const untracked = execFileSync('git', ['ls-files', '-z', '--others', '--exclude-standard'], { cwd: upstream, encoding: 'utf8' }).split('\0').filter(name => name && !name.startsWith('apps/desktop/portable/'));
for (const name of untracked) {
  const body = (await readFile(join(upstream, name), 'utf8')).replaceAll('\r\n', '\n');
  const lines = body.replace(/\n$/, '').split('\n');
  patch += `diff --git a/${name} b/${name}\nnew file mode 100644\n--- /dev/null\n+++ b/${name}\n@@ -0,0 +1,${lines.length} @@\n${lines.map(line => '+' + line).join('\n')}\n`;
}
await writeFile(join(source, 'upstream-portable.patch'), patch);
if(!publicRelease){
await mkdir(join(source, 'verification'), { recursive: true });
for (const name of ['account-official-build.log', 'account-runtime-refresh.log', 'account-packaging.log', 'usb-persistent-tests.log', 'account-provider-tests.log', 'account-core-tests.log', 'account-lint.log', 'account-package-verify.log', 'account-desktop-probe.log', 'account-chat-probe.log', 'account-external-probe.log', 'account-missing-workspace-probe.log', 'account-restart-probe.log', 'account-move-probe.log', 'account-moved-workspace-probe.log', 'account-final-restart.log', 'account-final-checks.log', 'account-asar-smoke.log', 'account-real-backup.log', 'account-real-restore.log', 'account-restored-startup.log', 'account-restored-chat.log']) {
  let body = await readFile(join(work, 'logs', name), 'utf8');
  body = body.replaceAll(resolve(work, '..'), '<BUILD>').replaceAll(resolve(work, '..').replaceAll('\\', '/'), '<BUILD>').replaceAll(resolve(work, '..').replaceAll('\\', '\\\\'), '<BUILD>').replace(/([?&]token=)[^\s"']+/g, '$1[redacted]');
  await writeFile(join(source, 'verification', name + '.txt'), body);
}
for (const name of ['overwrite-unit-tests.log', 'overwrite-packaging.log', 'overwrite-actual-checks.log', 'official-modes-build.log', 'official-modes-typecheck.log', 'official-modes-tests.log', 'official-modes-native.log', 'official-modes-lint.log', 'official-modes-runtime-refresh.log', 'official-modes-package-verify.log', 'official-modes-asar-smoke.log', 'official-modes-doc-check.log', 'official-modes-upgrade-doc.log', 'official-modes-doc-suite.log', 'official-modes-doc-refs.log', 'official-modes-doc-summary.log', 'overwrite-staging.log', 'maintenance-ui-icon.log', ...['initial-gui', 'internal-chat', 'internal-restart', 'external-chat', 'external-restart', 'full-chat', 'full-restart', 'plugin-move', 'moved-chat', 'final-gui', 'install-update'].map(name => 'overwrite-' + name + '.log')]) {
  let body = await readFile(join(work, 'logs', name), 'utf8');
  body = body.replaceAll(resolve(work, '..'), '<BUILD>').replaceAll(resolve(work, '..').replaceAll('\\', '/'), '<BUILD>').replace(/([?&]token=)[^\s"']+/g, '$1[redacted]');
  await writeFile(join(source, 'verification', name + '.txt'), body);
}
await cp(join(project, 'docs/测试报告.md'), join(source, '测试报告.md'));
for (const item of ['build', 'typecheck', 'targeted-tests', 'default-workspace-test', 'runtime-probe', 'fat-guard', 'packaging']) {
  const name = '1.2.1-' + item + '.log';
  let body = await readFile(join(work, 'logs', name), 'utf8');
  body = body.replaceAll(resolve(work, '..'), '<BUILD>').replaceAll(resolve(work, '..').replaceAll('\\', '/'), '<BUILD>').replace(/([?&]token=)[^\s"']+/g, '$1[redacted]');
  await writeFile(join(source, 'verification', name + '.txt'), body);
}
await cp(join(work, 'qa/chat-success.png'), join(source, 'verification/chat-success.png'));
await cp(join(work, 'qa/move-success.png'), join(source, 'verification/move-success.png'));
for (const name of ['runtime-environment-result.json','office-cleanup-result.json','1.2.2-runtime-chain-result.json','1.2.2-pnpm-move-result.json']) {
  let body=await readFile(join(work,'qa',name),'utf8');
  body=body.replaceAll(resolve(work,'..').replaceAll('\\','\\\\'),'<BUILD>').replaceAll(resolve(work,'..'),'<BUILD>');
  await writeFile(join(source,'verification',name),body);
}
for (const name of ['1.2.2-package-verify.log','1.2.2-validation.json']) await cp(join(work,'logs',name),join(source,'verification',name));
await writeFile(join(source, 'source-checksums.json'), JSON.stringify({ format: 1, algorithm: 'SHA-256', files: await inventoryFiles(source) }, null, 2) + '\n');
}

async function archive(folder, filename, rootless = false) {
  const temporary = join(stage, filename);
  await new Promise((done, reject) => {
    const python = join(distribution, 'resources/runtime/primary-runtime/dependencies/python/python.exe');
    const child = spawn(python, ['-I', '-B', join(project, 'scripts/zip-release.py'), folder, temporary, ...(rootless ? ['--rootless'] : [])], { stdio: 'inherit', windowsHide: true });
    child.once('error', reject); child.once('exit', code => code === 0 ? done() : reject(new Error('ZIP creation failed: ' + code)));
  });
  await rename(temporary, join(output, filename));
}
await archive(product, `DSH-Portable-${version}-win-x64${publicRelease?'':'-unsigned'}.zip`);
if(!publicRelease){
await archive(source, `DSH-Portable-${version}-source.zip`);
const update = join(stage, 'overwrite-update');
await cp(product, update, { recursive: true, filter: file => {
  const name = relative(product, file).replaceAll('\\', '/');
  return name !== 'data' && !name.startsWith('data/') && name !== 'backups' && !name.startsWith('backups/');
} });
await archive(update, `DSH-Portable-${version}-overwrite-update.zip`, true);
for (const name of ['测试报告.md', '依赖清单.json']) await cp(join(product, 'app/说明与许可', name), join(output, name));
}
if(publicRelease)await writeFile(join(work,'delivery/public-source.json'),JSON.stringify({source,product,output,version},null,2));
const sums = [];
for (const name of (await readdir(output)).sort()) if (name !== 'SHA256SUMS.txt' && (await stat(join(output, name))).isFile()) sums.push(await hash(join(output, name)) + '  ' + name);
await writeFile(join(output, 'SHA256SUMS.txt'), sums.join('\n') + '\n');
console.log(JSON.stringify({ output, productFiles: (await inventoryFiles(product)).length, sourceFiles: listed.length }));
