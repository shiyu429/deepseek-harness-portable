import assert from 'node:assert/strict'
import { LocalSandboxProvider } from '../../d/packages/sandbox/sandbox-local/src/index.ts'
import { canonicalPath } from '../../d/packages/sandbox/sandbox/src/index.ts'
const previous = process.env.DSH_PORTABLE_FILESYSTEM
try {
  const provider = Object.create(LocalSandboxProvider.prototype) as LocalSandboxProvider
  for (const filesystem of ['FAT32', 'EXFAT']) for (const mode of ['read-only', 'workspace-write'] as const) {
    process.env.DSH_PORTABLE_FILESYSTEM = filesystem
    await assert.rejects(provider.confine(['must-not-run'], { mode, workspaceRoot: canonicalPath(process.cwd()) }), /已阻止受限系统命令/)
  }
  console.log('FAT32_EXFAT_RESTRICTED_COMMANDS_REFUSED_BEFORE_RUNNER_OR_GRANTS')
} finally {
  if (previous === undefined) delete process.env.DSH_PORTABLE_FILESYSTEM
  else process.env.DSH_PORTABLE_FILESYSTEM = previous
}
