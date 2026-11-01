import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { crc32 } from 'node:zlib';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync, renameSync } from 'node:fs';
import { join, resolve, relative, isAbsolute } from 'node:path';
const base = resolve(import.meta.dirname, '../../qa'), native = resolve(import.meta.dirname, '../build/launcher.exe');
const contract = JSON.parse(readFileSync(resolve(import.meta.dirname, '../data-contract.json')));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const json = value => Buffer.from(JSON.stringify(value));
const record = (path, bytes) => ({ path, bytes: bytes.length, sha256: sha(bytes) });
function zip(entries) {
  const local = [], central = []; let offset = 0;
  for (const [path, value] of entries) {
    const name = Buffer.from(path), data = Buffer.from(value), crc = crc32(data);
    const header = Buffer.alloc(30); header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x800, 6); header.writeUInt32LE(crc, 14); header.writeUInt32LE(data.length, 18); header.writeUInt32LE(data.length, 22); header.writeUInt16LE(name.length, 26);
    const index = Buffer.alloc(46); index.writeUInt32LE(0x02014b50); index.writeUInt16LE(20, 4); index.writeUInt16LE(20, 6); index.writeUInt16LE(0x800, 8); index.writeUInt32LE(crc, 16); index.writeUInt32LE(data.length, 20); index.writeUInt32LE(data.length, 24); index.writeUInt16LE(name.length, 28); index.writeUInt32LE(offset, 42);
    local.push(header, name, data); central.push(index, name); offset += header.length + name.length + data.length;
  }
  const index = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(index.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, index, end]);
}
function fixture() {
  mkdirSync(base, { recursive: true }); const root = mkdtempSync(join(base, '图形更新 中文 '));
  mkdirSync(join(root, 'app')); mkdirSync(join(root, 'data/dsh'), { recursive: true });
  for (const name of ['DSH Portable.exe', 'DSH 维护工具.exe']) copyFileSync(native, join(root, name));
  writeFileSync(join(root, 'data/portable-state.json'), json({ format: 1, release: '1.2.0', roots: [root], dataContract: contract.id }));
  writeFileSync(join(root, 'data/dsh/.credentials.yaml'), 'refs:\n  DEEPSEEK_API_KEY: fixture-only-not-a-real-key\n');
  writeFileSync(join(root, 'data/dsh/chat.json'), '{"text":"保留历史聊天"}');
  const snapshot = () => ['data/portable-state.json', 'data/dsh/.credentials.yaml', 'data/dsh/chat.json'].map(path => [path, sha(readFileSync(join(root, path)))]);
  const before = snapshot();
  function packageFiles(version = '1.3.0', id = contract.id, payload = Buffer.from('verified test payload')) {
    const program = 'app/' + version + '-fixture';
    const manifest = { format: 1, payloadLayout: 1, portableVersion: version, dataContract: id, legacyPortableReleases: contract.legacyPortableReleases };
    const files = new Map([[program + '/portable.json', json(manifest)], [program + '/DSH Portable.exe', payload]]);
    const index = json({ format: 1, files: [...files].map(([path, bytes]) => record(path.substring(program.length + 1), bytes)) }); files.set(program + '/checksums.json', index);
    const pointer = { layout: 'versioned-1', launcherProtocol: 1, portableVersion: version, dataContract: id, program, programManifestSha256: sha(index) };
    files.set('app/portable.json', json(pointer));
    for (const name of ['DSH Portable.exe', 'DSH 维护工具.exe']) files.set(name, readFileSync(native));
    files.set('app/说明与许可/使用说明.md', Buffer.from('测试说明'));
    files.set('app/checksums.json', json({ format: 1, files: [...files].map(([path, bytes]) => record(path, bytes)) }));
    return files;
  }
  const install = files => { for (const [path, bytes] of files) { mkdirSync(join(root, path, '..'), { recursive: true }); writeFileSync(join(root, path), bytes); } };
  install(packageFiles('1.2.0'));
  return { root, before, snapshot, packageFiles, apply(files) { const file = join(root, 'candidate.zip'); writeFileSync(file, zip([...files])); return spawnSync(join(root, 'DSH Portable.exe'), ['--portable-apply-update', file], { encoding: 'utf8', windowsHide: true, timeout: 30000 }); },
    close() { const part = relative(base, root); assert.ok(part && !part.startsWith('..') && !isAbsolute(part)); rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } };
}
async function completed(f) {
  const end = Date.now() + 30000, receipt = join(f.root, 'app/.updates/result.json');
  while (Date.now() < end) { if (existsSync(receipt) && !existsSync(join(f.root, 'app/.update.pending.json'))) return JSON.parse(readFileSync(receipt)); await new Promise(done => setTimeout(done, 100)); }
  throw new Error('update did not complete: ' + (existsSync(receipt) ? readFileSync(receipt) : 'no receipt'));
}
const skip = process.platform !== 'win32' || !existsSync(native);
test('graphical updater replaces its own entries and program while preserving data byte for byte', { skip }, async () => {
  const f = fixture(); try { const result = f.apply(f.packageFiles()); assert.equal(result.status, 0, result.stderr); assert.equal((await completed(f)).ok, true); assert.match(JSON.parse(readFileSync(join(f.root, 'app/portable.json'))).program, /1\.3\.0/); assert.deepEqual(f.snapshot(), f.before); assert.equal(existsSync(join(f.root, 'backups')), false); } finally { f.close(); }
});
for (const [name, change] of [
  ['user data', files => files.set('data/chat.json', Buffer.from('do not write'))],
  ['traversal', files => files.set('../outside', Buffer.from('do not write'))],
  ['alternate stream', files => files.set('app/file:stream', Buffer.from('do not write'))],
  ['incompatible format', (files, f) => { files.clear(); for (const pair of f.packageFiles('2.0.0', 'incompatible')) files.set(...pair); }],
  ['truncated program', files => files.set('app/1.3.0-fixture/DSH Portable.exe', Buffer.from('x'))],
  ['unlisted root entry', files => { const index = JSON.parse(files.get('app/checksums.json')); index.files = index.files.filter(item => item.path !== 'DSH Portable.exe'); files.set('app/checksums.json', json(index)); }],
]) test('updater refuses ' + name + ' before changing selected program or data', { skip }, () => {
  const f = fixture(); try { const selected = readFileSync(join(f.root, 'app/portable.json')), files = f.packageFiles(); change(files, f); const result = f.apply(files); assert.equal(result.status, 1, result.stderr); assert.deepEqual(readFileSync(join(f.root, 'app/portable.json')), selected); assert.deepEqual(f.snapshot(), f.before); assert.equal(existsSync(join(f.root, 'app/.update.pending.json')), false); } finally { f.close(); }
});
test('an interrupted program move blocks launch and resumes without copying or rewriting data', { skip }, async () => {
  const f = fixture(); try {
    const stage = join(f.root, 'app/.updates/stage-interrupted'); mkdirSync(stage, { recursive: true });
    for (const [path, bytes] of f.packageFiles()) { mkdirSync(join(stage, path, '..'), { recursive: true }); writeFileSync(join(stage, path), bytes); }
    renameSync(join(stage, 'app/1.3.0-fixture'), join(f.root, 'app/1.3.0-fixture'));
    const transaction = join(f.root, 'app/.updates/update-interrupted.json'); writeFileSync(transaction, json({ format: 1, root: f.root, stage, quiet: true })); writeFileSync(join(f.root, 'app/.update.pending.json'), json({ format: 1, transaction }));
    assert.equal(spawnSync(join(f.root, 'DSH Portable.exe'), ['--portable-probe'], { encoding: 'utf8', windowsHide: true }).status, 1);
    const result = spawnSync(join(f.root, 'DSH Portable.exe'), ['--portable-resume-update'], { encoding: 'utf8', windowsHide: true }); assert.equal(result.status, 0, result.stderr); assert.equal((await completed(f)).ok, true); assert.deepEqual(f.snapshot(), f.before);
  } finally { f.close(); }
});
test('a live application prevents replacement of program files', { skip }, async () => {
  const f = fixture(); let child;
  try {
    const files = f.packageFiles('1.2.0', contract.id, readFileSync(process.execPath));
    for (const [path, bytes] of files) { mkdirSync(join(f.root, path, '..'), { recursive: true }); writeFileSync(join(f.root, path), bytes); }
    child = spawn(join(f.root, 'DSH Portable.exe'), ['-e', "console.log('ready');setInterval(()=>{},1000)"], { windowsHide: true });
    await new Promise((done, reject) => { child.stdout.once('data', done); child.once('exit', code => reject(new Error('child exited ' + code))); });
    const result = f.apply(f.packageFiles()); assert.equal(result.status, 1); assert.match(result.stderr, /仍在运行/); assert.deepEqual(f.snapshot(), f.before);
  } finally {
    if (child && child.exitCode === null) spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
    if (child && child.exitCode === null) await new Promise(done => child.once('exit', done)); f.close();
  }
});
test('a complete compatible package can replace an unrecoverable pending program update', { skip }, async () => {
  const f = fixture(); try {
    writeFileSync(join(f.root, 'app/.update.pending.json'), '{broken pending record');
    const result = f.apply(f.packageFiles()); assert.equal(result.status, 0, result.stderr); assert.equal((await completed(f)).ok, true); assert.deepEqual(f.snapshot(), f.before);
  } finally { f.close(); }
});
