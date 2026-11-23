import copy
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import stat
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import urllib.error

HERE=Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('retained_windows',HERE/'retained_windows.py')
q=importlib.util.module_from_spec(spec);spec.loader.exec_module(q)


def approved():
    return {'schema_version':1,'enabled':True,'approval':'ROOT_APPROVED_ACTUAL_BYTES',
            'repository':q.REPOSITORY,'app_source_repository':q.SOURCE_REPOSITORY,
            'app_source_commit':q.SOURCE_COMMIT,'source_offer_id':q.OFFER,
            'qualification_controller_commit':'a'*40,'auditor_commit':q.AUDITOR_COMMIT,
            'release':{'id':123,'tag_name':q.TAG_PREFIX+'0123456789ab','target_commitish':'c'*40,'draft':True,'prerelease':True},
            'assets':[{'name':name,'id':i+10,'size':3,'sha256':hashlib.sha256(b'abc').hexdigest(),
                       'privacy_receipt_sha256':'d'*64,'original_failed_run':copy.deepcopy(q.ORIGINAL_FAILURES['windows'])}
                      for i,name in enumerate(q.PACKAGES['windows'])]}


def metadata(m):
    release={**m['release'],'published_at':None,'url':q.API+'/releases/'+str(m['release']['id'])}
    assets=[dict(id=a['id'],name=a['name'],size=a['size'],state='uploaded',digest='sha256:'+a['sha256'],
                 url=q.API+'/releases/assets/'+str(a['id'])) for a in m['assets']]
    return release,assets


class Response(io.BytesIO):
    def __init__(self,data,status=200,headers=None):super().__init__(data);self.status=status;self.headers=headers or {}
    def getcode(self):return self.status


def canonical_fixture_root(value):
    # Production uses resolved RUNNER_TEMP roots. Check the raw fresh physical
    # directory before expanding a native Windows 8.3 temporary-path alias.
    raw = Path(value).absolute()
    q.physical_chain(raw, directory=True)
    canonical = raw.resolve(strict=True)
    q.physical_chain(canonical, directory=True)
    return canonical


class Tests(unittest.TestCase):
    def test_disabled_and_pending_auditor_never_authorize(self):
        self.assertEqual(q.AUDITOR_COMMIT,'87f5f9bf3c0ed1659ba11eb0650b3ca15ddeb81e')
        with self.assertRaisesRegex(q.Blocked,'MANIFEST_NOT_APPROVED'):
            q.validate_manifest(json.loads((HERE/'candidates.disabled.json').read_text()),'windows')
        with patch.object(q,'AUDITOR_COMMIT',None),self.assertRaisesRegex(q.Blocked,'AUDITOR_NOT_APPROVED'):
            q.validate_manifest(approved(),'windows')

    def test_exact_two_packages_source_auditor_release_and_failed_origin(self):
        self.assertEqual(len(q.validate_manifest(approved(),'windows')['selected_assets']),2)
        changes=[lambda m:m.update(app_source_commit='f'*40),lambda m:m.update(auditor_commit='f'*40),
                 lambda m:m['assets'].pop(),lambda m:m['assets'].append(copy.deepcopy(m['assets'][0])),
                 lambda m:m['assets'][0].update(name='other.exe'),lambda m:m['assets'][0].update(id=True),
                 lambda m:m['assets'][1].update(id=m['assets'][0]['id']),lambda m:m['assets'][0].update(size=0),
                 lambda m:m['assets'][0].update(privacy_receipt_sha256=''),
                 lambda m:m['assets'][0]['original_failed_run'].update(conclusion='success'),
                 lambda m:m['assets'][0]['original_failed_run'].update(run_id=45093464213),
                 lambda m:m['assets'][0]['original_failed_run'].update(controller_commit='e'*40),
                 lambda m:m['release'].update(tag_name='v3.0.0'),lambda m:m['release'].update(draft=False),
                 lambda m:m.update(unreviewed=True)]
        for change in changes:
            m=approved();change(m)
            with self.subTest(change=change),self.assertRaises(q.Blocked):q.validate_manifest(m,'windows')

    def test_remote_exact_two_unpublished_assets_with_sha_required(self):
        m=approved();s=q.validate_manifest(m,'windows');q.verify_api(s,*metadata(m))
        changes=[lambda r,a:r.update(published_at='published'),lambda r,a:r.update(target_commitish='main'),
                 lambda r,a:r.update(prerelease=False),lambda r,a:a.append(copy.deepcopy(a[0])),
                 lambda r,a:a[0].update(digest=None),lambda r,a:a[0].update(size=4),
                 lambda r,a:a[0].update(url='https://example.com/asset')]
        for change in changes:
            r,a=metadata(m);change(r,a)
            with self.assertRaises(q.Blocked):q.verify_api(s,r,a)

    def test_cdn_redirect_drops_credentials_and_wrong_origins_rejected(self):
        calls=[]
        def opener(request,timeout):
            calls.append(request)
            return Response(b'',302,{'Location':'https://release-assets.githubusercontent.com/asset?private=signed'}) if len(calls)==1 else Response(b'abc')
        with tempfile.TemporaryDirectory() as tmp:
            dest=canonical_fixture_root(tmp)/'package';q.Client('PRIVATE_TOKEN',opener).download(approved()['assets'][0],dest)
            self.assertEqual(dest.read_bytes(),b'abc')
        self.assertIn('Authorization',calls[0].headers)
        self.assertTrue(all(call.get_method()=='GET' for call in calls))
        self.assertEqual(calls[1].headers,{'Accept':'application/octet-stream','User-agent':q.USER_AGENT})
        for url in ['https://example.com/asset','http://release-assets.githubusercontent.com/x',
                    'https://private@release-assets.githubusercontent.com/x','https://release-assets.githubusercontent.com:444/x',
                    'https://release-assets.githubusercontent.com/x#fragment']:
            with self.assertRaises(q.Blocked):q.validate_redirect(url)

    def test_download_tamper_size_and_existing_destination_fail_closed(self):
        for raw,code in [(b'abd','ASSET_DIGEST_MISMATCH'),(b'ab','ASSET_DIGEST_MISMATCH'),(b'abcd','ASSET_SIZE_MISMATCH')]:
            with tempfile.TemporaryDirectory() as tmp:
                p=canonical_fixture_root(tmp)/'package';client=q.Client('private',lambda request,timeout:Response(raw))
                with self.assertRaisesRegex(q.Blocked,code):client.download(approved()['assets'][0],p)
                self.assertFalse(p.exists())
        with tempfile.TemporaryDirectory() as tmp:
            p=canonical_fixture_root(tmp)/'package';p.write_bytes(b'original')
            with self.assertRaises(FileExistsError):q.Client('private',lambda request,timeout:Response(b'abc')).download(approved()['assets'][0],p)
            self.assertEqual(p.read_bytes(),b'original')

    def test_manifest_hash_and_duplicate_keys_checked(self):
        with tempfile.TemporaryDirectory() as tmp:
            p=canonical_fixture_root(tmp)/'manifest';p.write_bytes(json.dumps(approved()).encode())
            with self.assertRaisesRegex(q.Blocked,'MANIFEST_DIGEST_MISMATCH'):q.load_manifest(p,'0'*64,'windows')
        with self.assertRaisesRegex(q.Blocked,'JSON_DUPLICATE_KEY'):q.parse_json(b'{"enabled":false,"enabled":true}')

    def test_windows_metadata_rejects_reparse_hardlink_special_or_missing_attributes(self):
        safe=SimpleNamespace(st_mode=stat.S_IFREG|0o600,st_nlink=1,st_file_attributes=0)
        q.validate_physical_stat(safe,directory=False,windows=True)
        for attr,value in [('st_nlink',2),('st_file_attributes',0x400),('st_mode',stat.S_IFLNK)]:
            bad=copy.copy(safe);setattr(bad,attr,value)
            with self.assertRaises(q.Blocked):q.validate_physical_stat(bad,directory=False,windows=True)
        del safe.st_file_attributes
        with self.assertRaises(q.Blocked):q.validate_physical_stat(safe,directory=False,windows=True)

    def test_windows_handle_info_checks_disk_attributes_hardlinks_and_final_path(self):
        q.validate_handle_info(file_type=1,attributes=0,links=1,final_path=r'\\?\D:\a\_temp\file',expected_path=r'D:\a\_temp\file')
        for change in [dict(file_type=2),dict(attributes=0x400),dict(attributes=0x10),dict(links=2),dict(final_path=r'\\?\D:\elsewhere')]:
            values=dict(file_type=1,attributes=0,links=1,final_path=r'\\?\D:\a\_temp\file',expected_path=r'D:\a\_temp\file');values.update(change)
            with self.assertRaises(q.Blocked):q.validate_handle_info(**values)

    def test_noncanonical_short_alias_is_still_rejected_by_production_handle_policy(self):
        with self.assertRaisesRegex(q.Blocked,'WINDOWS_FINAL_PATH_MISMATCH'):
            q.validate_handle_info(file_type=1,attributes=0,links=1,
                final_path=r'\\?\C:\Users\RunnerAdmin\AppData\Local\Temp\fixture',
                expected_path=r'C:\Users\RUNNER~1\AppData\Local\Temp\fixture')

    def test_native_host_guard_rejects_workstation_or_wrong_arch(self):
        with patch.dict(os.environ,{},clear=True),self.assertRaises(q.Blocked):q.host_guard('windows')
        env={'GITHUB_ACTIONS':'true','RUNNER_ENVIRONMENT':'github-hosted','RUNNER_OS':'Windows','GITHUB_REPOSITORY':q.REPOSITORY,'RUNNER_ARCH':'X64'}
        with patch.dict(os.environ,env,clear=True),patch.object(q.platform,'system',return_value='Windows'),patch.object(q.platform,'machine',return_value='ARM64'):
            with self.assertRaises(q.Blocked):q.host_guard('windows')

    def test_materialize_exact_bytes_exclusive_with_no_added_newline(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=canonical_fixture_root(tmp);p=root/'v3-retained-input.json';raw=json.dumps(approved(),indent=2).encode()
            args=['materialize','--target','windows','--manifest',str(p),'--manifest-sha256',hashlib.sha256(raw).hexdigest()]
            with patch.dict(os.environ,{'RUNNER_TEMP':str(root),'RETAINED_MANIFEST_JSON':raw.decode()}),patch.object(q,'host_guard'),patch.object(q,'controller_guard'):
                q.run(args);self.assertEqual(p.read_bytes(),raw)
                with self.assertRaises(FileExistsError):q.run(args)

    def test_two_packages_one_origin_receipt_and_failed_run_preserved(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=canonical_fixture_root(tmp);m=approved();p=root/'v3-retained-input.json';raw=json.dumps(m).encode();p.write_bytes(raw)
            evidence=root/'retained-evidence';output=root/'v3-retained-windows'
            args=['download','--target','windows','--manifest',str(p),'--manifest-sha256',hashlib.sha256(raw).hexdigest(),'--evidence',str(evidence),'--output',str(output)]
            with patch.dict(os.environ,{'RUNNER_TEMP':str(root),'GITHUB_WORKSPACE':str(root),'GH_RETAINED_READ_TOKEN':'private'}),patch.object(q,'host_guard'),patch.object(q,'controller_guard'),patch.object(q.Client,'metadata',return_value=metadata(m)),patch.object(q.Client,'download',side_effect=lambda a,path:path.write_bytes(b'abc')):
                q.run(args)
            self.assertEqual({x.name for x in output.iterdir()},set(q.PACKAGES['windows']))
            self.assertEqual({x.name for x in evidence.iterdir()},{'retained-origin.json'})
            receipt=json.loads((evidence/'retained-origin.json').read_text());self.assertFalse(receipt['qualified'])
            self.assertEqual(receipt['original_run_qualification'],'FAILED_NOT_REWRITTEN')
            self.assertEqual(receipt['assets'][0]['original_failed_run'],q.ORIGINAL_FAILURES['windows'])

    def test_preflight_emits_only_auditor_output_without_network_or_extra_receipt(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=canonical_fixture_root(tmp);p=root/'v3-retained-input.json';raw=json.dumps(approved()).encode();p.write_bytes(raw)
            output=root/'github-output';output.write_bytes(b'');evidence=root/'retained-evidence'
            with patch.dict(os.environ,{'RUNNER_TEMP':str(root),'GITHUB_WORKSPACE':str(root),'GITHUB_OUTPUT':str(output)}),patch.object(q,'host_guard'),patch.object(q,'controller_guard'),patch.object(q.Client,'metadata',side_effect=AssertionError('No network')):
                q.run(['preflight','--target','windows','--manifest',str(p),'--manifest-sha256',hashlib.sha256(raw).hexdigest(),'--evidence',str(evidence)])
            self.assertEqual(output.read_bytes(),b'auditor_commit='+q.AUDITOR_COMMIT.encode()+b'\n')
            self.assertEqual(list(evidence.iterdir()),[])

    def test_remote_metadata_changed_after_download_cleans_all_candidates(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=canonical_fixture_root(tmp);m=approved();p=root/'v3-retained-input.json';raw=json.dumps(m).encode();p.write_bytes(raw)
            release,assets=metadata(m);changed={**release,'draft':False};output=root/'v3-retained-windows';evidence=root/'retained-evidence'
            with patch.dict(os.environ,{'RUNNER_TEMP':str(root),'GITHUB_WORKSPACE':str(root),'GH_RETAINED_READ_TOKEN':'private'}),patch.object(q,'host_guard'),patch.object(q,'controller_guard'),patch.object(q.Client,'metadata',side_effect=[(release,assets),(changed,assets)]),patch.object(q.Client,'download',side_effect=lambda asset,path:path.write_bytes(b'abc')):
                with self.assertRaisesRegex(q.Blocked,'DRAFT_RELEASE_MISMATCH'):
                    q.run(['download','--target','windows','--manifest',str(p),'--manifest-sha256',hashlib.sha256(raw).hexdigest(),'--evidence',str(evidence),'--output',str(output)])
            self.assertFalse(output.exists());self.assertEqual(list(evidence.iterdir()),[])

    def test_controller_dirty_tracked_files_rejected(self):
        result=lambda code,stdout=b'':SimpleNamespace(returncode=code,stdout=stdout)
        with patch.dict(os.environ,{'GITHUB_SHA':'a'*40}),patch.object(q.subprocess,'run',side_effect=[result(0,b'a'*40+b'\n'),result(1)]):
            with self.assertRaisesRegex(q.Blocked,'CONTROLLER_CHECKOUT_DIRTY'):q.controller_guard(approved(),Path('/controller'))

    def test_http_diagnostic_only_static_endpoint_and_numeric_status(self):
        def opener(request,timeout):raise urllib.error.HTTPError(request.full_url,404,'PRIVATE_MESSAGE',{'PRIVATE_HEADER':'PRIVATE'},io.BytesIO(b'PRIVATE_BODY'))
        try:q.Client('PRIVATE_TOKEN',opener).metadata(approved())
        except q.Blocked as error:
            with patch.object(q,'run',side_effect=error),patch('sys.stdout',new_callable=io.StringIO) as output:
                self.assertEqual(q.main([]),2)
            value=json.loads(output.getvalue());self.assertEqual(value,{'status':'BLOCKED','code':'API_HTTP_REJECTED','http_status':404,'endpoint':'release-metadata'})
            self.assertNotIn('PRIVATE',output.getvalue())
        else:self.fail('Expected safe HTTP rejection')


if __name__=='__main__':unittest.main()
