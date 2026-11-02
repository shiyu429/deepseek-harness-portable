/** Focused real-Windows regressions; never touches user workspaces or host configuration. */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, cpSync, existsSync } from 'node:fs'
import { join, relative, isAbsolute } from 'node:path'
import { execFileSync } from 'node:child_process'
import { AclWriteGrant, AclSandbox, workspaceWriteSid, tempWriteSid } from '../../upstream/packages/sandbox/sandbox-windows-acl/src/index.ts'
import { work, project } from './environment.mjs'

const base = join(work, 'qa'), root = mkdtempSync(join(base, 'environment-'))
const workspace = join(root, '中文 工作区'), temp = join(root, 'private-temp')
mkdirSync(workspace); mkdirSync(temp)
const packed = join(work, 'packed-app/win-unpacked')
const primary = join(packed, 'resources/runtime/primary-runtime/dependencies')
const python = join(primary, 'python/python.exe'), pwsh = join(packed, 'resources/runtime/powershell/pwsh.exe')
const helper = join(project, 'build/native-helper.exe')
const environment = { ...process.env }
const grants: AclWriteGrant[] = [], sandboxes: AclSandbox[] = []
const report: Record<string, unknown> = { workspace }
try {
  Object.assign(process.env, { DSH_PORTABLE_ROOT: root, DSH_PORTABLE_NATIVE_HELPER: helper, DSH_PORTABLE_SANDBOX_ROOT: workspace,
    DSH_PORTABLE_SANDBOX_TEMP: temp, TMP: temp, TEMP: temp, PIP_CACHE_DIR: join(temp, 'pip-cache'),
    PIP_TARGET: join(workspace, '.dsh-python/site-packages'), PYTHONDONTWRITEBYTECODE: '1' })
  // Reproduce a user-owned directory that grants Modify and WRITE_DAC, without WRITE_OWNER.
  execFileSync('icacls.exe', [workspace, '/inheritance:r', '/grant:r', process.env.USERDOMAIN + '\\' + process.env.USERNAME + ':(OI)(CI)(M,WDAC)', '*S-1-5-18:(OI)(CI)F'], { stdio: 'pipe', windowsHide: true })
  for (const [dir, sid, standing] of [[workspace, workspaceWriteSid(workspace), true], [temp, tempWriteSid(temp), false]] as const) {
    const grant = AclWriteGrant.create(sid); grants.push(grant); grant.add(dir, standing)
  }
  const sandbox = new AclSandbox({ writableDirs: [workspace], tempDir: temp, writeSid: workspaceWriteSid(workspace), tempWriteSid: tempWriteSid(temp), mode: 'workspace-write', manageDacls: false })
  sandboxes.push(sandbox); await sandbox.init()
  const run = async (command: string, args: string[]) => {
    const result = await sandbox.spawn({ command, args, cwd: workspace }).wait()
    return { exitCode: result.exitCode, stdout: result.stdout.toString('utf8'), stderr: result.stderr.toString('utf8') }
  }
  const pythonProbe = "import tempfile, pathlib; p=pathlib.Path(tempfile.mkdtemp()); (p/'ok.txt').write_text('saved'); (p/'ok.txt').unlink(); p.rmdir(); print('PYTHON_PRIVATE_TEMP_OK')"
  const sitecustomize = join(primary, 'python/Lib/site-packages/sitecustomize.py')
  if (!existsSync(sitecustomize)) report.pythonBefore = await run(python, ['-c', pythonProbe])
  cpSync(join(project, 'runtime/python-sitecustomize.py'), sitecustomize)
  report.pythonTemp = await run(python, ['-I', '-c', pythonProbe])
  assert.equal((report.pythonTemp as { exitCode: number }).exitCode, 0, JSON.stringify(report.pythonTemp))
  report.pythonImports = await run(python, ['-I', '-c', "import importlib.util; print({n:bool(importlib.util.find_spec(n)) for n in ['pip','setuptools','wheel','docx','openpyxl','pptx','pypdf','requests']})"])
  report.https = await run(pwsh, ['-NoLogo', '-NoProfile', '-Command', "$ProgressPreference='SilentlyContinue'; try { $r=Invoke-WebRequest https://www.python.org -TimeoutSec 25; Write-Output ('HTTPS_OK '+$r.StatusCode) } catch { $e=$_.Exception; while($e){ Write-Output ($e.GetType().FullName+': '+$e.Message); $e=$e.InnerException }; exit 1 }"])
  writeFileSync(join(workspace, 'package.json'), '{"name":"portable-environment-probe","private":true}')
  report.pnpm = await run(process.execPath, [join(primary, 'pnpm/bin/pnpm.mjs'), 'add', 'is-number@7.0.0', '--ignore-scripts', '--reporter=append-only'])
  report.pip = await run(python, ['-m', 'pip', 'install', 'six==1.17.0', '--disable-pip-version-check', '--no-input', '--retries', '1', '--timeout', '25'])
  assert.equal((report.pnpm as { exitCode: number }).exitCode, 0, JSON.stringify(report.pnpm))
  assert.equal((report.pip as { exitCode: number }).exitCode, 0, JSON.stringify(report.pip))
  report.pipImport = await run(python, ['-I', '-c', "import six; print(six.__file__)"])
  assert.equal((report.pipImport as { exitCode: number }).exitCode, 0)
  // Creating one unrelated protected child must not disable the next session.
  const protectedChild = join(workspace, 'existing-private'); mkdirSync(protectedChild)
  execFileSync(python, ['-c', "import os; os.mkdir(os.path.join(os.environ['DSH_PORTABLE_SANDBOX_ROOT'],'legacy-private'),0o700)"], { windowsHide: true })
  const next = AclWriteGrant.create(workspaceWriteSid(workspace)); grants.push(next); next.add(workspace, true)
  report.reopenProtectedChild = true
  console.log(JSON.stringify(report, null, 2))
} finally {
  writeFileSync(join(work, 'qa/runtime-environment-result.json'), JSON.stringify(report, null, 2) + '\n')
  for (const sandbox of sandboxes) sandbox.dispose()
  for (const grant of grants) grant.dispose()
  for (const key of Object.keys(process.env)) if (!(key in environment)) delete process.env[key]
  Object.assign(process.env, environment)
  const part = relative(base, root); assert.ok(part && !part.startsWith('..') && !isAbsolute(part)); rmSync(root, { recursive: true, force: true })
}
