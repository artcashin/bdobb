import copy
import importlib.util
from pathlib import Path
import unittest
import tempfile
import hashlib
from unittest.mock import patch

spec=importlib.util.spec_from_file_location('ui',Path(__file__).with_name('linux_ui_supplement.py'))
s=importlib.util.module_from_spec(spec);spec.loader.exec_module(s)

class Tests(unittest.TestCase):
    def test_independent_package_and_receipt_pins_block_both_payload_and_metadata_tampering(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);package=root/'app/release-stage/example.deb';package.parent.mkdir(parents=True);package.write_bytes(b'reviewed package')
            receipt=root/'retained-evidence/retained-qualification.json';receipt.parent.mkdir();receipt.write_bytes(b'reviewed receipt')
            pins={'linux-arm':{'packages':{'example.deb':{'sha256':hashlib.sha256(package.read_bytes()).hexdigest(),'size':package.stat().st_size}},'receipts':{'retained-evidence/retained-qualification.json':hashlib.sha256(receipt.read_bytes()).hexdigest()}}}
            with patch.object(s,'PINS',pins):
                s.validate_pinned_files(root,'linux-arm')
                package.write_bytes(b'altered package')
                with self.assertRaises(ValueError):s.validate_pinned_files(root,'linux-arm')
                package.write_bytes(b'reviewed package');receipt.write_bytes(b'altered self-reported receipt')
                with self.assertRaises(ValueError):s.validate_pinned_files(root,'linux-arm')

    def provenance(self):
        pin=s.PRIOR['linux-arm']
        run={'id':pin['run'],'run_attempt':1,'head_sha':pin['controller'],'event':'workflow_dispatch','path':'.github/workflows/release.yml','status':'completed','conclusion':'success','repository':{'full_name':'artcashin/bdobb'}}
        jobs={'jobs':[{'id':pin['job'],'name':'Post-review same-byte V3 linux-arm qualification','status':'completed','conclusion':'success'}]}
        artifacts={'artifacts':[{'id':pin['artifact'],'name':'requalified-retained-v3-linux-arm','expired':False,'digest':'sha256:'+pin['artifact_sha256'],'workflow_run':{'id':pin['run'],'head_sha':pin['controller']}}]}
        return run,jobs,artifacts

    def test_exact_successful_requalification_is_required_not_failed_compile(self):
        run,jobs,artifacts=self.provenance();self.assertEqual(s.validate_run(run,jobs,artifacts,'linux-arm')['artifact_id'],s.PRIOR['linux-arm']['artifact'])
        for field,value in [('id',45086629317),('conclusion','failure'),('head_sha','f'*40),('run_attempt',2)]:
            bad=copy.deepcopy(run);bad[field]=value
            with self.subTest(field=field),self.assertRaises(ValueError):s.validate_run(bad,jobs,artifacts,'linux-arm')

    def test_wrong_immutable_artifact_digest_job_and_duplicates_rejected(self):
        run,jobs,artifacts=self.provenance()
        for field,value in [('id',1),('digest','sha256:'+'0'*64),('expired',True)]:
            bad=copy.deepcopy(artifacts);bad['artifacts'][0][field]=value
            with self.assertRaises(ValueError):s.validate_run(run,jobs,bad,'linux-arm')
        jobs['jobs'][0]['conclusion']='failure'
        with self.assertRaises(ValueError):s.validate_run(run,jobs,artifacts,'linux-arm')
        run,jobs,artifacts=self.provenance();artifacts['artifacts']*=2
        with self.assertRaises(ValueError):s.validate_run(run,jobs,artifacts,'linux-arm')

if __name__=='__main__':unittest.main()
