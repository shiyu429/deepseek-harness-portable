/** Exercise a packaged Electron build using Playwright's native Electron driver. */
import { createRequire } from 'node:module';
import { cp, mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { upstream, work } from './environment.mjs';
const require = createRequire(resolve(upstream, 'package.json'));
const { _electron } = require(resolve(upstream, 'node_modules/.pnpm/playwright@1.61.1/node_modules/playwright'));
const source = resolve(work, 'packed-app/win-unpacked');
const destination = resolve(process.argv.find(arg => arg.startsWith('--root='))?.slice(7) || join(work, 'qa', '便携 实测 (中文)', process.argv.includes('--fresh') ? 'DSH Portable fresh' : 'DSH Portable'));
await mkdir(destination, { recursive: true });
if (process.argv.includes('--copy')) await cp(source, destination, { recursive: true, filter: filename => !filename.startsWith(join(source, 'data') + '\\') });
const environment = { ...process.env };
delete environment.ELECTRON_RUN_AS_NODE;
delete environment.NODE_OPTIONS;
for (const key of Object.keys(environment)) if (/(?:API_KEY|SECRET|TOKEN|PASSWORD)$/i.test(key)) delete environment[key];
const args = [];
if (process.argv.includes('--offline')) {
  Object.assign(environment, { NODE_USE_ENV_PROXY: '1', HTTP_PROXY: 'http://127.0.0.1:1', HTTPS_PROXY: 'http://127.0.0.1:1', NO_PROXY: 'localhost,127.0.0.1' });
  args.push('--proxy-server=http://127.0.0.1:1');
}
const app = await _electron.launch({ executablePath: join(destination, 'DSH Portable.exe'), env: environment, args, timeout: 90000 });
const errors = [];
app.process().stderr?.on('data', bytes => process.stderr.write(bytes.toString().replace(/([?&]token=)[^\s]+/g, '$1[redacted]')));
function observe(page) {
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') console.error('RENDERER', message.text()); });
  page.on('requestfailed', request => console.error('REQUEST', request.url().split('?')[0], request.failure()?.errorText));
}
app.on('window', observe);
for (const page of app.windows()) observe(page);
await app.evaluate(({ app, dialog }) => {
  dialog.showErrorBox = (title, message) => { console.error('QA_FATAL_DIALOG', title, message); setTimeout(() => app.exit(1), 10); };
  dialog.showMessageBox = async (options) => {
    console.error('QA_DIALOG', options.title, options.message, options.detail, options.buttons);
    if (options.type === 'error') { setTimeout(() => app.exit(1), 10); return { response: 0, checkboxChecked: false }; }
    return { response: options.defaultId ?? 0, checkboxChecked: false };
  };
});
try {
  const page = await app.firstWindow({ timeout: 90000 });
  await page.waitForLoadState('domcontentloaded');
  for (let attempt = 0; attempt < 120; attempt++) {
    const texts = await Promise.all(app.windows().map(p => p.locator('body').innerText().catch(() => '')));
    if (texts.some(text => text.length > 100 && !text.trim().endsWith('Loading plugins…'))) break;
    await page.waitForTimeout(1000);
  }
  console.log('WINDOWS', await Promise.all(app.windows().map(async p => ({ url: p.url(), text: await p.locator('body').innerText() }))));
  console.log('MAIN', await app.evaluate(({ app, BrowserWindow }) => ({ paths: Object.fromEntries(['appData', 'userData', 'sessionData', 'temp', 'logs', 'crashDumps'].map(name => [name, app.getPath(name)])), windows: BrowserWindow.getAllWindows().length })));
  await page.screenshot({ path: resolve(work, 'qa', 'desktop-first-launch.png') });
  await writeFile(resolve(work, 'qa', 'desktop-first-launch-errors.json'), JSON.stringify(errors, null, 2));
} finally { await app.close(); }
