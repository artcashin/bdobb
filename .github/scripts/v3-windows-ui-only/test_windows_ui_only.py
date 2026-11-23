import copy,hashlib,importlib.util,json,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('ui',Path(__file__).with_name('windows_ui_only.py'))
u=importlib.util.module_from_spec(spec);spec.loader.exec_module(u)
class Tests(unittest.TestCase):
 def api(self):
  p=u.PINS
  return ({'id':p['run_id'],'head_sha':p['controller'],'run_attempt':1,'event':'workflow_dispatch','path':'.github/workflows/release.yml','status':'completed','conclusion':'success','repository':{'full_name':'artcashin/bdobb'}},
   {'jobs':[{'id':p['job_id'],'name':u.JOB_NAME,'status':'completed','conclusion':'success'}]},
   {'artifacts':[{'id':p['artifact_id'],'name':'requalified-retained-v3-windows','digest':'sha256:'+p['artifact_zip_sha256'],'size_in_bytes':p['artifact_size'],'expired':False,'workflow_run':{'id':p['run_id'],'head_sha':p['controller']}}]})
 def test_exact_successful_job_and_immutable_artifact_required(self):
  r,j,a=self.api();u.validate_api(r,j,a)
  for key,val in [('head_sha','f'*40),('conclusion','failure'),('run_attempt',2)]:
   bad=copy.deepcopy(r);bad[key]=val
   with self.assertRaises(ValueError):u.validate_api(bad,j,a)
  for key,val in [('id',1),('digest','sha256:'+'0'*64),('expired',True)]:
   bad=copy.deepcopy(a);bad['artifacts'][0][key]=val
   with self.assertRaises(ValueError):u.validate_api(r,j,bad)
 def test_public_artifact_digest_receipt_uses_noncredential_field_name(self):
  receipt=u.validate_api(*self.api())
  self.assertEqual(receipt['artifact_zip_sha256'],u.PINS['artifact_zip_sha256'])
  self.assertNotIn('api_declared_zip_sha256',receipt)
 def test_pinned_used_files_block_self_reported_tamper(self):
  with tempfile.TemporaryDirectory()as temp:
   root=Path(temp);p=root/'receipt';p.write_bytes(b'reviewed')
   pins={'packages':{},'files':{'receipt':hashlib.sha256(b'reviewed').hexdigest()}}
   with patch.object(u,'PINS',pins):
    u.validate_files(root)
    p.write_bytes(b'self reported altered')
    with self.assertRaises(ValueError):u.validate_files(root)
 def test_both_distinct_observations_required(self):
  names=list(u.PINS['packages']);good={name:{'displayed_release_observed':True,'status':'OBSERVED_OWNED_TOOLTIP'}for name in names}
  self.assertTrue(u.both_displayed(good))
  for name in names:
   bad=copy.deepcopy(good);bad[name]['displayed_release_observed']=False;self.assertFalse(u.both_displayed(bad))
  self.assertFalse(u.both_displayed({names[0]:good[names[0]]}))
 def test_platform_acceptance_requires_msi_and_keeps_nsis_gap_honest(self):
  msi=next(n for n in u.PINS['packages']if n.endswith('.msi'));nsis=next(n for n in u.PINS['packages']if n.endswith('.exe'))
  good={'displayed_release_observed':True,'status':'OBSERVED_OWNED_TOOLTIP'};gap={'displayed_release_observed':False,'status':'NOT_OBSERVED'}
  self.assertTrue(u.required_msi_displayed({msi:good,nsis:gap}));self.assertFalse(u.both_displayed({msi:good,nsis:gap}))
  self.assertFalse(u.required_msi_displayed({msi:gap,nsis:good}));self.assertFalse(u.required_msi_displayed({msi:good}))
 def test_no_duplicate_pe_digest_substitution(self):
  digests={row['executable_sha256']for row in u.PINS['packages'].values()};self.assertEqual(len(digests),2)
  self.assertEqual(digests,{'4b5b540b90f573790b044ce550cf40cfaa4755c00cd8c342e32ff7dd2896b687','667418327fa6086fdbc8f3117f62fd3aaec97837b2d65889750d7de560a44576'})
 def test_observer_claims_bound_to_exact_product_and_pe(self):
  pe=next(iter(u.PINS['packages'].values()))['executable_sha256']
  row={'status':'OBSERVED_OWNED_TOOLTIP','source_commit':u.SOURCE,'source_offer_id':u.OFFER,'executable_sha256':pe,'displayed_release_observed':True,'accessible_release_observed':False,'release':'3.0.0','native_about':'NOT_OBSERVED','observed_tooltip_text':u.TITLE,'source_control_visible':True,'tooltip_visible':True}
  u.validate_observation(row,pe)
  for key,value in [('executable_sha256','0'*64),('source_offer_id','0'*64),('displayed_release_observed','true'),('status','OBSERVED_UIA_HELPTEXT'),('release','9.0.0')]:
   changed=dict(row);changed[key]=value
   with self.assertRaises(ValueError):u.validate_observation(changed,pe)
if __name__=='__main__':unittest.main()
