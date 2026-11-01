"""Portable package locations and Windows restricted-token mkdir compatibility."""
import os
import sys


def _inside(root, target):
    try:
        return os.path.commonpath((root, target)) == root
    except ValueError:
        return False


# pip installs user packages into mutable data, never into the sealed application.
_target = os.environ.get("PIP_TARGET")
if _target:
    sys.path.insert(0, os.path.realpath(_target))

if sys.platform == "win32" and os.environ.get("DSH_PORTABLE_SANDBOX_ROOT"):
    import ctypes
    from ctypes import wintypes

    _advapi = ctypes.WinDLL("advapi32", use_last_error=True)
    _kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    _advapi.OpenProcessToken.argtypes = (wintypes.HANDLE, wintypes.DWORD, ctypes.POINTER(wintypes.HANDLE))
    _advapi.OpenProcessToken.restype = wintypes.BOOL
    _advapi.IsTokenRestricted.argtypes = (wintypes.HANDLE,)
    _advapi.IsTokenRestricted.restype = wintypes.BOOL
    _kernel.GetCurrentProcess.restype = wintypes.HANDLE
    _kernel.CloseHandle.argtypes = (wintypes.HANDLE,)
    _token = wintypes.HANDLE()
    if not _advapi.OpenProcessToken(_kernel.GetCurrentProcess(), 0x8, ctypes.byref(_token)):
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        _restricted = bool(_advapi.IsTokenRestricted(_token))
    finally:
        _kernel.CloseHandle(_token)
    if _restricted:
        import atexit
        _roots = tuple(os.path.normcase(os.path.realpath(p)) for p in (
            os.environ["DSH_PORTABLE_SANDBOX_ROOT"],
            os.environ["DSH_PORTABLE_SANDBOX_TEMP"],
        ))
        _mkdir = os.mkdir
        _created_pip_dirs = set()

        def _portable_mkdir(path, mode=0o777, *, dir_fd=None):
            # CPython's Windows 0700 DACL omits the capability SID. Inherit
            # the already restricted parent ACL only within the granted trees.
            if mode == 0o700 and dir_fd is None:
                resolved = os.path.normcase(os.path.realpath(os.fsdecode(path)))
                if any(_inside(root, resolved) for root in _roots):
                    mode = 0o777
            result = _mkdir(path, mode, dir_fd=dir_fd)
            resolved = os.path.normcase(os.path.realpath(os.fsdecode(path)))
            if _inside(_roots[1], resolved) and os.path.basename(resolved).startswith("pip-"):
                _created_pip_dirs.add(resolved)
            return result

        os.mkdir = _portable_mkdir

        @atexit.register
        def _remove_own_empty_pip_dirs():
            for path in sorted(_created_pip_dirs, key=len, reverse=True):
                try:
                    if not os.path.islink(path):
                        os.rmdir(path)
                except OSError:
                    pass  # Nonempty or in-use directories remain intact.
