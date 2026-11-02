/** Put verified Electron files in a compact program slot; root entry validates before data initialization. */
import { mkdir, readFile, writeFile, readdir, rename, cp, unlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { buildLauncher } from './build-launcher.mjs';
import { resolve, join, relative, isAbsolute } from 'node:path';
import { project, work, upstream } from './environment.mjs';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
export async function assembleOverwrite(product, { publicRelease = false } = {}) {
  product = resolve(product);
  const part = relative(join(work, 'delivery'), product);
  if (!part || part.startsWith('..') || isAbsolute(part)) throw new Error('Assembly target must be a generated delivery directory.');
  const manifest = JSON.parse(await readFile(join(product, 'portable.json'), 'utf8'));
  const contract = JSON.parse(await readFile(join(project, 'data-contract.json'), 'utf8'));
  if (contract.format !== 1 || contract.id !== manifest.dataContract || !contract.verifiedUpstreamCommits.includes(manifest.upstreamCommit)) throw new Error('Data compatibility has not been verified for this upstream commit.');
  manifest.payloadLayout = 1;
  manifest.programLayout = 'compact-1';
  await writeFile(join(product, 'portable.json'), JSON.stringify(manifest, null, 2) + '\n');
  const inventory = JSON.parse(await readFile(join(product, 'checksums.json'), 'utf8'));
  for (const item of inventory.files) if (item.path.endsWith('.cmd') && !item.path.includes('/')) await unlink(join(product, item.path));
  inventory.files = inventory.files.filter(item => !(item.path.endsWith('.cmd') && !item.path.includes('/')));
  const infoFiles=['依赖清单.json','LICENSE-DeepSeek-Harness.txt','LICENSE-Portable.txt','THIRD_PARTY_NOTICES.md','runtime-sources.json'];
  if(!publicRelease)infoFiles.push('测试报告.md');
  const infoStage=join(product,'.information-stage');await mkdir(infoStage);
  for(const file of infoFiles)await rename(join(product,file),join(infoStage,file));
  // The public portable folder contains notices and sources, not the source-tree user guide.
  try{await unlink(join(product,'使用说明.md'));}catch(error){if(error.code!=='ENOENT')throw error;}
  if(publicRelease){try{await unlink(join(product,'测试报告.md'));}catch(error){if(error.code!=='ENOENT')throw error;}}
  inventory.files=inventory.files.filter(item=>!infoFiles.includes(item.path)&&item.path!=='使用说明.md'&&(!publicRelease||item.path!=='测试报告.md'));
  const manifestEntry = inventory.files.find(item => item.path === 'portable.json');
  const manifestBytes = await readFile(join(product, 'portable.json'));
  Object.assign(manifestEntry, { bytes: manifestBytes.length, sha256: sha(manifestBytes) });
  const indexBytes = Buffer.from(JSON.stringify(inventory, null, 2) + '\n');
  await writeFile(join(product, 'checksums.json'), indexBytes);
  const build = 'bin';
  for (const item of inventory.files) if (('app/bin/' + item.path).length > 179) throw new Error('Review Windows extraction path length before release: ' + item.path);
  const staging = join(product, '.program-stage'); await mkdir(staging);
  for (const entry of await readdir(product)) if (!['data', 'backups', '.program-stage','.information-stage'].includes(entry)) await rename(join(product, entry), join(staging, entry));
  await mkdir(join(product, 'app'));
  const program = join(product, 'app', build); await rename(staging, program);
  const launcher = await buildLauncher(join(program, 'DSH Portable.exe'));
  await cp(launcher, join(product, 'DSH Portable.exe'));
  await cp(launcher, join(product, 'DSH 维护工具.exe'));
  await writeFile(join(product, 'app/portable.json'), JSON.stringify({ ...manifest, payloadLayout: undefined, layout: 'versioned-1', launcherProtocol: 1, program: 'app/' + build, programManifestSha256: sha(indexBytes) }, null, 2) + '\n');
  const information = join(product, 'app/说明与许可'); await rename(infoStage,information);
  return { program, build };
}
