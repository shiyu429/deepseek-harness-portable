'use strict';
/** Use the official CLI with the same portable data and private environment. */
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const core = require('./core.cjs');
void (async () => { try {
  const args = process.argv.slice(2);
  if (args.length === 1 && ['--version','-V','-v','--help','-h'].includes(args[0])) {
    const entry = path.join(path.dirname(process.execPath),'resources/app.asar/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js');
    process.argv = [process.execPath,entry,...args];
    const {runCli} = await import(pathToFileURL(entry).href);
    await runCli({manageDesktopProfile:true});
    return;
  }
  const context = core.prepare(path.dirname(process.execPath));
  context.environment.DSH_PORTABLE_FILESYSTEM = core.native(context.helper, ['probe', context.dirs.root]).filesystem.toUpperCase();
  Object.assign(process.env, context.environment);
  delete process.env.NODE_OPTIONS;
  delete process.env.NODE_PATH;
  core.native(context.helper, ['portable-data', context.dirs.data]);
  const lock = await core.acquireRunLock(context.dirs, context.helper, context.environment);
  let closing = false;
  const finish = async () => {
    if (closing) return;
    closing = true;
    lock.child.ref();
    for (const stream of [lock.child.stdin, lock.child.stdout, lock.child.stderr]) stream.ref?.();
    await lock.release();
  };
  lock.child.once('exit', () => { if (!closing) { console.error('便携数据锁异常结束，已停止命令进程。请保留 data。'); process.exit(2); } });
  try {
    const location = core.rememberLocation(context.dirs, context.manifest.portableVersion, context.manifest, context.programRoot);
    core.repairProfileMetadata(context.dirs, location.roots, location.programRoots, context.programRoot);
    core.writeDefaultPatch(context.dirs);
    process.once('beforeExit', () => { void finish().catch(fail); });
    process.once('exit', () => {
      if (closing) return;
      closing = true;
    });
    const entry = path.join(context.programRoot, 'resources', 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js');
    process.argv = [process.execPath, entry, ...process.argv.slice(2)];
    const { runDesktopCli } = await import(pathToFileURL(entry).href);
    await runDesktopCli(path.join(context.programRoot, 'resources', 'app.asar', 'dsh'), path.join(context.programRoot, 'resources', 'runtime'));
    // Profile commands keep their own event loop alive after boot. Hold the data lock
    // until that loop drains, while allowing short commands such as --help to exit.
    lock.child.unref();
    for (const stream of [lock.child.stdin, lock.child.stdout, lock.child.stderr]) stream.unref?.();
  }
  catch (error) { await finish(); throw error; }
} catch (error) { fail(error); } })();
function fail(error) { console.error('DSH portable:', error.message); process.exitCode = 1; }
