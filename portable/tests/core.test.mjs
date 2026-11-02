import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { resolve, join, relative, isAbsolute } from 'node:path';

const require = createRequire(import.meta.url);
const core = require('../runtime/core.cjs');
const nativeFs = require('node:fs');
const fixtures = resolve(import.meta.dirname, '../../qa');
mkdirSync(fixtures, { recursive: true });
function fixture() {
  const root = mkdtempSync(join(fixtures, 'core-'));
  return { root, close() { const rest = relative(fixtures, root); assert.ok(rest && !rest.startsWith('..') && !isAbsolute(rest)); rmSync(root, { recursive: true, force: true }); } };
}
function fakePackage(root) {
  writeFileSync(join(root, 'portable.json'), JSON.stringify({ format: 1, upstreamCommit: core.UPSTREAM, portableVersion: '1.0.0' }));
  for (const file of ['resources/portable/native-helper.exe', 'resources/runtime/primary-runtime/dependencies/node/bin/node.exe', 'resources/runtime/primary-runtime/dependencies/python/python.exe', 'resources/runtime/powershell/pwsh.exe', 'resources/runtime/msvc/msvcp140.dll', 'resources/runtime/msvc/vcruntime140.dll']) {
    mkdirSync(resolve(root, file, '..'), { recursive: true }); writeFileSync(resolve(root, file), 'test fixture');
  }
}

test('portable environment does not mutate its caller and confines runtime caches to the package', () => {
  const f = fixture();
  try {
    fakePackage(f.root);
    const inherited = { PATH: 'C:\\unrelated-runtime', SystemRoot: 'C:\\Windows', USERPROFILE: 'C:\\original-user', NODE_OPTIONS: '--inspect' };
    const before = structuredClone(inherited);
    const result = core.prepare(f.root, inherited);
    assert.deepEqual(inherited, before);
    assert.equal(result.environment.NODE_OPTIONS, undefined);
    assert.equal(result.environment.DSH_PORTABLE_ACCOUNT_ACCESS, undefined);
    assert.equal(result.environment.DSH_PERMISSION_MODE, 'workspace-write');
    assert.ok(!result.environment.PATH.includes('unrelated-runtime'));
    for (const name of ['USERPROFILE', 'DSH_HOME', 'DSH_AGENTS_HOME', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'PIP_CACHE_DIR', 'NUGET_PACKAGES']) assert.ok(core.inside(f.root, result.environment[name]), name);
    assert.equal(result.environment.npm_config_store_dir,undefined);
    assert.ok(result.environment.PATH.includes('C:\\Windows'));
  } finally { f.close(); }
});

test('private runtime directory junctions are refused before writing host configuration or caches', { skip: process.platform !== 'win32' }, () => {
  for (const part of ['home', 'cache', 'home/.config', 'dsh/profiles']) {
    const f = fixture(), outside = fixture();
    try {
      fakePackage(f.root); writeFileSync(join(outside.root, 'original.txt'), 'host remains unchanged');
      const redirected = join(f.root, 'data', part); mkdirSync(resolve(redirected, '..'), { recursive: true });
      nativeFs.symlinkSync(outside.root, redirected, 'junction');
      assert.throws(() => core.prepare(f.root), /不能使用文件链接/);
      assert.deepEqual(nativeFs.readdirSync(outside.root), ['original.txt']);
      assert.equal(readFileSync(join(outside.root, 'original.txt'), 'utf8'), 'host remains unchanged');
      assert.equal(nativeFs.existsSync(join(f.root, 'data/temp')), false);
    } finally { f.close(); outside.close(); }
  }
});

test('first-start preparation remains retryable before the helper or data lock starts', () => {
  const f = fixture();
  try {
    fakePackage(f.root);
    const filename = join(f.root, 'portable.json');
    const manifest = { ...JSON.parse(readFileSync(filename, 'utf8')), dataContract: 'fixture-v1' };
    writeFileSync(filename, JSON.stringify(manifest));
    core.prepare(f.root);
    const stateFile = join(f.root, 'data/portable-state.json');
    const first = readFileSync(stateFile, 'utf8');
    assert.equal(JSON.parse(first).dataContract, 'fixture-v1');
    // The first attempt can stop here, before rememberLocation or any helper.
    core.prepare(f.root);
    assert.equal(readFileSync(stateFile, 'utf8'), first);
    writeFileSync(join(f.root, 'data/dsh/user.txt'), 'preserve existing data');
    core.prepare(f.root);
    assert.equal(readFileSync(join(f.root, 'data/dsh/user.txt'), 'utf8'), 'preserve existing data');
  } finally { f.close(); }
});

test('location history persists across directory moves and refuses a mismatched data release', () => {
  const f = fixture();
  try {
    const dirs = core.directories(f.root);
    mkdirSync(dirs.data);
    core.rememberLocation(dirs, '1.0.0');
    assert.deepEqual(core.readJson(join(dirs.data, 'portable-state.json')).roots, [f.root]);
    assert.throws(() => core.rememberLocation(dirs, '2.0.0'), /版本不一致/);
    assert.equal(core.readJson(join(dirs.data, 'portable-state.json')).release, '1.0.0');
  } finally { f.close(); }
});

test('portable profile paths are late-bound and user edits are retained', () => {
  const f = fixture();
  try {
    const dirs = core.directories(f.root);
    mkdirSync(dirs.dsh, { recursive: true });
    core.writeDefaultPatch(dirs);
    const filename = join(dirs.dsh, 'cordis.patch.yml');
    const patch = readFileSync(filename, 'utf8');
    assert.ok(patch.includes('!!js process.env.DSH_PORTABLE_PWSH'));
    assert.ok(!patch.includes(f.root));
    assert.ok(!patch.includes('credentials'));
    assert.ok(!patch.includes('id: permission'));
    assert.ok(!patch.includes('portablePersistentRoot'));
    assert.ok(!patch.includes('portableAclJournalDir'));
    writeFileSync(filename, '# user patch\n');
    core.writeDefaultPatch(dirs);
    assert.equal(readFileSync(filename, 'utf8'), '# user patch\n');
  } finally { f.close(); }
});

test('FAT account mode is labelled and its managed config is removed on NTFS without losing user rows', () => {
  const f = fixture(), previous = process.env.DSH_PORTABLE_FILESYSTEM;
  try {
    const dirs = core.directories(f.root); mkdirSync(dirs.dsh, { recursive: true });
    const filename = join(dirs.dsh, 'cordis.patch.yml');
    writeFileSync(filename, '# user patch\n- id: my-plugin\n  config: {}\n');
    process.env.DSH_PORTABLE_FILESYSTEM = 'FAT32'; core.writeDefaultPatch(dirs);
    const fat = readFileSync(filename, 'utf8');
    assert.match(fat, /当前账户权限（FAT32\/exFAT）/);
    assert.match(fat, /portableAccountAccess: true/);
    assert.match(fat, /sandbox: danger-full-access/);
    core.writeDefaultPatch(dirs); assert.equal(readFileSync(filename,'utf8'), fat);
    process.env.DSH_PORTABLE_FILESYSTEM = 'NTFS'; core.writeDefaultPatch(dirs);
    assert.equal(readFileSync(filename,'utf8'), '# user patch\n- id: my-plugin\n  config: {}\n');
  } finally {
    if (previous === undefined) delete process.env.DSH_PORTABLE_FILESYSTEM; else process.env.DSH_PORTABLE_FILESYSTEM = previous;
    f.close();
  }
});

test('an unchanged generated 1.1 profile adopts official modes without replacing user edits', () => {
  const f = fixture();
  try {
    const dirs = core.directories(f.root); mkdirSync(dirs.dsh, { recursive: true });
    const file = join(dirs.dsh, 'cordis.patch.yml');
    writeFileSync(file, readFileSync(new URL('./fixtures/legacy-1.1.0.yml', import.meta.url)));
    core.writeDefaultPatch(dirs);
    assert.ok(!readFileSync(file, 'utf8').includes('当前账户权限'));
    assert.ok(!readFileSync(file, 'utf8').includes('portableWorkspaceRoot'));
    writeFileSync(file, '# custom settings\n'); core.writeDefaultPatch(dirs);
    assert.equal(readFileSync(file, 'utf8'), '# custom settings\n');
  } finally { f.close(); }
});

test('missing runtime files and corrupt portable state stop startup', () => {
  const f = fixture();
  try {
    assert.throws(() => core.prepare(f.root), /便携包标识/);
    fakePackage(f.root);
    const { dirs } = core.prepare(f.root);
    writeFileSync(join(dirs.data, 'portable-state.json'), '{broken');
    assert.throws(() => core.rememberLocation(dirs, '1.0.0'));
  } finally { f.close(); }
});

test('a failed flush or replacement keeps the previously committed portable state', () => {
  const f = fixture();
  const fsync = nativeFs.fsyncSync, rename = nativeFs.renameSync;
  try {
    const filename = join(f.root, 'saved.json');
    core.atomicJson(filename, { saved: 1 });
    nativeFs.fsyncSync = () => { throw Object.assign(new Error('simulated disk-full flush'), { code: 'ENOSPC' }); };
    assert.throws(() => core.atomicJson(filename, { saved: 2 }), /disk-full/);
    assert.deepEqual(core.readJson(filename), { saved: 1 });
    nativeFs.fsyncSync = fsync;
    nativeFs.renameSync = () => { throw Object.assign(new Error('simulated file in use'), { code: 'EBUSY' }); };
    assert.throws(() => core.atomicJson(filename, { saved: 3 }), /file in use/);
    assert.deepEqual(core.readJson(filename), { saved: 1 });
  } finally { nativeFs.fsyncSync = fsync; nativeFs.renameSync = rename; f.close(); }
});

test('moving a package repairs generated dependency paths without changing scripts or conversation text', () => {
  const f = fixture();
  try {
    const dirs = core.directories(f.root);
    const profile = join(dirs.dsh, 'profiles', 'default');
    mkdirSync(join(profile, 'node_modules'), { recursive: true });
    const before = 'E:\\旧目录 (测试)\\DSH Portable';
    const dependency = 'file:' + before.replaceAll('\\', '/') + '/resources/pkg.tgz';
    const manifest = { dependencies: { plugin: dependency, other: 'file:' + before + '-other\\plugin' }, scripts: { test: 'echo ' + before }, description: before };
    writeFileSync(join(profile, 'package.json'), JSON.stringify(manifest));
    writeFileSync(join(profile, 'node_modules', '.pnpm-workspace-state-v1.json'), JSON.stringify({ storeDir: before + '\\data\\cache\\pnpm-store' }));
    const history = before + '\\original-file.txt';
    writeFileSync(join(profile, 'conversation.json'), JSON.stringify({ text: history }));
    assert.equal(core.repairProfileMetadata(dirs, [before, f.root]), 2);
    const repaired = core.readJson(join(profile, 'package.json'));
    assert.equal(repaired.dependencies.plugin, 'file:' + f.root.replaceAll('\\', '/') + '/resources/pkg.tgz');
    assert.equal(repaired.dependencies.other, manifest.dependencies.other);
    assert.equal(repaired.scripts.test, manifest.scripts.test);
    assert.equal(repaired.description, before);
    assert.equal(core.readJson(join(profile, 'node_modules', '.pnpm-workspace-state-v1.json')).storeDir, f.root + '\\data\\cache\\pnpm-store');
    assert.equal(core.readJson(join(profile, 'conversation.json')).text, history);
    assert.equal(core.repairProfileMetadata(dirs, [before, f.root]), 0);
  } finally { f.close(); }
});
