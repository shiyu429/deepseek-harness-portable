/** Verify retained credentials, sessions and a real installed plugin after moving the whole directory. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { cp, readFile, writeFile, mkdir, readdir, rename } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { upstream, work, project } from './environment.mjs';
const require = createRequire(resolve(upstream, 'package.json'));
const { _electron } = require(resolve(upstream, 'node_modules/.pnpm/playwright@1.61.1/node_modules/playwright'));
const core = createRequire(import.meta.url)('../runtime/core.cjs');
const candidates = ['qa/最终 便携版!', 'qa/搬移后 DSH 便携!', 'qa/再次搬移 DSH 便携!'].map(name => resolve(work, name));
const source = process.argv.find(arg => arg.startsWith('--source='))?.slice(9) || candidates.find(filename => existsSync(filename));
const target = process.argv.find(arg => arg.startsWith('--target='))?.slice(9) || candidates.find(filename => !existsSync(filename));
if (!source || !target) throw new Error('No isolated QA move source or destination');
const qaRoot = resolve(work, 'qa');
if (!core.inside(qaRoot, source) || !core.inside(qaRoot, target) || source === qaRoot || target === qaRoot) throw new Error('Unsafe QA move');
let context = core.prepare(source);
const lock = await core.acquireRunLock(context.dirs, context.helper, context.environment); await lock.release();
const distribution = resolve(work, 'packed-app/win-unpacked');
if (context.programRoot === source) {
  for (const file of ['DSH Portable.exe', 'resources/app.asar']) await cp(join(distribution, file), join(source, file));
  await cp(join(distribution, 'resources/portable'), join(source, 'resources/portable'), { recursive: true });
}
context = core.prepare(source);
const pluginName = 'portable-relocation-fixture';
const plugin = join(source, 'data/relocation-plugin'); await mkdir(plugin, { recursive: true });
await writeFile(join(plugin, 'package.json'), JSON.stringify({ name: pluginName, version: '1.0.2', type: 'module', exports: './index.js', dsh: { bundle: { patch: './bundle.yml' } } }));
await writeFile(join(plugin, 'bundle.yml'), '- insert:\n    - id: portable-relocation-fixture\n      name: portable-relocation-fixture\n      inject: [webServer]\n');
await writeFile(join(plugin, 'index.js'), "import {pathToFileURL} from 'node:url'; import {join} from 'node:path'; export async function apply(ctx) { const {resolvePortablePath}=await import(pathToFileURL(join(process.env.DSH_PORTABLE_PROGRAM_ROOT??process.env.DSH_PORTABLE_ROOT,'resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-home-paths/lib/index.js')).href); ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/portable-qa-plugin', handler(req, res) { const url=new URL(req.url,'http://localhost'); res.setHeader('content-type','application/json'); res.end(JSON.stringify({message:'portable plugin ready',resolved:resolvePortablePath(url.searchParams.get('path'))})); } })); }\n");
await new Promise((done, reject) => {
  const child = spawn(join(context.programRoot, 'DSH Portable.exe'), ['--expose-internals', join(context.programRoot, 'resources/portable/cli-bootstrap.cjs'), 'plugin', '--profile', 'desktop', 'add', 'file:' + plugin, '--offline', '--ignore-scripts'], { env: { ...context.environment, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let output = ''; child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
  const timer = setTimeout(() => { child.kill(); reject(new Error('Packaged plugin CLI timed out: ' + output)); }, 120000);
  child.once('error', reject); child.once('exit', code => { clearTimeout(timer); code === 0 ? done() : reject(new Error('Packaged plugin CLI failed: ' + output)); });
});
console.log('PERSISTENT_PLUGIN_INSTALLED', true);
const credentials = await readFile(join(source, 'data/dsh/.credentials.yaml'));
const settings = await readFile(join(source, 'data/dsh/profiles/desktop/cordis.patch.yml'));
await mkdir(dirname(target), { recursive: true });
await rename(source, target);
const environment = { ...process.env, NODE_USE_ENV_PROXY: '1', HTTP_PROXY: 'http://127.0.0.1:1', HTTPS_PROXY: 'http://127.0.0.1:1', NO_PROXY: 'localhost,127.0.0.1' };
delete environment.ELECTRON_RUN_AS_NODE; delete environment.NODE_OPTIONS; delete environment.DEEPSEEK_API_KEY;
const app = await _electron.launch({ executablePath: join(target, 'DSH Portable.exe'), env: environment, args: ['--proxy-server=http://127.0.0.1:1'], timeout: 90000 });
app.process().stderr?.on('data', bytes => process.stderr.write(bytes.toString().replace(/([?&]token=)[^\s]+/g, '$1[redacted]')));
try {
  await app.evaluate(({ app, dialog }) => {
    dialog.showErrorBox = (title, message) => { console.error('QA_FATAL', title, message); setTimeout(() => app.exit(1), 10); };
    dialog.showMessageBox = async options => ({ response: options.cancelId ?? 0, checkboxChecked: false });
  });
  const page = await app.firstWindow();
  await page.getByText('新会话', { exact: true }).first().waitFor({ timeout: 90000 });
  const oldWorkspace = join(source, 'data/workspaces/演示 工作区');
  const pluginResponse = await page.evaluate(async oldWorkspace => { const result = await fetch('/portable-qa-plugin?path=' + encodeURIComponent(oldWorkspace)); return { status: result.status, body: await result.json() }; }, oldWorkspace);
  assert.deepEqual(pluginResponse, { status: 200, body: { message: 'portable plugin ready', resolved: join(target, 'data/workspaces/演示 工作区') } });
  const title = page.getByText('便携原文件验证', { exact: true }).first();
  if (await title.isVisible()) await title.click();
  await page.getByText('便携版模拟聊天验证通过，文件已经保存。', { exact: false }).last().waitFor({ timeout: 30000 });
  assert.equal(await app.evaluate(({ app }) => app.getPath('userData')), join(target, 'data/desktop'));
  const manifest = JSON.parse(await readFile(join(target, 'data/dsh/profiles/desktop/package.json'), 'utf8'));
  assert.ok(!Object.values(manifest.dependencies).some(value => value.toLowerCase().includes(source.toLowerCase())));
  await page.screenshot({ path: join(work, 'qa/move-success.png') });
  console.log(JSON.stringify({ pluginContinuesAfterMove: true, historicalWorkspacePathResolves: true, previousConversationVisible: true, desktopDataAtNewLocation: true }));
} finally { await app.close(); }
assert.deepEqual(await readFile(join(target, 'data/dsh/.credentials.yaml')), credentials);
assert.deepEqual(await readFile(join(target, 'data/dsh/profiles/desktop/cordis.patch.yml')), settings);
assert.equal(existsSync(join(target, 'data/recovery')), false);
console.log('OFFICIAL_CREDENTIALS_AND_SETTINGS_UNCHANGED', true);
await writeFile(join(work, 'qa/move-result.json'), JSON.stringify({ ok: true, root: target, credentialsUnchanged: true, settingsUnchanged: true, pluginsPortable: true, previousConversationVisible: true }, null, 2));
