/** Portable workspace references and runtime-only relocation of historical paths. */
import { createHash, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

const PREFIX = 'dsh-portable:/'

function within(root: string, path: string): boolean {
  const rest = relative(root, path)
  return rest === '' || (rest !== '..' && !rest.startsWith(`..${sep}`) && !isAbsolute(rest))
}

function portableRoot(): string | undefined {
  const root = process.env.DSH_PORTABLE_ROOT
  // Match the realpath spelling used by workspace/session identity comparisons.
  return root === undefined ? undefined : realpathSync.native(root)
}

/**
 * Resolve a portable reference or a historical absolute path without rewriting Session logs.
 * @param path - Stored workspace reference or path from an immutable Session header.
 * @returns The current absolute path; ordinary installations retain the supplied path.
 */
function resolveBase(path: string): string {
  const root = portableRoot()
  if (root === undefined) return path
  if (path.startsWith(PREFIX)) {
    const rest = decodeURIComponent(path.slice(PREFIX.length))
    const decoded = resolve(root, rest)
    if (!within(root, decoded)) throw new Error('portable workspace reference escapes its package')
    return decoded
  }
  if (!isAbsolute(path) || within(root, path)) return path
  const state: unknown = JSON.parse(readFileSync(join(root, 'data', 'portable-state.json'), 'utf8'))
  if (typeof state !== 'object' || state === null || !('roots' in state) || !Array.isArray(state.roots)
    || state.roots.some(value => typeof value !== 'string')) throw new Error('portable path history is invalid')
  const roots = (state.roots as string[]).toSorted((a, b) => b.length - a.length)
  for (const previous of roots) if (within(previous, path)) return resolve(root, relative(previous, path))
  return path
}

interface WorkspaceLocation {
  format: 1
  originalPath: string
  location: string
  identity?: string
  machine?: string
}

function locations(root: string): WorkspaceLocation[] {
  let names: string[]
  try { names = readdirSync(join(root, 'data', 'workspace-identities')) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error }
  return names.filter(name => /^[a-f0-9]{64}\.json$/u.test(name)).map((name) => {
    const raw: unknown = JSON.parse(readFileSync(join(root, 'data', 'workspace-identities', name), 'utf8'))
    if (typeof raw !== 'object' || raw === null || !('format' in raw) || raw.format !== 1) throw new Error('portable workspace location record is invalid')
    const record = raw as Record<string, unknown>
    const original = record['originalPath'] ?? record['path']
    const location = record['location'] ?? record['path']
    if (typeof original !== 'string' || typeof location !== 'string' || (record['identity'] !== undefined && typeof record['identity'] !== 'string')
      || (record['machine'] !== undefined && typeof record['machine'] !== 'string')) {
      throw new Error('portable workspace location record is invalid')
    }
    return { format: 1, originalPath: original, location,
      ...(typeof record['identity'] === 'string' ? { identity: record['identity'] } : {}),
      ...(typeof record['machine'] === 'string' ? { machine: record['machine'] } : {}) }
  })
}

/**
 * Resolve a recorded path through package moves and explicit user workspace reconnections.
 * @param path - Portable reference or absolute historical path.
 * @returns Its current location without changing any historical Session event.
 */
export function resolvePortablePath(path: string): string {
  const root = portableRoot()
  if (root === undefined) return path
  const current = resolveBase(path)
  if (!isAbsolute(current)) return current
  const records = locations(root)
  for (const record of records) {
    const target = resolveBase(record.location)
    if (record.originalPath !== record.location && within(target, current)) return current
  }
  for (const record of records.toSorted((a, b) => b.originalPath.length - a.originalPath.length)) {
    const original = resolveBase(record.originalPath)
    if (within(original, current)) return resolve(resolveBase(record.location), relative(original, current))
  }
  return current
}

/**
 * Store an internal workspace relative to the package; external paths keep their selected spelling.
 * @param path - Canonical absolute workspace directory.
 * @returns A portable reference inside this package, or the original external path.
 */
export function encodePortablePath(path: string): string {
  const root = portableRoot()
  return root !== undefined && within(root, path)
    ? PREFIX + relative(root, path).split(sep).map(encodeURIComponent).join('/')
    : path
}

function identityFile(root: string, path: string): string {
  const key = createHash('sha256').update((path.startsWith(PREFIX) ? path : resolve(path)).toLowerCase()).digest('hex')
  return join(root, 'data', 'workspace-identities', `${key}.json`)
}

function currentIdentity(path: string): { identity: string; machine: string } {
  const helper = process.env.DSH_PORTABLE_NATIVE_HELPER
  if (helper === undefined) throw new Error('portable workspace identity helper is missing')
  const output = execFileSync(helper, ['identity', path], { encoding: 'utf8', windowsHide: true, maxBuffer: 1024 * 1024 })
  const report: unknown = JSON.parse(output.replace(/^\uFEFF/u, ''))
  if (typeof report !== 'object' || report === null || !('ok' in report) || report.ok !== true
    || !('identity' in report) || typeof report.identity !== 'string'
    || !('machine' in report) || typeof report.machine !== 'string') throw new Error('portable workspace identity is unavailable')
  return { identity: report.identity, machine: report.machine }
}

function currentMachine(): string {
  const helper = process.env.DSH_PORTABLE_NATIVE_HELPER
  if (helper === undefined) throw new Error('portable workspace identity helper is missing')
  const output = execFileSync(helper, ['machine'], { encoding: 'utf8', windowsHide: true, maxBuffer: 1024 * 1024 })
  const report: unknown = JSON.parse(output.replace(/^\uFEFF/u, ''))
  if (typeof report !== 'object' || report === null || !('ok' in report) || report.ok !== true
    || !('machine' in report) || typeof report.machine !== 'string') throw new Error('portable computer identity is unavailable')
  return report.machine
}

/**
 * Remember the directory explicitly selected by the user; choosing it again reconnects it.
 * @param path - Canonical absolute directory selected through Workspace creation.
 */
export function rememberPortableWorkspace(path: string): void {
  const root = portableRoot()
  if (root === undefined) return
  const found = locations(root).find(record => resolveBase(record.originalPath) === path || resolveBase(record.location) === path)
  const location = encodePortablePath(path)
  const originalPath = found?.originalPath ?? location
  const identity = within(root, path) ? undefined : currentIdentity(path)
  const filename = identityFile(root, originalPath)
  mkdirSync(dirname(filename), { recursive: true })
  const temp = `${filename}.${randomUUID()}.tmp`
  let descriptor: number | undefined
  try {
    descriptor = openSync(temp, 'wx', 0o600)
    writeFileSync(descriptor, JSON.stringify({ format: 1, originalPath, location, ...(identity === undefined ? {} : identity) }) + '\n')
    fsyncSync(descriptor)
    closeSync(descriptor)
    descriptor = undefined
    renameSync(temp, filename)
  } finally {
    if (descriptor !== undefined) closeSync(descriptor)
    rmSync(temp, { force: true })
  }
}

/**
 * Refuse an external workspace whose directory identity differs on this computer.
 * @param path - Workspace path, after resolving internal portable references.
 * @throws An ENOENT-class error when the selected original workspace is unavailable.
 */
export function assertPortableWorkspaceIdentity(path: string): void {
  const root = portableRoot()
  if (root === undefined || within(root, path)) return
  const failure = (): Error & { code: string } => Object.assign(
    new Error('原工作区不可用。请在工作区菜单中重新选择原文件夹；聊天记录仍保存在 U 盘。'), { code: 'ENOENT' },
  )
  const stored = locations(root).find(record => resolveBase(record.location) === path)
  if (stored?.identity === undefined || stored.machine === undefined) throw failure()
  if (currentMachine() !== stored.machine) throw failure()
  if (currentIdentity(path).identity !== stored.identity) throw failure()
}
