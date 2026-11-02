/** Build paths and process-only cache configuration. */
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile, readFile } from 'node:fs/promises';

export const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const work = resolve(project, '..');
export const upstream = resolve(work, 'upstream');
export const pnpm = resolve(work, 'tools', 'pnpm', 'package', 'bin', 'pnpm.mjs');

export async function buildEnvironment() {
  const lock = JSON.parse(await readFile(resolve(project, 'upstream.lock.json'), 'utf8'));
  const cache = resolve(work, 'cache');
  await mkdir(cache, { recursive: true });
  await mkdir(resolve(work, 'tools', 'bin'), { recursive: true });
  await mkdir(resolve(work, 'tmp'), { recursive: true });
  await writeFile(resolve(cache, 'npmrc'), '', 'utf8');
  const shim = '@echo off\r\n"' + process.execPath + '" "' + pnpm + '" %*\r\n';
  await writeFile(resolve(work, 'tools', 'bin', 'pnpm.cmd'), shim, 'utf8');
  return {
    ...process.env,
    NODE_USE_ENV_PROXY: '1',
    DSH_CLIENT_COMMIT_HASH: lock.commit,
    DSH_DESKTOP_BUILD_COMMIT: lock.commit,
    DSH_DESKTOP_BUILD_DIRTY: '1',
    TEMP: resolve(work, 'tmp'),
    TMP: resolve(work, 'tmp'),
    PNPM_HOME: resolve(work, 'tools', 'bin'),
    PATH: resolve(work, 'tools', 'bin') + ';' + process.env.PATH,
    npm_config_userconfig: resolve(cache, 'npmrc'),
    npm_config_globalconfig: resolve(cache, 'npmrc'),
    npm_config_cache: resolve(cache, 'npm'),
    npm_config_store_dir: resolve(work, 's'),
    npm_config_cache_dir: resolve(cache, 'pnpm'),
    npm_config_state_dir: resolve(cache, 'state'),
    npm_config_manage_package_manager_versions: 'false',
    pnpm_config_store_dir: resolve(work, 's'),
    pnpm_config_cache_dir: resolve(cache, 'pnpm'),
    pnpm_config_state_dir: resolve(cache, 'state'),
    pnpm_config_config_dir: resolve(cache, 'config'),
    pnpm_config_manage_package_manager_versions: 'false',
    ELECTRON_CACHE: resolve(cache, 'electron'),
    ELECTRON_BUILDER_CACHE: resolve(cache, 'electron-builder'),
    ELECTRON_SKIP_BINARY_DOWNLOAD: '1',
    ELECTRON_GET_USE_PROXY: '1',
    LEFTHOOK: '0',
    CI: '1',
    DSH_PORTABLE_TEST_NATIVE_HELPER: resolve(project, 'build', 'native-helper.exe'),
    DSH_PORTABLE_TEST_ROOT: resolve(work, 'qa'),
    DSH_PORTABLE_ACL_DEBUG: '1',
    DSH_PORTABLE_RUNTIME_OVERRIDES: resolve(project, 'runtime-overrides.json'),
    DSH_PORTABLE_RUNTIME_LOCK: resolve(project, 'production-pnpm-lock.yaml'),
    DSH_PORTABLE_BUILD_STORE: resolve(work, 's'),
  };
}
