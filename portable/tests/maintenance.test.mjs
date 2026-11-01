import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, readdirSync, rmSync, symlinkSync, rmdirSync } from 'node:fs';
import { spawn, execFileSync } from 'node:child_process';
import { resolve, join, relative, isAbsolute } from 'node:path';

const require = createRequire(import.meta.url);
const core = require('../runtime/core.cjs');
const base = resolve(import.meta.dirname, '../../qa');
const binary = resolve(import.meta.dirname, '../build/native-helper.exe');
mkdirSync(base, { recursive: true });
function fixture() {
  const root = mkdtempSync(join(base, 'maintenance-'));
  mkdirSync(join(root, 'resources/portable'), { recursive: true });
  mkdirSync(join(root, 'data/dsh'), { recursive: true });
  copyFileSync(binary, join(root, 'resources/portable/native-helper.exe'));
  copyFileSync(binary + '.config', join(root, 'resources/portable/native-helper.exe.config'));
  writeFileSync(join(root, 'portable.json'), JSON.stringify({ format: 1, dataFormat: 1, portableVersion: '1.0.0', upstreamCommit: core.UPSTREAM }));
  writeFileSync(join(root, 'data/portable-state.json'), JSON.stringify({ format: 1, release: '1.0.0', roots: [root] }));
  return { root, helper: join(root, 'resources/portable/native-helper.exe'), cleanup() {
    const rest = relative(base, root); assert.ok(rest && !rest.startsWith('..') && !isAbsolute(rest));
    rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  } };
}
function maintenance(action, root, choices = [], extra = []) {
  return new Promise((done, reject) => {
    const child = spawn(process.execPath, [resolve(import.meta.dirname, '../runtime/maintenance.cjs'), action, root, ...extra], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', supplied = false, closed = false;
    const timer = setTimeout(() => { child.kill(); reject(new Error('maintenance timed out\n' + stdout + stderr)); }, 30000);
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      stdout += chunk;
      if (!supplied && choices.length && stdout.includes('选择要恢复的备份编号')) { supplied = true; child.stdin.write(choices[0] + '\n'); }
      if (!closed && stdout.includes('按回车关闭')) { closed = true; child.stdin.end('\n'); }
    });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', code => { clearTimeout(timer); done({ code, stdout, stderr }); });
  });
}

test('the data lock rejects a second writer and is reusable after release', { skip: process.platform !== 'win32' }, async () => {
  const f = fixture(); let first, third;
  try {
    first = await core.acquireRunLock(core.directories(f.root), f.helper);
    await assert.rejects(core.acquireRunLock(core.directories(f.root), f.helper), /使用|退出/);
    await first.release();
    third = await core.acquireRunLock(core.directories(f.root), f.helper);
    await third.release();
  } finally { if (first) await first.release(); if (third) await third.release(); f.cleanup(); }
});

test('portable data permissions support repeat launches without changing an external junction target', { skip: process.platform !== 'win32' }, async () => {
  const f = fixture(); let lock;
  try {
    const outside = join(f.root, 'outside'); mkdirSync(outside);
    writeFileSync(join(outside, 'untouched.txt'), 'unchanged');
    symlinkSync(outside, join(f.root, 'data', 'external-link'), 'junction');
    const before = execFileSync('icacls.exe', [outside], { encoding: 'utf8' });
    assert.equal(core.native(f.helper, ['portable-data', join(f.root, 'data')]).reused, false);
    assert.equal(execFileSync('icacls.exe', [outside], { encoding: 'utf8' }), before);
    lock = await core.acquireRunLock(core.directories(f.root), f.helper);
    assert.equal(core.native(f.helper, ['portable-data', join(f.root, 'data')]).reused, true);
  } finally { if (lock) await lock.release(); f.cleanup(); }
});

test('backup and restore preserve the official credential bytes and keep the replaced data', { skip: process.platform !== 'win32' }, async () => {
  const f = fixture();
  try {
    const credential = 'version: 1\nrefs:\n  DEEPSEEK_API_KEY: fixture-only-not-a-real-key\n';
    writeFileSync(join(f.root, 'data/dsh/.credentials.yaml'), credential);
    writeFileSync(join(f.root, 'data/dsh/history.txt'), 'saved history');
    const backed = await maintenance('backup', f.root);
    assert.equal(backed.code, 0, backed.stdout + backed.stderr);
    const snapshot = readdirSync(join(f.root, 'backups'))[0];
    assert.equal(readFileSync(join(f.root, 'backups', snapshot, 'dsh/.credentials.yaml'), 'utf8'), credential);
    writeFileSync(join(f.root, 'data/dsh/history.txt'), 'later history');
    const restored = await maintenance('restore', f.root, ['1']);
    assert.equal(restored.code, 0, restored.stdout + restored.stderr);
    assert.equal(readFileSync(join(f.root, 'data/dsh/history.txt'), 'utf8'), 'saved history');
    assert.equal(readFileSync(join(f.root, 'data/dsh/.credentials.yaml'), 'utf8'), credential);
    const previous = readdirSync(join(f.root, 'backups')).find(name => name.startsWith('before-restore-'));
    assert.equal(readFileSync(join(f.root, 'backups', previous, 'dsh/history.txt'), 'utf8'), 'later history');
  } finally { f.cleanup(); }
});

test('a nested external directory link cannot produce a falsely completed portable backup', { skip: process.platform !== 'win32' }, async () => {
  const f = fixture();
  const external = mkdtempSync(join(base, 'external-backup-'));
  try {
    writeFileSync(join(external, 'external.txt'), 'must not be imported');
    mkdirSync(join(f.root, 'data/dsh/nested'));
    symlinkSync(external, join(f.root, 'data/dsh/nested/link'), 'junction');
    const result = await maintenance('backup', f.root);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /便携目录外/);
    for (const name of readdirSync(join(f.root, 'backups'))) assert.equal(readdirSync(join(f.root, 'backups', name)).includes('backup.json'), false);
    assert.equal(readFileSync(join(external, 'external.txt'), 'utf8'), 'must not be imported');
  } finally { f.cleanup(); rmSync(external, { recursive: true, force: true }); }
});

test('backup and restore omit relocated pnpm project indexes and reinitialize cross-account data access', { skip: process.platform !== 'win32' }, async () => {
  const f = fixture();
  try {
    const projects = join(f.root, 'data/cache/pnpm-store/v11/projects');
    mkdirSync(projects, { recursive: true });
    symlinkSync(join(f.root, 'missing-old-project'), join(projects, '0123456789abcdef0123456789abcdef'), 'junction');
    writeFileSync(join(f.root, 'data/dsh/saved.txt'), 'confirmed contents');
    writeFileSync(join(f.root, 'data/.portable-acl-v1.json'), '{"completed":true}');
    const backed = await maintenance('backup', f.root);
    assert.equal(backed.code, 0, backed.stdout + backed.stderr);
    const name = readdirSync(join(f.root, 'backups'))[0];
    assert.deepEqual(readdirSync(join(f.root, 'backups', name, 'cache/pnpm-store/v11/projects')), []);
    assert.deepEqual(core.readJson(join(f.root, 'backups', name, 'backup.json')).omittedRebuildable, ['cache/pnpm-store/v11/projects']);
    const restored = await maintenance('restore', f.root, ['1']);
    assert.equal(restored.code, 0, restored.stdout + restored.stderr);
    assert.equal(readFileSync(join(f.root, 'data/dsh/saved.txt'), 'utf8'), 'confirmed contents');
    assert.equal(core.readJson(join(f.root, 'data/.portable-acl-v1.json')), undefined);
  } finally { f.cleanup(); }
});

test('an interrupted restoration blocks normal startup and can be undone without overwriting original files', { skip: process.platform !== 'win32' }, async () => {
  const f = fixture();
  try {
    const previous = join(f.root, 'backups', 'before-restore-fixture');
    const staged = join(f.root, '.restore-fixture');
    mkdirSync(join(previous, 'dsh'), { recursive: true }); mkdirSync(staged);
    writeFileSync(join(previous, 'dsh/history.txt'), 'original before interruption');
    writeFileSync(join(f.root, 'data/dsh/history.txt'), 'partial replacement');
    writeFileSync(join(f.root, '.maintenance-transaction.json'), JSON.stringify({ format: 1, kind: 'restore', phase: 'installing', previous, staged }));
    assert.throws(() => core.prepare(f.root), /维护中断/);
    const recovered = await maintenance('restore', f.root);
    assert.equal(recovered.code, 0, recovered.stdout + recovered.stderr);
    assert.equal(readFileSync(join(f.root, 'data/dsh/history.txt'), 'utf8'), 'original before interruption');
  } finally { f.cleanup(); }
});

test('manual migration backs up the original data and stamps only the matching new release', { skip: process.platform !== 'win32' }, async () => {
  const original = fixture(), next = fixture();
  try {
    rmSync(join(next.root, 'data/portable-state.json'));
    rmdirSync(join(next.root, 'data/dsh'));
    const nextManifest = core.readJson(join(next.root, 'portable.json'));
    nextManifest.portableVersion = '1.1.0';
    writeFileSync(join(next.root, 'portable.json'), JSON.stringify(nextManifest));
    writeFileSync(join(original.root, 'data/dsh/saved.txt'), 'saved before migration');
    const result = await maintenance('upgrade', original.root, [], [next.root]);
    assert.equal(result.code, 0, result.stdout + result.stderr);
    assert.equal(readFileSync(join(next.root, 'data/dsh/saved.txt'), 'utf8'), 'saved before migration');
    assert.equal(readFileSync(join(original.root, 'data/dsh/saved.txt'), 'utf8'), 'saved before migration');
    assert.equal(core.readJson(join(next.root, 'data/portable-state.json')).release, '1.1.0');
    assert.equal(core.readJson(join(original.root, 'data/portable-state.json')).release, '1.0.0');
    const repeated = await maintenance('upgrade', original.root, [], [next.root]);
    assert.notEqual(repeated.code, 0);
    assert.match(repeated.stderr, /已经有数据/);
  } finally { original.cleanup(); next.cleanup(); }
});

test('a user file colliding with snapshot metadata is never silently replaced', { skip: process.platform !== 'win32' }, async () => {
  const f = fixture();
  try {
    const saved = await maintenance('backup', f.root); assert.equal(saved.code, 0, saved.stderr);
    writeFileSync(join(f.root, 'data/backup.json'), 'user-owned confirmed contents');
    const backed = await maintenance('backup', f.root); assert.notEqual(backed.code, 0);
    const restored = await maintenance('restore', f.root, ['1']); assert.notEqual(restored.code, 0);
    assert.equal(readFileSync(join(f.root, 'data/backup.json'), 'utf8'), 'user-owned confirmed contents');
  } finally { f.cleanup(); }
});
