/** Exercise the unmodified official Windows runner against portable data and a host workspace. */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, linkSync, symlinkSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, relative, isAbsolute } from 'node:path'
import { AclWriteGrant } from '../../d/packages/sandbox/sandbox-windows-acl/src/grant.ts'
import { AclSandbox } from '../../d/packages/sandbox/sandbox-windows-acl/src/index.ts'
import { workspaceWriteSid, tempWriteSid } from '../../d/packages/sandbox/sandbox-windows-acl/src/workspace-sid.ts'
import { work, project } from './environment.mjs'
const base = join(work, 'qa'), root = mkdtempSync(join(base, 'official-acl-'))
const portable = join(root, '便携包'), data = join(portable, 'data'), first = join(data, 'workspaces/原文件'), other = join(data, 'workspaces/其他工作区')
const temp = join(data, 'temp/私有目录'), host = join(root, '电脑工作区'), denied = join(root, '不能越界.txt')
for (const dir of [first, other, temp, host]) mkdirSync(dir, { recursive: true })
for (const dir of [first, other, host]) writeFileSync(join(dir, 'original.txt'), 'original')
writeFileSync(join(portable, 'portable.json'), '{"format":1}')
const helper = join(project, 'build/native-helper.exe')
const invoke = (args: string[]) => JSON.parse(execFileSync(helper, args, { encoding: 'utf8', windowsHide: true }))
const inspect = (dir: string) => invoke(['inspect', dir]).entries.map((item: { Path: string; Sddl: string }) => ({ path: item.Path, sddl: item.Sddl }))
const grants: AclWriteGrant[] = [], sandboxes: AclSandbox[] = []
const previousHelper = process.env.DSH_PORTABLE_NATIVE_HELPER
try {
  const beforeHost = inspect(host)
  execFileSync('icacls.exe', [portable, '/grant', '*S-1-1-0:(OI)(CI)F', '/T'], { windowsHide: true, stdio: 'ignore' })
  invoke(['portable-data', data])
  process.env.DSH_PORTABLE_NATIVE_HELPER = helper
  assert.deepEqual(inspect(host), beforeHost)
  const grant = (dir: string, sid: string, standing = true) => {
    const value = AclWriteGrant.create(sid); grants.push(value); value.add(dir, standing)
  }
  for (const dir of [first, other, host]) grant(dir, workspaceWriteSid(dir))
  grant(temp, tempWriteSid(temp), false)
  const afterHost = inspect(host); assert.notDeepEqual(afterHost, beforeHost)
  for (const dir of [first, host]) {
    const sandbox = new AclSandbox({ writableDirs: [dir], tempDir: temp, writeSid: workspaceWriteSid(dir), tempWriteSid: tempWriteSid(temp), mode: 'workspace-write', manageDacls: false })
    sandboxes.push(sandbox); await sandbox.init()
    const child = sandbox.spawn({ command: process.execPath, args: ['-e', "const f=require('node:fs'); f.writeFileSync('original.txt','saved'); try{f.writeFileSync(process.argv[1],'bad');process.exitCode=7}catch{}", dir === first ? join(other, 'original.txt') : denied], cwd: dir })
    assert.equal((await child.wait()).exitCode, 0)
    assert.equal(readFileSync(join(dir, 'original.txt'), 'utf8'), 'saved')
  }
  assert.equal(readFileSync(join(other, 'original.txt'), 'utf8'), 'original'); assert.equal(existsSync(denied), false)
  const readOnly = new AclSandbox({ writableDirs: [], tempDir: null, mode: 'read-only' }); sandboxes.push(readOnly); await readOnly.init()
  const child = readOnly.spawn({ command: process.execPath, args: ['-e', "try{require('node:fs').writeFileSync('original.txt','bad');process.exitCode=8}catch{}"], cwd: first })
  assert.equal((await child.wait()).exitCode, 0)
  const broad = join(root, '不安全的所有人写入'); mkdirSync(broad); writeFileSync(join(broad, 'original.txt'), 'unchanged')
  execFileSync('icacls.exe', [broad, '/grant', '*S-1-1-0:(OI)(CI)F', '/T'], { windowsHide: true, stdio: 'ignore' })
  const broadBefore = inspect(broad)
  const refusedBroad = AclWriteGrant.create(workspaceWriteSid(broad)); grants.push(refusedBroad)
  assert.throws(() => refusedBroad.add(broad, true), /所有人/)
  assert.deepEqual(inspect(broad), broadBefore)
  const linked = join(root, '外部硬链接工作区'); mkdirSync(linked); linkSync(join(host, 'original.txt'), join(linked, 'alias.txt'))
  const linkedBefore = inspect(linked), refusedLink = AclWriteGrant.create(workspaceWriteSid(linked)); grants.push(refusedLink)
  assert.throws(() => refusedLink.add(linked, true), /硬链接/); assert.deepEqual(inspect(linked), linkedBefore)
  const junction = join(root, '外部目录链接工作区'); mkdirSync(junction); symlinkSync(host, join(junction, 'alias'), 'junction')
  const junctionBefore = inspect(junction), refusedJunction = AclWriteGrant.create(workspaceWriteSid(junction)); grants.push(refusedJunction)
  assert.throws(() => refusedJunction.add(junction, true), /外部目录/); assert.deepEqual(inspect(junction), junctionBefore)
  execFileSync('icacls.exe', [join(first, 'original.txt'), '/setintegritylevel', 'M'], { windowsHide: true, stdio: 'ignore' })
  const retry = AclWriteGrant.create(workspaceWriteSid(first)); grants.push(retry); retry.add(first, true)
  assert.match(inspect(first).find((entry: { path: string }) => entry.path === join(first, 'original.txt')).sddl, /;;;LW\)/)
  console.log('UNSAFE_EVERYONE_WRITE_EXTERNAL_HARDLINK_AND_DIRECTORY_LINK_REFUSED_WITHOUT_ACL_CHANGES', true)
  console.log('INTERRUPTED_CHILD_PERMISSION_PROPAGATION_REAPPLIED', true)
  for (const sandbox of sandboxes) sandbox.dispose(); sandboxes.length = 0
  for (const grant of grants) grant.dispose(); grants.length = 0
  assert.deepEqual(inspect(host), afterHost)
  console.log('OFFICIAL_WINDOWS_RUNNER_PORTABLE_AND_HOST_WORKSPACE_WRITE_READ_ONLY_AND_NO_RESTORE', true)
} finally {
  if (previousHelper === undefined) delete process.env.DSH_PORTABLE_NATIVE_HELPER
  else process.env.DSH_PORTABLE_NATIVE_HELPER = previousHelper
  for (const sandbox of sandboxes) sandbox.dispose()
  for (const grant of grants) grant.dispose()
  const part = relative(base, root); assert.ok(part && !part.startsWith('..') && !isAbsolute(part)); rmSync(root, { recursive: true, force: true })
}
