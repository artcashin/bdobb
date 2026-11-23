"""Prepared V3 installer supplement; native execution only on ephemeral hosted CI."""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import platform
import plistlib
import re
import shutil
import subprocess
import sys
import tempfile
import urllib.request

RUN_ATTEMPT = 1
CONTROLLER = '205d83afce56d13dfdc8d91ec3e311c977b33bd4'
SOURCE = 'de25611461ad0559ce237c4f59b812decd91dec1'
OFFER = '19c760a782e0ab84152ee990e8f9014f7e677f448bc58d6a3e548d8f485f1c6b'
TRIPLES = {'mac-arm': 'aarch64-apple-darwin', 'mac-intel': 'x86_64-apple-darwin', 'windows': 'x86_64-pc-windows-msvc', 'linux-x64': 'x86_64-unknown-linux-gnu'}
BUILDS = {target: {'run': 45082804450, 'controller': CONTROLLER} for target in TRIPLES}
BUILDS['windows'] = {'run': 45083124393, 'controller': '1d315d088377948219c440b56f230fb70ffbe273'}
BUILDS['mac-arm']['artifact_id'] = 14778397164
BUILDS['mac-intel']['artifact_id'] = 14778680808
AUDITOR = '60866feb4f0e933f9264628c12911be810516de0'


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def command(args, **kwargs):
    return subprocess.run(list(map(str, args)), check=True, text=True, **kwargs)


def read_json(path):
    return json.loads(path.read_text(encoding='utf-8-sig'))


def validate_run(value, target, jobs, artifacts):
    build = BUILDS[target]
    expected = {'id': build['run'], 'run_attempt': RUN_ATTEMPT, 'head_sha': build['controller'], 'event': 'workflow_dispatch',
                'path': '.github/workflows/release.yml'}
    if any(value.get(key) != wanted for key, wanted in expected.items()) or value.get('repository', {}).get('full_name') != 'artcashin/bdobb':
        raise ValueError('Original owned qualification run identity mismatch; no installation allowed')
    selected_jobs = [j for j in jobs.get('jobs', []) if j.get('name') == f'V3 {target} native qualification']
    if len(selected_jobs) != 1 or selected_jobs[0].get('status') != 'completed' or selected_jobs[0].get('conclusion') != 'success':
        raise ValueError('Exact original native target job has not succeeded')
    selected_artifacts = [a for a in artifacts.get('artifacts', []) if a.get('name') == f'qualified-v3-{target}']
    if len(selected_artifacts) != 1:
        raise ValueError('Exact original target artifact absent or ambiguous')
    artifact = selected_artifacts[0]
    if build.get('artifact_id') is not None and artifact.get('id') != build['artifact_id']:
        raise ValueError('Immutable original artifact ID mismatch')
    if artifact.get('expired') is not False or not isinstance(artifact.get('id'), int) or artifact['id'] <= 0 or artifact.get('workflow_run', {}).get('id') != build['run'] or artifact.get('workflow_run', {}).get('head_sha') != build['controller']:
        raise ValueError('Original immutable artifact provenance mismatch')
    return dict(expected, repository='artcashin/bdobb', target=target, job_id=selected_jobs[0]['id'], job_conclusion='success',
                artifact_id=artifact['id'], artifact_name=artifact['name'])


def validate_artifact(root, target, controller):
    stage = root / 'release-stage'
    expected = set(controller.expected_names(target))
    if {p.name for p in stage.iterdir() if p.name.startswith('BDOBB')} != expected:
        raise ValueError('Original target artifact package set mismatch')
    records = read_json(stage / 'qualification.json')
    scans = read_json(stage / 'scan.json')
    if set(records) != expected or set(scans) != expected:
        raise ValueError('Original scan/qualification package set mismatch')
    checksums = {}
    for line in (stage / 'SHA256SUMS').read_text().splitlines():
        match = re.fullmatch(r'([0-9a-f]{64})  ([A-Za-z0-9_.-]+)', line)
        if not match or match[2] in checksums:
            raise ValueError('Malformed or duplicate original checksum')
        checksums[match[2]] = match[1]
    if set(checksums) != expected:
        raise ValueError('Original checksum set mismatch')
    identity = read_json(root / 'qualification-evidence/build-identity.json')
    for key, wanted in {'source_commit': SOURCE, 'source_id': OFFER, 'controller_commit': BUILDS[target]['controller'], 'target': TRIPLES[target]}.items():
        if identity.get(key) != wanted:
            raise ValueError('Original build identity mismatch: ' + key)
    for name in expected:
        package = stage / name
        record = records[name]
        if package.is_symlink() or not package.is_file() or not package.stat().st_size:
            raise ValueError('Expected regular original installer')
        sha = digest(package)
        if sha != checksums[name] or sha != scans[name].get('sha256') or sha != record.get('sha256'):
            raise ValueError('Original package/scan/qualification/checksum digest mismatch')
        if record.get('source_commit') != SOURCE or record.get('source_id') != OFFER or record.get('runtime', {}).get('status') != 'PASS':
            raise ValueError('Original source/runtime qualification missing')
        if record.get('embedded_offer') != controller.EXPECTED_OFFER or record.get('embedded_defaults') != 'all six exact empty values verified by app checker':
            raise ValueError('Original decoded defaults/offer proof missing')
        if record.get('architecture') != controller.TARGETS[target][0] or not re.fullmatch('[0-9a-f]{64}', record.get('executable_sha256', '')):
            raise ValueError('Original executable identity missing')
    suffix = '.dmg' if target.startswith('mac-') else '.msi' if target == 'windows' else '.deb'
    selected = [name for name in expected if name.endswith(suffix)]
    if len(selected) != 1:
        raise ValueError('Expected exactly one selected installer')
    name = selected[0]
    return stage / name, records[name]


def load_controller(path):
    if command(['git', '-C', path, 'rev-parse', 'HEAD'], capture_output=True).stdout.strip() != CONTROLLER:
        raise ValueError('Runtime reference controller is not exactly pinned')
    spec = importlib.util.spec_from_file_location('v3_runtime_reference', path / '.github/scripts/v3_qualification.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def load_supplement_runtime():
    root = Path(__file__).resolve().parents[3]
    expected = os.environ.get('GITHUB_SHA', '')
    if not re.fullmatch('[0-9a-f]{40}', expected) or command(['git', '-C', root, 'rev-parse', 'HEAD'], capture_output=True).stdout.strip() != expected:
        raise ValueError('Supplement runtime must match owned dispatched controller')
    command(['git', '-C', root, 'diff', '--quiet', 'HEAD', '--'], capture_output=True)
    spec = importlib.util.spec_from_file_location('v3_supplement_runtime', root / '.github/scripts/v3_qualification.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    if module.SOURCE_COMMIT != SOURCE or module.SOURCE_ID != OFFER:
        raise ValueError('Supplement runtime product binding mismatch')
    return module


def preflight(target, q):
    if os.environ.get('GITHUB_ACTIONS') != 'true' or os.environ.get('RUNNER_ENVIRONMENT') != 'github-hosted':
        raise ValueError('Installation restricted to fresh GitHub-hosted runners')
    actual = {'arm64': 'aarch64', 'AMD64': 'x86_64'}.get(platform.machine(), platform.machine())
    if actual != q.TARGETS[target][0]:
        raise ValueError('Runner must natively match package')
    if platform.system() == 'Windows':
        parent = q.windows_roaming()
        if any((parent / name).exists() for name in ['com.artcashin.bdobb', 'com.artcashin.bdobb.clean.v3.repair']):
            raise ValueError('Existing native Windows app/migration profile; refusing installation')


def windows(args, mode, package, evidence):
    command(['powershell', '-NoProfile', '-File', Path(__file__).with_name('windows_install.ps1'),
             '-Mode', mode, '-Package', package, '-Evidence', evidence])


def install_and_launch(args):
    q = load_controller(args.controller)
    runtime_q = load_supplement_runtime()
    if command(['git', '-C', args.auditor, 'rev-parse', 'HEAD'], capture_output=True).stdout.strip() != AUDITOR:
        raise ValueError('Independent auditor is not exactly pinned')
    preflight(args.target, q)
    if command(['git', '-C', args.app, 'rev-parse', 'HEAD'], capture_output=True).stdout.strip() != SOURCE:
        raise ValueError('App scanner source is not pinned')
    # This evidence is produced by the separate read-only GitHub API step.
    provenance = read_json(args.evidence / 'original-run.json')
    expected_provenance = {'id': BUILDS[args.target]['run'], 'run_attempt': RUN_ATTEMPT, 'head_sha': BUILDS[args.target]['controller'],
                           'event': 'workflow_dispatch', 'path': '.github/workflows/release.yml', 'repository': 'artcashin/bdobb',
                           'target': args.target, 'job_conclusion': 'success', 'artifact_name': f'qualified-v3-{args.target}'}
    if any(provenance.get(key) != wanted for key, wanted in expected_provenance.items()) or not isinstance(provenance.get('artifact_id'), int) or provenance['artifact_id'] <= 0:
        raise ValueError('Pinned successful original target-job/artifact receipt missing')
    package, original = validate_artifact(args.artifacts, args.target, q)
    evidence = args.evidence / args.target
    evidence.mkdir()
    gate = q.load_release_gate(args.auditor)
    expected_arch = q.TARGETS[args.target][0]
    receipt = {'original_run': BUILDS[args.target]['run'], 'original_run_attempt': RUN_ATTEMPT, 'controller_commit': BUILDS[args.target]['controller'],
               'artifact_validation_controller': CONTROLLER, 'runtime_controller': os.environ['GITHUB_SHA'], 'auditor_commit': AUDITOR, 'original_artifact_id': provenance['artifact_id'],
               'source_commit': SOURCE, 'source_id': OFFER, 'package': package.name, 'sha256': original['sha256'],
               'target': args.target, 'architecture': expected_arch, 'status': 'INCOMPLETE'}
    installed = False
    package_name = None
    with tempfile.TemporaryDirectory(prefix='v3-install-', dir=os.environ['RUNNER_TEMP']) as temporary:
        work = Path(temporary)
        try:
            if args.target.startswith('mac-'):
                mount = work / 'mount'
                mount.mkdir()
                apps = work / 'Applications'
                apps.mkdir()
                bundle = apps / 'BDOBB.app'
                command(['hdiutil', 'attach', '-readonly', '-nobrowse', '-noautoopen', '-mountpoint', mount, package], capture_output=True)
                try:
                    source_bundle = mount / 'BDOBB.app'
                    if not source_bundle.is_dir() or source_bundle.is_symlink():
                        raise ValueError('Exact mounted DMG lacks expected app')
                    command(['ditto', source_bundle, bundle], capture_output=True)
                    installed = True
                finally:
                    command(['hdiutil', 'detach', mount], capture_output=True)
                executable = bundle / 'Contents/MacOS/bdobb'
                # Tauri's configured product name may retain capitalisation.
                if not executable.exists():
                    executable = bundle / 'Contents/MacOS/BDOBB'
                meta = plistlib.loads((bundle / 'Contents/Info.plist').read_bytes())
                if meta.get('CFBundleShortVersionString') != '3.0.0' or meta.get('CFBundleIdentifier') != 'com.artcashin.bdobb':
                    raise ValueError('Installed app-copy bundle identity/version mismatch')
                command(['codesign', '--verify', '--deep', '--strict', bundle], capture_output=True)
                receipt['installation'] = {'method': 'DMG mounted read-only; ditto app-copy installation into private runner Applications directory',
                                           'installed_path': str(bundle), 'bundle_version': meta['CFBundleShortVersionString'],
                                           'signature': 'ad hoc verified; no Gatekeeper/notarization/global LaunchServices registration claim'}
            elif args.target == 'linux-x64':
                package_name = command(['dpkg-deb', '-f', package, 'Package'], capture_output=True).stdout.strip()
                version = command(['dpkg-deb', '-f', package, 'Version'], capture_output=True).stdout.strip()
                if package_name != 'bdobb' or version not in {'3.0.0', '3.0.0-1'}:
                    raise ValueError('Exact DEB package identity/version mismatch')
                existing = subprocess.run(['dpkg-query', '-W', '-f=${Status}', package_name], text=True, capture_output=True)
                if existing.returncode == 0 or existing.stdout.strip():
                    raise ValueError('Pre-existing Debian package; refusing installation')
                installed = True  # dpkg may partially install before returning an error; always purge it.
                command(['sudo', 'dpkg', '-i', package], capture_output=True)
                status = command(['dpkg-query', '-W', '-f=${Status}\n${Version}\n', package_name], capture_output=True).stdout
                if status.splitlines() != ['install ok installed', version]:
                    raise ValueError('dpkg installed registration/version mismatch')
                paths = command(['dpkg-query', '-L', package_name], capture_output=True).stdout.splitlines()
                executable = Path('/usr/bin/bdobb')
                if str(executable) not in paths:
                    raise ValueError('Installed DEB does not register expected native executable')
                receipt['installation'] = {'method': 'sudo dpkg -i exact original DEB; no dependency repair/rebuild', 'package': package_name,
                                           'version': version, 'dpkg_query': status, 'installed_path': str(executable), 'registered_paths': paths}
            elif args.target == 'windows':
                # PowerShell rechecks absence before invoking MSI; cleanup uses original MSI.
                windows(args, 'Preflight', package, evidence)
                installed = True
                windows(args, 'Install', package, evidence)
                receipt['installation'] = read_json(evidence / 'windows-install.json')
                executable = Path(receipt['installation']['installed_path'])
            else:
                raise ValueError('No installer supplement defined for target')
            if not executable.is_file() or executable.is_symlink() or digest(executable) != original['executable_sha256']:
                raise ValueError('Actual installed executable differs from original scanned executable')
            q.require_arch(executable, expected_arch)
            frontend = work / 'installed-frontend'
            command(['tauri-dumper', 'extract', executable, '-o', frontend, '--json'], capture_output=True)
            gate.check_frontend(frontend)
            q.verify_offer(frontend)
            receipt['installed_executable_sha256'] = digest(executable)
            receipt['embedded_defaults'] = 'all six exact empty values verified again from installed executable'
            receipt['embedded_offer'] = q.EXPECTED_OFFER
            runtime = runtime_q.native_runtime(executable, package, work, evidence, expected_arch)
            runtime['method'] = 'actual installed executable launched after recorded platform installation; installer dialog not exercised'
            receipt['runtime'] = runtime
            if digest(package) != original['sha256'] or digest(executable) != original['executable_sha256']:
                raise ValueError('Package or installed executable changed during runtime smoke')
        finally:
            if installed:
                if args.target == 'windows':
                    windows(args, 'Remove', package, evidence)
                    receipt['cleanup'] = read_json(evidence / 'windows-remove.json')
                elif args.target == 'linux-x64':
                    command(['sudo', 'dpkg', '--purge', package_name], capture_output=True)
                    removed = subprocess.run(['dpkg-query', '-W', '-f=${Status}', package_name], text=True, capture_output=True)
                    if removed.returncode == 0 or Path('/usr/bin/bdobb').exists():
                        raise ValueError('DEB cleanup failed')
                    receipt['cleanup'] = {'method': 'dpkg --purge', 'package_absent': True, 'installed_executable_absent': True}
                else:
                    shutil.rmtree(bundle)
                    if bundle.exists():
                        raise ValueError('App-copy cleanup failed')
                    receipt['cleanup'] = {'method': 'remove only private installed app copy', 'installed_bundle_absent': True}
            (evidence / 'install-receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')
        receipt['status'] = 'PASS'
        (evidence / 'install-receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode', choices=['verify-run', 'install'])
    parser.add_argument('--controller', type=Path)
    parser.add_argument('--app', type=Path)
    parser.add_argument('--auditor', type=Path)
    parser.add_argument('--artifacts', type=Path)
    parser.add_argument('--target', choices=TRIPLES)
    parser.add_argument('--evidence', type=Path, required=True)
    args = parser.parse_args()
    if args.mode == 'verify-run':
        args.evidence.mkdir()
        build_run = BUILDS[args.target]['run']
        def get(path):
            request = urllib.request.Request('https://api.github.com/repos/artcashin/bdobb/' + path,
                                             headers={'Authorization': 'Bearer ' + os.environ['GH_READ_TOKEN'], 'Accept': 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28'})
            with urllib.request.urlopen(request, timeout=60) as response:
                return json.load(response)
        run = get(f'actions/runs/{build_run}')
        jobs = get(f'actions/runs/{build_run}/attempts/{RUN_ATTEMPT}/jobs?per_page=100')
        artifacts = get(f'actions/runs/{build_run}/artifacts?per_page=100')
        if jobs.get('total_count', 0) > 100 or artifacts.get('total_count', 0) > 100:
            raise ValueError('Unexpected pagination; refuse partial provenance verification')
        record = validate_run(run, args.target, jobs, artifacts)
        (args.evidence / 'original-run.json').write_text(json.dumps(record, indent=2) + '\n')
        with Path(os.environ['GITHUB_OUTPUT']).open('a') as output:
            output.write(f"build_run={build_run}\nartifact_id={record['artifact_id']}\n")
    else:
        for name in ['controller', 'app', 'auditor', 'artifacts', 'evidence']:
            setattr(args, name, getattr(args, name).resolve())
        install_and_launch(args)


if __name__ == '__main__':
    main()
