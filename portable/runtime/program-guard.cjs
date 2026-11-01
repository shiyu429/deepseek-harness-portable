'use strict';
/** Read-only admission checks. Rejected or incomplete updates never initialize application data. */
const fs = process.versions.electron ? require('original-fs') : require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
function json(file) { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }
function noLinks(file, root, checked = new Set()) {
  let current = file;
  while (true) {
    if (checked.has(current)) break;
    if (fs.lstatSync(current).isSymbolicLink()) throw new Error('程序或数据路径不能经过目录链接。');
    checked.add(current);
    if (current === root) break;
    const parent = path.dirname(current);
    if (parent === current) throw new Error('程序路径超出便携目录。');
    current = parent;
  }
}
function safe(root, name) {
  if (typeof name !== 'string' || !name || name.includes('\\') || name.includes(':') || name.split('/').some(p => !p || p === '.' || p === '..' || /[. ]$/.test(p))) throw new Error('程序校验路径无效。');
  const file = path.resolve(root, name);
  if (!file.startsWith(root + path.sep)) throw new Error('程序校验路径越界。');
  return file;
}
function hash(file) {
  const digest = crypto.createHash('sha256'), fd = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let size;
    while ((size = fs.readSync(fd, buffer)) > 0) digest.update(buffer.subarray(0, size));
  } finally { fs.closeSync(fd); }
  return digest.digest('hex');
}
function assertData(root, manifest) {
  const data = path.join(root, 'data'), stateFile = path.join(data, 'portable-state.json');
  if (fs.existsSync(path.join(root, '.maintenance-transaction.json'))) throw new Error('尚有未完成的数据维护，已停止启动；原数据未转换。');
  if (!fs.existsSync(data)) return;
  noLinks(data, root);
  if (!fs.existsSync(stateFile)) {
    if (fs.readdirSync(data).length) throw new Error('现有 data 缺少格式记录，已停止启动；不会初始化或覆盖原数据。');
    return;
  }
  noLinks(stateFile, root);
  const state = json(stateFile);
  if (state.format !== 1 || !Array.isArray(state.roots) || state.roots.some(value => typeof value !== 'string')) throw new Error('数据格式记录损坏，已停止启动。');
  if (state.programRoots !== undefined && (!Array.isArray(state.programRoots) || state.programRoots.some(value => typeof value !== 'string'))) throw new Error('程序路径记录损坏，已停止启动。');
  const contract = state.dataContract ?? (manifest.legacyPortableReleases?.includes(state.release) ? manifest.dataContract : undefined);
  if (typeof manifest.dataContract !== 'string' || contract !== manifest.dataContract) throw new Error('此更新与现有数据格式不兼容，已停止启动；原数据未修改。请使用兼容的数据格式版本。');
}
function inspect(program) {
  program = path.resolve(program);
  const nestedPointer = path.join(program, 'app', 'portable.json');
  if (fs.existsSync(nestedPointer)) {
    const pointer = json(nestedPointer);
    if (pointer.layout !== 'versioned-1' || !/^app\/[A-Za-z0-9._-]+$/.test(pointer.program)) throw new Error('程序目录标识无效。');
    return inspect(safe(program, pointer.program));
  }
  if (!fs.existsSync(path.join(program, 'portable.json'))) throw new Error('便携包标识缺失，请重新覆盖完整程序包；不要删除 data。');
  const manifest = json(path.join(program, 'portable.json'));
  if (manifest.layout !== undefined) {
    if (manifest.layout !== 'versioned-1' || !/^app\/[A-Za-z0-9._-]+$/.test(manifest.program)) throw new Error('程序目录标识无效。');
    return inspect(safe(program, manifest.program));
  }
  if (!manifest.payloadLayout) return { root: program, program, manifest, versioned: false };
  if (manifest.payloadLayout !== 1) throw new Error('不支持此程序目录格式。');
  const root = path.resolve(program, '..', '..');
  if (fs.existsSync(path.join(root, 'app', '.update.pending.json'))) throw new Error('程序更新尚未完成，请打开 DSH 维护工具完成更新；data 保持原位。');
  noLinks(program, root);
  const pointerFile = fs.existsSync(path.join(root, 'app', 'portable.json')) ? path.join(root, 'app', 'portable.json') : path.join(root, 'portable.json'); noLinks(pointerFile, root);
  const pointer = json(pointerFile);
  if (pointer.layout !== 'versioned-1' || pointer.launcherProtocol !== 1 || !/^app\/[A-Za-z0-9._-]+$/.test(pointer.program) || safe(root, pointer.program) !== program
      || pointer.portableVersion !== manifest.portableVersion || pointer.dataContract !== manifest.dataContract) throw new Error('程序更新尚未完整覆盖，已停止启动；请重新覆盖完整更新包。');
  const inventoryFile = path.join(program, 'checksums.json'); noLinks(inventoryFile, root);
  if (!/^[a-f0-9]{64}$/.test(pointer.programManifestSha256) || hash(inventoryFile) !== pointer.programManifestSha256) throw new Error('更新清单不完整，已停止启动；请重新覆盖完整更新包。');
  const inventory = json(inventoryFile);
  if (inventory.format !== 1 || !Array.isArray(inventory.files) || inventory.files.length === 0) throw new Error('程序校验清单无效。');
  const seen = new Set();
  const checked = new Set();
  for (const item of inventory.files) {
    const file = safe(program, item.path), key = file.toLowerCase();
    if (seen.has(key) || !Number.isSafeInteger(item.bytes) || item.bytes < 0 || !/^[a-f0-9]{64}$/.test(item.sha256)) throw new Error('程序校验条目无效。');
    seen.add(key); noLinks(file, root, checked);
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size !== item.bytes || hash(file) !== item.sha256) throw new Error('程序更新不完整或文件损坏：' + item.path + '。请重新覆盖完整更新包；不要删除 data。');
  }
  if (!seen.has(path.join(program, 'portable.json').toLowerCase()) || !seen.has(path.join(program, 'DSH Portable.exe').toLowerCase())) throw new Error('程序校验清单缺少启动文件。');
  assertData(root, manifest);
  return { root, program, manifest, versioned: true };
}
module.exports = { inspect, assertData, hash };
