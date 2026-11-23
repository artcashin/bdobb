"""UI-only observation of two immutable qualified Windows executables; never builds/scans/installs."""
import argparse,hashlib,importlib.util,json,os,stat,subprocess,tempfile,urllib.request
from pathlib import Path
SOURCE='de25611461ad0559ce237c4f59b812decd91dec1'
OFFER='19c760a782e0ab84152ee990e8f9014f7e677f448bc58d6a3e548d8f485f1c6b'
TITLE='Download the corresponding source for v3.0.0 (GNU AGPL v3).'
AUDITOR='87f5f9bf3c0ed1659ba11eb0650b3ca15ddeb81e'
PINS=json.loads(Path(__file__).with_name('prior-file-pins.json').read_text(encoding='utf-8'))
JOB_NAME='Post-review same-byte V3 Windows native and MSI installation'
API='https://api.github.com/repos/artcashin/bdobb/actions/'
def module(path,name):
 spec=importlib.util.spec_from_file_location(name,path);value=importlib.util.module_from_spec(spec);spec.loader.exec_module(value);return value
def sha(path):
 with path.open('rb')as stream:return hashlib.file_digest(stream,'sha256').hexdigest()
def read(path):return json.loads(path.read_text(encoding='utf-8-sig'))
def write(path,value):
 with path.open('x',encoding='utf-8',newline='\n')as stream:json.dump(value,stream,indent=2);stream.write('\n')
def command(args,**kwargs):return subprocess.run(list(map(str,args)),check=True,capture_output=True,text=True,**kwargs)
def validate_api(run,jobs,artifacts):
 expected={'id':PINS['run_id'],'head_sha':PINS['controller'],'run_attempt':1,'event':'workflow_dispatch','path':'.github/workflows/release.yml','status':'completed','conclusion':'success'}
 if any(type(run.get(k))is not type(v)or run.get(k)!=v for k,v in expected.items())or run.get('repository',{}).get('full_name')!='artcashin/bdobb':raise ValueError('Prior run mismatch')
 rows=[j for j in jobs.get('jobs',[])if j.get('name')==JOB_NAME]
 if len(rows)!=1 or rows[0].get('id')!=PINS['job_id']or rows[0].get('status')!='completed'or rows[0].get('conclusion')!='success':raise ValueError('Prior exact job mismatch')
 rows=[a for a in artifacts.get('artifacts',[])if a.get('name')=='requalified-retained-v3-windows']
 if len(rows)!=1:raise ValueError('Prior artifact ambiguous')
 a=rows[0]
 if a.get('id')!=PINS['artifact_id']or a.get('digest')!='sha256:'+PINS['artifact_zip_sha256']or a.get('size_in_bytes')!=PINS['artifact_size']or a.get('expired')is not False or a.get('workflow_run',{}).get('id')!=PINS['run_id']or a.get('workflow_run',{}).get('head_sha')!=PINS['controller']:raise ValueError('Prior artifact mismatch')
 return {'prior_run':PINS['run_id'],'prior_job':PINS['job_id'],'artifact_id':PINS['artifact_id'],'artifact_zip_sha256':PINS['artifact_zip_sha256'],'prior_controller':PINS['controller'],'prior_result':'PASS_NATIVE_AND_ACTUAL_MSI_INSTALL','scope':'prior package qualification; no displayed-version inference'}
class NoRedirect(urllib.request.HTTPRedirectHandler):
 def redirect_request(self,*args):return None
def api(suffix):
 token=os.environ.get('GH_UI_READ_TOKEN','')
 if not token or any(c.isspace()for c in token):raise ValueError('Read token absent')
 request=urllib.request.Request(API+suffix,headers={'Authorization':'Bearer '+token,'Accept':'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28'},method='GET')
 with urllib.request.build_opener(NoRedirect()).open(request,timeout=60)as response:
  if response.getcode()!=200 or response.headers.get('Link'):raise ValueError('Read API rejected')
  raw=response.read(1024*1024+1)
 if len(raw)>1024*1024:raise ValueError('Read API over budget')
 return json.loads(raw.decode('utf-8'))
def validate_files(root,opener=None):
 selected={**PINS['files'],**{'app/release-stage/'+name:row['sha256']for name,row in PINS['packages'].items()}}
 for relative,expected in selected.items():
  path=root/relative
  if path.is_symlink()or not stat.S_ISREG(path.lstat().st_mode):raise ValueError('Independent file pin mismatch')
  with (opener(path,'rb')if opener else path.open('rb'))as stream:actual=hashlib.file_digest(stream,'sha256').hexdigest()
  if actual!=expected:raise ValueError('Independent file pin mismatch')
 for name,row in PINS['packages'].items():
  if(root/'app/release-stage'/name).stat().st_size!=row['size']:raise ValueError('Independent package size mismatch')
def both_displayed(observations):
 return set(observations)==set(PINS['packages'])and all(row.get('displayed_release_observed')is True and row.get('status')=='OBSERVED_OWNED_TOOLTIP'for row in observations.values())
def required_msi_displayed(observations):
 msi=next(name for name in PINS['packages']if name.endswith('.msi'))
 return set(observations)==set(PINS['packages'])and observations[msi].get('displayed_release_observed')is True and observations[msi].get('status')=='OBSERVED_OWNED_TOOLTIP'
def validate_observation(row,executable_sha):
 if row.get('status')not in {'OBSERVED_OWNED_TOOLTIP','OBSERVED_UIA_HELPTEXT','NOT_OBSERVED'}or row.get('source_commit')!=SOURCE or row.get('source_offer_id')!=OFFER or row.get('executable_sha256')!=executable_sha:raise ValueError('Observer identity mismatch')
 if any(type(row.get(k))is not bool for k in ['displayed_release_observed','accessible_release_observed']):raise ValueError('Observer claim type mismatch')
 if row['displayed_release_observed']!=(row['status']=='OBSERVED_OWNED_TOOLTIP')or(row['displayed_release_observed']and(row.get('release')!='3.0.0'or row.get('observed_tooltip_text')!=TITLE or row.get('source_control_visible')is not True or row.get('tooltip_visible')is not True))or row.get('native_about')!='NOT_OBSERVED':raise ValueError('Observer claim mismatch')
 return row
def guard(args):
 transfer=module(args.controller/'.github/scripts/v3-windows-retained/retained_windows.py','ui_host_transfer')
 transfer.host_guard('windows')
 sha=os.environ.get('GITHUB_SHA','');transfer.controller_guard({'qualification_controller_commit':sha},args.controller)
 return transfer
def verify(args):
 guard(args);run=PINS['run_id']
 record=validate_api(api(f'runs/{run}'),api(f'runs/{run}/attempts/1/jobs?per_page=100'),api(f'runs/{run}/artifacts?per_page=100'))
 args.evidence.mkdir();write(args.evidence/'ui-prior-api.json',record)
 with Path(os.environ['GITHUB_OUTPUT']).open('a',encoding='ascii',newline='\n')as stream:stream.write(f'run_id={run}\nartifact_id={PINS["artifact_id"]}\n')
def observe(args):
 transfer=guard(args)
 prior=read(args.evidence/'ui-prior-api.json')
 expected_api={'prior_run':PINS['run_id'],'prior_job':PINS['job_id'],'artifact_id':PINS['artifact_id'],'artifact_zip_sha256':PINS['artifact_zip_sha256'],'prior_controller':PINS['controller'],'prior_result':'PASS_NATIVE_AND_ACTUAL_MSI_INSTALL','scope':'prior package qualification; no displayed-version inference'}
 if prior!=expected_api:raise ValueError('API verification missing or altered')
 for path,wanted in [(args.app,SOURCE),(args.auditor,AUDITOR)]:
  if command(['git','-C',path,'rev-parse','HEAD']).stdout.strip()!=wanted:raise ValueError('Checkout mismatch')
  command(['git','-C',path,'diff','--quiet','HEAD','--'])
 validate_files(args.artifacts,transfer.physical_open)
 old=read(args.artifacts/'retained-evidence-windows/retained-qualification.json')
 expected={'status':'PASS_NATIVE_AND_ACTUAL_MSI_INSTALL','compiled_product_source_commit':SOURCE,'source_offer_id':OFFER,'auditor_commit':AUDITOR,'qualification_controller_commit':PINS['controller'],'manifest_sha256':PINS['manifest_sha256'],'app_rebuilt':False,'original_failed_compile_run_not_reclassified':True}
 if any(type(old.get(k))is not type(v)or old.get(k)!=v for k,v in expected.items()):raise ValueError('Prior source identity mismatch')
 origin=old['retained_origin']
 if origin.get('original_run_qualification')!='FAILED_NOT_REWRITTEN'or len(origin.get('assets',[]))!=2 or any(a.get('original_failed_run')!=transfer.ORIGINAL_FAILURES['windows']for a in origin.get('assets',[])):raise ValueError('Failed compile origin changed')
 q=module(args.controller/'.github/scripts/v3_qualification.py','ui_native_runtime')
 if q.SOURCE_COMMIT!=SOURCE or q.SOURCE_ID!=OFFER:raise ValueError('Runtime source mismatch')
 records=read(args.artifacts/'app/release-stage/qualification.json')
 gate=q.load_release_gate(args.auditor);results={}
 for name,pin in PINS['packages'].items():
  package=args.artifacts/'app/release-stage'/name
  if records[name].get('executable_sha256')!=pin['executable_sha256']:raise ValueError('Prior executable mismatch')
  evidence=args.evidence/name;evidence.mkdir()
  with tempfile.TemporaryDirectory(prefix='v3-ui-only-',dir=os.environ['RUNNER_TEMP'])as temporary:
   work=Path(temporary);unpacked=work/'unpacked';unpacked.mkdir()
   gate.unpack(package,unpacked) # Existing strict format preflight, no privacy rescan.
   executable,_member=q.locate_executable(unpacked,package,work)
   if sha(executable)!=pin['executable_sha256']:raise ValueError('Extracted executable differs')
   q.require_arch(executable,'x86_64')
   def callback(pid,live_executable,runtime_work,runtime_evidence,native_arch):
    command(['powershell','-NoProfile','-File',Path(__file__).with_name('windows_ui_probe.ps1'),'-AppPid',pid,'-Executable',live_executable,'-ExpectedSha256',pin['executable_sha256'],'-Evidence',runtime_evidence],timeout=30)
    return validate_observation(read(runtime_evidence/'windows-ui-only.json'),pin['executable_sha256'])
   runtime=q.native_runtime(executable,package,work,evidence,'x86_64',ui_observer=callback)
   observation=runtime['displayed_version_ui'];results[name]=observation
   if sha(package)!=pin['sha256']or sha(executable)!=pin['executable_sha256']:raise ValueError('Bytes changed during UI')
   write(evidence/'ui-runtime.json',runtime)
 required=required_msi_displayed(results);both=both_displayed(results)
 report={'status':'PASS_DISPLAYED_BOTH'if both else'PASS_MSI_PLATFORM_DISPLAYED'if required else'UI_GAP','required_msi_platform_displayed':required,'both_displayed':both,'source_commit':SOURCE,'source_offer_id':OFFER,'auditor_commit':AUDITOR,'ui_controller':os.environ['GITHUB_SHA'],'prior_run':PINS['run_id'],'artifact_id':PINS['artifact_id'],'original_failed_compile_origin_preserved':True,'app_rebuilt':False,'privacy_rescan_performed':False,'installation_repeated':False,'observations':results}
 write(args.evidence/'windows-ui-supplement.json',report)
 transfer.controller_guard({'qualification_controller_commit':os.environ['GITHUB_SHA']},args.controller)
def main(argv=None):
 parser=argparse.ArgumentParser(description=__doc__)
 parser.add_argument('mode',choices=['verify-api','observe'])
 for name in ['controller','evidence']:parser.add_argument('--'+name,type=Path,required=True)
 for name in ['app','auditor','artifacts']:parser.add_argument('--'+name,type=Path)
 try:
  args=parser.parse_args(argv)
  for name in ['controller','evidence','app','auditor','artifacts']:
   if getattr(args,name)is not None:setattr(args,name,getattr(args,name).absolute())
  verify(args)if args.mode=='verify-api'else observe(args)
 except Exception:
  print(json.dumps({'status':'WINDOWS_UI_ONLY_BLOCKED','code':'PROVENANCE_OR_NATIVE_OBSERVATION_FAILED'}));return 2
 print(json.dumps({'status':'WINDOWS_UI_ONLY_STEP_COMPLETED','app_rebuilt':False}));return 0
if __name__=='__main__':raise SystemExit(main())
