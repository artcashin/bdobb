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
import zipfile
import struct
import urllib.request

SOURCE = 'de25611461ad0559ce237c4f59b812decd91dec1'
OFFER = '19c760a782e0ab84152ee990e8f9014f7e677f448bc58d6a3e548d8f485f1c6b'
AUDITOR = '36f4c810ecdc8481bc15e2f10a45b3f18b780ddd'
RECIPIENT = 'age10ds3n8f25h5uvjzza4eluvwt7xp43eqjwdhmdm9haduyrxctwevqt4r7rr'
RECIPIENT_FINGERPRINT = '4c2a60f4add41b995dbbf5e6bd7022254c1a8b5f24a9a49a40a6506063411fcb'
AGE_VERSION = '1.3.2'
TARGETS = {
    'windows': {'triple': 'x86_64-pc-windows-msvc', 'age_arch': 'amd64',
                'files': {'msi': 'BDOBB_3.0.0_x64_en-US.msi', 'nsis': 'BDOBB_3.0.0_x64-setup.exe'}},
}
AGE = {
    'archive_sha256': 'f48d8f8f9ebe903ab5027ed067652f2cc1db94bc206976430133b905dcd8e8c7',
    'archive_size': 20250704, 'binary_sha256': '2821a4ed191da07372acd302e5f6feae7a7985e285e1417765ebe74025af45f0',
    'binary_size': 7172096,
    'archive_url': 'https://github.com/FiloSottile/age/releases/download/v1.3.2/age-v1.3.2-windows-amd64.zip',
}
FAILURE_STAGES = ('package-scan', 'native-qualification', 'evidence-scan')


class RetentionError(Exception):
    """A fixed diagnostic code only; never carry candidate contents or input values."""


def file_hash(path):
    initial = regular_file(path)
    with os.fdopen(os.open(path, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0)), 'rb') as stream:
        opened = os.fstat(stream.fileno())
        if not stat.S_ISREG(opened.st_mode) or getattr(opened, 'st_file_attributes', 0) & getattr(stat, 'FILE_ATTRIBUTE_REPARSE_POINT', 1024) or opened.st_nlink != 1 or (opened.st_dev,opened.st_ino,opened.st_size) != (initial.st_dev,initial.st_ino,initial.st_size):
            raise RetentionError('UNSAFE_FILE')
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def physical_directory(path):
    # Reject symlink ancestors too, including an aliased candidate parent.
    for part in [path, *path.parents]:
        if not stat.S_ISDIR(part.lstat().st_mode) or getattr(part.lstat(), 'st_file_attributes', 0) & getattr(stat, 'FILE_ATTRIBUTE_REPARSE_POINT', 1024):
            raise RetentionError('UNSAFE_DIRECTORY')


def regular_file(path):
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_size <= 0 or getattr(info, 'st_file_attributes', 0) & getattr(stat, 'FILE_ATTRIBUTE_REPARSE_POINT', 1024) or info.st_nlink != 1:
        raise RetentionError('UNSAFE_FILE')
    return info


def select_candidates(bundle, target):
    physical_directory(bundle)
    wanted = TARGETS[target]['files']
    selected = {name: [] for name in wanted.values()}
    def unreadable(_error):
        raise RetentionError('UNREADABLE_BUNDLE')
    # Only the exact two installer files may cross the encrypted QA boundary.
    for directory, subdirs, names in os.walk(bundle, followlinks=False, onerror=unreadable):
        for name in subdirs + names:
            if name.lower().endswith(('.msi', '.exe')):
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


def require_hosted_windows(target):
    if target != 'windows' or os.environ.get('GITHUB_ACTIONS') != 'true' or os.environ.get('RUNNER_ENVIRONMENT') != 'github-hosted' or os.environ.get('RUNNER_OS') != 'Windows' or platform.system() != 'Windows' or platform.machine().lower() not in {'amd64', 'x86_64'} or struct.calcsize('P') != 8:
        raise RetentionError('HOSTED_NATIVE_WINDOWS_REQUIRED')


def git_identity(path, expected):
    physical_directory(path)
    process = subprocess.run(['git', '-C', str(path), 'rev-parse', 'HEAD'], capture_output=True, text=True)
    if process.returncode or process.stdout.strip() != expected:
        raise RetentionError('CHECKOUT_IDENTITY_MISMATCH')
    clean = subprocess.run(['git', '-C', str(path), 'diff', '--quiet', 'HEAD', '--'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    if clean.returncode:
        raise RetentionError('TRACKED_CHECKOUT_CHANGED')


def install_age(work, target):
    if target != 'windows': raise RetentionError('TARGET_MISMATCH')
    request = urllib.request.Request(AGE['archive_url'], headers={'User-Agent': 'V3-encrypted-Windows-QA-retention'})
    with urllib.request.urlopen(request, timeout=60) as response:
        data = response.read(AGE['archive_size'] + 1)
    if len(data) != AGE['archive_size'] or hashlib.sha256(data).hexdigest() != AGE['archive_sha256']:
        raise RetentionError('AGE_ARCHIVE_HASH_MISMATCH')
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        members = [m for m in archive.infolist() if m.filename == 'age/age.exe']
        if len(members) != 1 or members[0].is_dir() or members[0].file_size != AGE['binary_size'] or members[0].flag_bits & 1 or stat.S_IFMT(members[0].external_attr >> 16) not in {0,stat.S_IFREG}:
            raise RetentionError('AGE_BINARY_MEMBER_MISMATCH')
        with archive.open(members[0]) as stream: binary = stream.read(AGE['binary_size'] + 1)
    if len(binary) != AGE['binary_size'] or hashlib.sha256(binary).hexdigest() != AGE['binary_sha256']:
        raise RetentionError('AGE_BINARY_HASH_MISMATCH')
    if len(binary) < 64 or binary[:2] != b'MZ': raise RetentionError('AGE_BINARY_ARCH_MISMATCH')
    at = struct.unpack_from('<I',binary,60)[0]
    if binary[at:at+4] != b'PE\0\0' or len(binary) < at+6 or struct.unpack_from('<H',binary,at+4)[0] != 0x8664:
        raise RetentionError('AGE_BINARY_ARCH_MISMATCH')
    executable = work / 'age.exe'
    with executable.open('xb') as stream: stream.write(binary)
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


def make_receipt(target, records, ciphertext, controller, failure_stage, build_metadata=None):
    return {'schema': 1, 'purpose': 'ENCRYPTED QA ONLY; NOT A QUALIFIED INSTALLER', 'qualification_state': 'FAILED/BLOCKED',
            'failure_stage': failure_stage, 'target': target, 'source_commit': SOURCE, 'source_offer_id': OFFER,
            'auditor_commit': AUDITOR, 'controller_commit': controller, 'recipient_fingerprint_sha256': RECIPIENT_FINGERPRINT,
            'recipient_type': 'single X25519 age recipient; private identity never provided to runner',
            'age': {'version': AGE_VERSION, 'architecture': 'windows-amd64', **AGE},
            'packages': records, 'ciphertext': {'filename': ciphertext.name, 'size': ciphertext.stat().st_size, 'sha256': file_hash(ciphertext)},
            'retention_days': 1, 'scratch_scope': 'GitHub-hosted ephemeral runner temp; no independent Windows DACL qualification claim'}


def retain(args):
    require_hosted_windows(args.target)
    require_recipient(args.recipient)
    if args.qualification_outcome != 'failure' or args.failure_stage not in FAILURE_STAGES:
        raise RetentionError('ORIGINAL_FAILURE_REQUIRED')
    controller = os.environ.get('GITHUB_SHA', '')
    if not re.fullmatch('[0-9a-f]{40}', controller):
        raise RetentionError('CONTROLLER_PIN_MISSING')
    app, auditor, control = (Path(value).absolute() for value in [args.app, args.auditor, args.controller])
    if not re.fullmatch('[0-9a-f]{40}', AUDITOR): raise RetentionError('WINDOWS_AUDITOR_NOT_REVIEWED')
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
            receipt = make_receipt(args.target, records, ciphertext, controller, args.failure_stage)
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
