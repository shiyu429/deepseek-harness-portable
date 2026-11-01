/** Declare the path-adapter dependency wherever its portable extension is consumed. */
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { upstream } from './environment.mjs';

for (const directory of ['packages/fs/fs-local', 'packages/session/working-directory', 'packages/workspace/workspace', 'packages/sandbox/sandbox-policy', 'packages/api/session-controller', 'packages/api/workspace-files', 'packages/sandbox/sandbox']) {
  const manifestFile = resolve(upstream, directory, 'package.json');
  const manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
  manifest.peerDependencies ||= {};
  manifest.devDependencies ||= {};
  manifest.peerDependencies['@deepseek-ai/dsh-home-paths'] = 'workspace:*';
  manifest.devDependencies['@deepseek-ai/dsh-home-paths'] = 'workspace:*';
  await writeFile(manifestFile, JSON.stringify(manifest, null, 2) + '\n');
  const configFile = resolve(upstream, directory, 'tsconfig.json');
  const config = JSON.parse(await readFile(configFile, 'utf8'));
  config.references ||= [];
  const reference = relative(resolve(upstream, directory), resolve(upstream, 'packages/util/home-paths')).replaceAll('\\', '/');
  if (!config.references.some(record => record.path === reference)) config.references.push({ path: reference });
  await writeFile(configFile, JSON.stringify(config, null, 2) + '\n');
}
console.log('Portable path dependency declarations updated.');
