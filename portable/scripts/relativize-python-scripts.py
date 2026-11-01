"""Replace build-machine Python console launchers with relative portable commands."""
import importlib.metadata
from pathlib import Path
import re
import sys

scripts = Path(sys.executable).parent / "Scripts"
scripts.mkdir(exist_ok=True)
for dist in importlib.metadata.distributions():
    for entry in dist.entry_points:
        if entry.group != "console_scripts":
            continue
        module, function = entry.value.split(":", 1)
        function = function.split("[", 1)[0].strip()
        if not re.fullmatch(r"[\w.-]+", entry.name) or not re.fullmatch(r"[\w.]+", module) or not re.fullmatch(r"[\w.]+", function):
            raise RuntimeError("Unsupported console entry point: " + entry.value)
        code = f"import sys; from {module} import {function}; sys.exit({function}())"
        (scripts / (entry.name + ".cmd")).write_text(
            '@echo off\n"%~dp0..\\python.exe" -c "' + code + '" %*\nexit /b %errorlevel%\n', encoding="utf-8", newline="\r\n")
        for suffix in (".exe", "-script.py"):
            (scripts / (entry.name + suffix)).unlink(missing_ok=True)
print("Python console commands use relative interpreter paths")
