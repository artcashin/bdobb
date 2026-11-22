#!/usr/bin/env python3
"""Bind published installer bytes to the successful scanner outputs."""
import hashlib
import json
from pathlib import Path
import sys

root = Path(sys.argv[1])
target = Path(sys.argv[2])
target.mkdir()
manifests = list(root.glob("scanned-*/scan.json"))
if len(manifests) != 5:
    raise SystemExit("Expected five scanned platform jobs")
for path in manifests:
    manifest = json.loads(path.read_text())
    files = {p.name for p in path.parent.iterdir() if p.is_file() and p.name != "scan.json"}
    if files != set(manifest):
        raise SystemExit("Scanned asset manifest differs from the downloaded files")
    for name, result in manifest.items():
        package = path.parent / name
        with package.open("rb") as src:
            digest = hashlib.file_digest(src, "sha256").hexdigest()
        if digest != result["sha256"] or (target / name).exists():
            raise SystemExit("Duplicate asset or scan digest mismatch")
        (target / name).write_bytes(package.read_bytes())
if len(list(target.iterdir())) != 12:
    raise SystemExit("Expected all twelve scanned desktop packages")
