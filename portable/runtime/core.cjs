'use strict';
/** Paths and durable state shared by the desktop and command launchers. */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync, spawn } = require('node:child_process');
const programGuard = require('./program-guard.cjs');

const UPSTREAM = 'b830ec950faba0a46dda564be3e2d854afed94f1';

function inside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}

function atomicJson(filename, value) {
  const temp = filename + '.' + crypto.randomUUID() + '.tmp';
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  let descriptor;
  try {
    descriptor = fs.openSync(temp, 'wx', 0o600);
    fs.writeFileSync(descriptor, JSON.stringify(value, null, 2) + '\n', 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temp, filename);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    fs.rmSync(temp, { force: true });
  }
}

function readJson(filename) {
  try { return JSON.parse(fs.readFileSync(filename, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
}

function native(helper, args) {
  const result = spawnSync(helper, args, { encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
  if (result.error) throw result.error;
  let report;
  try { report = JSON.parse(result.stdout.replace(/^\uFEFF/, '').trim()); }
  catch (_error) { throw new Error('Windows helper returned no valid report. ' + (result.stderr || '').slice(-1200)); }
  if (result.status !== 0 || report.ok !== true) {
    const failure = new Error(report.message || 'Windows file operation failed.');
    failure.code = report.code || 'PORTABLE_NATIVE_FAILED';
    failure.report = report;
    throw failure;
  }
  return report;
}

function directories(root) {
  const data = path.join(root, 'data');
  return {
    root, data,
    dsh: path.join(data, 'dsh'),
    agents: path.join(data, 'agents'),
    home: path.join(data, 'home'),
    roaming: path.join(data, 'home', 'AppData', 'Roaming'),
    local: path.join(data, 'home', 'AppData', 'Local'),
    userData: path.join(data, 'desktop'),
    sessionData: path.join(data, 'browser'),
    cache: path.join(data, 'cache'),
    logs: path.join(data, 'logs'),
    temp: path.join(data, 'temp'),
    crashes: path.join(data, 'crashes'),
    workspaces: path.join(data, 'workspaces'),
    downloads: path.join(data, 'downloads'),
    bin: path.join(data, 'bin'),
  };
}

function prepare(root, inherited = process.env) {
  const layout = programGuard.inspect(fs.realpathSync(root));
  root = layout.root;
  const programRoot = layout.program;
  const manifest = layout.manifest;
  if (!manifest || manifest.format !== 1 || manifest.upstreamCommit !== UPSTREAM) {
    throw new Error('便携包标识无效。请重新解压完整便携包；不要单独复制 EXE。');
  }
  if (manifest.dataContract && !layout.versioned) programGuard.assertData(root, manifest);
  if (fs.existsSync(path.join(root, '.maintenance-transaction.json'))) throw new Error('上次数据维护中断。请先运行“恢复备份”工具处理，保留所有 data、backups 和 .restore 目录。');
  const dirs = directories(root);
  // Private runtime locations must not redirect caches or user configuration onto the host.
  const privatePaths = [...Object.values(dirs), ...[
    'home/.config', 'home/.local/share', 'home/.npmrc', 'home/.npmrc-global', 'home/pip.ini',
    'home/.dotnet', 'dsh/profiles', 'dsh/sessions', 'dsh/cache', 'workspace-identities',
    'cache/npm', 'cache/pnpm', 'cache/pnpm-store', 'cache/pnpm-state', 'cache/pip', 'cache/nuget',
    'npm-global', 'pnpm-global', 'pnpm-bin', 'python', 'python/site-packages',
  ].map(part => path.join(dirs.data, part))];
  for (const target of privatePaths) {
    let current = target;
    while (inside(root, current)) {
      try { if (fs.lstatSync(current).isSymbolicLink()) throw new Error('便携运行目录或配置不能使用文件链接，请保留 data 并检查此位置：' + current); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (current === root) break;
      current = path.dirname(current);
    }
  }
  const helper = path.join(programRoot, 'resources', 'portable', 'native-helper.exe');
  const primary = path.join(programRoot, 'resources', 'runtime', 'primary-runtime', 'dependencies');
  const node = path.join(primary, 'node', 'bin', 'node.exe');
  const python = path.join(primary, 'python', 'python.exe');
  const pwsh = path.join(programRoot, 'resources', 'runtime', 'powershell', 'pwsh.exe');
  const msvc = path.join(programRoot, 'resources', 'runtime', 'msvc');
  for (const executable of [helper, node, python, pwsh, path.join(msvc, 'msvcp140.dll'), path.join(msvc, 'vcruntime140.dll')]) {
    if (!fs.statSync(executable).isFile()) throw new Error('便携包缺少运行文件：' + path.basename(executable));
  }
  // Admission has already verified that unmarked data is empty. Commit its
  // format before creating runtime folders: a later helper/lock failure must
  // leave an initialized package that can be retried, not an unrecognized data tree.
  if (manifest.dataContract && !fs.existsSync(path.join(dirs.data, 'portable-state.json'))) {
    atomicJson(path.join(dirs.data, 'portable-state.json'), {
      format: 1, roots: [], release: manifest.portableVersion, dataContract: manifest.dataContract,
    });
  }
  for (const folder of Object.values(dirs)) fs.mkdirSync(folder, { recursive: true });
  const systemRoot = inherited.SystemRoot || inherited.SYSTEMROOT || 'C:\\Windows';
  const systemPath = [path.join(systemRoot, 'System32'), systemRoot, path.join(systemRoot, 'System32', 'Wbem'), path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0')];
  const hostPath = (inherited.PATH || inherited.Path || '').split(';').map(item=>item.trim().replace(/^"|"$/g,'')).filter(item=>/^[a-z]:[\\/]/i.test(item) && fs.existsSync(item));
  const environment = {
    ...inherited,
    HOME: dirs.home,
    USERPROFILE: dirs.home,
    HOMEDRIVE: path.parse(dirs.home).root.slice(0, 2),
    HOMEPATH: dirs.home.slice(2),
    APPDATA: dirs.roaming,
    LOCALAPPDATA: dirs.local,
    TEMP: dirs.temp, TMP: dirs.temp,
    DSH_HOME: dirs.dsh,
    DSH_AGENTS_HOME: dirs.agents,
    DSH_PORTABLE_ROOT: root,
    HARNESS_PORTABLE_RUNTIME: programRoot,
    DSH_PORTABLE_PROGRAM_ROOT: programRoot,
    DSH_PORTABLE_NATIVE_HELPER: helper,
    DSH_PORTABLE_PWSH: pwsh,
    DSH_PORTABLE_WORKSPACES: dirs.workspaces,
    DSH_PERMISSION_MODE: 'workspace-write',
    DSH_DESKTOP_USER_DATA_DIR: dirs.userData,
    XDG_CACHE_HOME: dirs.cache,
    XDG_CONFIG_HOME: path.join(dirs.home, '.config'),
    XDG_DATA_HOME: path.join(dirs.home, '.local', 'share'),
    npm_config_cache: path.join(dirs.cache, 'npm'),
    npm_config_userconfig: path.join(dirs.home, '.npmrc'),
    npm_config_globalconfig: path.join(dirs.home, '.npmrc-global'),
    npm_config_prefix: path.join(dirs.data, 'npm-global'),
    pnpm_config_config_dir: path.join(dirs.home, '.config', 'pnpm'),
    pnpm_config_global_dir: path.join(dirs.data, 'pnpm-global'),
    pnpm_config_manage_package_manager_versions: 'false',
    PNPM_HOME: path.join(dirs.data, 'pnpm-bin'),
    PIP_CACHE_DIR: path.join(dirs.cache, 'pip'),
    PIP_CONFIG_FILE: path.join(dirs.home, 'pip.ini'),
    PIP_TARGET: path.join(dirs.data, 'python', 'site-packages'),
    PIP_DEFAULT_TIMEOUT: '60',
    PYTHONNOUSERSITE: '1',
    PYTHONDONTWRITEBYTECODE: '1',
    POWERSHELL_TELEMETRY_OPTOUT: '1',
    POWERSHELL_UPDATECHECK: 'Off',
    DOTNET_CLI_HOME: path.join(dirs.home, '.dotnet'),
    DOTNET_CLI_TELEMETRY_OPTOUT: '1',
    NUGET_PACKAGES: path.join(dirs.cache, 'nuget'),
    PSModulePath: [path.join(path.dirname(pwsh), 'Modules'), path.join(systemRoot, 'System32/WindowsPowerShell/v1.0/Modules')].join(';'),
    PATH: [...new Set([dirs.bin, path.join(primary, 'pnpm', 'bin'), path.join(programRoot, 'resources/runtime/cli/bin'), path.dirname(node), path.dirname(python), path.join(path.dirname(python), 'Scripts'), path.dirname(pwsh), msvc, ...systemPath, ...hostPath])].join(';'),
  };
  delete environment.NODE_OPTIONS;
  delete environment.NODE_PATH;
  delete environment.PYTHONHOME;
  delete environment.PYTHONPATH;
  delete environment.PIP_PREFIX;
  delete environment.PIP_USER;
  for (const key of Object.keys(environment)) if (/^(npm|pnpm)_config_(store_dir|cache_dir|state_dir|node_linker|package_import_method)$/i.test(key)) delete environment[key];
  for (const filename of ['.npmrc', '.npmrc-global', 'pip.ini']) {
    const target = path.join(dirs.home, filename);
    if (!fs.existsSync(target)) fs.writeFileSync(target, '', { flag: 'wx' });
  }
  return { dirs, environment, helper, manifest, programRoot };
}

function rememberLocation(dirs, version, manifest, programRoot = dirs.root) {
  const filename = path.join(dirs.data, 'portable-state.json');
  const stored = readJson(filename);
  const state = stored || { format: 1, roots: [], release: version };
  if (state.format !== 1 || !Array.isArray(state.roots) || state.roots.some(root => typeof root !== 'string')) {
    throw new Error('便携路径记录损坏。请保留 data 文件夹并使用备份恢复。');
  }
  if (manifest?.dataContract) {
    if (stored) programGuard.assertData(dirs.root, manifest);
    state.dataContract = manifest.dataContract;
  } else if (state.release !== version) throw new Error('程序与数据版本不一致。请使用兼容的程序包。');
  if (state.programRoots !== undefined && (!Array.isArray(state.programRoots) || state.programRoots.some(item => typeof item !== 'string'))) throw new Error('程序路径记录损坏，已停止启动。');
  const programs = state.programRoots ?? [...state.roots];
  if (!programs.includes(programRoot)) programs.push(programRoot);
  state.programRoots = programs;
  state.release = version;
  const previousRoot = state.lastRoot || state.roots.at(-1);
  if (!state.roots.includes(dirs.root)) state.roots.push(dirs.root);
  state.lastRoot = dirs.root;
  atomicJson(filename, state);
  return { ...state, locationChanged: previousRoot !== undefined && previousRoot !== dirs.root };
}

function writeDefaultPatch(dirs) {
  const filename = path.join(dirs.dsh, 'cordis.patch.yml');
  const legacy =
    "# Portable workspace grants stay on the drive; external folders use account access.\n" +
    "- id: sandbox\n  config:\n    workspaceWriteEnabled: true\n    portableAclHelper: !!js process.env.DSH_PORTABLE_NATIVE_HELPER\n    portablePersistentRoot: !!js process.env.DSH_PORTABLE_ROOT\n" +
    "- id: sandbox-policy\n  config:\n    mode: workspace-write\n" +
    "- id: permission\n  config:\n    defaultPreset: workspace-write\n    portableWorkspaceRoot: !!js process.env.DSH_PORTABLE_ROOT\n    presets:\n      read-only:\n        sandbox: read-only\n        approval: ask\n      workspace-write:\n        sandbox: workspace-write\n        approval: ask\n        description: 仅允许修改便携包内部的当前工作区；授权保留在 U 盘内，无需退出恢复。\n      danger-full-access:\n        sandbox: danger-full-access\n        approval: ask\n        name: 当前账户权限\n        description: 可修改工作区及当前 Windows 账户有写入权限的其他位置，不限制在工作区内。\n" +
    "- id: approval\n  config:\n    policy: ask\n" +
    "- id: pwsh-sandbox\n  config:\n    pwshPath: !!js process.env.DSH_PORTABLE_PWSH\n" +
    "- id: workspace-controller\n  config:\n    documentsDirectory: !!js process.env.DSH_PORTABLE_WORKSPACES\n";
  const current = '# Portable runtime locations; permission modes and approval rules use the official base profile.\n' +
    '- id: pwsh-sandbox\n  config:\n    pwshPath: !!js process.env.DSH_PORTABLE_PWSH\n' +
    '- id: workspace-controller\n  config:\n    documentsDirectory: !!js process.env.DSH_PORTABLE_WORKSPACES\n';
  const existing = fs.existsSync(filename) ? fs.readFileSync(filename, 'utf8') : undefined;
  const begin = '# BEGIN DSH PORTABLE FILESYSTEM';
  const end = '# END DSH PORTABLE FILESYSTEM';
  let next = existing === undefined || existing === legacy ? current : existing;
  next = next.replace(/^# BEGIN DSH PORTABLE FILESYSTEM\r?\n[\s\S]*?^# END DSH PORTABLE FILESYSTEM(?:\r?\n|$)/gm, '');
  if (['FAT32', 'EXFAT'].includes(process.env.DSH_PORTABLE_FILESYSTEM)) {
    next = next + (next.endsWith('\n') ? '' : '\n') + begin + '\n- id: permission\n  config:\n    portableAccountAccess: true\n    defaultPreset: portable-account\n    presets:\n      portable-account:\n        sandbox: danger-full-access\n        approval: ask\n        name: 当前账户权限（FAT32/exFAT）\n        description: 文件与命令使用当前 Windows 账户权限，范围不限于工作区。\n' + end + '\n';
  }
  if (existing === undefined) fs.writeFileSync(filename, next, { flag: 'wx', encoding: 'utf8' });
  else if (existing !== next) {
    const temporary = filename + '.' + crypto.randomUUID() + '.tmp';
    try {
      fs.writeFileSync(temporary, next, { flag: 'wx', encoding: 'utf8' });
      const fd = fs.openSync(temporary, 'r+'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.renameSync(temporary, filename);
    } finally { fs.rmSync(temporary, { force: true }); }
  }
}

function acquireRunLock(dirs, helper, environment = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(helper, ['hold', path.join(dirs.data, '.running.lock')], { env: environment, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', ready = false, released = false, releasePromise;
    const timeout = setTimeout(() => { child.kill(); reject(new Error('便携数据锁等待超时，请重试。')); }, 30000);
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.stdin.on('error', error => { if (!ready) reject(error); });
    child.once('exit', () => { clearTimeout(timeout); if (!ready) reject(new Error('便携数据正在使用，请先完整退出 DSH 和其他维护工具。')); });
    child.stdout.setEncoding('utf8');
    child.stderr.resume();
    child.stdout.on('data', chunk => {
      if (ready) return;
      output += chunk;
      if (!output.includes('\n')) return;
      clearTimeout(timeout);
      let report;
      try { report = JSON.parse(output.slice(0, output.indexOf('\n')).replace(/^\uFEFF/, '')); }
      catch (error) { child.kill(); reject(new Error('便携数据锁返回了无效结果。')); return; }
      if (!report.ok || !report.locked) { reject(new Error(report.message || '便携数据正在使用。')); return; }
      ready = true;
      resolve({
        child,
        get released() { return released; },
        release() {
          if (releasePromise) return releasePromise;
          releasePromise = new Promise((done, failed) => {
            if (child.exitCode !== null || child.signalCode !== null) { released = true; done(); return; }
            const timer = setTimeout(() => { child.kill(); failed(new Error('便携数据锁未能正常关闭。')); }, 10000);
            child.once('exit', code => { clearTimeout(timer); released = true; code === 0 ? done() : failed(new Error('便携数据锁异常结束。')); });
            child.stdin.end();
          });
          return releasePromise;
        },
      });
    });
  });
}

function repairProfileMetadata(dirs, roots, programRoots = [], programRoot = dirs.root) {
  const profiles = path.join(dirs.dsh, 'profiles');
  if (!fs.existsSync(profiles)) return 0;
  let yaml, changed = 0;
  function scalar(value) {
    if (typeof value !== 'string' || (!path.isAbsolute(value) && !value.includes('file:') && !value.includes('link:'))) return value;
    let result = value;
    const mappings = [
      ...programRoots.map(previous => [path.join(previous, 'resources'), path.join(programRoot, 'resources')]),
      ...roots.map(previous => [previous, dirs.root]),
    ];
    for (const [previous, target] of mappings) {
      if (previous.toLowerCase() === target.toLowerCase()) continue;
      for (const slash of ['\\', '/']) {
        const before = previous.replaceAll('\\', slash).replaceAll('/', slash);
        const after = target.replaceAll('\\', slash).replaceAll('/', slash);
        const escaped = before.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        result = result.replace(new RegExp(escaped + '(?=$|[\\\\/(])', 'gi'), () => after);
      }
    }
    return result;
  }
  function transform(value) {
    if (typeof value === 'string') return scalar(value);
    if (Array.isArray(value)) return value.map(transform);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [scalar(key), transform(child)]));
  }
  for (const entry of fs.readdirSync(profiles, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const profile = path.join(profiles, entry.name);
    for (const name of ['pnpm-workspace.yaml', 'pnpm-lock.yaml', 'node_modules/.modules.yaml', 'node_modules/.pnpm-workspace-state-v1.json']) {
      const filename = path.join(profile, name);
      if (!fs.existsSync(filename)) continue;
      const text = fs.readFileSync(filename, 'utf8');
      let document;
      if (name.endsWith('.json')) document = JSON.parse(text);
      else {
        if (!yaml) yaml = require('node:module').createRequire(path.join(programRoot, 'resources', 'app.asar', 'dsh', 'package.json'))('yaml');
        document = yaml.parse(text);
      }
      const next = transform(document);
      if (JSON.stringify(next) === JSON.stringify(document)) continue;
      const temp = filename + '.' + crypto.randomUUID() + '.tmp';
      try {
        // Keep pnpm 11's native JSON representation even though its filename
        // ends in .yaml. The wrapper also accepts existing YAML from older starts.
        fs.writeFileSync(temp, name.endsWith('.json') || name === 'node_modules/.modules.yaml' ? JSON.stringify(next, null, 2) + '\n' : yaml.stringify(next), { flag: 'wx' });
        const fd = fs.openSync(temp, 'r+'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
        fs.renameSync(temp, filename); changed++;
      } finally { fs.rmSync(temp, { force: true }); }
    }
    const manifestFile = path.join(profile, 'package.json');
    if (fs.existsSync(manifestFile)) {
      const manifest = readJson(manifestFile);
      const before = JSON.stringify(manifest);
      for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) if (manifest[field]) manifest[field] = transform(manifest[field]);
      if (manifest.pnpm?.overrides) manifest.pnpm.overrides = transform(manifest.pnpm.overrides);
      if (JSON.stringify(manifest) !== before) { atomicJson(manifestFile, manifest); changed++; }
    }
  }
  return changed;
}

module.exports = { UPSTREAM, inside, atomicJson, readJson, native, directories, prepare, rememberLocation, writeDefaultPatch, acquireRunLock, repairProfileMetadata };
