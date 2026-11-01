"""Write standard UTF-8 ZIP names independently of the Windows system code page."""
from pathlib import Path
import sys
import zipfile

folder, output = Path(sys.argv[1]), Path(sys.argv[2])
rootless = len(sys.argv) > 3 and sys.argv[3] == '--rootless'
base = folder if rootless else folder.parent
with zipfile.ZipFile(output, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=1) as archive:
    if not rootless:
        archive.write(folder, folder.name + '/')
    for path in sorted(folder.rglob('*')):
        if path.is_symlink():
            raise RuntimeError('Release paths must not be filesystem links')
        archive.write(path, path.relative_to(base).as_posix() + ('/' if path.is_dir() else ''))
