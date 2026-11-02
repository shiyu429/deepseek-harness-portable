/** Local model-service simulation through the real packaged Desktop interface. Never uses a real API key. */
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { upstream, work } from './environment.mjs';
const require = createRequire(resolve(upstream, 'package.json'));
const { _electron } = require(resolve(upstream, 'node_modules/.pnpm/playwright@1.61.1/node_modules/playwright'));
const root = resolve(process.argv.find(arg => arg.startsWith('--root='))?.slice(7) || join(work, 'qa/便携 实测 (中文)/DSH Portable fresh'));
const chatOnly = process.argv.includes('--chat-only');
const fullAccess = process.argv.includes('--full-access');
const accountAccess = process.argv.includes('--account-access') || fullAccess;
const persistentWorkspace = process.argv.includes('--persistent-workspace') || process.argv.includes('--official-workspace');
const packageManifest = JSON.parse(await readFile(join(root, 'app/portable.json'), 'utf8').catch(error => { if (error.code === 'ENOENT') return readFile(join(root, 'portable.json'), 'utf8'); throw error; }));
const programRoot = packageManifest.layout === 'versioned-1' ? resolve(root, packageManifest.program) : root;
const nativeHelper = join(programRoot, 'resources/portable/native-helper.exe');
function inspect() { return JSON.parse(execFileSync(nativeHelper, ['inspect', workspace], { encoding: 'utf8', windowsHide: true })).entries; }
const workspace = resolve(process.argv.find(arg => arg.startsWith('--workspace='))?.slice(12) || join(root, 'data/workspaces/演示 工作区'));
const token = String(Date.now());
const filename = 'portable-original-' + token + '.txt';
const expectedContent = '便携原文件直接修改验证通过。' + token + '\n';
const shellFile = 'portable-shell-' + token + '.txt';
const deniedFile = resolve(workspace, '..', 'portable-denied-' + token + '.txt');
await mkdir(workspace, { recursive: true });
await writeFile(join(workspace, filename), '修改前的原文件。\n');
if (accountAccess) execFileSync('icacls.exe', [join(workspace, filename), '/inheritance:d', '/grant', '*S-1-5-32-546:(R)'], { windowsHide: true, stdio: 'ignore' });
const originalPermissions = accountAccess ? inspect() : [];
function assertOriginalPermissions() {
  const current = new Map(inspect().map(entry => [entry.Path, entry.Sddl]));
  for (const entry of originalPermissions) assert.equal(current.get(entry.Path), entry.Sddl, 'Workspace permissions changed: ' + entry.Path);
}
async function assertNoLeases() {
  assert.equal(existsSync(join(root, 'data/recovery')), false);
}
const credentialFile = join(root, 'data/dsh/.credentials.yaml');
const existingCredentials = existsSync(credentialFile) ? await readFile(credentialFile, 'utf8') : '';
if (!existingCredentials.includes('fixture-only-not-a-real-key')) {
  const yaml = require('js-yaml');
  const document = existingCredentials ? yaml.load(existingCredentials) : { version: 1, refs: {} };
  document.refs ??= {}; document.refs.DEEPSEEK_API_KEY = 'fixture-only-not-a-real-key';
  await writeFile(credentialFile, yaml.dump(document));
}
let calls = 0;
let accountPolicySeen = false;
let failApi = false;
const server = createServer(async (request, response) => {
  const chunks = []; for await (const chunk of request) chunks.push(chunk);
  if (request.method !== 'POST') { response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: [{ id: 'deepseek-flash' }, { id: 'deepseek-v4-pro' }] })); return; }
  const body = JSON.parse(Buffer.concat(chunks).toString());
  if (accountAccess && JSON.stringify(body).includes('Current DSH file policy: danger-full-access')) accountPolicySeen = true;
  calls++;
  console.log('MOCK_REQUEST', { path: request.url, model: body.model, tools: body.tools?.map(tool => tool.name), credentialReadFromOfficialFile: request.headers['x-api-key'] === 'fixture-only-not-a-real-key' });
  const results = body.messages?.flatMap(message => Array.isArray(message.content) ? message.content.filter(block => block.type === 'tool_result') : []) || [];
  const hasRead = results.some(block => block.tool_use_id === 'portable_read_' + token);
  const hasWrite = results.some(block => block.tool_use_id === 'portable_write_' + token);
  const hasShell = results.some(block => block.tool_use_id === 'portable_pwsh_' + token);
  const title = !body.tools?.length;
  if (failApi && !title) {
    response.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: '便携验收模拟401错误' } }));
    return;
  }
  const tool = hasWrite ? 'pwsh' : hasRead ? 'write' : 'read';
  const complete = chatOnly || title || hasShell;
  const shellArgs = { description: '验证便携 PowerShell 和工作区写入保护', command: `Set-Content -LiteralPath '${shellFile}' -Value 'portable-shell-ok' -ErrorAction Stop; $PSVersionTable.PSVersion.ToString(); try { Set-Content -LiteralPath '${deniedFile.replaceAll("'", "''")}' -Value 'escape' -ErrorAction Stop; 'ESCAPED' } catch { 'SIBLING-DENIED' }` };
  const block = complete ? { type: 'text', text: '' } : { type: 'tool_use', id: 'portable_' + tool + '_' + token, name: tool, input: {} };
  const events = [
    { type: 'message_start', message: { id: 'msg_portable_' + calls, type: 'message', role: 'assistant', model: body.model, content: [], usage: { input_tokens: 10, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: block },
    { type: 'content_block_delta', index: 0, delta: complete ? { type: 'text_delta', text: title ? '便携原文件验证' : chatOnly ? '新建工作区对话验证通过。' : '便携版模拟聊天验证通过，文件已经保存。' } : { type: 'input_json_delta', partial_json: JSON.stringify(tool === 'pwsh' ? shellArgs : tool === 'read' ? { file_path: filename } : { file_path: filename, content: expectedContent }) } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: complete ? 'end_turn' : 'tool_use' }, usage: { output_tokens: 10 } },
    { type: 'message_stop' },
  ];
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const event of events) response.write('data: ' + JSON.stringify(event) + '\n\n');
  response.end();
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const environment = { ...process.env, DEEPSEEK_BASE_URL: `http://127.0.0.1:${server.address().port}` };
delete environment.ELECTRON_RUN_AS_NODE; delete environment.NODE_OPTIONS; delete environment.DEEPSEEK_API_KEY;
// The root native launcher proxies a child process; Playwright must attach to
// the actual Electron process. Its bootstrap still performs package/data admission.
const app = await _electron.launch({ executablePath: join(programRoot, 'DSH Portable.exe'), env: environment, timeout: 90000 });
let terminated = false;
app.process().stderr?.on('data', bytes => process.stderr.write(bytes.toString().replace(/([?&]token=)[^\s]+/g, '$1[redacted]')));
try {
  await app.evaluate(({ app, dialog }, workspace) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [workspace] });
    dialog.showErrorBox = (title, message) => { console.error('QA_FATAL', title, message); setTimeout(() => app.exit(1), 10); };
    dialog.showMessageBox = async options => { console.error('QA_DIALOG', options.message); return { response: options.cancelId ?? 0, checkboxChecked: false }; };
  }, workspace);
  const page = await app.firstWindow();
  page.on('console', message => { if (message.type() === 'error' || message.type() === 'warning') console.error('RENDERER', message.text()); });
  page.on('response', async response => {
    if (response.status() >= 400) console.error('HTTP_FAILURE', response.status(), response.url().split('?')[0], (await response.text().catch(() => '')).slice(0, 1400));
    if (response.url().includes('workspace') && response.request().method() === 'POST') console.log('WORKSPACE_RPC', response.url().split('?')[0], (await response.text().catch(() => '')).slice(0, 1800));
  });
  await page.getByText('新会话', { exact: true }).first().waitFor({ timeout: 90000 });
  await page.waitForTimeout(2000);
  const close = page.getByRole('button', { name: '关闭', exact: true });
  if (await close.isVisible()) await close.click();
  await page.getByText('新会话', { exact: true }).first().click();
  await page.waitForTimeout(1500);
  if (process.argv.some(arg => arg.startsWith('--workspace='))) {
    await page.getByRole('button', { name: '选择工作区', exact: true }).click();
    console.log('WORKSPACE_MENU', await page.locator('body').innerText());
    const add = page.getByText(/^添加工作区/, { exact: false }).last();
    if (await add.isVisible()) { await add.click(); await page.waitForTimeout(1500); }
  }
  console.log('BEFORE_PICK', await page.locator('body').innerText());
  const choose = page.getByText('选择工作区', { exact: true });
  if (await choose.isVisible()) { await choose.click(); await page.waitForTimeout(2000); }
  console.log('WORKSPACE_PICKER', await page.locator('body').innerText());
  console.log('AFTER_PICK', await page.locator('body').innerText());
  console.log('INPUTS', await page.locator('textarea, [contenteditable="true"]').evaluateAll(elements => elements.map(element => ({ tag: element.tagName, placeholder: element.getAttribute('placeholder'), role: element.getAttribute('role') }))));
  if (!process.argv.includes('--inspect')) {
    if (fullAccess) {
      await page.getByRole('button', { name: /访问模式，当前/ }).click();
      await page.getByText('完全权限', { exact: true }).last().click();
      await page.getByRole('checkbox', { name: '我已了解风险，并愿意继续' }).check();
      await page.getByRole('button', { name: '启用完全权限', exact: true }).click();
      await page.getByRole('button', { name: /访问模式，当前：完全权限/ }).waitFor({ timeout: 10000 });
      console.log('OFFICIAL_FULL_ACCESS_CONFIRMATION', true);
    } else if (process.argv.includes('--official-workspace')) {
      await page.getByRole('button', { name: /访问模式，当前/ }).click();
      await page.getByText('仅可查看', { exact: true }).last().click();
      await page.getByRole('button', { name: /访问模式，当前：仅可查看/ }).waitFor({ timeout: 10000 });
      await page.getByRole('button', { name: /访问模式，当前/ }).click();
      await page.getByText('工作区内修改', { exact: true }).last().click();
      await page.getByRole('button', { name: /访问模式，当前：工作区内修改/ }).waitFor({ timeout: 10000 });
      console.log('OFFICIAL_READ_ONLY_AND_WORKSPACE_SELECTION', true);
    }
    const editor = page.locator('[contenteditable="true"], textarea').first();
    await editor.fill(`请读取并修改工作区里的原文件 ${filename}，然后回复完成。`);
    await editor.press('Enter');
    if (chatOnly) {
      await page.getByText('新建工作区对话验证通过。', { exact: false }).last().waitFor({ timeout: 60000 });
      assert.ok(calls > 0);
      await page.screenshot({ path: join(work, 'qa/workspace-chat-success.png') });
      console.log('NEW_INTERNAL_WORKSPACE_CHAT', true);
    } else {
    for (let attempt = 0; attempt < 60; attempt++) {
      if (await readFile(join(workspace, filename), 'utf8') === expectedContent) break;
      await page.waitForTimeout(1000);
    }
    assert.equal(await readFile(join(workspace, filename), 'utf8'), expectedContent);
    await page.getByText('便携版模拟聊天验证通过，文件已经保存。', { exact: false }).last().waitFor({ timeout: 60000 });
    console.log('DIRECT_ORIGINAL_FILE', true);
    assert.equal((await readFile(join(workspace, shellFile), 'utf8')).trim(), 'portable-shell-ok');
    assert.equal(existsSync(deniedFile), accountAccess);
    console.log(accountAccess ? 'ACCOUNT_ACCESS_INCLUDES_USER_WRITABLE_SIBLING' : 'BUNDLED_POWERSHELL_AND_WRITE_BOUNDARY', true);
    if (accountAccess) {
      assert.equal(accountPolicySeen, true, 'Model context must describe the actual account-access policy');
      assert.match(await page.locator('body').innerText(), fullAccess ? /完全权限/ : /当前账户权限/);
      assertOriginalPermissions(); await assertNoLeases();
      console.log('WORKSPACE_DACL_AND_LABEL_UNCHANGED_WHILE_RUNNING', true);
      console.log('MODEL_AND_UI_ACCOUNT_ACCESS_POLICY', true);
    }
    const secondExit = await new Promise((done, reject) => {
      const second = spawn(join(root, 'DSH Portable.exe'), [], { env: environment, windowsHide: true, stdio: 'ignore' });
      const timer = setTimeout(() => { execFileSync('taskkill.exe', ['/PID', String(second.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); reject(new Error('duplicate launch did not settle')); }, 90000);
      second.once('error', reject); second.once('exit', code => { clearTimeout(timer); done(code); });
    });
    assert.equal(secondExit, 0); console.log('DUPLICATE_LAUNCH', true);
    if (process.argv.includes('--errors')) {
      failApi = true;
      await editor.fill('请验证 API 错误时仍保留这条已经发送的提示。');
      await editor.press('Enter');
      await page.getByText(/401|便携验收模拟|authentication_error|API\s*密钥无效/).last().waitFor({ timeout: 60000 });
      console.log('SIMULATED_API_ERROR_VISIBLE', true);
    }
    await page.screenshot({ path: join(work, 'qa/chat-success.png') });
    console.log('MOCK_CALLS', calls);
    if (accountAccess) {
      await page.getByRole('button', { name: /访问模式，当前/ }).click();
      await page.getByText('仅可查看', { exact: true }).last().click();
      await page.getByRole('button', { name: /访问模式，当前：仅可查看/ }).waitFor({ timeout: 10000 });
      assertOriginalPermissions(); await assertNoLeases();
      console.log('READ_ONLY_SELECTABLE', true);
    }
    const retainedPermissions = persistentWorkspace ? inspect() : undefined;
    if (persistentWorkspace) {
      assert.match(await page.locator('body').innerText(), /工作区内修改/);
      await assertNoLeases(); console.log('PORTABLE_WORKSPACE_RESTRICTION_AND_NO_RECOVERY', true);
    }
    if (process.argv.includes('--abrupt')) {
      assert.ok(accountAccess || persistentWorkspace, 'Use abrupt mode only with the portable permission checks');
      const stopped = new Promise(done => app.process().once('exit', done));
      execFileSync('taskkill.exe', ['/PID', String(app.process().pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      terminated = true; await stopped;
      if (accountAccess) assertOriginalPermissions();
      if (persistentWorkspace) assert.deepEqual(inspect(), retainedPermissions);
      await assertNoLeases();
      console.log('ABRUPT_EXIT_NO_PERMISSION_RESTORATION_NEEDED', true);
    }
    }
  }
} catch (error) {
  for (const page of app.windows()) { console.error('UI_FAILURE', await page.locator('body').innerText().catch(() => 'closed')); await page.screenshot({ path: join(work, 'qa/chat-failure.png') }).catch(() => {}); }
  throw error;
} finally { if (!terminated) await app.close(); await new Promise(done => server.close(done)); }
