#!/usr/bin/env python3
"""V3-only controller; app-owned scanners remain the authority for publication."""
import argparse
import ctypes
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import platform
import plistlib
import shutil
import signal
import struct
import subprocess
import sys
import tempfile
import time

SOURCE_COMMIT = "de25611461ad0559ce237c4f59b812decd91dec1"
SOURCE_ID = "19c760a782e0ab84152ee990e8f9014f7e677f448bc58d6a3e548d8f485f1c6b"
EXPECTED_OFFER = {
    "sourceId": SOURCE_ID,
    "baseCommit": "1cca004c7e708c989121e7f7db01fbf65fdd7920",
    "archiveFilename": "bdobb-v3.0.0-agpl-19c760a782e0-source.tar.gz",
    "archiveUrl": "https://github.com/Adventures-OpenBQ/bdobb/releases/download/agpl-v3.0.0-19c760a782e0/bdobb-v3.0.0-agpl-19c760a782e0-source.tar.gz",
}
TARGETS = {
    "mac-arm": ("aarch64", ["BDOBB_3.0.0_aarch64.dmg", "BDOBB_aarch64.app.tar.gz"]),
    "mac-intel": ("x86_64", ["BDOBB_3.0.0_x64.dmg", "BDOBB_x64.app.tar.gz"]),
    "windows": ("x86_64", ["BDOBB_3.0.0_x64-setup.exe", "BDOBB_3.0.0_x64_en-US.msi"]),
    "linux-x64": ("x86_64", ["BDOBB-3.0.0-1.x86_64.rpm", "BDOBB_3.0.0_amd64.AppImage", "BDOBB_3.0.0_amd64.deb"]),
    "linux-arm": ("aarch64", ["BDOBB-3.0.0-1.aarch64.rpm", "BDOBB_3.0.0_aarch64.AppImage", "BDOBB_3.0.0_arm64.deb"]),
}


def expected_names(target):
    return list(TARGETS[target][1])


def sha256(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def run(args, **kwargs):
    return subprocess.run(list(map(str, args)), check=True, text=True, **kwargs)


def binary_arch(path):
    with path.open("rb") as stream:
        header = stream.read(64)
        if header[:4] == b"\x7fELF" and header[5] == 1:
            value = struct.unpack_from("<H", header, 18)[0]
        elif header[:4] == b"\xcf\xfa\xed\xfe":
            value = struct.unpack_from("<I", header, 4)[0]
        elif header[:2] == b"MZ":
            stream.seek(struct.unpack_from("<I", header, 60)[0])
            pe = stream.read(6)
            if pe[:4] != b"PE\0\0":
                raise ValueError("Invalid PE executable")
            value = struct.unpack_from("<H", pe, 4)[0]
        else:
            raise ValueError("Unknown native executable header")
    for arch, values in {"aarch64": {183, 0x100000C, 0xAA64}, "x86_64": {62, 0x1000007, 0x8664}}.items():
        if value in values:
            return arch
    raise ValueError("Unexpected executable architecture")


def require_arch(path, expected):
    if binary_arch(path) != expected:
        raise ValueError("Executable architecture does not match native runner")


def require_packages(root, names):
    actual = {p.name for p in root.iterdir() if p.name.startswith("BDOBB")}
    if actual != set(names) or any(not (root / n).is_file() or not (root / n).stat().st_size for n in names):
        raise ValueError("Missing, empty, duplicate, or unexpected installer package")


def verify_offer(frontend):
    # Maps can contain dead source. Require offer values in shipped executable JS.
    for path in frontend.rglob("*.js"):
        text = path.read_text(encoding="utf-8")
        if all(value in text for value in EXPECTED_OFFER.values()):
            return
    raise ValueError("Final executable JavaScript does not embed the exact V3 source offer")


def verify_empty_profile(data):
    backend = data / "backends.json"
    if not backend.is_file() or json.loads(backend.read_text()) != []:
        raise ValueError("Fresh runtime did not persist exactly empty backends")
    workspace = data / "workspace.json"
    if workspace.exists() and json.loads(workspace.read_text()).get("connections") != []:
        raise ValueError("Fresh runtime contains Workspace connections")


def locate_executable(unpacked, package, work):
    allowed_names = {"bdobb", "bdobb.exe"}
    if package.suffix == ".msi":
        # WiX's CAB file identifier is Path; 7-Zip exposes that identifier.
        allowed_names.add("path")
    binaries = [p for p in unpacked.rglob("*") if p.is_file() and p.name.lower() in allowed_names]
    if len(binaries) != 1:
        raise ValueError("Expected exactly one final native executable")
    executable = binaries[0]
    member = str(executable.relative_to(unpacked))
    if executable.name.lower() == "path":
        installed = work / "installed"
        installed.mkdir()
        launch_copy = installed / "bdobb.exe"
        shutil.copy2(executable, launch_copy)
        if sha256(launch_copy) != sha256(executable):
            raise ValueError("MSI executable copy changed bytes")
        executable = launch_copy
    return executable, member


def load_release_gate(app):
    spec = importlib.util.spec_from_file_location("app_release_gate", app / "scripts/public-release.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def collect(app, target):
    root = app / "src-tauri/target" / os.environ["BDOBB_RUST_TARGET"] / "release/bundle"
    names = expected_names(target)
    found = []
    for name in names:
        if name.endswith(".app.tar.gz"):
            continue
        matches = list(root.rglob(name))
        if len(matches) != 1:
            raise ValueError(f"Expected one build output: {name}")
        found.append(matches[0])
    if target.startswith("mac-"):
        # Tauri can remove the intermediate .app after making the DMG.
        with tempfile.TemporaryDirectory(prefix="v3-archive-") as temp:
            unpacked = Path(temp)
            load_release_gate(app).unpack(found[0], unpacked)
            bundles = list(unpacked.rglob("BDOBB.app"))
            if len(bundles) != 1:
                raise ValueError("Expected one app in exact final DMG")
            archive = root / names[1]
            run(["tar", "-czf", archive, "-C", bundles[0].parent, bundles[0].name])
            found.append(archive)
    env = os.environ.copy()
    env["BDOBB_ARTIFACT_PATHS"] = json.dumps(list(map(str, found)))
    run([sys.executable, app / "scripts/public-release.py", "stage"], cwd=app, env=env)
    require_packages(app / "release-stage", names)


def windows_roaming():
    # dirs6 uses KnownFolder APIs; APPDATA replacement alone is insufficient.
    buffer = ctypes.create_unicode_buffer(32768)
    if ctypes.windll.shell32.SHGetFolderPathW(None, 26, None, 0, buffer) != 0:
        raise ValueError("Cannot resolve native Windows roaming profile")
    return Path(buffer.value)


def native_runtime(executable, package, work, evidence, expected_arch):
    home = work / "home"
    home.mkdir()
    env = os.environ.copy()
    env.update(HOME=str(home), CFFIXED_USER_HOME=str(home), XDG_DATA_HOME=str(home / ".local/share"), XDG_CONFIG_HOME=str(home / ".config"), XDG_CACHE_HOME=str(home / ".cache"))
    system = platform.system()
    if system == "Darwin":
        data = home / "Library/Application Support/com.artcashin.bdobb"
        profile = work / "profile.sb"
        # Only an ephemeral Actions runner is allowed. Never run on a workstation.
        protected = Path.home() / "Library"
        profile.write_text('(version 1)\n(allow default)\n' + ''.join(f'(deny file-read* file-write* (subpath "{protected / part}"))\n' for part in ["Application Support", "Caches", "Preferences", "WebKit", "HTTPStorages", "Saved Application State", "Logs"]))
        probe = work / "pathprobe.m"
        probe.write_text('#import <Foundation/Foundation.h>\nint main(){@autoreleasepool{puts([NSHomeDirectory() UTF8String]);}return 0;}\n')
        run(["clang", "-framework", "Foundation", probe, "-o", work / "pathprobe"], capture_output=True)
        result = run(["sandbox-exec", "-f", profile, work / "pathprobe"], env=env, capture_output=True)
        if result.stdout.strip() != str(home):
            raise ValueError("Foundation fresh-profile preflight failed")
        command = ["sandbox-exec", "-f", profile, executable]
    elif system == "Windows":
        data = windows_roaming() / "com.artcashin.bdobb"
        env["WEBVIEW2_USER_DATA_FOLDER"] = str(work / "webview2")
        command = [executable]
    else:
        data = home / ".local/share/com.artcashin.bdobb"
        command = [executable]
        if package.suffix == ".AppImage":
            appdir = executable.parents[2]
            if not (appdir / "AppRun").exists():
                raise ValueError("Extracted AppImage AppRun missing")
            env.update(APPDIR=str(appdir), APPIMAGE=str(package))
            command = [appdir / "AppRun"]
    if data.exists():
        raise ValueError("Native data directory existed before launch; refusing to read or reset it")
    if (data.parent / "com.artcashin.bdobb.clean.v3.repair").exists():
        raise ValueError("Migration profile exists before launch; refusing to read it")
    receipt = {"method": "exact package extraction and native executable launch; installer UI/system registration not exercised", "data_preflight_absent": True, "expected_arch": expected_arch, "host_arch": platform.machine(), "data_directory": str(data), "displayed_about": "not observed remotely; version 3.0.0 asserted from pinned Tauri config and package metadata; prior local ARM About proof is separate"}
    process = None
    try:
        with (evidence / "runtime.log").open("w") as log:
            process = subprocess.Popen(list(map(str, command)), env=env, stdout=log, stderr=subprocess.STDOUT, start_new_session=system != "Windows")
            deadline = time.monotonic() + 60
            while not (data / "backends.json").exists():
                if process.poll() is not None:
                    raise ValueError("Native app exited before seeding a fresh profile")
                if time.monotonic() >= deadline:
                    raise ValueError("Native app did not seed a fresh profile within 60 seconds")
                time.sleep(0.5)
            verify_empty_profile(data)
            time.sleep(3)
            if process.poll() is not None:
                raise ValueError("Native app exited during startup smoke")
            receipt["pid"] = process.pid
            receipt["backends"] = []
            if system == "Darwin":
                run(["sample", process.pid, "1", "1", "-file", evidence / "native-process.txt"], capture_output=True)
                sample = (evidence / "native-process.txt").read_text()
                line = next((x.strip() for x in sample.splitlines() if "Code Type:" in x), "")
                actual_code_type = "aarch64" if "ARM64" in line or "ARM-64" in line else "x86_64" if "X86-64" in line else None
                if "Translated" in line or actual_code_type != expected_arch:
                    raise ValueError("Native process architecture proof failed")
                receipt["native_process_code_type"] = line
            elif system == "Windows":
                run(["powershell", "-NoProfile", "-File", Path(__file__).with_name("v3_windows_uia.ps1"), "-AppPid", process.pid, "-Evidence", evidence, "-Executable", executable])
                receipt["ui"] = json.loads((evidence / "windows-ui.json").read_text(encoding="utf-8-sig"))
            else:
                result = run(["xdotool", "search", "--onlyvisible", "--pid", process.pid], capture_output=True)
                receipt["visible_windows"] = result.stdout.splitlines()
                if not receipt["visible_windows"]:
                    raise ValueError("Native Linux process has no visible window")
            receipt["status"] = "PASS"
            return receipt
    finally:
        if process is not None:
            if system == "Windows":
                subprocess.run(["taskkill", "/PID", str(process.pid), "/T", "/F"], capture_output=True)
            else:
                try:
                    os.killpg(process.pid, signal.SIGTERM)
                except ProcessLookupError:
                    pass
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)
        # Only this run's newly created ephemeral Windows data can be moved.
        if system == "Windows" and data.exists():
            shutil.move(str(data), work / "created-roaming-profile")


def qualify(app, target):
    if os.environ.get("GITHUB_ACTIONS") != "true" or os.environ.get("RUNNER_ENVIRONMENT") != "github-hosted":
        raise ValueError("Runtime smoke is restricted to ephemeral GitHub-hosted runners")
    expected_arch = TARGETS[target][0]
    host_arch = {"arm64": "aarch64", "AMD64": "x86_64"}.get(platform.machine(), platform.machine())
    if host_arch != expected_arch:
        raise ValueError("Runner must natively match target architecture")
    if run(["git", "rev-parse", "HEAD"], cwd=app, capture_output=True).stdout.strip() != SOURCE_COMMIT:
        raise ValueError("App checkout is not pinned final V3 source")
    gate = load_release_gate(app)
    stage = app / "release-stage"
    require_packages(stage, expected_names(target))
    if json.loads((app / "source-offer.json").read_text())["sourceId"] != SOURCE_ID:
        raise ValueError("App source-offer identity mismatch")
    if json.loads((app / "src-tauri/tauri.conf.json").read_text())["version"] != "3.0.0":
        raise ValueError("Tauri source version mismatch")
    records = {}
    scans = json.loads((stage / "scan.json").read_text())
    for name in expected_names(target):
        package = stage / name
        digest = sha256(package)
        if scans.get(name, {}).get("sha256") != digest:
            raise ValueError("Package changed after app-owned final scanner")
        evidence = app / "qualification-evidence" / name
        evidence.mkdir(parents=True)
        with tempfile.TemporaryDirectory(prefix="v3-runtime-", dir=os.environ["RUNNER_TEMP"]) as temp:
            work = Path(temp)
            unpacked = work / "unpacked"
            unpacked.mkdir()
            gate.unpack(package, unpacked)
            executable, member = locate_executable(unpacked, package, work)
            require_arch(executable, expected_arch)
            frontend = work / "frontend"
            run(["tauri-dumper", "extract", executable, "-o", frontend, "--json"], capture_output=True)
            gate.check_frontend(frontend)
            verify_offer(frontend)
            record = {"sha256": digest, "source_commit": SOURCE_COMMIT, "source_id": SOURCE_ID, "embedded_offer": EXPECTED_OFFER, "embedded_defaults": "all six exact empty values verified by app checker", "executable_sha256": sha256(executable), "architecture": expected_arch}
            record["extracted_executable_member"] = member
            record["launch_executable_name"] = executable.name
            if platform.system() == "Darwin":
                bundle = executable.parents[2]
                meta = plistlib.loads((bundle / "Contents/Info.plist").read_bytes())
                if meta.get("CFBundleShortVersionString") != "3.0.0" or meta.get("CFBundleIdentifier") != "com.artcashin.bdobb":
                    raise ValueError("Installed macOS bundle identity/version mismatch")
                result = run(["codesign", "--verify", "--deep", "--strict", bundle], capture_output=True)
                record["signature"] = "valid ad hoc; no Developer ID/notarization/Gatekeeper claim"
            record["runtime"] = native_runtime(executable, package, work, evidence, expected_arch)
            if sha256(package) != digest:
                raise ValueError("Package changed during runtime qualification")
            records[name] = record
    (stage / "qualification.json").write_text(json.dumps(records, indent=2) + "\n")
    (stage / "SHA256SUMS").write_text("".join(f"{r['sha256']}  {n}\n" for n, r in sorted(records.items())))


def aggregate(root):
    expected = {name for target in TARGETS for name in expected_names(target)}
    result = {}
    for manifest in root.rglob("qualification.json"):
        records = json.loads(manifest.read_text())
        for name, record in records.items():
            if name not in expected or name in result or Path(name).name != name:
                raise ValueError("Duplicate, unexpected, or unsafe artifact in qualification manifests")
            path = manifest.parent / name
            if not path.is_file() or sha256(path) != record["sha256"]:
                raise ValueError("Downloaded installer digest does not match scanned qualification")
            if record.get("source_commit") != SOURCE_COMMIT or record.get("source_id") != SOURCE_ID or record.get("runtime", {}).get("status") != "PASS":
                raise ValueError("Installer source identity or runtime qualification missing")
            result[name] = record
    if set(result) != expected:
        raise ValueError("Expected all twelve original V3 installers")
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=["collect", "qualify", "aggregate"])
    parser.add_argument("--app", type=Path, default=Path.cwd())
    parser.add_argument("--target", choices=TARGETS)
    parser.add_argument("--root", type=Path)
    args = parser.parse_args()
    if args.mode == "collect":
        collect(args.app.resolve(), args.target)
    elif args.mode == "qualify":
        qualify(args.app.resolve(), args.target)
    else:
        records = aggregate(args.root)
        output = Path("qualification-all12")
        output.mkdir()
        (output / "qualification.json").write_text(json.dumps(records, indent=2) + "\n")
        (output / "SHA256SUMS").write_text("".join(f"{r['sha256']}  {n}\n" for n, r in sorted(records.items())))
        print("Verified all 12 exact original V3 installers and native-runtime receipts")


if __name__ == "__main__":
    main()
