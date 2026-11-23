import copy
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import urllib.request
import urllib.error
import contextlib

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('retained_linux', HERE / 'retained_linux.py')
q = importlib.util.module_from_spec(spec)
spec.loader.exec_module(q)


def approved():
    names = [name for names in q.PACKAGES.values() for name in names]
    return {
        'schema_version': 1, 'enabled': True, 'approval': 'ROOT_APPROVED_ACTUAL_BYTES',
        'repository': q.REPOSITORY, 'app_source_repository': q.SOURCE_REPOSITORY,
        'app_source_commit': q.SOURCE_COMMIT, 'source_offer_id': q.OFFER,
        'qualification_controller_commit': 'a' * 40, 'auditor_commit': q.AUDITOR_COMMIT,
        'release': {'id': 123, 'tag_name': q.TAG_PREFIX + '0123456789ab',
                    'target_commitish': 'c' * 40, 'draft': True, 'prerelease': True},
        'assets': [
            {'name': name, 'id': i + 10, 'size': 3,
             'sha256': hashlib.sha256(b'abc').hexdigest(),
             'privacy_receipt_sha256': 'd' * 64,
             'original_failed_run': copy.deepcopy(q.ORIGINAL_FAILURES[
                 next(t for t, target_names in q.PACKAGES.items() if name in target_names)])}
            for i, name in enumerate(names)
        ],
    }


def api_release(m):
    return {**m['release'], 'published_at': None,
            'url': q.API + '/releases/' + str(m['release']['id'])}


def api_assets(m):
    return [dict(id=a['id'], name=a['name'], size=a['size'], state='uploaded',
                 digest='sha256:' + a['sha256'],
                 url=q.API + '/releases/assets/' + str(a['id'])) for a in m['assets']]


class Response(io.BytesIO):
    def __init__(self, data, status=200, headers=None):
        super().__init__(data)
        self.status = status
        self.headers = headers or {}
    def getcode(self):
        return self.status


class Tests(unittest.TestCase):
    def test_http_rejection_exposes_only_numeric_status_and_fixed_endpoint(self):
        def opener(request, timeout):
            raise urllib.error.HTTPError('https://PRIVATE.invalid/PRIVATE',404,'PRIVATE_REASON',{},None)
        client=q.Client('PRIVATE_TOKEN',opener)
        out=io.StringIO()
        with contextlib.redirect_stdout(out),patch.object(q,'run',side_effect=lambda argv:client.metadata(approved())):
            self.assertEqual(q.main([]),2)
        observed=json.loads(out.getvalue())
        self.assertEqual(observed,{'status':'BLOCKED','code':'API_HTTP_REJECTED','http_status':404,'endpoint':'release-metadata'})
        self.assertNotIn('PRIVATE',out.getvalue())

    def test_disabled_template_and_unknown_schema_block(self):
        with self.assertRaisesRegex(q.Blocked, 'MANIFEST_NOT_APPROVED'):
            q.validate_manifest(json.loads((HERE / 'candidates.disabled.json').read_text()), 'linux-x64')
        m = approved(); m['surprise'] = True
        with self.assertRaises(q.Blocked):
            q.validate_manifest(m, 'linux-x64')

    def test_complete_exact_six_identity_and_origin_required(self):
        m = approved()
        self.assertEqual(len(q.validate_manifest(m, 'linux-arm')['selected_assets']), 3)
        changes = [lambda x: x.update(app_source_commit='f' * 40),
                   lambda x: x.update(auditor_commit='60866feb4f0e933f9264628c12911be810516de0'),
                   lambda x: x['assets'].pop(),
                   lambda x: x['assets'][0].update(id=True),
                   lambda x: x['assets'][1].update(id=x['assets'][0]['id']),
                   lambda x: x['assets'][0].update(size=0),
                   lambda x: x['assets'][0].update(privacy_receipt_sha256=''),
                   lambda x: x['assets'][0]['original_failed_run'].update(conclusion='success'),
                   lambda x: x['assets'][0].update(original_failed_run=copy.deepcopy(q.ORIGINAL_FAILURES['linux-arm'])),
                   lambda x: x['assets'][0]['original_failed_run'].update(run_id=45086627162),
                   lambda x: x['assets'][0]['original_failed_run'].update(controller_commit='e' * 40),
                   lambda x: x['release'].update(tag_name='v3.0.0'),
                   lambda x: x['release'].update(draft=False)]
        for change in changes:
            bad = copy.deepcopy(m); change(bad)
            with self.subTest(bad=bad), self.assertRaises(q.Blocked):
                q.validate_manifest(bad, 'linux-x64')

    def test_api_metadata_exact_draft_and_asset_binding(self):
        m = approved(); s = q.validate_manifest(m, 'linux-x64')
        q.verify_api(s, api_release(m), api_assets(m))
        mutations = [lambda r, a: r.update(published_at='now'),
                     lambda r, a: r.update(target_commitish='main'),
                     lambda r, a: a[0].update(digest=None),
                     lambda r, a: a[0].update(name='other.deb'),
                     lambda r, a: a.append(copy.deepcopy(a[0])),
                     lambda r, a: a[0].update(url='https://example.com/asset')]
        for mutate in mutations:
            r, a = api_release(m), api_assets(m); mutate(r, a)
            with self.assertRaises(q.Blocked): q.verify_api(s, r, a)

    def test_redirect_drops_all_credentials_and_rejects_other_origins(self):
        requests = []
        def opener(req, timeout):
            requests.append(req)
            if len(requests) == 1:
                return Response(b'', 302, {'Location': 'https://release-assets.githubusercontent.com/path?sig=private'})
            return Response(b'abc')
        client = q.Client('private-token', opener)
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp) / 'package'
            client.download(approved()['assets'][0], p)
            self.assertEqual(p.read_bytes(), b'abc')
        self.assertIn('Authorization', requests[0].headers)
        self.assertNotIn('Authorization', requests[1].headers)
        self.assertEqual(requests[1].headers, {'Accept': 'application/octet-stream', 'User-agent': q.USER_AGENT})
        for url in ['http://release-assets.githubusercontent.com/x', 'https://example.com/x',
                    'https://private@release-assets.githubusercontent.com/x',
                    'https://release-assets.githubusercontent.com:444/x',
                    'https://release-assets.githubusercontent.com/x#fragment']:
            with self.assertRaises(q.Blocked): q.validate_redirect(url)

    def test_digest_and_size_tampering_remove_partial(self):
        for data in [b'abd', b'abcd', b'ab']:
            with tempfile.TemporaryDirectory() as tmp:
                p = Path(tmp) / 'package'
                client = q.Client('private', lambda req, timeout: Response(data))
                with self.assertRaises(q.Blocked): client.download(approved()['assets'][0], p)
                self.assertFalse(p.exists())

    def test_existing_destination_never_overwritten_or_deleted(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp) / 'package'; p.write_bytes(b'original')
            client = q.Client('private', lambda req, timeout: Response(b'abc'))
            with self.assertRaises(FileExistsError): client.download(approved()['assets'][0], p)
            self.assertEqual(p.read_bytes(), b'original')

    def test_duplicate_json_keys_rejected(self):
        with self.assertRaisesRegex(q.Blocked, 'JSON_DUPLICATE_KEY'):
            q.parse_json(b'{"enabled":false,"enabled":true}')

    def test_materialize_preserves_exact_utf8_without_newline(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve(); p = root / 'v3-retained-input.json'
            raw = json.dumps(approved(), indent=2).encode('utf-8')
            with patch.dict(q.os.environ, {'RUNNER_TEMP': str(root), 'RETAINED_MANIFEST_JSON': raw.decode()}), \
                 patch.object(q, 'host_guard'), patch.object(q, 'controller_guard'):
                result = q.run(['materialize', '--manifest', str(p), '--manifest-sha256',
                                hashlib.sha256(raw).hexdigest(), '--target', 'linux-x64'])
                self.assertEqual(p.read_bytes(), raw)
                self.assertEqual(p.stat().st_mode & 0o777, 0o600)
                self.assertEqual(result['status'], 'APPROVED_MANIFEST_MATERIALIZED')
                with self.assertRaises(FileExistsError):
                    q.run(['materialize', '--manifest', str(p), '--manifest-sha256',
                           hashlib.sha256(raw).hexdigest(), '--target', 'linux-x64'])

    def test_download_receipt_never_promotes_original_failure(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve(); m = approved(); manifest = root / 'approved.json'
            raw = json.dumps(m).encode(); manifest.write_bytes(raw)
            out = root / 'v3-retained-linux-x64'; evidence = root / 'retained-evidence'
            def metadata(client, spec): return api_release(m), api_assets(m)
            def download(client, asset, path): path.write_bytes(b'abc')
            with patch.dict(q.os.environ, {'RUNNER_TEMP': str(root), 'GITHUB_WORKSPACE': str(root),
                                           'GH_RETAINED_READ_TOKEN': 'secret'}), \
                 patch.object(q, 'host_guard'), patch.object(q, 'controller_guard'), \
                 patch.object(q.Client, 'metadata', metadata), patch.object(q.Client, 'download', download):
                result = q.run(['download', '--manifest', str(manifest), '--manifest-sha256',
                                hashlib.sha256(raw).hexdigest(), '--target', 'linux-x64',
                                '--evidence', str(evidence), '--output', str(out)])
            receipt = json.loads((evidence / 'retained-origin.json').read_text())
            self.assertEqual({p.name for p in out.iterdir()}, set(q.PACKAGES['linux-x64']))
            self.assertFalse(result['qualified']); self.assertFalse(receipt['qualified'])
            self.assertFalse(receipt['native_installation_observed'])
            self.assertEqual(receipt['original_run_qualification'], 'FAILED_NOT_REWRITTEN')
            self.assertEqual(receipt['assets'][0]['original_failed_run']['conclusion'], 'failure')

    def test_post_download_metadata_mutation_cleans_candidates(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve(); m = approved(); manifest = root / 'approved.json'
            raw = json.dumps(m).encode(); manifest.write_bytes(raw)
            out = root / 'v3-retained-linux-x64'; evidence = root / 'retained-evidence'
            mutated = api_release(m); mutated['draft'] = False
            with patch.dict(q.os.environ, {'RUNNER_TEMP': str(root), 'GITHUB_WORKSPACE': str(root),
                                           'GH_RETAINED_READ_TOKEN': 'secret'}), \
                 patch.object(q, 'host_guard'), patch.object(q, 'controller_guard'), \
                 patch.object(q.Client, 'metadata', side_effect=[(api_release(m), api_assets(m)),
                                                               (mutated, api_assets(m))]), \
                 patch.object(q.Client, 'download', side_effect=lambda a, p: p.write_bytes(b'abc')):
                with self.assertRaisesRegex(q.Blocked, 'DRAFT_RELEASE_MISMATCH'):
                    q.run(['download', '--manifest', str(manifest), '--manifest-sha256',
                           hashlib.sha256(raw).hexdigest(), '--target', 'linux-x64',
                           '--evidence', str(evidence), '--output', str(out)])
            self.assertFalse(out.exists())
            self.assertFalse((evidence / 'retained-origin.json').exists())

    def test_root_manifest_hash_checked_before_network(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp) / 'manifest.json'; p.write_text(json.dumps(approved()))
            with patch.object(q.Client, 'json', side_effect=AssertionError('network')):
                with self.assertRaisesRegex(q.Blocked, 'MANIFEST_DIGEST_MISMATCH'):
                    q.load_manifest(p, '0' * 64, 'linux-x64')

    def test_native_guard_and_static_error(self):
        with patch.dict(q.os.environ, {}, clear=True):
            with self.assertRaisesRegex(q.Blocked, 'HOST_NOT_AUTHORIZED'):
                q.host_guard('linux-x64')
        with patch.object(q, 'run', side_effect=RuntimeError('private-token signed-url private-line')):
            with patch('sys.stdout', new_callable=io.StringIO) as out:
                self.assertEqual(q.main([]), 2)
                self.assertEqual(out.getvalue(), '{"status":"BLOCKED","code":"INTERNAL_ERROR"}\n')

    def test_controller_tracked_dirty_rejected(self):
        class Result:
            def __init__(self, code, stdout=b''): self.returncode = code; self.stdout = stdout
        with patch.dict(q.os.environ, {'GITHUB_SHA': 'a' * 40}), \
             patch.object(q.subprocess, 'run', side_effect=[Result(0, b'a' * 40 + b'\n'), Result(1)]) as git:
            with self.assertRaisesRegex(q.Blocked, 'CONTROLLER_CHECKOUT_DIRTY'):
                q.controller_guard(approved(), Path('/controller'))
            self.assertEqual(git.call_args_list[1].args[0][-4:], ['diff', '--quiet', 'HEAD', '--'])


if __name__ == '__main__':
    unittest.main()
