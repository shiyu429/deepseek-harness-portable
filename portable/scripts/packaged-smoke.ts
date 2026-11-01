/** Run upstream's complete production smoke against the actual ASAR-contained distribution. */
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { smokeDesktopRuntime } from '../../d/apps/desktop/scripts/smoke-runtime.ts'
import type { DesktopRuntimeDescriptor } from '../../d/apps/desktop/src/runtime-tree.ts'
const require = createRequire(import.meta.url)
const core = require('../runtime/core.cjs') as typeof import('../runtime/core.cjs')
const root = resolve(process.argv[2] as string)
const context = core.prepare(root)
Object.assign(process.env, context.environment)
delete process.env.NODE_OPTIONS
delete process.env.NODE_PATH
const dsh = join(root, 'resources/app.asar/dsh')
const descriptor = JSON.parse(readFileSync(join(dsh, 'desktop-runtime.json'), 'utf8')) as DesktopRuntimeDescriptor
await smokeDesktopRuntime(dsh, join(root, 'DSH Portable.exe'), descriptor, context.environment, join(root, 'resources/runtime'))
console.log('Actual packaged ASAR: offline plugin operations, Host, Office conversion and Office CLI passed.')
