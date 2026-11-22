#!/usr/bin/env python3
"""Stage desktop release packages only after inspecting their installed bytes."""
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import struct
import subprocess
import sys
import tarfile
import tempfile


DEFAULTS = ("VITE_OPENBB_API_URL", "VITE_RITA_URL", "VITE_MCP_SERVERS", "VITE_SHARE_FOLDERS")
ASSIGNMENT = re.compile(
    rb'(?:["\x27`])?(' + b"|".join(key.encode() for key in DEFAULTS) +
    rb')(?:["\x27`])?\s*[:=]\s*(["\x27`])(?=\S)(?!\2)'
)
TAILNET = re.compile(rb"\b([a-z0-9-]+(?:\.[a-z0-9-]+)*)\.ts\.net\b", re.I)
PLACEHOLDERS = {b"your-tailnet", b"tailnet-name", b"example", b"example-tailnet", b"tailxxxxxx"}
FORMATS = {
    "Linux": (".deb", ".rpm", ".AppImage"),
    "macOS": (".dmg", ".app.tar.gz"),
    "Windows": ("-setup.exe", ".msi"),
}


class GateError(Exception):
    pass


def check_bytes(data, label):
    # Scanned package and executable bytes include plain text and UTF-16
    # strings. Removing NULs exposes ASCII UTF-16 in either endianness.
    data = data.replace(b"\0", b"")
    if match := ASSIGNMENT.search(data):
        raise GateError(f"Nonempty {match[1].decode()} in {label}")
    for host in TAILNET.findall(data):
        if host.lower().rsplit(b".", 1)[-1] not in PLACEHOLDERS:
            raise GateError(f"Tailnet hostname in {label}")


def run(*args):
    result = subprocess.run(list(map(str, args)), capture_output=True, timeout=240)
    if result.returncode:
        raise GateError(f"{Path(str(args[0])).name} failed with exit {result.returncode}")


def extract_7z(source, dest):
    exe = shutil.which("7zz") or shutil.which("7z") or Path(r"C:\Program Files\7-Zip\7z.exe")
    run(exe, "x", "-y", f"-o{dest}", "--", source)


def squashfs_offset(source):
    data = source.read_bytes()
    candidates = []
    for match in re.finditer(b"hsqs", data):
        at = match.start()
        if at + 96 > len(data):
            continue
        block = struct.unpack_from("<I", data, at + 12)[0]
        codec, shift, _, _, major, minor = struct.unpack_from("<6H", data, at + 20)
        size = struct.unpack_from("<Q", data, at + 40)[0]
        if major == 4 and minor == 0 and 1 <= codec <= 6 and block == 1 << shift and 96 < size <= len(data) - at:
            candidates.append(at)
    if len(candidates) != 1:
        raise GateError("Expected a single SquashFS AppImage payload")
    return candidates[0]


def unpack(source, dest):
    suffix = source.suffix
    if suffix == ".dmg":
        mount = dest / "mount"
        mount.mkdir()
        run("hdiutil", "attach", "-readonly", "-nobrowse", "-noautoopen", "-mountpoint", mount, source)
        try:
            shutil.copytree(mount, dest / "contents", symlinks=True)
        finally:
            run("hdiutil", "detach", mount)
    elif suffix == ".gz":
        with tarfile.open(source, "r:gz") as archive:
            archive.extractall(dest, filter="data")
    elif suffix == ".rpm":
        run("bsdtar", "-xf", source, "-C", dest)
    elif suffix == ".deb":
        run("bsdtar", "-xf", source, "-C", dest)
        pieces = [p for p in dest.iterdir() if p.name.startswith(("data.tar", "control.tar"))]
        if not any(piece.name.startswith("data.tar") for piece in pieces):
            raise GateError("Debian data archive missing")
        for piece in pieces:
            member = dest / (piece.name.split(".")[0] + "-contents")
            member.mkdir()
            run("bsdtar", "-xf", piece, "-C", member)
    elif suffix == ".AppImage":
        run("unsquashfs", "-no-progress", "-no-xattrs", "-o", squashfs_offset(source), "-d", dest / "contents", source)
    elif suffix in (".msi", ".exe"):
        extract_7z(source, dest / "installer")
        if suffix == ".msi":
            exe = shutil.which("7zz") or shutil.which("7z") or Path(r"C:\Program Files\7-Zip\7z.exe")
            run(exe, "x", "-tCompound", "-y", f"-o{dest / 'metadata'}", "--", source)
    else:
        raise GateError(f"Unsupported release format: {suffix}")


def scan_tree(root):
    files = []
    def unreadable(_error):
        raise GateError("Unreadable package directory")

    for directory, subdirs, names in os.walk(root, followlinks=False, onerror=unreadable):
        for name in sorted(subdirs + names):
            path = Path(directory) / name
            rel = path.relative_to(root)
            check_bytes(os.fsencode(str(rel)), "package path")
            if path.is_symlink():
                check_bytes(os.fsencode(os.readlink(path)), f"link {rel}")
            elif path.is_file():
                check_bytes(path.read_bytes(), str(rel))
                files.append(path)
            elif not path.is_dir():
                raise GateError("Unexpected file type in package")
    return files


def scan_package(asset):
    check_bytes(asset.read_bytes(), asset.name)
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        package = root / "package"
        package.mkdir()
        unpack(asset, package)
        files = scan_tree(package)
        targets = [f for f in files if f.name.lower() in {"bdobb", "bdobb.exe", "path"}]
        if len(targets) != 1:
            raise GateError(f"Expected one BDOBB executable in {asset.name}, found {len(targets)}")
        frontend = root / "frontend"
        run("tauri-dumper", "extract", targets[0], "-o", frontend, "--json")
        extracted = scan_tree(frontend)
        index = frontend / "index.html"
        if not index.is_file() or not any(f.suffix == ".js" for f in extracted):
            raise GateError(f"Embedded frontend missing in {asset.name}")
        for path in re.findall(r'(?:href|src)="(/assets/[^"]+)"', index.read_text(encoding="utf-8")):
            if not (frontend / path.lstrip("/")).is_file():
                raise GateError(f"Embedded entrypoint dependency missing in {asset.name}")
        return {"package_files": len(files), "frontend_files": len(extracted) - 1}


def select_assets(outputs, system):
    selected = []
    for extension in FORMATS[system]:
        matches = [p for p in outputs if p.is_file() and p.name.endswith(extension)]
        if len(matches) != 1:
            raise GateError(f"Expected one {extension} asset, found {len(matches)}")
        selected.append(matches[0])
    return selected


def main():
    if len(sys.argv) < 2 or sys.argv[1] not in {"check", "stage"}:
        raise GateError("Use check PACKAGE... or stage with the workflow build outputs")
    if sys.argv[1] == "check":
        for arg in sys.argv[2:]:
            asset = Path(arg)
            print(f"Passed {asset.name}: {scan_package(asset)}")
        return
    outputs = [Path(p).resolve() for p in json.loads(os.environ["BDOBB_ARTIFACT_PATHS"])]
    system = os.environ["RUNNER_OS"]
    stage = Path("release-stage").resolve()
    stage.mkdir()
    if system == "macOS" and not any(p.name.endswith(".app.tar.gz") for p in outputs):
        app = next((p for p in outputs if p.is_dir() and p.suffix == ".app"), None)
        if app is None:
            dmgs = [p for p in outputs if p.suffix == ".dmg"]
            if len(dmgs) == 1:
                bundles = list((dmgs[0].parent.parent / "macos").glob("*.app"))
                if len(bundles) == 1:
                    app = bundles[0]
        if app is not None:
            architecture = os.environ["BDOBB_RUST_TARGET"].split("-")[0]
            archive = stage / f"BDOBB_{architecture}.app.tar.gz"
            run("tar", "-czf", archive, "-C", app.parent, app.name)
            outputs.append(archive)
    selected = select_assets(outputs, system)
    manifest = {}
    for source in selected:
        dest = stage / source.name
        if source != dest:
            shutil.copyfile(source, dest)
        manifest[dest.name] = scan_package(dest)
        with dest.open("rb") as file:
            manifest[dest.name]["sha256"] = hashlib.file_digest(file, "sha256").hexdigest()
        print(f"Passed {dest.name}")
    (stage / "scan.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    try:
        main()
    except (GateError, OSError, ValueError, subprocess.TimeoutExpired, tarfile.TarError) as error:
        print(str(error) if isinstance(error, GateError) else f"Release scan failed: {type(error).__name__}", file=sys.stderr)
        sys.exit(1)
