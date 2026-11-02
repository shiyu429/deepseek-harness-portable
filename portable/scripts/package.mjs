/** Package the patched official Desktop as a directory, without an installer or updater. */
import { cp, mkdir, readFile, writeFile, readdir, rm, rename } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve, join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { project, work, upstream, buildEnvironment } from './environment.mjs';
import { installMsvc } from './prepare-msvc.mjs';
import { installRuntimeExtras } from './install-runtime-extras.mjs';
import { patchOfficeRuntime } from './patch-office-runtime.mjs';

const lock = JSON.parse(await readFile(resolve(project, 'upstream.lock.json'), 'utf8'));
const portableRelease = JSON.parse(await readFile(resolve(project, 'package.json'), 'utf8')).version;
const dataContract = JSON.parse(await readFile(resolve(project, 'data-contract.json'), 'utf8'));
if (dataContract.format !== 1 || !dataContract.verifiedUpstreamCommits.includes(lock.commit)) throw new Error('The upstream data format has not been admitted for overwrite updates.');
const app = resolve(upstream, 'apps/desktop');
await patchOfficeRuntime(join(app,'.desktop-build/targets/win-x64/dsh'));
const require = createRequire(join(app, 'package.json'));
const { build, Platform, Arch } = require('electron-builder');
const { createElectronBuilderConfig } = await import(pathToFileURL(resolve(app, 'scripts/electron-builder-config.mjs')).href);
const env = { ...await buildEnvironment(), DSH_DESKTOP_TARGET_PLATFORM: 'win32', DSH_DESKTOP_TARGET_ARCH: 'x64', DSH_DESKTOP_APP_ID: 'community.dsh.portable', DSH_DESKTOP_UNSIGNED: '1',
  // The upstream config validates policy metadata even for unsigned Windows directories.
  // Supply an unroutable build-only origin, then omit the policy from the portable manifest below.
  DSH_DESKTOP_AUTO_UPDATE_ENV: 'production', DSH_DESKTOP_MANDATORY_UPDATE_PROD_ORIGIN: 'https://portable.invalid',
};
delete env.DSH_DESKTOP_MANDATORY_UPDATE_CONFIG;
const compiler = join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
await mkdir(resolve(project, 'build'), { recursive: true });
execFileSync(compiler, ['/nologo', '/utf8output', '/optimize+', '/target:exe', '/platform:x64', '/reference:System.Web.Extensions.dll', '/reference:System.Windows.Forms.dll', '/reference:System.Drawing.dll', '/win32manifest:' + resolve(project, 'native/native-helper.manifest'), '/out:' + resolve(project, 'build/native-helper.exe'), resolve(project, 'native/NativeHelper.cs')], { stdio: 'inherit', windowsHide: true });
await cp(resolve(project, 'native/native-helper.exe.config'), resolve(project, 'build/native-helper.exe.config'));
await mkdir(join(app, 'portable'), { recursive: true });
await rm(join(app, 'portable/bootstrap.cjs'), { force: true });
for (const filename of ['core.cjs', 'bootstrap.mjs', 'program-guard.cjs']) await cp(resolve(project, 'runtime', filename), join(app, 'portable', filename));
const config = createElectronBuilderConfig(env, 'win32', 'x64');
config.productName = 'DSH Portable';
config.executableName = 'DSH Portable';
config.electronVersion = lock.electron;
config.extraMetadata = { ...config.extraMetadata, main: 'portable/bootstrap.mjs', description: 'Unofficial portable build of the official DeepSeek Harness', author: 'DSH Portable community build' };
delete config.extraMetadata.dshMandatoryUpdatePolicy;
config.files.push('portable/**/*.cjs', 'portable/**/*.mjs');
config.protocols = [];
config.publish = null;
config.beforeBuild = async () => true;
config.directories = { app, output: resolve(work, 'packed-app') };
config.extraResources.push(
  { from: resolve(project, 'build/native-helper.exe'), to: 'portable/native-helper.exe' },
  { from: resolve(project, 'build/native-helper.exe.config'), to: 'portable/native-helper.exe.config' },
  { from: resolve(project, 'runtime/core.cjs'), to: 'portable/core.cjs' },
  { from: resolve(project, 'runtime/program-guard.cjs'), to: 'portable/program-guard.cjs' },
  { from: resolve(project, 'runtime/maintenance.cjs'), to: 'portable/maintenance.cjs' },
  { from: resolve(project, 'runtime/cli-bootstrap.cjs'), to: 'portable/cli-bootstrap.cjs' },
  { from: resolve(project, 'runtime/verify-install.cjs'), to: 'portable/verify-install.cjs' },
  { from: resolve(work, 'tools/powershell'), to: 'runtime/powershell' },
);
const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
Object.assign(process.env, env);
try { await build({ projectDir: app, targets: Platform.WINDOWS.createTarget('dir', Arch.x64), config, publish: 'never' }); }
finally { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
const output = resolve(work, 'packed-app/win-unpacked');
await writeFile(join(output, 'portable.json'), JSON.stringify({ format: 1, dataFormat: 1, dataContract: dataContract.id, legacyPortableReleases: dataContract.legacyPortableReleases, portableVersion: portableRelease, execution: 'portable-workspaces', upstreamVersion: lock.version, upstreamCommit: lock.commit, platform: 'win32', arch: 'x64', unsigned: true }, null, 2) + '\n');
await mkdir(join(output, 'data'), { recursive: true });
// Keep the installed CLI entry in the resources consistent with the portable executable name.
await writeFile(join(output, 'resources/runtime/cli/bin/dsh.cmd'), '@echo off\r\nsetlocal DisableDelayedExpansion\r\nset "NODE_OPTIONS="\r\nset "NODE_PATH="\r\nset "ELECTRON_RUN_AS_NODE=1"\r\n"%~dp0..\\..\\..\\..\\DSH Portable.exe" --expose-internals "%~dp0..\\..\\..\\portable\\cli-bootstrap.cjs" %*\r\nexit /b %errorlevel%\r\n', 'utf8');
// The portable UI has no global command installation action; omit its installer workers as well.
await rm(join(output, 'resources/runtime/cli/command-manager.js'), { force: true });
await rm(join(output, 'resources/runtime/cli/command-path.ps1'), { force: true });
await cp(resolve(upstream, 'LICENSE'), join(output, 'LICENSE-DeepSeek-Harness.txt'));
await cp(resolve(project, 'LICENSE'), join(output, 'LICENSE-Portable.txt'));
await cp(resolve(upstream, 'THIRD_PARTY_NOTICES.md'), join(output, 'THIRD_PARTY_NOTICES.md'));
await cp(resolve(project, 'docs/使用说明.md'), join(output, '使用说明.md'));
await cp(resolve(project, 'resources.lock.json'), join(output, 'runtime-sources.json'));
await cp(resolve(upstream, 'scripts/primary-runtime/lock.json'), join(output, 'primary-runtime-lock.json'));
for (const entry of await readdir(output)) if (entry.endsWith('.cmd')) await rm(join(output, entry));
async function assertNoLinks(folder) {
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    const filename = join(folder, entry.name);
    if (entry.isSymbolicLink()) throw new Error('Distribution contains a machine-dependent link: ' + filename);
    if (entry.isDirectory()) await assertNoLinks(filename);
  }
}
await assertNoLinks(output);
await installMsvc(output);
await installRuntimeExtras(output);
const primary = join(output, 'resources/runtime/primary-runtime/dependencies');
await cp(resolve(project, 'runtime/python-sitecustomize.py'), join(primary, 'python/Lib/site-packages/sitecustomize.py'));
await rename(join(primary, 'pnpm/bin/pnpm.mjs'), join(primary, 'pnpm/bin/pnpm-real.mjs'));
await cp(resolve(project, 'runtime/pnpm-portable.mjs'), join(primary, 'pnpm/bin/pnpm.mjs'));
// The standalone Node launcher cannot resolve packages inside Electron's ASAR.
// Reuse the exact YAML dependency from the frozen production runtime, including its license.
const metadataYaml = join(app,'.desktop-build/targets/win-x64/dsh/node_modules/yaml');
const metadataYamlLock = JSON.parse(await readFile(join(project,'pnpm-yaml.lock.json'),'utf8'));
if (JSON.parse(await readFile(join(metadataYaml,'package.json'),'utf8')).version !== metadataYamlLock.version) throw new Error('Review the pinned pnpm metadata YAML parser before updating it');
await cp(metadataYaml,join(primary,'pnpm/dist/node_modules/yaml'),{recursive:true});
await writeFile(join(primary, 'pnpm/bin/pnpm.cmd'), '@echo off\r\n"%~dp0..\\..\\node\\bin\\node.exe" "%~dp0pnpm.mjs" %*\r\nexit /b %errorlevel%\r\n');
await writeFile(join(primary, 'python/Scripts/pip.cmd'), '@echo off\r\n"%~dp0..\\python.exe" -m pip %*\r\nexit /b %errorlevel%\r\n');
console.log('Portable directory built:', output);
