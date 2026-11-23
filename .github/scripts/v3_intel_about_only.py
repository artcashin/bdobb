"""Observe exact retained V3 Intel packages; build no product and export only safe receipts."""
import argparse,hashlib,json,os,platform,plistlib,shutil,stat,subprocess,tempfile,zipfile
from pathlib import Path,PurePosixPath
import v3_mac_qualification as q
RUN=45123656948
ARTIFACT=14795826748
ZIP_SHA='56a580f9dd0bce62ad998d39e3fae08a18fd8fd83b39ca0f4bd8702dd9758309'
EXECUTABLE_SHA='259a5be97b67ded567f66b126537731ed123ec6f38fa7272677c79c28d1fc324'
PACKAGES={'BDOBB_3.0.0_x64.dmg':'a9402ccf708ef712a71b14b441da2db0c602091f80e32d65181611151e20ed46','BDOBB_x64.app.tar.gz':'69f1b131eceec0541f9eb04baab975cfdb948078a396a5a5c66808b65d071a1a'}

def extract_exact_zip(path,out):
    if path.is_symlink() or q.sha256(path)!=ZIP_SHA:raise ValueError('Retained artifact digest mismatch')
    with zipfile.ZipFile(path) as z:
        records=z.infolist();seen=set();total=0
        for r in records:
            p=PurePosixPath(r.filename);total+=r.file_size
            if p.is_absolute() or '..' in p.parts or '\\' in r.filename or r.filename in seen or stat.S_ISLNK(r.external_attr>>16) or total>512*1024*1024:raise ValueError('Unsafe retained artifact')
            seen.add(r.filename)
        for r in records:
            dest=out/r.filename
            if r.is_dir():dest.mkdir(parents=True,exist_ok=True)
            else:
                dest.parent.mkdir(parents=True,exist_ok=True)
                with z.open(r) as source,dest.open('xb') as target:shutil.copyfileobj(source,target)
    return out/'release-stage'

def verify_stage(stage):
    q.require_packages(stage,list(PACKAGES));old=json.loads((stage/'qualification.json').read_text());scan=json.loads((stage/'scan.json').read_text())
    for name,digest in PACKAGES.items():
        r=old[name]
        if q.sha256(stage/name)!=digest or scan[name]['sha256']!=digest or scan[name]['frontend_files']!=81 or r['source_commit']!=q.SOURCE_COMMIT or r['source_id']!=q.SOURCE_ID or r['executable_sha256']!=EXECUTABLE_SHA or r['architecture']!='x86_64' or r['runtime']['status']!='PASS' or r['runtime']['native_process_code_type']!='Code Type:       X86-64' or not r['cleanup']['installed_bundle_absent']:raise ValueError('Retained exact qualification binding rejected')

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--artifact',type=Path,required=True);parser.add_argument('--auditor',type=Path,required=True);parser.add_argument('--out',type=Path,required=True);args=parser.parse_args()
    if os.environ.get('GITHUB_ACTIONS')!='true' or os.environ.get('RUNNER_ENVIRONMENT')!='github-hosted' or os.environ.get('RUNNER_OS')!='macOS' or platform.system()!='Darwin' or platform.machine()!='x86_64':raise ValueError('Native hosted Intel required')
    temp=Path(os.environ['RUNNER_TEMP']).resolve(strict=True);workspace=Path(os.environ['GITHUB_WORKSPACE']).resolve(strict=True);auditor=args.auditor.resolve(strict=True);out=args.out.absolute()
    if out.exists() or out.is_symlink() or not out.is_relative_to(workspace) or subprocess.check_output(['git','-C',str(auditor),'rev-parse','HEAD'],text=True).strip()!=q.SOURCE_COMMIT:raise ValueError('Source/output guard rejected')
    out.mkdir();records=[];gate=q.load_release_gate(auditor)
    try:
        with tempfile.TemporaryDirectory(prefix='v3-intel-retained-',dir=temp) as private:
            root=Path(private);stage=extract_exact_zip(args.artifact,root/'artifact');verify_stage(stage)
            for name,digest in PACKAGES.items():
                work=root/name.replace('.','-');work.mkdir();unpacked=work/'unpacked';unpacked.mkdir();gate.unpack(stage/name,unpacked);binary,_=q.locate_executable(unpacked,stage/name,work);q.require_arch(binary,'x86_64')
                if q.sha256(binary)!=EXECUTABLE_SHA:raise ValueError('Exact retained executable rejected')
                installed=work/'Applications/BDOBB.app';installed.parent.mkdir();q.run(['ditto',binary.parents[2],installed],capture_output=True);exe=installed/'Contents/MacOS/bdobb';q.require_arch(exe,'x86_64')
                if q.sha256(exe)!=EXECUTABLE_SHA:raise ValueError('Private installed bytes changed')
                meta=plistlib.loads((installed/'Contents/Info.plist').read_bytes())
                if meta.get('CFBundleIdentifier')!='com.artcashin.bdobb' or meta.get('CFBundleShortVersionString')!='3.0.0':raise ValueError('Bundle metadata guard rejected')
                evidence=work/'private-evidence';evidence.mkdir()
                try:runtime=q.native_runtime(exe,stage/name,work,evidence,'x86_64')
                finally:
                    shutil.rmtree(installed)
                if installed.exists() or q.sha256(stage/name)!=digest:raise ValueError('Cleanup or immutable package guard rejected')
                about=runtime['displayed_about'];safe={key:about[key] for key in ['status','source_commit','source_offer_id','executable_sha256','native_architecture','swift_source_sha256','ax_phase_timeout_seconds','process_timeout_seconds','maximum_nodes']}
                for key in ['name_text','version_text','origin','ax_trusted','menu_invoked','owned_window_focused','nodes_visited']:
                    if key in about:safe[key]=about[key]
                records.append({'filename':name,'sha256':digest,'executable_sha256':EXECUTABLE_SHA,'native_process_code_type':runtime['native_process_code_type'],'backends':[],'private_app_copy_removed':True,'displayed_about':safe})
    finally:
        result={'status':'PASS' if len(records)==2 and all(r['displayed_about']['status']=='OBSERVED_VERSION_MATCH' for r in records) else 'INCOMPLETE_OBSERVATION','method':'Observe-only native Intel retry of exact retained packages; no product build, provider calls or metadata-as-UI substitution','source_commit':q.SOURCE_COMMIT,'source_offer':q.SOURCE_ID,'original_run':RUN,'original_artifact':ARTIFACT,'original_artifact_zip_sha256':ZIP_SHA,'packages':records,'temporary_inputs_removed':True}
        p=out/'intel-about.json';p.write_text(json.dumps(result,indent=2)+'\n');(out/'SHA256SUMS').write_text(q.sha256(p)+'  intel-about.json\n')
    return 0 if result['status']=='PASS' else 2

if __name__=='__main__':
    try:raise SystemExit(main())
    except Exception:raise SystemExit('ERROR_INTEL_OBSERVATION_OPERATION')
