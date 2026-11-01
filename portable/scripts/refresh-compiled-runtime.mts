/** Refresh explicitly changed local archives without changing the dependency graph. Full integrity verification follows. */
import { readFile, writeFile, readdir, mkdir, mkdtemp, cp, lstat, rm } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { spawn, execFileSync } from 'node:child_process'
import { join, relative, isAbsolute } from 'node:path'
import { pathToFileURL } from 'node:url'
import { work, project, upstream, pnpm, buildEnvironment } from './environment.mjs'
import { pruneAclBuild } from './prune-acl-build.mjs'
if (!process.argv.includes('--refresh-lock')) throw new Error('An intentional source refresh requires --refresh-lock')
const require = createRequire(join(upstream, 'package.json'))
const yaml = require('js-yaml')
const env = await buildEnvironment()
const targetBase = join(upstream, 'apps/desktop/.desktop-build/targets/win-x64')
const runtime = join(targetBase, 'dsh'), archives = join(targetBase, 'packed/dsh')
const descriptorPath = join(runtime, 'desktop-runtime.json')
const descriptor = JSON.parse(await readFile(descriptorPath, 'utf8'))
const inventory = new Map<string, { path: string; bytes: number; sha256: string; executable: boolean }>(descriptor.files.map((file: { path: string }) => [file.path, file]))
const lockPath = join(project, 'production-pnpm-lock.yaml')
let lockText = await readFile(lockPath, 'utf8')
const lock = yaml.load(lockText)
const lockOnly = process.argv.includes('--lock-only')
const packageSelection = process.argv.find(arg => arg.startsWith('--packages='))
const selected = packageSelection ? packageSelection.slice(11).split(',') : ['sandbox/sandbox-policy', 'interaction/permission-presets', 'sandbox/sandbox-local', 'sandbox/sandbox-windows-acl',
  'util/home-paths', 'api/workspace-controller', 'boot/app-boot', 'fs/fs-local']
const allowed = new Set(await Promise.all(selected.map(async name => JSON.parse(await readFile(join(upstream, 'packages', name, 'package.json'), 'utf8')).name)))
if (selected.includes('sandbox/sandbox-windows-acl')) {
  for (const file of await pruneAclBuild()) {
    const name='node_modules/@deepseek-ai/dsh-sandbox-windows-acl/'+file;
    inventory.delete(name);
    if (!lockOnly) await rm(join(runtime,name),{force:true});
  }
}
for (const group of await readdir(join(upstream, 'packages'), { withFileTypes: true })) {
  if (!group.isDirectory()) continue
  for (const entry of await readdir(join(upstream, 'packages', group.name), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const source = join(upstream, 'packages', group.name, entry.name)
    let manifest
    try { manifest = JSON.parse(await readFile(join(source, 'package.json'), 'utf8')) } catch (error) { if (error.code === 'ENOENT') continue; throw error }
    if (allowed.has(manifest.name)) continue
    try {
      const fresh = await readFile(join(source, 'lib/index.js'))
      const current = await readFile(join(runtime, 'node_modules', manifest.name, 'lib/index.js'))
      if (!fresh.equals(current)) throw new Error('Another compiled package changed; use the full runtime refresh: ' + manifest.name)
    } catch (error) { if (error.code !== 'ENOENT') throw error }
  }
}
for (const directory of selected) {
  const source = join(upstream, 'packages', directory)
  const manifest = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'))
  const archiveName = manifest.name.replace('@', '').replace('/', '-') + '-' + manifest.version + '.tgz'
  const archive = join(archives, archiveName)
  await new Promise<void>((done, reject) => {
    const child = spawn(process.execPath, [pnpm, '--dir', source, 'pack', '--pack-destination', archives], { env, windowsHide: true, stdio: 'inherit' })
    child.once('error', reject); child.once('exit', code => code === 0 ? done() : reject(new Error('Packing failed: ' + manifest.name)))
  })
  const extracted = await mkdtemp(join(work, 'qa/compiled-refresh-'))
  execFileSync('tar.exe', ['-xf', archive, '-C', extracted], { windowsHide: true })
  const packageRoot = join(extracted, 'package')
  const packedManifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'))
  const existing = JSON.parse(await readFile(join(runtime, 'node_modules', manifest.name, 'package.json'), 'utf8'))
  for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
    if (JSON.stringify(packedManifest[field]) !== JSON.stringify(existing[field])) throw new Error('Dependency graph changed; use the full refresh: ' + manifest.name)
  }
  async function copyFiles(folder: string) {
    for (const item of await readdir(folder, { withFileTypes: true })) {
      const filename = join(folder, item.name)
      if (item.isSymbolicLink()) throw new Error('Archive contains a filesystem link')
      if (item.isDirectory()) { await copyFiles(filename); continue }
      const part = relative(packageRoot, filename)
      if (!part || part.startsWith('..') || isAbsolute(part) || !(await lstat(filename)).isFile()) throw new Error('Unsafe archive entry')
      const name = join('node_modules', manifest.name, part).replaceAll('\\', '/')
      const target = join(runtime, name)
      await mkdir(join(target, '..'), { recursive: true }); await cp(filename, target)
      const bytes = await readFile(target)
      inventory.set(name, { path: name, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), executable: false })
    }
  }
  if (!lockOnly) await copyFiles(packageRoot)
  const key = manifest.name + '@file:desktop-packages/' + archiveName
  const oldIntegrity = lock.packages[key]?.resolution?.integrity
  const integrity = 'sha512-' + createHash('sha512').update(await readFile(archive)).digest('base64')
  if (typeof oldIntegrity !== 'string' || lockText.split(oldIntegrity).length !== 2) throw new Error('Unexpected local archive lock record')
  lockText = lockText.replace(oldIntegrity, integrity)
}
if (!lockOnly) {
  const { prepareRuntimeManifests } = await import(pathToFileURL(join(upstream, 'apps/desktop/scripts/prepare-runtime-manifests.ts')).href)
  await prepareRuntimeManifests(runtime)
  for (const file of inventory.values()) {
    if (!file.path.startsWith('node_modules/') || !file.path.endsWith('/package.json')) continue
    const bytes = await readFile(join(runtime, file.path))
    file.bytes = bytes.length; file.sha256 = createHash('sha256').update(bytes).digest('hex')
  }
  descriptor.files = [...inventory.values()].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
  await writeFile(descriptorPath, JSON.stringify(descriptor, null, 2) + '\n')
  const { verifyDesktopRuntime } = await import(pathToFileURL(join(upstream, 'apps/desktop/src/runtime-tree.ts')).href)
  await verifyDesktopRuntime(runtime, descriptor.release.version, { platform: 'win32', arch: 'x64' })
}
await writeFile(lockPath, lockText)
console.log(lockOnly ? 'Source archive locks refreshed; dependency graph unchanged.' : 'Refreshed local archives; dependency graph unchanged and every runtime file verified.')
