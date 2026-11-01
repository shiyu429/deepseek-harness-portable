'use strict';
/** Offline backup, data rollback and explicit workspace reconnection. */
const fs = require('node:fs');
const path = require('node:path');
const { createInterface } = require('node:readline/promises');
const core = require('./core.cjs');

const root = fs.realpathSync(process.argv[3] || require('./program-guard.cjs').inspect(path.resolve(__dirname, '..', '..')).root);
const manifestAt = directory => core.readJson(path.join(directory, 'app/portable.json')) ?? core.readJson(path.join(directory, 'portable.json'));
const selected = manifestAt(root);
const layout = require('./program-guard.cjs').inspect(selected.layout === 'versioned-1' ? path.resolve(root, selected.program) : root);
const dirs = core.directories(root);
const helper = path.join(layout.program, 'resources', 'portable', 'native-helper.exe');
const action = process.argv[2];
const input = createInterface({ input: process.stdin, output: process.stdout });
let lock;
const now = () => new Date().toISOString().replace(/[:.]/g, '-');
function safety(candidate, parent) {
  if (!core.inside(parent, candidate) || path.resolve(candidate) === path.resolve(parent)) throw new Error('路径必须位于指定的便携目录内。');
}
const rebuildableIndex = 'cache/pnpm-store/v11/projects';
function copyTree(source, destination, snapshot = false) {
  const projectIndex = path.join(source, rebuildableIndex);
  function copy(file, target, ancestors) {
    if (path.resolve(file) === path.resolve(projectIndex)) { fs.mkdirSync(target); return; }
    const actual = fs.realpathSync(file);
    if (!core.inside(root, actual)) throw new Error('备份发现了指向便携目录外的链接，已停止：' + file);
    const info = fs.statSync(actual);
    if (info.isDirectory()) {
      const identity = actual.toLowerCase();
      if (ancestors.has(identity)) throw new Error('备份发现了循环目录链接，已停止：' + file);
      fs.mkdirSync(target);
      const next = new Set(ancestors); next.add(identity);
      for (const name of fs.readdirSync(actual)) copy(path.join(actual, name), path.join(target, name), next);
    } else if (info.isFile()) {
      fs.copyFileSync(actual, target, fs.constants.COPYFILE_EXCL);
      const descriptor = fs.openSync(target, 'r+');
      try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
    } else throw new Error('备份遇到不支持的文件对象：' + file);
  }
  const ancestors = new Set([fs.realpathSync(source).toLowerCase()]);
  for (const name of fs.readdirSync(source)) if (name !== '.running.lock' && (!snapshot || name !== 'backup.json')) copy(path.join(source, name), path.join(destination, name), ancestors);
}
function backup() {
  if (fs.existsSync(path.join(dirs.data, 'backup.json'))) throw new Error('data 根目录的 backup.json 与备份保留名称冲突。请先移到工作文件夹，未开始备份。');
  const backupRoot = path.join(root, 'backups');
  fs.mkdirSync(backupRoot, { recursive: true });
  const destination = path.join(backupRoot, now());
  safety(destination, backupRoot);
  fs.mkdirSync(destination);
  copyTree(dirs.data, destination);
  core.atomicJson(path.join(destination, 'backup.json'), { format: 1, completed: true, release: manifestAt(root).portableVersion, createdAt: new Date().toISOString(), omittedRebuildable: [rebuildableIndex] });
  return destination;
}
function baseResolve(reference) {
  if (reference.startsWith('dsh-portable:/')) {
    const result = path.resolve(root, decodeURIComponent(reference.slice('dsh-portable:/'.length)));
    if (!core.inside(root, result)) throw new Error('工作区位置记录越过便携目录。');
    return result;
  }
  const state = core.readJson(path.join(dirs.data, 'portable-state.json'));
  for (const previous of state?.roots || []) if (core.inside(previous, reference)) return path.resolve(root, path.relative(previous, reference));
  return reference;
}
async function reconnect() {
  const recordsDirectory = path.join(dirs.data, 'workspace-identities');
  if (!fs.existsSync(recordsDirectory)) throw new Error('尚未记录工作区。请先在 DSH 中添加工作文件夹。');
  const records = fs.readdirSync(recordsDirectory).filter(name => /^[a-f0-9]{64}\.json$/.test(name)).map(name => {
    const filename = path.join(recordsDirectory, name), value = core.readJson(filename);
    return { filename, value, original: value.originalPath || value.path, location: baseResolve(value.location || value.path) };
  });
  records.forEach((record, index) => console.log(`${index + 1}. ${record.original}\n   当前：${record.location}`));
  const number = Number(process.argv[4] || await input.question('输入要重新定位的工作区编号，直接回车取消：'));
  if (!Number.isSafeInteger(number) || number < 1 || number > records.length) return;
  const record = records[number - 1];
  const picked = process.argv[5] ? { path: process.argv[5] } : core.native(helper, ['choose-folder']);
  if (picked.cancelled) return;
  const selected = fs.realpathSync(picked.path);
  const originalLocation = baseResolve(record.original);
  if (selected.toLowerCase() !== originalLocation.toLowerCase() && (core.inside(selected, originalLocation) || core.inside(originalLocation, selected))) throw new Error('新旧位置不能互相包含。请选择独立的工作文件夹。');
  if (records.some(other => other !== record && path.resolve(other.location).toLowerCase() === selected.toLowerCase())) throw new Error('该目录已属于另一个工作区。请选择尚未添加的目录。');
  const directoryIdentity = core.native(helper, ['identity', selected]);
  const identity = directoryIdentity.identity;
  const saved = backup();
  const location = core.inside(root, selected) ? 'dsh-portable:/' + path.relative(root, selected).split(path.sep).map(encodeURIComponent).join('/') : selected;
  core.atomicJson(record.filename, { format: 1, originalPath: record.original, location, ...(core.inside(root, selected) ? {} : { identity, machine: directoryIdentity.machine }) });
  console.log('工作区已重新定位。历史聊天和命令文字保持原样。\n原数据备份：' + saved);
}
async function restore() {
  if (fs.existsSync(path.join(dirs.data, 'backup.json'))) throw new Error('data 根目录的 backup.json 与备份保留名称冲突。请先移到工作文件夹，未开始恢复。');
  const backupRoot = path.join(root, 'backups');
  const names = fs.existsSync(backupRoot) ? fs.readdirSync(backupRoot).filter(name => fs.statSync(path.join(backupRoot, name)).isDirectory()).sort().reverse() : [];
  const snapshots = names.filter(name => core.readJson(path.join(backupRoot, name, 'backup.json'))?.completed === true);
  if (!snapshots.length) throw new Error('没有完整的数据备份。');
  snapshots.forEach((name, index) => console.log(`${index + 1}. ${name}`));
  const number = Number(await input.question('选择要恢复的备份编号，直接回车取消：'));
  if (!Number.isSafeInteger(number) || number < 1 || number > snapshots.length) return;
  const selected = path.join(backupRoot, snapshots[number - 1]);
  const metadata = core.readJson(path.join(selected, 'backup.json'));
  const manifest = manifestAt(root);
  if (metadata.release !== manifest.portableVersion) throw new Error('备份与当前程序版本不一致。请先使用与备份配套的程序版本。');
  const staged = path.join(root, '.restore-' + now());
  safety(staged, root); fs.mkdirSync(staged);
  copyTree(selected, staged, true);
  const previous = path.join(backupRoot, 'before-restore-' + now());
  fs.mkdirSync(previous);
  const marker = path.join(root, '.maintenance-transaction.json');
  const transaction = { format: 1, kind: 'restore', phase: 'moving-original', staged, previous };
  core.atomicJson(marker, transaction);
  // Keep the live lock inode in data so no application can enter during replacement.
  for (const name of fs.readdirSync(dirs.data)) if (name !== '.running.lock') fs.renameSync(path.join(dirs.data, name), path.join(previous, name));
  core.atomicJson(path.join(previous, 'backup.json'), { format: 1, completed: true, release: manifest.portableVersion, createdAt: new Date().toISOString() });
  transaction.phase = 'installing'; core.atomicJson(marker, transaction);
  try {
    for (const name of fs.readdirSync(staged)) fs.renameSync(path.join(staged, name), path.join(dirs.data, name));
    fs.rmSync(path.join(dirs.data, '.portable-acl-v1.json'), { force: true });
    fs.rmSync(path.join(dirs.data, '.portable-acl-v2.json'), { force: true });
  } catch (error) {
    console.error('恢复中断。保留了原数据和待恢复数据，请勿删除：\n' + previous + '\n' + staged);
    throw error;
  }
  fs.rmdirSync(staged);
  fs.unlinkSync(marker);
  console.log('数据已恢复。恢复前的数据保留在：' + previous);
}

function undoInterruptedRestore() {
  const marker = path.join(root, '.maintenance-transaction.json');
  const transaction = core.readJson(marker);
  if (!transaction) return false;
  if (transaction.format !== 1 || transaction.kind !== 'restore') throw new Error('上次是迁移到新版时中断，请保留原版本的数据，重新解压新的空程序目录后再迁移。');
  safety(transaction.previous, path.join(root, 'backups')); safety(transaction.staged, root);
  if (transaction.phase === 'installing') {
    const partial = path.join(root, 'backups', 'interrupted-restore-' + now()); fs.mkdirSync(partial);
    for (const name of fs.readdirSync(dirs.data)) if (name !== '.running.lock') fs.renameSync(path.join(dirs.data, name), path.join(partial, name));
  } else if (transaction.phase !== 'moving-original') throw new Error('维护恢复记录状态无效，未修改数据。');
  for (const name of fs.readdirSync(transaction.previous)) if (name !== 'backup.json') {
    if (fs.existsSync(path.join(dirs.data, name))) throw new Error('数据恢复遇到同名文件，未覆盖。请保留维护恢复记录。');
    fs.renameSync(path.join(transaction.previous, name), path.join(dirs.data, name));
  }
  fs.unlinkSync(marker);
  console.log('已撤回中断的恢复操作，原数据重新可用。尚未使用的备份和暂存目录仍保留。');
  return true;
}

async function upgrade() {
  const picked = process.argv[4] ? { path: process.argv[4] } : core.native(helper, ['choose-folder']);
  if (picked.cancelled) return;
  const target = fs.realpathSync(picked.path);
  if (core.inside(root, target) || core.inside(target, root)) throw new Error('请把新版程序解压到与当前目录分开的独立文件夹。');
  const current = manifestAt(root);
  const next = manifestAt(target);
  if (current.layout === 'versioned-1' || next?.layout === 'versioned-1') throw new Error('本版使用覆盖更新，不需要复制或迁移 data。请退出程序后，把兼容的覆盖更新包解压到原目录。');
  if (!next || next.format !== 1 || next.dataFormat !== current.dataFormat) throw new Error('目标不是兼容的 DSH 便携包。');
  const version = value => { if (!/^\d+\.\d+\.\d+$/.test(value)) throw new Error('便携版本号无效。'); return value.split('.').map(Number); };
  const a = version(current.portableVersion), b = version(next.portableVersion);
  const first = a.findIndex((number, index) => number !== b[index]);
  if (first >= 0 && a[first] > b[first]) throw new Error('不能把新版数据交给旧程序。请使用旧版本自己的完整备份恢复。');
  const targetDirs = core.directories(target);
  fs.mkdirSync(targetDirs.data, { recursive: true });
  const targetHelper = path.join(target, 'resources', 'portable', 'native-helper.exe');
  const targetLock = await core.acquireRunLock(targetDirs, targetHelper);
  try {
    if (fs.readdirSync(targetDirs.data).some(name => name !== '.running.lock')) throw new Error('目标 data 目录已经有数据。请重新解压一个尚未启动的完整便携包。');
    const saved = backup();
    const marker = path.join(target, '.maintenance-transaction.json');
    core.atomicJson(marker, { format: 1, kind: 'upgrade', source: root, backup: saved });
    copyTree(dirs.data, targetDirs.data);
    fs.rmSync(path.join(targetDirs.data, '.portable-acl-v1.json'), { force: true });
    fs.rmSync(path.join(targetDirs.data, '.portable-acl-v2.json'), { force: true });
    const state = core.readJson(path.join(targetDirs.data, 'portable-state.json'));
    if (state) { state.release = next.portableVersion; core.atomicJson(path.join(targetDirs.data, 'portable-state.json'), state); }
    fs.unlinkSync(marker);
    console.log('数据已迁移到新版目录：' + target + '\n当前版本和原始备份仍保留：' + saved);
  } finally { await targetLock.release(); }
}

void (async () => {
  try {
    fs.mkdirSync(dirs.data, { recursive: true });
    lock = await core.acquireRunLock(dirs, helper);
    if (action === 'restore' && undoInterruptedRestore()) return;
    if (fs.existsSync(path.join(root, '.maintenance-transaction.json'))) throw new Error('上次维护中断，请先运行“恢复备份”。');
    if (action === 'backup') console.log('应用数据备份已保存：' + backup() + '\n已省略可重建的 pnpm 项目索引；聊天、设置、插件和工作文件已保留。');
    else if (action === 'restore') await restore();
    else if (action === 'reconnect') await reconnect();
    else if (action === 'upgrade') await upgrade();
    else throw new Error('未知维护操作。');
  } catch (error) { console.error('操作未完成：' + error.message); process.exitCode = 1; }
  finally {
    if (lock) await lock.release().catch(error => { console.error(error.message); process.exitCode = 2; });
    await input.question('按回车关闭。').catch(() => {});
    input.close();
  }
})();
