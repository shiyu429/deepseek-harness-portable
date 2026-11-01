/** Electron entry: select portable paths before loading any upstream application modules. */
import { app, dialog } from 'electron';
import path from 'node:path';
import core from './core.cjs';

try {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('此便携包仅支持 Windows 10/11 x64。');
  const context = core.prepare(path.dirname(process.execPath));
  const profileKeys = ['HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA'];
  const hostProfile = Object.fromEntries(profileKeys.map(key => [key, process.env[key]]));
  Object.assign(process.env, context.environment);
  process.env.DSH_PORTABLE_CHILD_PROFILE = JSON.stringify(Object.fromEntries(profileKeys.map(key => [key, context.environment[key]])));
  for (const [key, value] of Object.entries(hostProfile)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  delete process.env.NODE_OPTIONS;
  delete process.env.NODE_PATH;
  const d = context.dirs;
  // Prepare cross-account data access before Chromium holds its user-data lock files.
  const volume = core.native(context.helper, ['probe', d.root]);
  if (!['NTFS', 'FAT32', 'EXFAT'].includes(volume.filesystem.toUpperCase())) throw new Error('运行盘需要 NTFS、FAT32 或 exFAT。本程序不会格式化磁盘。');
  context.environment.DSH_PORTABLE_FILESYSTEM = process.env.DSH_PORTABLE_FILESYSTEM = volume.filesystem.toUpperCase();
  if (volume.integrity < 8192) throw new Error('当前进程受到低完整性限制，无法准备便携数据目录。请在普通 Windows 桌面会话中启动，无需管理员权限。');
  core.native(context.helper, ['portable-data', d.data]);
  app.setPath('appData', d.roaming);
  app.setPath('userData', d.userData);
  app.setPath('sessionData', d.sessionData);
  app.setPath('temp', d.temp);
  app.setPath('logs', d.logs);
  app.setPath('crashDumps', d.crashes);
  app.setPath('downloads', d.downloads);
  app.commandLine.appendSwitch('disk-cache-dir', path.join(d.cache, 'chromium'));
  app.commandLine.appendSwitch('disable-component-update');
  if (!app.requestSingleInstanceLock()) { app.quit(); }
  else {
    const lock = await core.acquireRunLock(d, context.helper, context.environment);
    let releasing = false;
    app.on('will-quit', event => {
      if (lock.released) return;
      event.preventDefault();
      if (releasing) return;
      releasing = true;
      void lock.release().then(() => app.quit()).catch(error => { dialog.showErrorBox('DSH 便携版退出未完成', error.message); app.exit(2); });
    });
    lock.child.once('exit', () => { if (!releasing) { dialog.showErrorBox('便携数据锁异常结束', '请完整退出程序后重新启动，暂勿复制正在使用的数据。'); app.quit(); } });
    const location = core.rememberLocation(d, context.manifest.portableVersion, context.manifest, context.programRoot);
    // Retrying on later starts also completes a repair interrupted by removal or a full disk.
    core.repairProfileMetadata(d, location.roots, location.programRoots, context.programRoot);
    core.writeDefaultPatch(d);
    process.chdir(d.workspaces);
    await import(new URL('../lib/main.js', import.meta.url).href);
  }
} catch (error) { fail(error); }

function fail(error) {
  console.error('Portable startup failed:', error.code || error.name, error.message);
  dialog.showErrorBox('DSH 便携版无法启动', String(error.message) + '\n\n请保留 data 文件夹。');
  app.exit(1);
}
