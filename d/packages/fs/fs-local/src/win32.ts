/**
 * Windows security-descriptor helpers for atomic local-file replacement. Koffi loads lazily so
 * non-Windows processes never open Win32 libraries.
 * @module @deepseek-ai/dsh-fs-local/win32
 */

import { dirname, toNamespacedPath } from 'node:path'

type GetFileSecurityW = (
  path: string,
  requestedInformation: number,
  descriptor: Buffer | null,
  length: number,
  needed: [number],
) => number
type SetFileSecurityW = (path: string, securityInformation: number, descriptor: Buffer) => number
type ReplaceFileW = (
  replaced: string,
  replacement: string,
  backup: null,
  flags: number,
  exclude: null,
  reserved: null,
) => number
type GetLastError = () => number

interface Win32Bindings {
  getFileSecurityW: GetFileSecurityW
  setFileSecurityW: SetFileSecurityW
  replaceFileW: ReplaceFileW
  getLastError: GetLastError
  moveFileExW: (source: string, destination: string, flags: number) => number
  getVolumePathNameW: (path: string, buffer: Buffer, length: number) => number
  getVolumeInformationW: (root: string, name: null, nameLength: number, serial: null, component: null, flags: [number], fs: null, fsLength: number) => number
}

interface Win32ErrnoException extends NodeJS.ErrnoException {
  win32Code: number
}

const DACL_SECURITY_INFORMATION = 0x00000004
const PROTECTED_DACL_SECURITY_INFORMATION = 0x80000000
const ERROR_FILE_NOT_FOUND = 2
const ERROR_PATH_NOT_FOUND = 3
const ERROR_ACCESS_DENIED = 5

let bindings: Win32Bindings | undefined

async function win32(): Promise<Win32Bindings> {
  if (bindings !== undefined) return bindings
  const koffi = (await import('koffi')).default
  const advapi32 = koffi.load('advapi32.dll')
  const kernel32 = koffi.load('kernel32.dll')
  bindings = {
    getFileSecurityW: advapi32.func('int __stdcall GetFileSecurityW(const char16_t *path, uint32_t requested, void *descriptor, uint32_t length, _Out_ uint32_t *needed)') as GetFileSecurityW,
    setFileSecurityW: advapi32.func('int __stdcall SetFileSecurityW(const char16_t *path, uint32_t information, const void *descriptor)') as SetFileSecurityW,
    replaceFileW: kernel32.func('int __stdcall ReplaceFileW(const char16_t *replaced, const char16_t *replacement, const char16_t *backup, uint32_t flags, void *exclude, void *reserved)') as ReplaceFileW,
    getLastError: kernel32.func('uint32_t __stdcall GetLastError()') as GetLastError,
    moveFileExW: kernel32.func('int __stdcall MoveFileExW(const char16_t *source, const char16_t *destination, uint32_t flags)') as Win32Bindings['moveFileExW'],
    getVolumePathNameW: kernel32.func('int __stdcall GetVolumePathNameW(const char16_t *path, _Out_ char16_t *buffer, uint32_t length)') as Win32Bindings['getVolumePathNameW'],
    getVolumeInformationW: kernel32.func('int __stdcall GetVolumeInformationW(const char16_t *root, void *name, uint32_t nameLength, void *serial, void *component, _Out_ uint32_t *flags, void *fs, uint32_t fsLength)') as Win32Bindings['getVolumeInformationW'],
  }
  return bindings
}

function errnoCode(win32Code: number): string {
  switch (win32Code) {
    case ERROR_FILE_NOT_FOUND:
    case ERROR_PATH_NOT_FOUND:
      return 'ENOENT'
    case ERROR_ACCESS_DENIED:
      return 'EACCES'
    case 80:
    case 183:
      return 'EEXIST'
    default:
      return 'EIO'
  }
}

async function supportsPersistentAcls(path: string): Promise<boolean> {
  const api = await win32()
  const root = Buffer.alloc(32768 * 2)
  if (api.getVolumePathNameW(toNamespacedPath(dirname(path)), root, 32768) === 0) {
    throw win32Error('GetVolumePathNameW', api.getLastError(), path)
  }
  const flags: [number] = [0]
  const rootPath = root.toString('utf16le').split('\0', 1)[0]!
  if (api.getVolumeInformationW(rootPath, null, 0, null, null, flags, null, 0) === 0) {
    throw win32Error('GetVolumeInformationW', api.getLastError(), path)
  }
  return (flags[0] & 0x8) !== 0 // FILE_PERSISTENT_ACLS
}

/**
 * Publish a closed, same-volume staging file without replacing a concurrent destination.
 * MoveFileEx works on NTFS, FAT32 and exFAT without requiring hard links.
 * @param source - closed staging file.
 * @param destination - destination that must not already exist.
 */
export async function publishFileWin32(source: string, destination: string): Promise<void> {
  const api = await win32()
  if (api.moveFileExW(toNamespacedPath(source), toNamespacedPath(destination), 0x8) === 0) {
    throw win32Error('MoveFileExW', api.getLastError(), destination)
  }
}

function win32Error(syscall: string, win32Code: number, path: string): Win32ErrnoException {
  const code = errnoCode(win32Code)
  const error = new Error(`${syscall} ${code} (Win32 ${win32Code}): ${path}`) as Win32ErrnoException
  error.code = code
  error.errno = win32Code
  error.syscall = syscall
  error.path = path
  error.win32Code = win32Code
  return error
}

/**
 * Read a file's self-relative DACL security descriptor.
 * @param path - existing file whose DACL is read.
 * @returns a descriptor buffer accepted by `SetFileSecurityW`.
 */
export async function readFileDaclWin32(path: string): Promise<Buffer> {
  const api = await win32()
  const nativePath = toNamespacedPath(path)
  const needed: [number] = [0]
  api.getFileSecurityW(nativePath, DACL_SECURITY_INFORMATION, null, 0, needed)
  if (needed[0] === 0) throw win32Error('GetFileSecurityW', api.getLastError(), path)

  const descriptor = Buffer.alloc(needed[0])
  if (api.getFileSecurityW(nativePath, DACL_SECURITY_INFORMATION, descriptor, descriptor.length, needed) === 0) {
    throw win32Error('GetFileSecurityW', api.getLastError(), path)
  }
  return descriptor.subarray(0, needed[0])
}

/**
 * Copy an existing file's DACL onto another file and protect it from staging-parent inheritance.
 * The destination must still be empty when confidentiality depends on this call.
 * @param source - existing file whose DACL is copied.
 * @param destination - existing file that receives the protected DACL.
 */
export async function copyFileDaclWin32(source: string, destination: string): Promise<void> {
  if (!await supportsPersistentAcls(source)) return
  const descriptor = await readFileDaclWin32(source)
  const api = await win32()
  const information = (DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION) >>> 0
  if (api.setFileSecurityW(toNamespacedPath(destination), information, descriptor) === 0) {
    throw win32Error('SetFileSecurityW', api.getLastError(), destination)
  }
}

/**
 * Replace a Windows file while preserving the replaced file's ACL and other replace metadata.
 * @param replaced - existing destination file.
 * @param replacement - closed staging file on the same volume.
 */
export async function replaceFileWin32(replaced: string, replacement: string): Promise<void> {
  const api = await win32()
  if (!await supportsPersistentAcls(replaced)) {
    if (api.moveFileExW(toNamespacedPath(replacement), toNamespacedPath(replaced), 0x9) === 0) {
      throw win32Error('MoveFileExW', api.getLastError(), replaced)
    }
    return
  }
  if (api.replaceFileW(
    toNamespacedPath(replaced),
    toNamespacedPath(replacement),
    null,
    0,
    null,
    null,
  ) === 0) {
    throw win32Error('ReplaceFileW', api.getLastError(), replaced)
  }
}
