/** Put immutable Electron files in a versioned directory; root entry validates before data initialization. */
import { mkdir, readFile, writeFile, readdir, rename, cp, unlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
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
  await writeFile(join(product, 'portable.json'), JSON.stringify(manifest, null, 2) + '\n');
  const inventory = JSON.parse(await readFile(join(product, 'checksums.json'), 'utf8'));
  for (const item of inventory.files) if (item.path.endsWith('.cmd') && !item.path.includes('/')) await unlink(join(product, item.path));
  inventory.files = inventory.files.filter(item => !(item.path.endsWith('.cmd') && !item.path.includes('/')));
  const infoFiles=['使用说明.md','依赖清单.json','LICENSE-DeepSeek-Harness.txt','LICENSE-Portable.txt','THIRD_PARTY_NOTICES.md','runtime-sources.json'];
  if(!publicRelease)infoFiles.push('测试报告.md');
  const infoStage=join(product,'.information-stage');await mkdir(infoStage);
  for(const file of infoFiles)await rename(join(product,file),join(infoStage,file));
  if(publicRelease){try{await unlink(join(product,'测试报告.md'));}catch(error){if(error.code!=='ENOENT')throw error;}}
  inventory.files=inventory.files.filter(item=>!infoFiles.includes(item.path)&&(!publicRelease||item.path!=='测试报告.md'));
  const manifestEntry = inventory.files.find(item => item.path === 'portable.json');
  const manifestBytes = await readFile(join(product, 'portable.json'));
  Object.assign(manifestEntry, { bytes: manifestBytes.length, sha256: sha(manifestBytes) });
  const indexBytes = Buffer.from(JSON.stringify(inventory, null, 2) + '\n');
  await writeFile(join(product, 'checksums.json'), indexBytes);
  const build = manifest.portableVersion + '-' + sha(indexBytes).slice(0, 16);
  const staging = join(product, '.program-stage'); await mkdir(staging);
  for (const entry of await readdir(product)) if (!['data', 'backups', '.program-stage','.information-stage'].includes(entry)) await rename(join(product, entry), join(staging, entry));
  await mkdir(join(product, 'app'));
  const program = join(product, 'app', build); await rename(staging, program);
  const compiler = join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
  await mkdir(join(project, 'build'), { recursive: true });
  execFileSync(compiler, ['/nologo', '/utf8output', '/optimize+', '/target:exe', '/platform:x64', '/define:ICON_TOOL', '/out:' + join(project, 'build/icon-tool.exe'), join(project, 'native/EmbeddedIcon.cs')], { windowsHide: true, stdio: 'inherit' });
  execFileSync(join(project, 'build/icon-tool.exe'), [join(program, 'DSH Portable.exe'), join(project, 'build/app.ico')], { windowsHide: true, stdio: 'inherit' });
  execFileSync(compiler, ['/nologo', '/utf8output', '/optimize+', '/target:winexe', '/platform:x64', '/reference:System.Web.Extensions.dll', '/reference:System.Windows.Forms.dll', '/reference:System.Core.dll', '/reference:System.Drawing.dll', '/reference:System.IO.Compression.dll', '/reference:System.IO.Compression.FileSystem.dll', '/win32manifest:' + join(project, 'native/native-helper.manifest'), '/win32icon:' + join(project, 'build/app.ico'), '/out:' + join(project, 'build/launcher.exe'), ...['Launcher.cs', 'StartupWindow.cs', 'MaintenanceEngine.cs', 'MaintenanceForm.cs', 'EmbeddedIcon.cs', 'UiKit.cs'].map(file => join(project, 'native', file))], { windowsHide: true, stdio: 'inherit' });
  await cp(join(project, 'build/launcher.exe'), join(product, 'DSH Portable.exe'));
  await cp(join(project, 'build/launcher.exe'), join(product, 'DSH 维护工具.exe'));
  await writeFile(join(product, 'app/portable.json'), JSON.stringify({ ...manifest, payloadLayout: undefined, layout: 'versioned-1', launcherProtocol: 1, program: 'app/' + build, programManifestSha256: sha(indexBytes) }, null, 2) + '\n');
  const information = join(product, 'app/说明与许可'); await rename(infoStage,information);
  return { program, build };
}
