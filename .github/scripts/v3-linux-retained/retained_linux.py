#!/usr/bin/env python3
"""Read-only, root-approved retained Linux candidate downloader. Never qualifies bytes."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import stat
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request

REPOSITORY = 'artcashin/bdobb'
SOURCE_REPOSITORY = 'Adventures-OpenBQ/bdobb'
SOURCE_COMMIT = 'de25611461ad0559ce237c4f59b812decd91dec1'
OFFER = '19c760a782e0ab84152ee990e8f9014f7e677f448bc58d6a3e548d8f485f1c6b'
AUDITOR_COMMIT = 'dd0689369f36793875a0b865fa37b47f3ae47e33'
TAG_PREFIX = 'qa-retained-linux-v3-20261122-'
API = 'https://api.github.com/repos/' + REPOSITORY
USER_AGENT = 'bdobb-retained-linux-readonly/1'
PACKAGES = {
    'linux-x64': ('BDOBB-3.0.0-1.x86_64.rpm', 'BDOBB_3.0.0_amd64.AppImage', 'BDOBB_3.0.0_amd64.deb'),
    'linux-arm': ('BDOBB-3.0.0-1.aarch64.rpm', 'BDOBB_3.0.0_aarch64.AppImage', 'BDOBB_3.0.0_arm64.deb'),
}
ORIGINAL_FAILURES = {
    'linux-x64': {'run_id': 45086627161, 'attempt': 1, 'job_id': 137406666803,
                  'controller_commit': '4faf5d299dad0dd3d63d09861831861f7986c3f7', 'conclusion': 'failure'},
    'linux-arm': {'run_id': 45086629317, 'attempt': 1, 'job_id': 137406671897,
                  'controller_commit': '4faf5d299dad0dd3d63d09861831861f7986c3f7', 'conclusion': 'failure'},
}
MAX_MANIFEST = 32768
MAX_PACKAGE = 2 * 1024 ** 3
SHA = re.compile(r'[0-9a-f]{64}\Z')
COMMIT = re.compile(r'[0-9a-f]{40}\Z')


class Blocked(Exception):
    pass


def require(ok, code):
    if not ok:
        raise Blocked(code)


def keys(value, expected):
    require(type(value) is dict and set(value) == set(expected), 'MANIFEST_SCHEMA_INVALID')


def positive(value, upper=2 ** 53 - 1):
    return type(value) is int and 0 < value <= upper


def digest(value, pattern=SHA):
    return type(value) is str and pattern.fullmatch(value) is not None


def validate_manifest(value, target):
    require(type(value) is dict and value.get('enabled') is True
            and value.get('approval') == 'ROOT_APPROVED_ACTUAL_BYTES', 'MANIFEST_NOT_APPROVED')
    keys(value, ('schema_version', 'enabled', 'approval', 'repository', 'app_source_repository',
                 'app_source_commit', 'source_offer_id', 'qualification_controller_commit',
                 'auditor_commit', 'release', 'assets'))
    require(type(value['schema_version']) is int and value['schema_version'] == 1,
            'MANIFEST_SCHEMA_INVALID')
    require(target in PACKAGES, 'TARGET_INVALID')
    require(value['repository'] == REPOSITORY and value['app_source_repository'] == SOURCE_REPOSITORY
            and value['app_source_commit'] == SOURCE_COMMIT and value['source_offer_id'] == OFFER,
            'SOURCE_BINDING_INVALID')
    require(digest(value['qualification_controller_commit'], COMMIT)
            and value['auditor_commit'] == AUDITOR_COMMIT, 'CONTROLLER_AUDITOR_INVALID')
    r = value['release']
    keys(r, ('id', 'tag_name', 'target_commitish', 'draft', 'prerelease'))
    require(positive(r['id']) and type(r['tag_name']) is str
            and re.fullmatch(re.escape(TAG_PREFIX) + r'[0-9a-f]{12}', r['tag_name'])
            and digest(r['target_commitish'], COMMIT)
            and r['draft'] is True and r['prerelease'] is True, 'RELEASE_BINDING_INVALID')
    assets = value['assets']
    require(type(assets) is list and len(assets) == 6, 'ASSET_SET_INVALID')
    expected = {name for names in PACKAGES.values() for name in names}
    ids, names = set(), set()
    for a in assets:
        keys(a, ('name', 'id', 'size', 'sha256', 'privacy_receipt_sha256', 'original_failed_run'))
        require(type(a['name']) is str and a['name'] in expected and a['name'] not in names
                and positive(a['id']) and a['id'] not in ids and positive(a['size'], MAX_PACKAGE)
                and digest(a['sha256']) and digest(a['privacy_receipt_sha256']), 'ASSET_BINDING_INVALID')
        names.add(a['name']); ids.add(a['id'])
        origin = a['original_failed_run']
        keys(origin, ('run_id', 'attempt', 'job_id', 'controller_commit', 'conclusion'))
        origin_target = next(t for t, names_for_target in PACKAGES.items() if a['name'] in names_for_target)
        expected_origin = ORIGINAL_FAILURES[origin_target]
        require(all(type(origin[k]) is type(v) and origin[k] == v for k, v in expected_origin.items()),
                'ORIGINAL_FAILURE_BINDING_INVALID')
    require(names == expected, 'ASSET_SET_INVALID')
    return {**value, 'target': target,
            'selected_assets': [a for name in PACKAGES[target] for a in assets if a['name'] == name]}


def no_duplicate_keys(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, 'JSON_DUPLICATE_KEY')
        result[key] = value
    return result


def parse_json(raw):
    return json.loads(raw.decode('utf-8', errors='strict'), object_pairs_hook=no_duplicate_keys)


def read_regular(path, limit):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, 'rb') as stream:
        require(stat.S_ISREG(os.fstat(stream.fileno()).st_mode), 'INPUT_NOT_REGULAR')
        data = stream.read(limit + 1)
    require(len(data) <= limit, 'INPUT_TOO_LARGE')
    return data


def load_manifest(path, expected_sha, target):
    require(digest(expected_sha), 'MANIFEST_DIGEST_REQUIRED')
    raw = read_regular(path, MAX_MANIFEST)
    require(hashlib.sha256(raw).hexdigest() == expected_sha, 'MANIFEST_DIGEST_MISMATCH')
    return validate_manifest(parse_json(raw), target)


def host_guard(target):
    require(os.environ.get('GITHUB_ACTIONS') == 'true' and os.environ.get('RUNNER_ENVIRONMENT') == 'github-hosted'
            and os.environ.get('RUNNER_OS') == 'Linux' and platform.system() == 'Linux'
            and os.environ.get('GITHUB_REPOSITORY') == REPOSITORY, 'HOST_NOT_AUTHORIZED')
    expected = {'linux-x64': ('X64', 'x86_64'), 'linux-arm': ('ARM64', 'aarch64')}[target]
    require((os.environ.get('RUNNER_ARCH'), platform.machine()) == expected, 'HOST_ARCH_MISMATCH')


def controller_guard(spec, root):
    require(os.environ.get('GITHUB_SHA') == spec['qualification_controller_commit'], 'CONTROLLER_BINDING_INVALID')
    result = subprocess.run(['git', '-C', str(root), 'rev-parse', 'HEAD'], capture_output=True,
                            timeout=10, check=False)
    require(result.returncode == 0 and result.stdout.decode('ascii').strip()
            == spec['qualification_controller_commit'], 'CONTROLLER_CHECKOUT_INVALID')
    clean = subprocess.run(['git', '-C', str(root), 'diff', '--quiet', 'HEAD', '--'], capture_output=True,
                           timeout=10, check=False)
    require(clean.returncode == 0, 'CONTROLLER_CHECKOUT_DIRTY')


def verify_api(spec, release, assets):
    r = spec['release']
    require(type(release) is dict and all(type(release.get(k)) is type(v) and release.get(k) == v
            for k, v in r.items()) and release.get('published_at') is None
            and 'published_at' in release and release.get('url') == API + '/releases/' + str(r['id']),
            'DRAFT_RELEASE_MISMATCH')
    require(type(assets) is list and len(assets) == 6, 'REMOTE_ASSET_SET_MISMATCH')
    by_id = {a['id']: a for a in spec['assets']}
    seen = set()
    for actual in assets:
        require(type(actual) is dict and positive(actual.get('id')) and actual['id'] in by_id
                and actual['id'] not in seen, 'REMOTE_ASSET_SET_MISMATCH')
        a = by_id[actual['id']]; seen.add(a['id'])
        require(actual.get('name') == a['name'] and type(actual.get('size')) is int
                and actual['size'] == a['size'] and actual.get('state') == 'uploaded'
                and actual.get('digest') == 'sha256:' + a['sha256']
                and actual.get('url') == API + '/releases/assets/' + str(a['id']),
                'REMOTE_ASSET_BINDING_MISMATCH')


def validate_redirect(url):
    u = urllib.parse.urlsplit(url)
    require(u.scheme == 'https' and u.hostname == 'release-assets.githubusercontent.com'
            and u.username is None and u.password is None and u.port in (None, 443)
            and not u.fragment and u.path.startswith('/'), 'ASSET_REDIRECT_REJECTED')


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class Client:
    def __init__(self, token, opener=None):
        require(type(token) is str and 0 < len(token) <= 4096 and not any(c.isspace() for c in token),
                'READ_TOKEN_REQUIRED')
        self.token = token
        self.opener = opener or urllib.request.build_opener(NoRedirect()).open

    def request(self, url, accept, authenticated, *, endpoint):
        require(endpoint in {'release-metadata', 'asset-list', 'asset-api', 'asset-cdn'}, 'ENDPOINT_KIND_REJECTED')
        headers = {'Accept': accept, 'User-Agent': USER_AGENT}
        if authenticated:
            require(url.startswith(API + '/'), 'API_ORIGIN_REJECTED')
            headers.update({'Authorization': 'Bearer ' + self.token, 'X-GitHub-Api-Version': '2022-11-28'})
        request = urllib.request.Request(url, headers=headers, method='GET')
        try:
            return self.opener(request, timeout=60)
        except urllib.error.HTTPError as exc:
            if exc.code == 302:
                return exc
            status = exc.code
            exc.close()
            error = Blocked('API_HTTP_REJECTED')
            if type(status) is int and 100 <= status <= 599:
                error.http_status = status
                error.endpoint = endpoint
            raise error from None

    def json(self, suffix, *, endpoint):
        with self.request(API + suffix, 'application/vnd.github+json', True, endpoint=endpoint) as response:
            require(response.getcode() == 200 and not response.headers.get('Link'), 'API_RESPONSE_REJECTED')
            raw = response.read(1024 * 1024 + 1)
        require(len(raw) <= 1024 * 1024, 'API_RESPONSE_TOO_LARGE')
        return parse_json(raw)

    def metadata(self, spec):
        rid = str(spec['release']['id'])
        return (self.json('/releases/' + rid, endpoint='release-metadata'),
                self.json('/releases/' + rid + '/assets?per_page=100', endpoint='asset-list'))

    def download(self, asset, destination):
        response = self.request(API + '/releases/assets/' + str(asset['id']), 'application/octet-stream', True, endpoint='asset-api')
        created = False
        try:
            if response.getcode() == 302:
                location = response.headers.get('Location', '')
                validate_redirect(location)
                response.close()
                response = self.request(location, 'application/octet-stream', False, endpoint='asset-cdn')
            require(response.getcode() == 200, 'ASSET_HTTP_REJECTED')
            size = 0; sha = hashlib.sha256()
            with destination.open('xb') as stream:
                created = True
                os.chmod(destination, 0o600)
                while True:
                    block = response.read(min(1024 * 1024, asset['size'] - size + 1))
                    if not block: break
                    size += len(block)
                    require(size <= asset['size'], 'ASSET_SIZE_MISMATCH')
                    sha.update(block); stream.write(block)
                stream.flush(); os.fsync(stream.fileno())
            require(size == asset['size'] and sha.hexdigest() == asset['sha256'], 'ASSET_DIGEST_MISMATCH')
        except BaseException:
            if created: destination.unlink(missing_ok=True)
            raise
        finally:
            response.close()


def runner_temp():
    root = Path(os.environ.get('RUNNER_TEMP', ''))
    require(root.is_absolute() and root.is_dir() and not root.is_symlink(), 'RUNNER_TEMP_INVALID')
    return root.resolve(strict=True)


def evidence_dir(value):
    p = Path(value).absolute()
    roots = [runner_temp(), Path(os.environ.get('GITHUB_WORKSPACE', '/nonexistent')).resolve()]
    require(p.name in ('retained-evidence', 'retained-evidence-linux-x64', 'retained-evidence-linux-arm')
            and p.parent.resolve(strict=True) in roots and not p.is_symlink(), 'EVIDENCE_PATH_INVALID')
    if not p.exists(): p.mkdir(mode=0o700)
    require(p.is_dir() and {x.name for x in p.iterdir()} <= {'retained-preflight.json'}, 'EVIDENCE_NOT_FRESH')
    require(p.stat().st_uid == os.geteuid() and p.stat().st_mode & 0o077 == 0
            and all(stat.S_ISREG(x.lstat().st_mode) for x in p.iterdir()), 'EVIDENCE_NOT_PRIVATE_REGULAR')
    return p


def write_json(path, value):
    with path.open('x', encoding='utf-8', newline='\n') as stream:
        os.chmod(path, 0o600)
        json.dump(value, stream, sort_keys=True, indent=2); stream.write('\n')


def output_auditor(commit):
    filename = os.environ.get('GITHUB_OUTPUT')
    require(filename is not None, 'GITHUB_OUTPUT_REQUIRED')
    fd = os.open(filename, os.O_WRONLY | os.O_APPEND | os.O_NOFOLLOW)
    with os.fdopen(fd, 'a', encoding='ascii', newline='\n') as stream:
        require(stat.S_ISREG(os.fstat(stream.fileno()).st_mode), 'GITHUB_OUTPUT_INVALID')
        stream.write('auditor_commit=' + commit + '\n')


class Parser(argparse.ArgumentParser):
    def error(self, message):
        raise Blocked('ARGUMENTS_INVALID')


def run(argv):
    parser = Parser(description=__doc__)
    parser.add_argument('command', choices=('preflight', 'download', 'materialize'))
    parser.add_argument('--manifest', required=True, type=Path)
    parser.add_argument('--manifest-sha256', required=True)
    parser.add_argument('--target', required=True, choices=tuple(PACKAGES))
    parser.add_argument('--evidence')
    parser.add_argument('--output', type=Path)
    parser.add_argument('--controller-root', type=Path, default=Path(os.environ.get('GITHUB_WORKSPACE', '.')))
    args = parser.parse_args(argv)
    if args.command == 'materialize':
        host_guard(args.target)
        raw = os.environ.get('RETAINED_MANIFEST_JSON', '').encode('utf-8')
        require(0 < len(raw) <= MAX_MANIFEST and digest(args.manifest_sha256)
                and hashlib.sha256(raw).hexdigest() == args.manifest_sha256, 'MANIFEST_DIGEST_MISMATCH')
        s = validate_manifest(parse_json(raw), args.target)
        controller_guard(s, args.controller_root)
        require(args.manifest.absolute() == runner_temp() / 'v3-retained-input.json', 'MANIFEST_PATH_INVALID')
        fd = os.open(args.manifest, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, 'wb') as stream: stream.write(raw)
        return {'status': 'APPROVED_MANIFEST_MATERIALIZED', 'manifest_sha256': args.manifest_sha256}
    s = load_manifest(args.manifest, args.manifest_sha256, args.target)
    host_guard(args.target); controller_guard(s, args.controller_root)
    require(args.evidence is not None, 'EVIDENCE_REQUIRED')
    evidence = evidence_dir(args.evidence)
    common = {'schema_version': 1, 'manifest_sha256': args.manifest_sha256,
              'target': args.target, 'repository': REPOSITORY, 'app_source_repository': SOURCE_REPOSITORY,
              'app_source_commit': SOURCE_COMMIT, 'source_offer_id': OFFER,
              'qualification_controller_commit': s['qualification_controller_commit'],
              'auditor_commit': s['auditor_commit'], 'release': s['release'],
              'original_run_qualification': 'FAILED_NOT_REWRITTEN'}
    if args.command == 'preflight':
        write_json(evidence / 'retained-preflight.json', {**common, 'status': 'APPROVED_MANIFEST_ONLY_NO_NETWORK'})
        output_auditor(s['auditor_commit'])
        return {'status': 'APPROVED_MANIFEST_ONLY_NO_NETWORK', 'auditor_commit': s['auditor_commit']}
    require(args.output is not None and args.output.absolute() == runner_temp() / ('v3-retained-' + args.target),
            'OUTPUT_PATH_INVALID')
    require(not args.output.exists() and not args.output.is_symlink(), 'OUTPUT_NOT_FRESH')
    client = Client(os.environ.get('GH_RETAINED_READ_TOKEN', ''))
    verify_api(s, *client.metadata(s))
    args.output.mkdir(mode=0o700)
    created = []
    try:
        for asset in s['selected_assets']:
            p = args.output / asset['name']; client.download(asset, p); created.append(p)
        verify_api(s, *client.metadata(s))
        for asset, path in zip(s['selected_assets'], created):
            require(path.stat().st_size == asset['size'], 'FINAL_FILE_SIZE_MISMATCH')
            sha = hashlib.sha256()
            with path.open('rb') as stream:
                while block := stream.read(1024 * 1024): sha.update(block)
            require(sha.hexdigest() == asset['sha256'], 'FINAL_FILE_DIGEST_MISMATCH')
        write_json(evidence / 'retained-origin.json', {**common, 'assets': s['selected_assets'],
                   'status': 'EXACT_RETAINED_BYTES_DOWNLOADED_PENDING_RESCAN',
                   'qualified': False, 'native_installation_observed': False})
    except BaseException:
        for path in created: path.unlink(missing_ok=True)
        args.output.rmdir()
        raise
    return {'status': 'EXACT_RETAINED_BYTES_DOWNLOADED_PENDING_RESCAN', 'qualified': False}


def main(argv=None):
    try:
        result = run(argv)
    except Blocked as exc:
        result = {'status': 'BLOCKED', 'code': str(exc)}
        status, endpoint = getattr(exc, 'http_status', None), getattr(exc, 'endpoint', None)
        if type(status) is int and 100 <= status <= 599 and endpoint in {'release-metadata','asset-list','asset-api','asset-cdn'}:
            result.update(http_status=status, endpoint=endpoint)
        print(json.dumps(result, separators=(',', ':')))
        return 2
    except Exception:
        print('{"status":"BLOCKED","code":"INTERNAL_ERROR"}')
        return 2
    print(json.dumps(result, sort_keys=True, separators=(',', ':')))
    return 0


if __name__ == '__main__':
    sys.exit(main())
