import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import types
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('retained_runtime', Path(__file__).with_name('qualify_retained.py'))
s = importlib.util.module_from_spec(spec)
spec.loader.exec_module(s)


class BindingTests(unittest.TestCase):
    def test_native_worker_refuses_workstation_and_cross_architecture(self):
        q=types.SimpleNamespace(TARGETS={'linux-x64':('x86_64',[])})
        with patch.dict(s.os.environ,{'GITHUB_ACTIONS':'false'}):
            with self.assertRaises(ValueError): s.require_hosted_linux('linux-x64',q)
        with patch.dict(s.os.environ,{'GITHUB_ACTIONS':'true','RUNNER_ENVIRONMENT':'github-hosted','RUNNER_OS':'Linux'}), patch.object(s.platform,'system',return_value='Linux'), patch.object(s.platform,'machine',return_value='aarch64'):
            with self.assertRaises(ValueError): s.require_hosted_linux('linux-x64',q)

    def test_owned_accessibility_environment_removes_disabling_inherited_key(self):
        with patch.dict(s.os.environ, {'NO_AT_BRIDGE':'1','KEEP_OWNED_VALUE':'same'}, clear=True):
            s.apply_owned_environment({'AT_SPI_BUS_ADDRESS':'unix:path=/owned-test-bus','KEEP_OWNED_VALUE':'same'})
            self.assertNotIn('NO_AT_BRIDGE',s.os.environ)
            self.assertEqual(s.os.environ['AT_SPI_BUS_ADDRESS'],'unix:path=/owned-test-bus')
            self.assertEqual(s.os.environ['KEEP_OWNED_VALUE'],'same')

    def stage(self, root):
        name = 'BDOBB_3.0.0_amd64.deb'
        package = root / name
        package.write_bytes(b'exact retained bytes')
        sha = hashlib.sha256(package.read_bytes()).hexdigest()
        expected = {name: {'sha256': sha, 'size': package.stat().st_size}}
        q = types.SimpleNamespace(SOURCE_COMMIT=s.SOURCE, SOURCE_ID=s.OFFER, EXPECTED_OFFER={'sourceId':s.OFFER},
                                  expected_names=lambda target: [name], TARGETS={'linux-x64': ('x86_64',[name])})
        record = {'sha256':sha,'source_commit':s.SOURCE,'source_id':s.OFFER,'embedded_offer':q.EXPECTED_OFFER,
                  'embedded_defaults':'all six exact empty values verified by app checker','architecture':'x86_64',
                  'executable_sha256':'a'*64,'runtime':{'status':'PASS'}}
        (root/'scan.json').write_text(json.dumps({name:{'sha256':sha}}))
        (root/'qualification.json').write_text(json.dumps({name:record}))
        return name, expected, q

    def test_only_exact_retained_scanned_native_qualified_bytes_can_be_installed(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp)
            name, expected, q = self.stage(root)
            self.assertEqual(s.validate_qualification(root, expected, q, 'linux-x64')[0], root/name)
            (root/name).write_bytes(b'changed bytes')
            with self.assertRaises(ValueError): s.validate_qualification(root, expected, q, 'linux-x64')

    def test_changed_offer_scan_runtime_and_extra_name_are_rejected(self):
        for field, value in [('source_commit','0'*40),('source_id','0'*64),('embedded_offer',{}),('runtime',{'status':'FAIL'}),('architecture','aarch64')]:
            with self.subTest(field=field), tempfile.TemporaryDirectory() as temp:
                root=Path(temp);name,expected,q=self.stage(root)
                obj=json.loads((root/'qualification.json').read_text());obj[name][field]=value
                (root/'qualification.json').write_text(json.dumps(obj))
                with self.assertRaises(ValueError): s.validate_qualification(root,expected,q,'linux-x64')
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);name,expected,q=self.stage(root)
            (root/'scan.json').write_text('{}')
            with self.assertRaises(ValueError): s.validate_qualification(root,expected,q,'linux-x64')
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);name,expected,q=self.stage(root)
            (root/'BDOBB_3.0.0_amd64.AppImage').write_bytes(b'extra')
            with self.assertRaises(ValueError): s.validate_qualification(root,expected,q,'linux-x64')


if __name__ == '__main__': unittest.main()
