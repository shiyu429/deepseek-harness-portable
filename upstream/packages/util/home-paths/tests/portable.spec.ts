import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve, relative, isAbsolute } from 'node:path'
import { resolvePortablePath, encodePortablePath, rememberPortableWorkspace, assertPortableWorkspaceIdentity } from '../src/portable.ts'

const fixtures = process.env.DSH_PORTABLE_TEST_ROOT
const helper = process.env.DSH_PORTABLE_TEST_NATIVE_HELPER
let root: string
let prior: NodeJS.ProcessEnv
beforeEach(() => {
  prior = { ...process.env }
  mkdirSync(fixtures as string, { recursive: true })
  root = realpathSync(mkdtempSync(join(fixtures as string, 'paths-')))
  mkdirSync(join(root, 'data'))
  process.env.DSH_PORTABLE_ROOT = root
  process.env.DSH_PORTABLE_NATIVE_HELPER = helper
  writeFileSync(join(root, 'data', 'portable-state.json'), JSON.stringify({ format: 1, roots: [root, 'P:\\旧路径 with spaces'], release: '1.0.0' }))
})
afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in prior)) delete process.env[key]
  Object.assign(process.env, prior)
  const rest = relative(resolve(fixtures as string), root)
  if (!rest || rest.startsWith('..') || isAbsolute(rest)) throw new Error('unsafe fixture cleanup')
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

describe.skipIf(process.platform !== 'win32' || !fixtures || !helper)('portable workspace paths', () => {
  it('resolves a lowercase launch path to the canonical spelling used by session cwd', () => {
    const folder = join(root, '中文 工作区')
    mkdirSync(folder)
    const canonical = realpathSync(folder)
    process.env.DSH_PORTABLE_ROOT = root.toLowerCase()
    expect(resolvePortablePath(encodePortablePath(canonical))).toBe(canonical)
  })
  it('stores internal paths relatively and resolves historical roots without changing unrelated paths', () => {
    const folder = join(root, 'data', 'workspaces', '中文 project')
    mkdirSync(folder, { recursive: true })
    const encoded = encodePortablePath(folder)
    expect(encoded).toMatch(/^dsh-portable:\//u)
    expect(encoded).not.toContain(root)
    expect(resolvePortablePath(encoded)).toBe(folder)
    expect(resolvePortablePath('P:\\旧路径 with spaces\\data\\workspaces\\中文 project')).toBe(folder)
    expect(resolvePortablePath('P:\\旧路径 with spaces-extra\\file')).toBe('P:\\旧路径 with spaces-extra\\file')
    expect(() => resolvePortablePath('dsh-portable:/..%2F..%2Foutside')).toThrow()
  })

  it('refuses a changed external directory identity and accepts only an explicit reselection', () => {
    const outside = mkdtempSync(join(fixtures as string, 'external-'))
    try {
      rememberPortableWorkspace(outside)
      expect(() => assertPortableWorkspaceIdentity(outside)).not.toThrow()
      const file = join(root, 'data', 'workspace-identities', readdirSync(join(root, 'data', 'workspace-identities'))[0] as string)
      const metadata = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
      metadata['identity'] = 'another-volume-and-object'
      writeFileSync(file, JSON.stringify(metadata))
      expect(() => assertPortableWorkspaceIdentity(outside)).toThrow(/原工作区不可用/u)
      rememberPortableWorkspace(outside)
      expect(() => assertPortableWorkspaceIdentity(outside)).not.toThrow()
    } finally { rmSync(outside, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
  })

  it('reconnects historical paths to a selected directory without changing history or remapping twice', () => {
    const old = mkdtempSync(join(fixtures as string, 'old-project-'))
    const selected = join(root, 'data', 'workspaces', 'relocated')
    mkdirSync(selected, { recursive: true })
    try {
      rememberPortableWorkspace(old)
      const folder = join(root, 'data', 'workspace-identities')
      const filename = join(folder, readdirSync(folder)[0] as string)
      const record = JSON.parse(readFileSync(filename, 'utf8')) as Record<string, unknown>
      record['location'] = encodePortablePath(selected)
      writeFileSync(filename, JSON.stringify(record))
      const history = `Read ${join(old, 'report.txt')}`
      expect(resolvePortablePath(old)).toBe(selected)
      expect(resolvePortablePath(join(old, 'report.txt'))).toBe(join(selected, 'report.txt'))
      expect(resolvePortablePath(join(selected, 'report.txt'))).toBe(join(selected, 'report.txt'))
      expect(history).toBe(`Read ${join(old, 'report.txt')}`)
    } finally { rmSync(old, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
  })

  it('rejects the same path and directory identity when its original computer differs', () => {
    const outside = mkdtempSync(join(fixtures as string, 'same-path-'))
    try {
      rememberPortableWorkspace(outside)
      const file = join(root, 'data', 'workspace-identities', readdirSync(join(root, 'data', 'workspace-identities'))[0] as string)
      const record = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
      expect(typeof record['machine']).toBe('string')
      record['machine'] = 'another-computer-with-the-same-path-and-object-id'
      writeFileSync(file, JSON.stringify(record))
      expect(() => assertPortableWorkspaceIdentity(outside)).toThrow(/原工作区不可用/u)
      delete record['machine']; writeFileSync(file, JSON.stringify(record))
      expect(() => assertPortableWorkspaceIdentity(outside)).toThrow(/原工作区不可用/u)
      rememberPortableWorkspace(outside)
      expect(() => assertPortableWorkspaceIdentity(outside)).not.toThrow()
      const portable = join(root, 'data', 'workspaces', 'same-name'); mkdirSync(portable, { recursive: true })
      expect(() => assertPortableWorkspaceIdentity(portable)).not.toThrow()
    } finally { rmSync(outside, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
  })
})
