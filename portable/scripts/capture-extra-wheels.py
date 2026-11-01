"""Refresh the small optional-runtime lock deliberately; normal builds never resolve versions."""
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import urllib.request
import zipfile
from email.parser import BytesParser

if "--refresh-lock" not in sys.argv:
    raise SystemExit("Pass --refresh-lock to refresh the extra wheel lock")
project = Path(__file__).resolve().parents[1]
work = project.parent
cache = work / "cache" / "extra-wheels"
cache.mkdir(parents=True, exist_ok=True)
subprocess.run([sys.executable, "-m", "pip", "download", "--only-binary=:all:", "--dest", str(cache),
                "--disable-pip-version-check", "--timeout", "60", "setuptools", "wheel", "requests", "pypdf"], check=True)
records = []
for wheel in sorted(cache.glob("*.whl")):
    with zipfile.ZipFile(wheel) as archive:
        name = next(n for n in archive.namelist() if n.endswith(".dist-info/METADATA"))
        meta = BytesParser().parsebytes(archive.read(name))
    with urllib.request.urlopen(f"https://pypi.org/pypi/{meta['Name']}/{meta['Version']}/json", timeout=60) as response:
        data = json.load(response)
    item = next(item for item in data["urls"] if item["filename"] == wheel.name)
    digest = hashlib.sha256(wheel.read_bytes()).hexdigest()
    if digest != item["digests"]["sha256"]:
        raise RuntimeError("Wheel integrity mismatch: " + wheel.name)
    records.append({"name": meta["Name"], "version": meta["Version"], "file": wheel.name,
                    "url": item["url"], "sha256": digest})
(project / "extra-wheels.lock.json").write_text(json.dumps(records, indent=2) + "\n", encoding="utf-8")
print("Locked", len(records), "verified wheels")
