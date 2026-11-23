import hashlib,importlib.util,json,tempfile,types,unittest
from pathlib import Path
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('worker',Path(__file__).with_name('qualify_windows_retained.py'));w=importlib.util.module_from_spec(spec);spec.loader.exec_module(w)

class Tests(unittest.TestCase):
    def stage(self,root):
        names=['BDOBB_3.0.0_x64_en-US.msi','BDOBB_3.0.0_x64-setup.exe'];pins={};records={};scans={};offer={'sourceId':w.OFFER}
        for name in names:
            p=root/name;p.write_bytes(name.encode());sha=hashlib.sha256(p.read_bytes()).hexdigest();pins[name]={'sha256':sha,'size':p.stat().st_size};scans[name]={'sha256':sha};records[name]={'sha256':sha,'source_commit':w.SOURCE,'source_id':w.OFFER,'architecture':'x86_64','embedded_offer':offer,'embedded_defaults':'all six exact empty values verified by app checker','executable_sha256':'a'*64,'runtime':{'status':'PASS','backends':[]}}
        (root/'scan.json').write_text(json.dumps(scans));(root/'qualification.json').write_text(json.dumps(records))
        q=types.SimpleNamespace(expected_names=lambda target:names,EXPECTED_OFFER=offer)
        return pins,q
    def test_exact_both_scanned_native_packages_required_before_msi_install(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);pins,q=self.stage(root);msi,_=w.validate_stage(root,pins,q);self.assertEqual(msi.name,'BDOBB_3.0.0_x64_en-US.msi')
            msi.write_bytes(b'tamper')
            with self.assertRaises(ValueError):w.validate_stage(root,pins,q)
    def test_wrong_source_offer_defaults_architecture_or_native_status_rejected(self):
        for field,value in [('source_commit','0'*40),('embedded_offer',{}),('embedded_defaults','nonempty'),('architecture','aarch64'),('runtime',{'status':'FAIL'})]:
            with self.subTest(field=field),tempfile.TemporaryDirectory() as temp:
                root=Path(temp);pins,q=self.stage(root);p=root/'qualification.json';o=json.loads(p.read_text());o[next(iter(o))][field]=value;p.write_text(json.dumps(o))
                with self.assertRaises(ValueError):w.validate_stage(root,pins,q)
    def test_actual_install_guard_rejects_workstation_before_any_command(self):
        with patch.dict(w.os.environ,{'GITHUB_ACTIONS':'false'}):
            with self.assertRaises(ValueError):w.host_guard()
if __name__=='__main__':unittest.main()
