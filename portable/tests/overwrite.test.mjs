import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, readdirSync, rmSync, unlinkSync, symlinkSync, existsSync } from 'node:fs';
import { resolve, join, relative, isAbsolute } from 'node:path';
const require = createRequire(import.meta.url), guard = require('../runtime/program-guard.cjs'), core = require('../runtime/core.cjs');
const base = resolve(import.meta.dirname, '../../qa'), launcher = resolve(import.meta.dirname, '../build/launcher.exe');
const contract = JSON.parse(readFileSync(resolve(import.meta.dirname, '../data-contract.json')));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const native = process.platform === 'win32' && existsSync(launcher);
function fixture() {
  mkdirSync(base, { recursive: true }); const root = mkdtempSync(join(base, '覆盖更新 中文 '));
  mkdirSync(join(root, 'data/dsh'), { recursive: true });
  writeFileSync(join(root, 'data/portable-state.json'), JSON.stringify({ format: 1, release: '1.1.0', roots: [root] }));
  writeFileSync(join(root, 'data/dsh/.credentials.yaml'), 'version: 1\nrefs:\n  DEEPSEEK_API_KEY: fixture-only-not-a-real-key\n');
  writeFileSync(join(root, 'data/dsh/history.json'), '{"text":"历史聊天不能被更新改写"}');
  if (native) copyFileSync(launcher, join(root, 'DSH Portable.exe'));
  function payload(version = '1.2.0', id = contract.id) {
    const program = join(root, 'app', version + '-fixture'); mkdirSync(program, { recursive: true });
    const manifest = { format: 1, payloadLayout: 1, dataContract: id, legacyPortableReleases: contract.legacyPortableReleases, portableVersion: version, upstreamCommit: core.UPSTREAM };
    writeFileSync(join(program, 'portable.json'), JSON.stringify(manifest));
    writeFileSync(join(program, 'DSH Portable.exe'), 'fixture payload');
    const records = ['portable.json', 'DSH Portable.exe'].map(path => { const bytes = readFileSync(join(program, path)); return { path, bytes: bytes.length, sha256: sha(bytes) }; });
    writeFileSync(join(program, 'checksums.json'), JSON.stringify({ format: 1, files: records }));
    const pointer = { ...manifest, layout: 'versioned-1', launcherProtocol: 1, program: relative(root, program).replaceAll('\\', '/'), programManifestSha256: sha(readFileSync(join(program, 'checksums.json'))) };
    return { program, pointer, manifest, activate() { writeFileSync(join(root, 'portable.json'), JSON.stringify(pointer)); } };
  }
  function snapshot(folder = join(root, 'data')) {
    return readdirSync(folder, { withFileTypes: true }).sort((a,b) => a.name.localeCompare(b.name)).flatMap(entry => entry.isDirectory() ? snapshot(join(folder, entry.name)) : [[relative(root, join(folder, entry.name)).replaceAll('\\', '/'), sha(readFileSync(join(folder, entry.name)))]]);
  }
  return { root, payload, snapshot, close() { const part = relative(base, root); assert.ok(part && !part.startsWith('..') && !isAbsolute(part)); rmSync(root, { recursive: true, force: true }); } };
}
function probe(f) { return spawnSync(join(f.root, 'DSH Portable.exe'), ['--portable-probe'], { encoding: 'utf8', windowsHide: true }); }
test('compatible version replacement reads the same data without copying, backups or migration', () => {
  const f = fixture(); try {
    const first = f.payload(); first.activate(); const before = f.snapshot();
    assert.equal(guard.inspect(first.program).root, f.root);
    const second = f.payload('1.3.0'); second.activate();
    assert.equal(guard.inspect(second.program).root, f.root);
    assert.throws(() => guard.inspect(first.program), /尚未完整覆盖/);
    assert.deepEqual(f.snapshot(), before); assert.equal(existsSync(join(f.root, 'backups')), false);
  } finally { f.close(); }
});
test('native launcher admits compatible legacy data and leaves every data file byte-identical', { skip: !native }, () => {
  const f = fixture(); try {
    const p = f.payload(); p.activate(); const before = f.snapshot(), result = probe(f);
    assert.equal(result.status, 0, result.stderr); assert.equal(JSON.parse(result.stdout).dataUntouched, true);
    assert.deepEqual(f.snapshot(), before);
  } finally { f.close(); }
});

test('native entry forwards stdin, UTF-8 output, quoted arguments and the actual child exit status', { skip: !native }, () => {
  const f = fixture(); try {
    const p = f.payload(); p.activate(); copyFileSync(process.execPath, join(p.program, 'DSH Portable.exe'));
    const index = JSON.parse(readFileSync(join(p.program, 'checksums.json'))), bytes = readFileSync(join(p.program, 'DSH Portable.exe'));
    Object.assign(index.files.find(item => item.path === 'DSH Portable.exe'), { bytes: bytes.length, sha256: sha(bytes) });
    writeFileSync(join(p.program, 'checksums.json'), JSON.stringify(index)); p.pointer.programManifestSha256 = sha(readFileSync(join(p.program, 'checksums.json'))); p.activate();
    const argument = '空格 "引号" 和末尾反斜杠\\';
    const script = "console.log(JSON.stringify({argument:process.argv[1],input:require('node:fs').readFileSync(0,'utf8')}));console.error('stderr 中文');process.exitCode=23;";
    const result = spawnSync(join(f.root, 'DSH Portable.exe'), ['-e', script, '--', argument], { input: 'stdin 中文', encoding: 'utf8', windowsHide: true, timeout: 30000 });
    assert.equal(result.status, 23, result.stderr); assert.deepEqual(JSON.parse(result.stdout), { argument, input: 'stdin 中文' }); assert.match(result.stderr, /stderr 中文/);
  } finally { f.close(); }
});
for (const [name, damage] of [
  ['missing payload', f => unlinkSync(join(f.root, 'app/1.2.0-fixture/DSH Portable.exe'))],
  ['truncated payload', f => writeFileSync(join(f.root, 'app/1.2.0-fixture/DSH Portable.exe'), 'short')],
  ['corrupt inventory', f => writeFileSync(join(f.root, 'app/1.2.0-fixture/checksums.json'), '{')],
  ['interrupted pointer replacement', f => writeFileSync(join(f.root, 'portable.json'), '{')],
  ['unknown data format', f => writeFileSync(join(f.root, 'data/portable-state.json'), JSON.stringify({ format: 1, roots: [f.root], dataContract: 'unknown-future-format' }))],
  ['corrupt data format record', f => writeFileSync(join(f.root, 'data/portable-state.json'), '{')],
  ['boolean data format record', f => writeFileSync(join(f.root, 'data/portable-state.json'), JSON.stringify({ format: true, roots: [f.root], dataContract: contract.id }))],
  ['missing data format record', f => unlinkSync(join(f.root, 'data/portable-state.json'))],
]) {
  test('rejects ' + name + ' before creating caches or changing data', () => {
    const f = fixture(); try {
      const p = f.payload(); p.activate(); damage(f); const before = f.snapshot();
      assert.throws(() => core.prepare(p.program));
      if (native) { const result = probe(f); assert.equal(result.status, 1, result.stdout); }
      assert.deepEqual(f.snapshot(), before); assert.equal(existsSync(join(f.root, 'data/cache')), false); assert.equal(existsSync(join(f.root, 'backups')), false);
    } finally { f.close(); }
  });
}
test('rejects a data directory junction without writing its target', { skip: !native }, () => {
  const f = fixture(); try {
    const p = f.payload(); p.activate(); const outside = join(f.root, 'outside'); mkdirSync(outside); writeFileSync(join(outside, 'original'), 'unchanged');
    rmSync(join(f.root, 'data'), { recursive: true }); symlinkSync(outside, join(f.root, 'data'), 'junction');
    assert.throws(() => guard.inspect(p.program), /链接/); assert.equal(probe(f).status, 1);
    assert.deepEqual(readdirSync(outside), ['original']); assert.equal(readFileSync(join(outside, 'original'), 'utf8'), 'unchanged');
  } finally { f.close(); }
});
test('compatible program releases update only portable metadata while retaining credentials and history', () => {
  const f = fixture(); try {
    const p = f.payload(); p.activate(); const before = f.snapshot().filter(([name]) => name !== 'data/portable-state.json');
    const state = core.rememberLocation(core.directories(f.root), '1.2.0', p.manifest, p.program);
    assert.equal(state.dataContract, contract.id); assert.equal(state.release, '1.2.0');
    assert.deepEqual(f.snapshot().filter(([name]) => name !== 'data/portable-state.json'), before);
    const next = f.payload('1.3.0'); next.activate(); assert.equal(guard.inspect(next.program).root, f.root);
    const incompatible = f.payload('2.0.0', 'a-new-format'); incompatible.activate(); assert.throws(() => guard.inspect(incompatible.program), /不兼容/);
    assert.deepEqual(f.snapshot().filter(([name]) => name !== 'data/portable-state.json'), before);
  } finally { f.close(); }
});

const electron = resolve(import.meta.dirname, '../../packed-app/win-unpacked/DSH Portable.exe');
test('Electron admission hashes ASAR as a physical file before any data initialization', { skip: !existsSync(electron) }, () => {
  const f = fixture(); try {
    const p = f.payload(); p.activate();
    mkdirSync(join(p.program, 'resources')); const bytes = Buffer.from('opaque ASAR payload for checksum verification');
    writeFileSync(join(p.program, 'resources/app.asar'), bytes);
    const indexFile = join(p.program, 'checksums.json'), inventory = JSON.parse(readFileSync(indexFile));
    inventory.files.push({ path: 'resources/app.asar', bytes: bytes.length, sha256: sha(bytes) }); writeFileSync(indexFile, JSON.stringify(inventory));
    p.pointer.programManifestSha256 = sha(readFileSync(indexFile)); p.activate(); const before = f.snapshot();
    const code = "const g=require(process.argv[1]);g.inspect(process.argv[2]);console.log('ASAR_RAW_FILE_ADMISSION_PASSED');";
    const result = spawnSync(electron, ['-e', code, resolve(import.meta.dirname, '../runtime/program-guard.cjs'), f.root], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /ASAR_RAW_FILE_ADMISSION_PASSED/); assert.deepEqual(f.snapshot(), before);
  } finally { f.close(); }
});
