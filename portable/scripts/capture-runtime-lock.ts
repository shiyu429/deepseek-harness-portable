/** Reconstruct the production resolver inputs without touching the materialized runtime. */
import { cpSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { resolve, join } from 'node:path'
import { createRequire } from 'node:module'
import { createRuntimeProjectMetadata } from '../../d/apps/desktop/src/project-manager.ts'
import { prepareRuntimePatches } from '../../d/apps/desktop/scripts/prepare-runtime-patches.ts'
import { parseDesktopRelease } from '../../d/apps/desktop/src/release.ts'
import { project, work, upstream, pnpm, buildEnvironment } from './environment.mjs'
const { load, dump } = createRequire(resolve(upstream, 'package.json'))('js-yaml') as { load: (text: string) => unknown; dump: (value: unknown) => string }
const target = resolve(upstream, 'apps/desktop/.desktop-build/targets/win-x64')
const stage = resolve(work, 'runtime-lock-input')
mkdirSync(stage, { recursive: true })
cpSync(join(target, 'package-set'), stage, { recursive: true })
const descriptor = JSON.parse(readFileSync(join(target, 'dsh/desktop-runtime.json'), 'utf8')) as { release: unknown }
createRuntimeProjectMetadata(stage, parseDesktopRelease(descriptor.release))
const workspaceFile = join(stage, 'pnpm-workspace.yaml')
const workspace = load(readFileSync(workspaceFile, 'utf8')) as Record<string, unknown>
const overrides = JSON.parse(readFileSync(join(project, 'runtime-overrides.json'), 'utf8')) as Record<string, string>
workspace['overrides'] = { ...overrides, ...workspace['overrides'] as Record<string, string> }
writeFileSync(workspaceFile, dump(workspace))
prepareRuntimePatches(stage, upstream)
const result = spawnSync(process.execPath, [pnpm, 'install', '--lockfile-only', '--ignore-scripts'], { cwd: stage, env: await buildEnvironment(), stdio: 'inherit', windowsHide: true })
if (result.status !== 0) throw new Error('Production lock capture failed')
copyFileSync(join(stage, 'pnpm-lock.yaml'), join(project, 'production-pnpm-lock.yaml'))
console.log('Captured exact production dependency lock.')
