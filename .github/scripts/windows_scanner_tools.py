"""Pinned portable Windows scanner dependencies; native hosted execution only."""
import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath, PureWindowsPath
import platform
import re
import shutil
import stat
import struct
import subprocess
import sys
import urllib.request
import zipfile

SOURCE = 'de25611461ad0559ce237c4f59b812decd91dec1'
OFFER = '19c760a782e0ab84152ee990e8f9014f7e677f448bc58d6a3e548d8f485f1c6b'
AUDITOR = '36f4c810ecdc8481bc15e2f10a45b3f18b780ddd'
MODEL_COMMIT = '87416418657359cb625c412a48b6e1d6d41c29bd'
ASSETS = {
    'bootstrap': {'filename': '7zr.exe', 'url': 'https://github.com/ip7z/7zip/releases/download/26.06/7zr.exe',
                  'size': 600064, 'sha256': 'e80db2dad715a6c5adabe292d31ed54e11f4e9b99ca349827b50573b175891bc'},
    '7zip': {'filename': '7z2606-x64.exe', 'url': 'https://github.com/ip7z/7zip/releases/download/26.06/7z2606-x64.exe',
             'size': 1659704, 'sha256': '9b697f65ecc2d9b0152f5ee96d72dde522a7827690349d9307935dacf40f42ec'},
    'tesseract': {'filename': 'tesseract-ocr-w64-setup-5.5.3.20260724.exe',
                  'url': 'https://github.com/tesseract-ocr/tesseract/releases/download/5.5.3/tesseract-ocr-w64-setup-5.5.3.20260724.exe',
                  'size': 26573224, 'sha256': 'bee9e3434bd94fd65387d9be28cd467a41f61b1275383b55b0f59a1331270ae4'},
    'poppler': {'filename': 'Release-26.09.0-0.zip',
                'url': 'https://github.com/oschwartz10612/poppler-windows/releases/download/v26.09.0-0/Release-26.09.0-0.zip',
                'size': 43709956, 'sha256': '7a6f256a0ddf7536182246a5733331bf4677cbcc34f4663774947ad34556c8d0'},
    'eng': {'filename': 'eng.traineddata', 'url': f'https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/{MODEL_COMMIT}/eng.traineddata',
            'size': 4113088, 'sha256': '7d4322bd2a7749724879683fc3912cb542f19906c83bcc1a52132556427170b2'},
    'osd': {'filename': 'osd.traineddata', 'url': f'https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/{MODEL_COMMIT}/osd.traineddata',
            'size': 10562727, 'sha256': '9cf5d576fcc47564f11265841e5ca839001e7e6f38ff7f7aacf46d15a96b00ff'},
}
MEMBERS = {
    '7zip/7z.exe': 'dc0493429fe28136fcb177a0e77c9875cbb3b0bff5f2f8eeba4df302e98cef76',
    '7zip/7z.dll': '500db9eb17f3c21b729ba41dd02ecfe1823da05028c7e4ba129084cc74cc364e',
    'tesseract/tesseract.exe': 'c66f0f12ed76f6aa455dac97684bbc86756d6a732380bee09122454cfda3f420',
    'poppler/poppler-26.09.0/Library/bin/pdfinfo.exe': '0824a83354a331469be7d0c2ab3691af46bef6ed89799cbdc5fb532dc4886c72',
    'poppler/poppler-26.09.0/Library/bin/pdfdetach.exe': '3e1cdb8a1ff164fbce45a46078b5d3708c37e96fcfa904d528d94b219dcec0f0',
    'poppler/poppler-26.09.0/Library/bin/pdftotext.exe': 'eedb0417a5a70eae7901151cb1a8902d7890187c4bd0535ca54e2c3924584db5',
    'poppler/poppler-26.09.0/Library/bin/pdftoppm.exe': '0c7853d56bc7a0679417b2f84d58608c1c381c4ec712b07c8e4e29d36582f67e',
}
RECIPES = {'tesseract': ('chtof/chocolatey-packages', '5f11002005fbbbc9dd7904f2670b61c340a0f7d9', 'automatic/tesseract'),
           'poppler': ('chtof/chocolatey-packages', 'b0679059d740b563dabe8ed016cfce29b3a75e48', 'automatic/poppler'),
           '7zip': ('chocolatey-community/chocolatey-packages', '3a1f0a27bf4f4f96982a4b7665871e4b858fe5a6', 'automatic/7zip.install')}


class ToolError(Exception):
    """Fixed diagnostic code; never include captured tool output or input values."""


def file_hash(path):
    with path.open('rb') as stream: return hashlib.file_digest(stream, 'sha256').hexdigest()


def ordinary(info, directory=False):
    return (stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode)) and not (getattr(info, 'st_file_attributes', 0) & getattr(stat, 'FILE_ATTRIBUTE_REPARSE_POINT', 1024))


def physical_directory(path):
    if any(not ordinary(p.lstat(), True) for p in [path, *path.parents]): raise ToolError('UNSAFE_DIRECTORY')


def verify_payload(data, pin):
    if len(data) != pin['size'] or hashlib.sha256(data).hexdigest() != pin['sha256']: raise ToolError('DOWNLOAD_HASH_MISMATCH')


def download(pin, directory):
    request = urllib.request.Request(pin['url'], headers={'User-Agent': 'V3-pinned-Windows-scanner-tools'})
    with urllib.request.urlopen(request, timeout=90) as response: data = response.read(pin['size'] + 1)
    verify_payload(data, pin)
    path = directory / pin['filename']
    with path.open('xb') as output: output.write(data)
    return path


def validate_member_names(names):
    seen = set()
    reserved = {'CON', 'PRN', 'AUX', 'NUL', *(f'COM{i}' for i in range(1, 10)), *(f'LPT{i}' for i in range(1, 10))}
    for name in names:
        normalized = name.replace('\\', '/').rstrip('/')
        parts = normalized.split('/')
        if not normalized or PureWindowsPath(name).drive or PureWindowsPath(name).root or PurePosixPath(normalized).is_absolute() or any(
                part in {'', '.', '..'} or ':' in part or part.endswith((' ', '.')) or any(ord(c) < 32 for c in part) or part.split('.')[0].upper() in reserved for part in parts):
            raise ToolError('UNSAFE_ARCHIVE_MEMBER')
        if normalized.casefold() in seen: raise ToolError('DUPLICATE_ARCHIVE_MEMBER')
        seen.add(normalized.casefold())


def extract_zip(source, destination):
    with zipfile.ZipFile(source) as archive:
        entries = archive.infolist()
        validate_member_names([entry.filename for entry in entries])
        if sum(entry.file_size for entry in entries) > 512 * 1024 * 1024 or any(stat.S_IFMT(entry.external_attr >> 16) not in {0, stat.S_IFREG, stat.S_IFDIR} for entry in entries):
            raise ToolError('UNSAFE_ZIP_CONTENTS')
        destination.mkdir()
        for entry in entries:
            path = destination.joinpath(*entry.filename.replace('\\', '/').rstrip('/').split('/'))
            if entry.is_dir(): path.mkdir(parents=True, exist_ok=True)
            else:
                path.parent.mkdir(parents=True, exist_ok=True)
                with archive.open(entry) as reader, path.open('xb') as output: shutil.copyfileobj(reader, output)


EXECUTION_STAGES = {'BOOTSTRAP_LIST', 'BOOTSTRAP_EXTRACT', 'TESSERACT_LIST', 'TESSERACT_EXTRACT',
                    'SEVENZIP_INFO', 'TESSERACT_VERSION', 'PDFINFO_VERSION', 'PDFDETACH_VERSION',
                    'PDFTOTEXT_VERSION', 'PDFTOPPM_VERSION', 'OCR_LANGUAGES'}


def execute(arguments, env=None, *, stage):
    if stage not in EXECUTION_STAGES: raise ToolError('UNREVIEWED_EXECUTION_STAGE')
    # Upstream Poppler26.09 pdfdetach.cc deliberately returns99 for -v.
    # No extraction/other command may use that version-only behavior.
    expected_exit = 0
    if stage == 'PDFDETACH_VERSION':
        if len(arguments) != 2 or PureWindowsPath(str(arguments[0])).name.casefold() != 'pdfdetach.exe' or arguments[1] != '-v':
            raise ToolError('UNREVIEWED_VERSION_COMMAND')
        expected_exit = 99
    try:
        process = subprocess.run(list(map(str, arguments)), capture_output=True, text=True, encoding='utf-8', errors='replace', env=env, timeout=180)
    except subprocess.TimeoutExpired:
        raise ToolError(stage + '_TIMEOUT') from None
    except OSError:
        raise ToolError(stage + '_START_FAILED') from None
    if process.returncode != expected_exit:
        error = ToolError(stage + '_FAILED')
        error.returncode = process.returncode
        raise error
    return process.stdout + '\n' + process.stderr


def extract_7zip(tool, source, destination, *, stage):
    listing = execute([tool, 'l', '-slt', '--', source], stage=stage + '_LIST')
    listing = listing.split('----------', 1)
    if len(listing) != 2: raise ToolError('ARCHIVE_LISTING_MISSING')
    names = []
    for block in re.split(r'\r?\n\r?\n', listing[1].strip()):
        fields = dict(line.split(' = ', 1) for line in block.splitlines() if ' = ' in line)
        if 'Symbolic Link' in fields or 'Hard Link' in fields: raise ToolError('ARCHIVE_LINK_REJECTED')
        if 'Path' in fields: names.append(fields['Path'])
    if not names: raise ToolError('ARCHIVE_MEMBERS_MISSING')
    validate_member_names(names)
    destination.mkdir()
    execute([tool, 'x', '-y', '-o' + str(destination), '--', source], stage=stage + '_EXTRACT')


def parse_version(name, output):
    if name == 'tesseract': pattern = r'(?m)^tesseract v?(5\.5\.3(?:\.20260724)?)(?:\s|$)'
    elif name == '7z': pattern = r'7-Zip\s+(26\.06)(?:\s|$)'
    else: pattern = r'(?m)^' + re.escape(name) + r' version (26\.09\.0)(?:\s|$)'
    match = re.search(pattern, output)
    if not match: raise ToolError('TOOL_VERSION_MISMATCH')
    return match[1]


def require_hosted_windows():
    if os.environ.get('GITHUB_ACTIONS') != 'true' or os.environ.get('RUNNER_ENVIRONMENT') != 'github-hosted' or os.environ.get('RUNNER_OS') != 'Windows' or platform.system() != 'Windows' or platform.machine().lower() not in {'amd64', 'x86_64'} or struct.calcsize('P') != 8:
        raise ToolError('HOSTED_NATIVE_WINDOWS_X64_REQUIRED')


def prepare_directory(outdir, runner_temp):
    physical_directory(runner_temp)
    if outdir != runner_temp / 'v3-windows-scanner-tools' or outdir.exists() or outdir.is_symlink(): raise ToolError('UNSAFE_OUTPUT_DIRECTORY')
    outdir.mkdir(mode=0o700)


def verify_checkout(path, commit):
    physical_directory(path)
    result = subprocess.run(['git', '-C', str(path), 'rev-parse', 'HEAD'], capture_output=True, text=True)
    if result.returncode or result.stdout.strip() != commit: raise ToolError('CHECKOUT_IDENTITY_MISMATCH')
    if subprocess.run(['git', '-C', str(path), 'diff', '--quiet', 'HEAD', '--'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode: raise ToolError('TRACKED_CHECKOUT_CHANGED')


def verify_member(path, expected):
    if not ordinary(path.lstat()) or file_hash(path) != expected: raise ToolError('EXTRACTED_TOOL_HASH_MISMATCH')
    with path.open('rb') as stream:
        header = stream.read(64)
        if len(header) != 64 or header[:2] != b'MZ': raise ToolError('NATIVE_TOOL_FORMAT_MISMATCH')
        stream.seek(struct.unpack_from('<I', header, 60)[0])
        pe = stream.read(6)
    if pe[:4] != b'PE\0\0' or len(pe) != 6 or struct.unpack_from('<H', pe, 4)[0] != 0x8664: raise ToolError('NATIVE_TOOL_ARCHITECTURE_MISMATCH')


def install(args):
    require_hosted_windows()
    controller = os.environ.get('GITHUB_SHA', '')
    if not re.fullmatch('[0-9a-f]{40}', controller): raise ToolError('CONTROLLER_PIN_MISSING')
    for value, commit in [(args.app, SOURCE), (args.auditor, AUDITOR), (args.controller, controller)]: verify_checkout(Path(value).absolute(), commit)
    if json.loads((Path(args.app) / 'source-offer.json').read_text(encoding='utf-8'))['sourceId'] != OFFER: raise ToolError('SOURCE_OFFER_MISMATCH')
    runner_temp = Path(os.environ['RUNNER_TEMP']).absolute()
    outdir = Path(args.outdir).absolute()
    prepare_directory(outdir, runner_temp)
    succeeded = False
    try:
        downloads = outdir / 'downloads'
        downloads.mkdir()
        files = {name: download(pin, downloads) for name, pin in ASSETS.items()}
        # The official reduced 7z reader only bootstraps the full official SFX.
        # No installer is run and no registry or system PATH is modified.
        extract_7zip(files['bootstrap'], files['7zip'], outdir / '7zip', stage='BOOTSTRAP')
        for relative in ['7zip/7z.exe', '7zip/7z.dll']: verify_member(outdir / relative, MEMBERS[relative])
        sevenzip = outdir / '7zip/7z.exe'
        extract_7zip(sevenzip, files['tesseract'], outdir / 'tesseract', stage='TESSERACT')
        extract_zip(files['poppler'], outdir / 'poppler')
        tessdata = outdir / 'tesseract/tessdata'
        for model in ['eng', 'osd']:
            destination = tessdata / ASSETS[model]['filename']
            with files[model].open('rb') as reader, destination.open('xb') as output: shutil.copyfileobj(reader, output)
            if file_hash(destination) != ASSETS[model]['sha256']: raise ToolError('TRAINEDDATA_HASH_MISMATCH')
        for directory, subdirs, names in os.walk(outdir, followlinks=False):
            for name in subdirs + names:
                path = Path(directory) / name
                if not (ordinary(path.lstat()) or ordinary(path.lstat(), True)): raise ToolError('EXTRACTED_LINK_OR_SPECIAL_FILE')
        for relative, expected in MEMBERS.items(): verify_member(outdir / relative, expected)
        env = {**os.environ, 'TESSDATA_PREFIX': str(tessdata)}
        tools = {}
        for relative, expected in MEMBERS.items():
            if not relative.endswith('.exe'): continue
            executable = outdir / relative
            name = executable.stem
            output = execute([executable, 'i' if name == '7z' else '--version' if name == 'tesseract' else '-v'], env,
                             stage={'7z': 'SEVENZIP_INFO', 'tesseract': 'TESSERACT_VERSION', 'pdfinfo': 'PDFINFO_VERSION',
                                    'pdfdetach': 'PDFDETACH_VERSION', 'pdftotext': 'PDFTOTEXT_VERSION', 'pdftoppm': 'PDFTOPPM_VERSION'}[name])
            tools[name] = {'version': parse_version(name, output), 'sha256': expected, 'relative_path': relative,
                           'version_probe_exit': 99 if name == 'pdfdetach' else 0}
            if name == '7z' and not all(re.search(r'\b' + format + r'\b', output, re.I) for format in ['Nsis', 'Compound']): raise ToolError('REQUIRED_ARCHIVE_FORMAT_MISSING')
        langs = execute([outdir / 'tesseract/tesseract.exe', '--list-langs'], env, stage='OCR_LANGUAGES')
        if not all(re.search(r'(?m)^' + lang + r'\s*$', langs) for lang in ['eng', 'osd']): raise ToolError('REQUIRED_OCR_LANGUAGE_MISSING')
        receipt = {'schema': 1, 'purpose': 'PINNED WINDOWS SCANNER DEPENDENCIES; NO PRODUCT QUALIFICATION CLAIM',
                   'source_commit': SOURCE, 'source_offer_id': OFFER, 'auditor_commit': AUDITOR, 'controller_commit': controller,
                   'method': 'checksum-verified portable extraction into RUNNER_TEMP; no Chocolatey feed or installer execution',
                   'assets': ASSETS, 'tools': tools, 'traineddata_commit': MODEL_COMMIT, 'languages': ['eng', 'osd'],
                   'recipes': {name: {'commit': commit, 'verification_url': f'https://github.com/{repo}/blob/{commit}/{folder}/legal/VERIFICATION.txt'} for name, (repo, commit, folder) in RECIPES.items()}}
        (outdir / 'windows-scanner-tools.json').write_text(json.dumps(receipt, indent=2) + '\n', encoding='utf-8', newline='\n')
        paths = [str(outdir / '7zip'), str(outdir / 'tesseract'), str(outdir / 'poppler/poppler-26.09.0/Library/bin')]
        if any('\n' in value or '\r' in value for value in paths + [str(tessdata)]): raise ToolError('UNSAFE_COMMAND_FILE_VALUE')
        with Path(os.environ['GITHUB_PATH']).open('a', encoding='utf-8', newline='\n') as output: output.write('\n'.join(paths) + '\n')
        with Path(os.environ['GITHUB_ENV']).open('a', encoding='utf-8', newline='\n') as output: output.write('TESSDATA_PREFIX=' + str(tessdata) + '\n')
        succeeded = True
    finally:
        if not succeeded: shutil.rmtree(outdir)


class SafeParser(argparse.ArgumentParser):
    def error(self, _message): raise ToolError('INVALID_ARGUMENTS')


def main(argv=None):
    try:
        parser = SafeParser(description=__doc__, add_help=False)
        for name in ['app', 'auditor', 'controller', 'outdir']: parser.add_argument('--' + name, required=True)
        install(parser.parse_args(argv))
        print(json.dumps({'status': 'WINDOWS_SCANNER_TOOLS_READY', 'receipt': 'windows-scanner-tools.json'}))
        return 0
    except Exception as error:
        code = str(error) if isinstance(error, ToolError) and re.fullmatch('[A-Z_]+', str(error)) else 'TOOL_SETUP_FAILED'
        diagnostic = {'status': 'WINDOWS_SCANNER_TOOLS_FAILED', 'code': code}
        returncode = getattr(error, 'returncode', None)
        if isinstance(error, ToolError) and type(returncode) is int and -(2 ** 63) <= returncode < 2 ** 63:
            diagnostic['tool_exit_code'] = returncode
        print(json.dumps(diagnostic), file=sys.stderr)
        return 1


if __name__ == '__main__': raise SystemExit(main())
