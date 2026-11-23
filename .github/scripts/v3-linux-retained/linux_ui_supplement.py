"""Install/UI-only supplement for immutable successful same-byte Linux qualification."""
import argparse
import importlib.util
import json
import os
import hashlib
import stat
from pathlib import Path
import subprocess
import urllib.request

SOURCE='de25611461ad0559ce237c4f59b812decd91dec1'
OFFER='19c760a782e0ab84152ee990e8f9014f7e677f448bc58d6a3e548d8f485f1c6b'
AUDITOR='dd0689369f36793875a0b865fa37b47f3ae47e33'
MANIFEST='c861adb45074101c3306be7e9d8d88469914eedbcf0122c872c7be0e87ce677d'
PINS=json.loads(Path(__file__).with_name('prior-ui-file-pins.json').read_text(encoding='utf-8'))
PRIOR={'linux-x64':{'run':45092949620,'job':137426439276,'artifact':14781917873,'artifact_sha256':'9e57e8578889f0cc85ee8335be94655f497582503e8cfc86881554667471fcc8','controller':'9134d3ad7111221b65fb7dd01e0a98fd7b400901'},'linux-arm':{'run':45093138550,'job':137426994629,'artifact':14782288060,'artifact_sha256':'62fda4fae36ccd2d196868fe95f4c60e1d92f3250557d59cf04c7530e7ee9e4f','controller':'9134d3ad7111221b65fb7dd01e0a98fd7b400901'}}
API='https://api.github.com/repos/artcashin/bdobb/actions/'


def module(path,name):
    spec=importlib.util.spec_from_file_location(name,path);value=importlib.util.module_from_spec(spec);spec.loader.exec_module(value);return value


def read(path):return json.loads(path.read_text(encoding='utf-8'))


def write(path,value):
    with path.open('x',encoding='utf-8',newline='\n') as stream:stream.write(json.dumps(value,indent=2)+'\n')


def validate_run(run,jobs,artifacts,target):
    pin=PRIOR[target]
    expected={'id':pin['run'],'run_attempt':1,'head_sha':pin['controller'],'event':'workflow_dispatch','path':'.github/workflows/release.yml','status':'completed','conclusion':'success'}
    if any(run.get(k)!=v for k,v in expected.items()) or run.get('repository',{}).get('full_name')!='artcashin/bdobb':raise ValueError('Successful retained qualification run identity mismatch')
    matching=[j for j in jobs.get('jobs',[]) if j.get('name')==f'Post-review same-byte V3 {target} qualification']
    if len(matching)!=1 or matching[0].get('id')!=pin['job'] or matching[0].get('status')!='completed' or matching[0].get('conclusion')!='success':raise ValueError('Exact successful native qualification job required')
    selected=[a for a in artifacts.get('artifacts',[]) if a.get('name')==f'requalified-retained-v3-{target}']
    if len(selected)!=1:raise ValueError('Immutable prior qualification artifact absent or ambiguous')
    a=selected[0]
    if a.get('id')!=pin['artifact'] or a.get('digest')!='sha256:'+pin['artifact_sha256'] or a.get('expired') is not False or a.get('workflow_run',{}).get('id')!=pin['run'] or a.get('workflow_run',{}).get('head_sha')!=pin['controller']:raise ValueError('Immutable prior artifact binding mismatch')
    return {'run_id':pin['run'],'job_id':pin['job'],'artifact_id':pin['artifact'],'artifact_zip_sha256':pin['artifact_sha256'],'qualification_controller':pin['controller'],'prior_status':'PASS_NATIVE_INSTALL_AND_PACKAGE_QUALIFICATION','prior_display_scope':'must be read separately; no inference from successful job'}


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,*args):return None


def api_json(suffix):
    token=os.environ.get('GH_UI_READ_TOKEN','')
    if not token or any(x.isspace() for x in token):raise ValueError('Ephemeral Actions read token required')
    request=urllib.request.Request(API+suffix,headers={'Authorization':'Bearer '+token,'Accept':'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28'},method='GET')
    with urllib.request.build_opener(NoRedirect()).open(request,timeout=60) as response:
        if response.getcode()!=200 or response.headers.get('Link'):raise ValueError('Prior qualification API rejected')
        raw=response.read(1024*1024+1)
    if len(raw)>1024*1024:raise ValueError('Prior qualification API budget exceeded')
    return json.loads(raw.decode('utf-8'))


def verify_api(args,worker,q):
    worker.require_hosted_linux(args.target,q)
    pin=PRIOR[args.target]
    run=api_json(f'runs/{pin["run"]}')
    jobs=api_json(f'runs/{pin["run"]}/attempts/1/jobs?per_page=100')
    artifacts=api_json(f'runs/{pin["run"]}/artifacts?per_page=100')
    record=validate_run(run,jobs,artifacts,args.target)
    args.evidence.mkdir()
    write(args.evidence/'ui-original-run.json',record)
    with Path(os.environ['GITHUB_OUTPUT']).open('a',encoding='ascii',newline='\n') as stream:
        stream.write(f'run_id={pin["run"]}\nartifact_id={pin["artifact"]}\n')


def validate_pinned_files(root,target):
    pins=PINS[target]
    selected={**pins['receipts'],**{'app/release-stage/'+name:row['sha256'] for name,row in pins['packages'].items()}}
    for relative,expected in selected.items():
        path=root/relative
        if path.is_symlink() or not stat.S_ISREG(path.lstat().st_mode):raise ValueError('Expected pinned regular prior artifact file')
        with path.open('rb') as stream:actual=hashlib.file_digest(stream,'sha256').hexdigest()
        if actual!=expected:raise ValueError('Downloaded prior package/receipt differs from independent reviewed pin')
    for name,row in pins['packages'].items():
        if (root/'app/release-stage'/name).stat().st_size!=row['size']:raise ValueError('Pinned package size mismatch')


def install(args,worker,q):
    worker.require_hosted_linux(args.target,q)
    pin=PRIOR[args.target]
    controller_sha=os.environ.get('GITHUB_SHA','')
    for path,wanted in [(args.controller,controller_sha),(args.app,SOURCE),(args.auditor,AUDITOR)]:
        if worker.command(['git','-C',path,'rev-parse','HEAD'],capture_output=True).stdout.strip()!=wanted:raise ValueError('UI supplement checkout identity mismatch')
        worker.command(['git','-C',path,'diff','--quiet','HEAD','--'],capture_output=True)
    if q.SOURCE_COMMIT!=SOURCE or q.SOURCE_ID!=OFFER:raise ValueError('UI runtime product source binding mismatch')
    provenance=read(args.evidence/'ui-original-run.json')
    if provenance.get('run_id')!=pin['run'] or provenance.get('artifact_id')!=pin['artifact'] or provenance.get('qualification_controller')!=pin['controller'] or provenance.get('artifact_zip_sha256')!=pin['artifact_sha256']:raise ValueError('Verified immutable prior run receipt missing')
    validate_pinned_files(args.artifacts,args.target)
    old=read(args.artifacts/'retained-evidence/retained-qualification.json')
    expected={'status':'PASS','compiled_product_source_commit':SOURCE,'source_offer_id':OFFER,'auditor_commit':AUDITOR,'qualification_controller_commit':pin['controller'],'approved_manifest_sha256':MANIFEST,'app_rebuilt':False,'original_failed_compile_run_not_reclassified':True}
    if any(type(old.get(k))is not type(v) or old.get(k)!=v for k,v in expected.items()):raise ValueError('Prior retained qualification identity mismatch')
    origin=old.get('retained_origin',{})
    binding=module(Path(__file__).with_name('retained_linux.py'),'ui_retained_bindings')
    assets=origin.get('assets',[])
    if len(assets)!=3 or origin.get('original_run_qualification')!='FAILED_NOT_REWRITTEN' or any(a.get('original_failed_run')!=binding.ORIGINAL_FAILURES[args.target] for a in assets):raise ValueError('Original failed compile origin changed')
    expected_packages={a['name']:{'sha256':a['sha256'],'size':a['size']} for a in assets}
    if expected_packages!=PINS[args.target]['packages'] or expected_packages!=old.get('packages'):raise ValueError('Prior approved retained package set mismatch')
    package,record=worker.validate_qualification(args.artifacts/'app/release-stage',expected_packages,q,args.target)
    session=module(args.controller/'.github/scripts/linux_owned_atspi_session.py','ui_owned_session')
    worker.apply_owned_environment(session.prepare_owned_session(args.evidence))
    installed=worker.install_deb(package,record,q,q.load_release_gate(args.auditor),args.target,args.evidence/'installed-deb',args.controller)
    write(args.evidence/'ui-supplement.json',{'status':'DISPLAYED_VERSION_MATCH' if installed['displayed_version_observed'] else 'UI_GAP','compiled_product_source_commit':SOURCE,'source_offer_id':OFFER,'auditor_commit':AUDITOR,'ui_controller_commit':controller_sha,'prior_qualification':provenance,'previous_displayed_version_observed':old.get('displayed_version_observed'),'displayed_version_observed':installed['displayed_version_observed'],'app_rebuilt':False,'unchanged_prior_package_native_checks_not_repeated':True,'original_failed_compile_origin_preserved':True,'installed_deb':package.name,'sha256':record['sha256'],'native_installation_and_cleanup':installed['status']})


def main(argv=None):
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode',choices=['verify-api','install'])
    parser.add_argument('--target',choices=PRIOR,required=True)
    parser.add_argument('--controller',type=Path,required=True)
    parser.add_argument('--evidence',type=Path,required=True)
    for name in ['app','auditor','artifacts']:parser.add_argument('--'+name,type=Path)
    try:
        args=parser.parse_args(argv)
        for name in ['controller','evidence','app','auditor','artifacts']:
            if getattr(args,name)is not None:setattr(args,name,getattr(args,name).absolute())
        worker=module(Path(__file__).with_name('qualify_retained.py'),'ui_install_worker')
        q=module(args.controller/'.github/scripts/v3_qualification.py','ui_runtime')
        if args.mode=='verify-api':verify_api(args,worker,q)
        else:install(args,worker,q)
    except Exception:
        print(json.dumps({'status':'LINUX_UI_SUPPLEMENT_BLOCKED','code':'PROVENANCE_INSTALL_OR_UI_OPERATION_FAILED'}))
        return 2
    print(json.dumps({'status':'LINUX_UI_SUPPLEMENT_STEP_COMPLETED','app_rebuilt':False}))
    return 0


if __name__=='__main__':raise SystemExit(main())
