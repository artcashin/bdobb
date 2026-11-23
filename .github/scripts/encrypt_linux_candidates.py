"""QA-only encrypted retention; never declares packages scanned or qualified."""
import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import platform
import re
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
import urllib.request

SOURCE = 'de25611461ad0559ce237c4f59b812decd91dec1'
OFFER = '19c760a782e0ab84152ee990e8f9014f7e677f448bc58d6a3e548d8f485f1c6b'
AUDITOR = '60866feb4f0e933f9264628c12911be810516de0'
RECIPIENT = 'age1uxxwajvn8cc73sr6pgzktjjef33mfawxev3w6766a80j5cqupf4s7m0rd8'
RECIPIENT_FINGERPRINT = '7f16b8c7475f4c819356d22e4fb3d35407aa6ce18176d59013ad9d0a39b50448'
AGE_VERSION = '1.3.2'
TARGETS = {
    'linux-x64': {'machine': 'x86_64', 'triple': 'x86_64-unknown-linux-gnu', 'age_arch': 'amd64',
                  'files': {'appimage': 'BDOBB_3.0.0_amd64.AppImage', 'deb': 'BDOBB_3.0.0_amd64.deb', 'rpm': 'BDOBB-3.0.0-1.x86_64.rpm'}},
    'linux-arm': {'machine': 'aarch64', 'triple': 'aarch64-unknown-linux-gnu', 'age_arch': 'arm64',
                  'files': {'appimage': 'BDOBB_3.0.0_aarch64.AppImage', 'deb': 'BDOBB_3.0.0_arm64.deb', 'rpm': 'BDOBB-3.0.0-1.aarch64.rpm'}},
}
AGE = {
    'amd64': {'archive_sha256': 'cbe24006683f8eb669266162894b9a522a1af52f2665fbc63a4bb032ed26ac10', 'archive_size': 19405817,
              'binary_sha256': 'eb7dd1b518f0a307c99cd97782623c5321da049154b04acd2d98d21aa7bc9b2c', 'binary_size': 6977014},
    'arm64': {'archive_sha256': '6b8dc4333c53a5a57c9e5834e3a48f92605d7154014cd07269ff3327db5d37f4', 'archive_size': 17771923,
              'binary_sha256': '41b072352f4561018949623c674d16ef704019b9108a9bbdbd21292efebfc94f', 'binary_size': 6540637},
}
FAILURE_STAGES = ('package-scan', 'native-qualification', 'evidence-scan')
DEPENDENCY_PACKAGES = ('libgtk-3-0', 'libglib2.0-0', 'libgnutls30', 'gsettings-desktop-schemas', 'tilix', 'tilix-common')


class RetentionError(Exception):
    """A fixed diagnostic code only; never carry candidate contents or input values."""


def file_hash(path):
    with os.fdopen(os.open(path, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0)), 'rb') as stream:
        if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
            raise RetentionError('UNSAFE_FILE')
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def physical_directory(path):
    # Reject symlink ancestors too, including an aliased candidate parent.
    for part in [path, *path.parents]:
        if not stat.S_ISDIR(part.lstat().st_mode):
            raise RetentionError('UNSAFE_DIRECTORY')


def regular_file(path):
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_size <= 0:
        raise RetentionError('UNSAFE_FILE')
    return info


def select_candidates(bundle, target):
    physical_directory(bundle)
    wanted = TARGETS[target]['files']
    selected = {name: [] for name in wanted.values()}
    def unreadable(_error):
        raise RetentionError('UNREADABLE_BUNDLE')
    # AppDir intermediate trees legitimately contain unrelated internal links.
    # Never follow those links; only regular installer outputs can be selected.
    for directory, subdirs, names in os.walk(bundle, followlinks=False, onerror=unreadable):
        for name in subdirs + names:
            if name.lower().endswith(('.deb', '.rpm', '.appimage')):
                path = Path(directory) / name
                if name not in selected:
                    raise RetentionError('EXTRA_INSTALLER')
                regular_file(path)
                selected[name].append(path)
    result = []
    for directory, name in sorted(wanted.items()):
        expected = bundle / directory / name
        if selected[name] != [expected]:
            raise RetentionError('MISSING_OR_AMBIGUOUS_INSTALLER')
        physical_directory(expected.parent)
        result.append(expected)
    return sorted(result, key=lambda path: path.name)


def snapshot_candidates(selected, snapshot):
    snapshot.mkdir(mode=0o700)
    records = []
    for source in selected:
        initial = regular_file(source)
        before = file_hash(source)
        destination = snapshot / source.name
        flags = os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0)
        with os.fdopen(os.open(source, flags), 'rb') as reader:
            opened = os.fstat(reader.fileno())
            if not stat.S_ISREG(opened.st_mode) or (opened.st_dev, opened.st_ino, opened.st_size) != (initial.st_dev, initial.st_ino, initial.st_size):
                raise RetentionError('CANDIDATE_CHANGED')
            with destination.open('xb') as writer:
                shutil.copyfileobj(reader, writer, length=1024 * 1024)
        destination.chmod(0o600)
        if destination.stat().st_size != initial.st_size or file_hash(destination) != before or file_hash(source) != before:
            raise RetentionError('CANDIDATE_CHANGED')
        records.append({'filename': source.name, 'size': initial.st_size, 'sha256': before})
    return records


def write_tar(stream, snapshot, records):
    if {path.name for path in snapshot.iterdir()} != {record['filename'] for record in records}:
        raise RetentionError('SNAPSHOT_EXTRAS')
    with tarfile.open(fileobj=stream, mode='w|', format=tarfile.USTAR_FORMAT) as archive:
        for record in sorted(records, key=lambda row: row['filename']):
            path = snapshot / record['filename']
            info = regular_file(path)
            if Path(record['filename']).name != record['filename'] or info.st_size != record['size'] or file_hash(path) != record['sha256']:
                raise RetentionError('SNAPSHOT_CHANGED')
            member = tarfile.TarInfo(record['filename'])
            member.size = record['size']
            member.mode = 0o600
            member.uid = member.gid = member.mtime = 0
            member.uname = member.gname = ''
            with path.open('rb') as payload:
                archive.addfile(member, payload)


def verify_candidates(selected, records):
    expected = {row['filename']: row for row in records}
    if len(expected) != len(records) or {p.name for p in selected} != set(expected):
        raise RetentionError('CANDIDATE_SET_CHANGED')
    for path in selected:
        row = expected[path.name]
        physical_directory(path.parent)
        if regular_file(path).st_size != row['size'] or file_hash(path) != row['sha256']:
            raise RetentionError('CANDIDATE_CHANGED')


def prepare_output(outdir, runner_temp, target):
    physical_directory(runner_temp)
    if outdir != runner_temp / ('v3-encrypted-qa-' + target) or outdir.exists() or outdir.is_symlink():
        raise RetentionError('UNSAFE_OUTPUT_DIRECTORY')
    outdir.mkdir(mode=0o700)


def require_recipient(recipient):
    if recipient != RECIPIENT or hashlib.sha256(recipient.encode('ascii')).hexdigest() != RECIPIENT_FINGERPRINT:
        raise RetentionError('UNREVIEWED_RECIPIENT')


def require_hosted_linux(target):
    if os.environ.get('GITHUB_ACTIONS') != 'true' or os.environ.get('RUNNER_ENVIRONMENT') != 'github-hosted' or os.environ.get('RUNNER_OS') != 'Linux' or platform.system() != 'Linux' or platform.machine() != TARGETS[target]['machine']:
        raise RetentionError('HOSTED_NATIVE_LINUX_REQUIRED')


def git_identity(path, expected):
    physical_directory(path)
    process = subprocess.run(['git', '-C', str(path), 'rev-parse', 'HEAD'], capture_output=True, text=True)
    if process.returncode or process.stdout.strip() != expected:
        raise RetentionError('CHECKOUT_IDENTITY_MISMATCH')
    clean = subprocess.run(['git', '-C', str(path), 'diff', '--quiet', 'HEAD', '--'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    if clean.returncode:
        raise RetentionError('TRACKED_CHECKOUT_CHANGED')


def install_age(work, target):
    arch = TARGETS[target]['age_arch']
    pin = AGE[arch]
    url = f'https://github.com/FiloSottile/age/releases/download/v{AGE_VERSION}/age-v{AGE_VERSION}-linux-{arch}.tar.gz'
    request = urllib.request.Request(url, headers={'User-Agent': 'V3-encrypted-QA-retention'})
    with urllib.request.urlopen(request, timeout=60) as response:
        data = response.read(pin['archive_size'] + 1)
    if len(data) != pin['archive_size'] or hashlib.sha256(data).hexdigest() != pin['archive_sha256']:
        raise RetentionError('AGE_ARCHIVE_HASH_MISMATCH')
    with tarfile.open(fileobj=io.BytesIO(data), mode='r:gz') as archive:
        members = [m for m in archive.getmembers() if m.name == 'age/age']
        if len(members) != 1 or not members[0].isfile() or members[0].size != pin['binary_size']:
            raise RetentionError('AGE_BINARY_MEMBER_MISMATCH')
        binary = archive.extractfile(members[0]).read(pin['binary_size'] + 1)
    if len(binary) != pin['binary_size'] or hashlib.sha256(binary).hexdigest() != pin['binary_sha256']:
        raise RetentionError('AGE_BINARY_HASH_MISMATCH')
    executable = work / 'age'
    executable.write_bytes(binary)
    executable.chmod(0o700)
    version = subprocess.run([str(executable), '--version'], capture_output=True, text=True, timeout=15)
    if version.returncode or version.stdout.strip().lstrip('v') != AGE_VERSION:
        raise RetentionError('AGE_VERSION_MISMATCH')
    return executable


def encrypt_stream(executable, recipient, snapshot, records, output):
    # Exactly one reviewed X25519 recipient, never a private identity or plugin.
    require_recipient(recipient)
    process = subprocess.Popen([str(executable), '-r', recipient, '-o', str(output)], stdin=subprocess.PIPE,
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        with process.stdin as stream:
            write_tar(stream, snapshot, records)
        if process.wait(timeout=120) != 0:
            raise RetentionError('AGE_ENCRYPTION_FAILED')
    finally:
        if process.poll() is None:
            process.kill()
            process.wait(timeout=10)
    regular_file(output)
    with output.open('rb') as stream:
        if stream.read(22) != b'age-encryption.org/v1\n':
            raise RetentionError('AGE_OUTPUT_FORMAT_MISMATCH')


def parse_dependency_rows(text):
    rows = []
    for line in text.splitlines():
        fields = line.split('\t')
        if len(fields) != 3 or fields[0].split(':')[0] not in DEPENDENCY_PACKAGES or not re.fullmatch('[0-9A-Za-z.+:~_-]{1,160}', fields[1]) or not re.fullmatch('[a-z0-9-]{1,24}', fields[2]):
            raise RetentionError('INVALID_DEPENDENCY_METADATA')
        rows.append(dict(zip(('package', 'version', 'architecture'), fields)))
    return rows


def collect_build_metadata():
    result = {'scope': 'installed package/tool metadata only; not official-payload equality or vendor clearance', 'packages': [], 'tools': [], 'errors': []}
    try:
        query = subprocess.run(['dpkg-query', '-W', '-f=${binary:Package}\t${Version}\t${Architecture}\n', *DEPENDENCY_PACKAGES], capture_output=True, text=True)
        result['packages'] = parse_dependency_rows(query.stdout)
        result['package_query_exit'] = query.returncode
    except Exception:
        result['errors'].append('DEPENDENCY_METADATA_UNAVAILABLE')
    for name in ('strip', 'patchelf'):
        try:
            path = Path(shutil.which(name)).resolve(strict=True)
            if path.parent != Path('/usr/bin'):
                raise RetentionError('UNEXPECTED_SYSTEM_TOOL')
            version = subprocess.run([str(path), '--version'], capture_output=True, text=True, timeout=10)
            first = version.stdout.splitlines()[0] if version.returncode == 0 and version.stdout else ''
            if not re.fullmatch(r'[A-Za-z0-9 .()+,:/_-]{1,180}', first):
                raise RetentionError('INVALID_TOOL_VERSION')
            result['tools'].append({'name': name, 'path': str(path), 'version': first, 'sha256': file_hash(path)})
        except Exception:
            result['errors'].append(name.upper() + '_METADATA_UNAVAILABLE')
    cache = Path.home() / '.cache/tauri'
    try:
        if cache.is_dir() and not cache.is_symlink():
            for path in sorted(cache.rglob('linuxdeploy*'))[:32]:
                if stat.S_ISREG(path.lstat().st_mode):
                    result['tools'].append({'name': path.name, 'cache_relative_path': str(path.relative_to(cache)), 'sha256': file_hash(path)})
    except Exception:
        result['errors'].append('LINUXDEPLOY_METADATA_UNAVAILABLE')
    return result


def make_receipt(target, records, ciphertext, controller, failure_stage, build_metadata=None):
    pin = AGE[TARGETS[target]['age_arch']]
    return {'schema': 1, 'purpose': 'ENCRYPTED QA ONLY; NOT A QUALIFIED INSTALLER', 'qualification_state': 'FAILED/BLOCKED',
            'failure_stage': failure_stage, 'target': target, 'source_commit': SOURCE, 'source_offer_id': OFFER,
            'auditor_commit': AUDITOR, 'controller_commit': controller, 'recipient_fingerprint_sha256': RECIPIENT_FINGERPRINT,
            'recipient_type': 'single X25519 age recipient; private identity never provided to runner',
            'age': {'version': AGE_VERSION, 'architecture': TARGETS[target]['age_arch'], **pin,
                    'archive_url': f"https://github.com/FiloSottile/age/releases/download/v{AGE_VERSION}/age-v{AGE_VERSION}-linux-{TARGETS[target]['age_arch']}.tar.gz"},
            'packages': records, 'ciphertext': {'filename': ciphertext.name, 'size': ciphertext.stat().st_size, 'sha256': file_hash(ciphertext)},
            'retention_days': 1, 'build_metadata': build_metadata or {'status': 'NOT_COLLECTED'}}


def retain(args):
    require_hosted_linux(args.target)
    require_recipient(args.recipient)
    if args.qualification_outcome != 'failure' or args.failure_stage not in FAILURE_STAGES:
        raise RetentionError('ORIGINAL_FAILURE_REQUIRED')
    controller = os.environ.get('GITHUB_SHA', '')
    if not re.fullmatch('[0-9a-f]{40}', controller):
        raise RetentionError('CONTROLLER_PIN_MISSING')
    app, auditor, control = (Path(value).absolute() for value in [args.app, args.auditor, args.controller])
    git_identity(app, SOURCE)
    git_identity(auditor, AUDITOR)
    git_identity(control, controller)
    if json.loads((app / 'source-offer.json').read_text(encoding='utf-8'))['sourceId'] != OFFER:
        raise RetentionError('SOURCE_OFFER_MISMATCH')
    bundle = app / 'src-tauri/target' / TARGETS[args.target]['triple'] / 'release/bundle'
    selected = select_candidates(bundle, args.target)
    runner_temp = Path(os.environ['RUNNER_TEMP']).absolute()
    outdir = Path(args.outdir).absolute()
    prepare_output(outdir, runner_temp, args.target)
    cipher_name = 'qa-blocked-v3-' + args.target + '.tar.age'
    partial = outdir / (cipher_name + '.partial')
    ciphertext = outdir / cipher_name
    succeeded = False
    try:
        with tempfile.TemporaryDirectory(prefix='v3-qa-private-', dir=runner_temp) as private:
            work = Path(private)
            records = snapshot_candidates(selected, work / 'packages')
            executable = install_age(work, args.target)
            encrypt_stream(executable, args.recipient, work / 'packages', records, partial)
            verify_candidates(selected, records)
            # Detect snapshots changed after their tar member was streamed too.
            verify_candidates(list((work / 'packages').iterdir()), records)
            if select_candidates(bundle, args.target) != selected:
                raise RetentionError('CANDIDATE_SET_CHANGED')
            partial.replace(ciphertext)
            ciphertext.chmod(0o600)
            receipt = make_receipt(args.target, records, ciphertext, controller, args.failure_stage, collect_build_metadata())
            manifest = outdir / 'retention.json'
            manifest.write_text(json.dumps(receipt, indent=2) + '\n', encoding='utf-8', newline='\n')
            manifest.chmod(0o600)
            if {p.name for p in outdir.iterdir()} != {cipher_name, 'retention.json'} or any(not stat.S_ISREG(p.lstat().st_mode) for p in outdir.iterdir()):
                raise RetentionError('OUTPUT_SET_MISMATCH')
        succeeded = True
        return [cipher_name, 'retention.json']
    finally:
        if not succeeded:
            # The directory was created exclusively by this invocation, mode 0700.
            shutil.rmtree(outdir)


class SafeParser(argparse.ArgumentParser):
    def error(self, _message):
        raise RetentionError('INVALID_ARGUMENTS')


def main(argv=None):
    try:
        parser = SafeParser(description=__doc__, add_help=False)
        parser.add_argument('--target', required=True, choices=TARGETS)
        for name in ['app', 'auditor', 'controller', 'recipient', 'outdir']:
            parser.add_argument('--' + name, required=True)
        parser.add_argument('--failure-stage', required=True, choices=FAILURE_STAGES)
        parser.add_argument('--qualification-outcome', required=True, choices=['failure'])
        args = parser.parse_args(argv)
        require_recipient(args.recipient)
        files = retain(args)
        print(json.dumps({'status': 'QA_ONLY_RETAINED', 'qualification_state': 'FAILED/BLOCKED', 'files': files}))
        return 0
    except Exception as error:
        # Never include exception text, commands, recipient inputs or raw reports.
        code = str(error) if isinstance(error, RetentionError) and re.fullmatch('[A-Z_]+', str(error)) else 'RETENTION_OPERATION_FAILED'
        print(json.dumps({'status': 'QA_RETENTION_FAILED', 'code': code}), file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
