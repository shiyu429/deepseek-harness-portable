/** Download the exact package manager into the build workspace, without a global installation. */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tools = resolve(project, '..', 'tools');
const lock = JSON.parse(await readFile(resolve(project, 'upstream.lock.json'), 'utf8'));
await mkdir(tools, { recursive: true });
const entry = resolve(tools, 'pnpm', 'package', 'bin', 'pnpm.mjs');
try {
  await stat(entry);
  const installed = JSON.parse(await readFile(resolve(tools, 'pnpm', 'package', 'package.json'), 'utf8'));
  if (installed.version !== lock.pnpm) throw new Error('Unexpected pnpm version in build workspace');
  console.log(`pnpm ${lock.pnpm} already prepared.`);
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
  const metadataResponse = await fetch(`https://registry.npmjs.org/pnpm/${lock.pnpm}`, { signal: AbortSignal.timeout(60000) });
  if (!metadataResponse.ok) throw new Error(`pnpm metadata: HTTP ${metadataResponse.status}`);
  const metadata = await metadataResponse.json();
  const response = await fetch(metadata.dist.tarball, { signal: AbortSignal.timeout(180000) });
  if (!response.ok) throw new Error(`pnpm archive: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const expected = lock.pnpmIntegrity;
  const actual = 'sha512-' + createHash('sha512').update(bytes).digest('base64');
  if (expected !== actual || metadata.dist.integrity !== expected) throw new Error('pnpm archive integrity mismatch');
  const archive = resolve(tools, `pnpm-${lock.pnpm}.tgz`);
  await writeFile(archive, bytes);
  await mkdir(resolve(tools, 'pnpm'), { recursive: true });
  const extraction = spawnSync('tar.exe', ['-xzf', archive, '-C', resolve(tools, 'pnpm')], { stdio: 'inherit', windowsHide: true });
  if (extraction.status !== 0) throw new Error('Could not extract the pinned pnpm archive');
  await writeFile(resolve(tools, 'pnpm.integrity.json'), JSON.stringify({ version: lock.pnpm, integrity: actual }, null, 2) + '\n');
  console.log(`Prepared verified pnpm ${lock.pnpm}.`);
}
