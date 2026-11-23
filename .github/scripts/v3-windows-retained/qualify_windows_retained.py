"""Requalify and actually install exact retained Windows bytes; never builds/publishes."""
import argparse,hashlib,importlib.util,json,os,platform,re,shutil,stat,subprocess,sys,tempfile
from pathlib import Path
SOURCE='de25611461ad0559ce237c4f59b812decd91dec1'
OFFER='19c760a782e0ab84152ee990e8f9014f7e677f448bc58d6a3e548d8f485f1c6b'
AUDITOR='87f5f9bf3c0ed1659ba11eb0650b3ca15ddeb81e'

def module(path,name):
 spec=importlib.util.spec_from_file_location(name,path);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m

def read(path):return json.loads(path.read_text(encoding='utf-8-sig'))
def sha(path):
 with path.open('rb')as stream:return hashlib.file_digest(stream,'sha256').hexdigest()
def command(args,**kwargs):return subprocess.run(list(map(str,args)),check=True,text=True,**kwargs)
def host_guard():
 if any(os.environ.get(k)!=v for k,v in {'GITHUB_ACTIONS':'true','RUNNER_ENVIRONMENT':'github-hosted','RUNNER_OS':'Windows'}.items()) or platform.system()!='Windows' or platform.machine().lower()not in {'amd64','x86_64'}:raise ValueError('Native hosted Windows required')

def validate_stage(stage,pins,q):
 names=set(q.expected_names('windows'))
 if set(pins)!=names or {p.name for p in stage.iterdir()if p.name.startswith('BDOBB')}!=names:raise ValueError('Exact Windows package set mismatch')
 records=read(stage/'qualification.json');scans=read(stage/'scan.json')
 if set(records)!=names or set(scans)!=names:raise ValueError('Exact Windows scan/qualification set mismatch')
 for name,pin in pins.items():
  p=stage/name;r=records[name]
  if p.is_symlink()or not stat.S_ISREG(p.lstat().st_mode)or p.stat().st_size!=pin['size']or sha(p)!=pin['sha256']or scans[name].get('sha256')!=pin['sha256']or r.get('sha256')!=pin['sha256']:raise ValueError('Retained package hash/size mismatch')
  if r.get('source_commit')!=SOURCE or r.get('source_id')!=OFFER or r.get('architecture')!='x86_64' or r.get('embedded_offer')!=q.EXPECTED_OFFER or r.get('embedded_defaults')!='all six exact empty values verified by app checker':raise ValueError('Retained decoded source/default/architecture proof missing')
  if r.get('runtime',{}).get('status')!='PASS' or r.get('runtime',{}).get('backends')!=[] or not re.fullmatch('[0-9a-f]{64}',r.get('executable_sha256','')):raise ValueError('Retained native empty-profile proof missing')
 msi=next(name for name in names if name.endswith('.msi'));return stage/msi,records[msi]

def ps(mode,package,evidence,controller):
 command(['powershell','-NoProfile','-File',controller/'.github/scripts/v3-install-supplement/windows_install.ps1','-Mode',mode,'-Package',package,'-Evidence',evidence],capture_output=True)

def install_msi(package,original,q,gate,evidence,controller):
 host_guard();evidence.mkdir();receipt={'status':'INCOMPLETE','method':'actual exact retained MSI installation/registration/native launch/removal; no app rebuild','package':package.name,'sha256':original['sha256'],'compiled_product_source_commit':SOURCE,'source_offer_id':OFFER,'auditor_commit':AUDITOR,'architecture':'x86_64','app_rebuilt':False};installed=False
 with tempfile.TemporaryDirectory(prefix='v3-retained-msi-',dir=os.environ['RUNNER_TEMP'])as temp:
  work=Path(temp);private=work/'installer-diagnostics';private.mkdir()
  try:
   ps('Preflight',package,private,controller)
   installed=True
   ps('Install',package,private,controller)
   registration=read(private/'windows-install.json');executable=Path(registration['installed_path'])
   if executable.is_symlink()or not executable.is_file()or sha(executable)!=original['executable_sha256']:raise ValueError('Actual installed MSI executable differs from scanned original')
   q.require_arch(executable,'x86_64')
   frontend=work/'installed-frontend';command(['tauri-dumper','extract',executable,'-o',frontend,'--json'],capture_output=True);gate.check_frontend(frontend);q.verify_offer(frontend)
   receipt.update(installation=registration,installed_executable_sha256=sha(executable),embedded_offer=q.EXPECTED_OFFER,embedded_defaults='all six exact empty values verified again from installed executable')
   receipt['runtime']=q.native_runtime(executable,package,work,evidence,'x86_64');receipt['runtime']['method']='actual installed MSI executable launched after recorded Windows Installer registration; installer dialog not exercised'
   receipt['displayed_version_observed']=receipt['runtime'].get('ui',{}).get('source_offer_release_ui',{}).get('displayed_release_observed')is True
   if sha(package)!=original['sha256']or sha(executable)!=original['executable_sha256']:raise ValueError('Installer or installed executable changed during smoke')
  finally:
   if installed:
    ps('Remove',package,private,controller);receipt['cleanup']=read(private/'windows-remove.json')
   for name in ['windows-preflight.json','windows-install.json','windows-remove.json']:
    p=private/name
    if p.is_file():shutil.copyfile(p,evidence/name)
   receipt['private_installer_logs']=[{'filename':p.name,'size':p.stat().st_size,'sha256':sha(p),'uploaded':False}for p in sorted(private.glob('*.log'))]
   (evidence/'install-receipt.json').write_text(json.dumps(receipt,indent=2)+'\n',encoding='utf-8',newline='\n')
 receipt['status']='PASS';(evidence/'install-receipt.json').write_text(json.dumps(receipt,indent=2)+'\n',encoding='utf-8',newline='\n');return receipt

def qualify(args):
 host_guard();transfer=module(Path(__file__).with_name('retained_windows.py'),'retained_windows');spec=transfer.load_manifest(args.manifest,args.manifest_sha256,'windows');transfer.host_guard('windows');transfer.controller_guard(spec,args.controller)
 if spec['auditor_commit']!=AUDITOR:raise ValueError('Windows post-review auditor mismatch')
 q=module(args.controller/'.github/scripts/v3_qualification.py','retained_windows_runtime')
 if q.SOURCE_COMMIT!=SOURCE or q.SOURCE_ID!=OFFER:raise ValueError('Product binding mismatch')
 for path,wanted in [(args.app,SOURCE),(args.auditor,AUDITOR)]:
  if command(['git','-C',path,'rev-parse','HEAD'],capture_output=True).stdout.strip()!=wanted:raise ValueError('Source/auditor checkout mismatch')
  command(['git','-C',path,'diff','--quiet','HEAD','--'],capture_output=True)
 origin=read(args.evidence/'retained-origin.json')
 for key,wanted in {'manifest_sha256':args.manifest_sha256,'target':'windows','app_source_commit':SOURCE,'source_offer_id':OFFER,'qualification_controller_commit':spec['qualification_controller_commit'],'auditor_commit':AUDITOR,'release':spec['release'],'assets':spec['selected_assets'],'original_run_qualification':'FAILED_NOT_REWRITTEN','qualified':False}.items():
  if type(origin.get(key))is not type(wanted)or origin.get(key)!=wanted:raise ValueError('Retained origin receipt mismatch')
 pins={a['name']:{'sha256':a['sha256'],'size':a['size']}for a in spec['selected_assets']}
 if args.downloaded.is_symlink()or args.downloaded.resolve()!=Path(os.environ['RUNNER_TEMP']).resolve()/'v3-retained-windows'or {p.name for p in args.downloaded.iterdir()}!=set(pins):raise ValueError('Retained input directory mismatch')
 for name,pin in pins.items():
  p=args.downloaded/name
  if p.is_symlink()or not p.is_file()or p.stat().st_size!=pin['size']or sha(p)!=pin['sha256']:raise ValueError('Retained downloaded bytes changed')
 stage=args.app/'release-stage'
 if stage.exists()or stage.is_symlink():raise ValueError('Fresh source contains unexpected release stage')
 env=os.environ.copy();env['BDOBB_ARTIFACT_PATHS']=json.dumps([str(args.downloaded/name)for name in pins]);command([sys.executable,args.auditor/'scripts/public-release.py','stage'],cwd=args.app,env=env)
 q.qualify(args.app,'windows',args.auditor)
 msi,record=validate_stage(stage,pins,q);installed=install_msi(msi,record,q,q.load_release_gate(args.auditor),args.evidence/'installed-msi',args.controller)
 shutil.copytree(args.app/'qualification-evidence',args.evidence/'package-qualification')
 for name,pin in pins.items():
  if sha(stage/name)!=pin['sha256']:raise ValueError('Retained package changed after runtime')
 report={'status':'PASS_NATIVE_AND_ACTUAL_MSI_INSTALL','compiled_product_source_commit':SOURCE,'source_offer_id':OFFER,'auditor_commit':AUDITOR,'qualification_controller_commit':spec['qualification_controller_commit'],'manifest_sha256':args.manifest_sha256,'packages':pins,'retained_origin':origin,'app_rebuilt':False,'original_failed_compile_run_not_reclassified':True,'displayed_version_observed':installed['displayed_version_observed'],'visible_version_acceptance':'separate required release gate; false remains blocker'}
 (args.evidence/'retained-qualification.json').write_text(json.dumps(report,indent=2)+'\n',encoding='utf-8',newline='\n');transfer.controller_guard(spec,args.controller);command(['git','-C',args.app,'diff','--quiet','HEAD','--'],capture_output=True)

def main(argv=None):
 parser=argparse.ArgumentParser(description=__doc__)
 for name in ['manifest','controller','app','auditor','downloaded','evidence']:parser.add_argument('--'+name,type=Path,required=True)
 parser.add_argument('--manifest-sha256',required=True)
 try:
  args=parser.parse_args(argv)
  for name in ['manifest','controller','app','auditor','downloaded','evidence']:setattr(args,name,getattr(args,name).absolute())
  qualify(args)
 except Exception:
  print(json.dumps({'status':'WINDOWS_RETAINED_POST_REVIEW_BLOCKED','code':'PROVENANCE_SCAN_OR_ACTUAL_NATIVE_INSTALL_FAILED'}));return 2
 print(json.dumps({'status':'WINDOWS_RETAINED_NATIVE_INSTALL_PASS','app_rebuilt':False}));return 0
if __name__=='__main__':raise SystemExit(main())
