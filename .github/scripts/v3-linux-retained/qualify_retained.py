"""Post-review same-byte Linux audit/installation worker; never builds or publishes."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import platform
import re
import shutil
import stat
import subprocess
import sys
import tempfile
from types import SimpleNamespace

SOURCE = 'de25611461ad0559ce237c4f59b812decd91dec1'
OFFER = '19c760a782e0ab84152ee990e8f9014f7e677f448bc58d6a3e548d8f485f1c6b'


def sha256(path):
    with path.open('rb') as stream: return hashlib.file_digest(stream, 'sha256').hexdigest()


def command(args, **kwargs):
    return subprocess.run(list(map(str,args)), check=True, text=True, **kwargs)


def read_json(path):
    return json.loads(path.read_text(encoding='utf-8'))


def module_from(path, name):
    spec=importlib.util.spec_from_file_location(name,path)
    module=importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def require_hosted_linux(target, q):
    if target not in {'linux-x64','linux-arm'} or platform.system() != 'Linux' or platform.machine() != q.TARGETS[target][0] or any(
            os.environ.get(key) != value for key,value in {'GITHUB_ACTIONS':'true','RUNNER_ENVIRONMENT':'github-hosted','RUNNER_OS':'Linux'}.items()):
        raise ValueError('Retained qualification restricted to matching native ephemeral Linux runner')


def validate_qualification(stage, expected, q, target):
    if set(expected) != set(q.expected_names(target)) or {p.name for p in stage.iterdir() if p.name.startswith('BDOBB')} != set(expected):
        raise ValueError('Retained package set mismatch')
    records=read_json(stage/'qualification.json')
    scans=read_json(stage/'scan.json')
    if set(records) != set(expected) or set(scans) != set(expected): raise ValueError('Retained scan/qualification set mismatch')
    for name, pin in expected.items():
        package=stage/name
        if package.is_symlink() or not stat.S_ISREG(package.lstat().st_mode) or package.stat().st_size != pin['size'] or sha256(package) != pin['sha256']:
            raise ValueError('Retained package differs from approved original bytes')
        record=records[name]
        if record.get('sha256') != pin['sha256'] or scans[name].get('sha256') != pin['sha256'] or record.get('source_commit') != SOURCE or record.get('source_id') != OFFER:
            raise ValueError('Retained source/scan binding mismatch')
        if record.get('embedded_offer') != q.EXPECTED_OFFER or record.get('embedded_defaults') != 'all six exact empty values verified by app checker':
            raise ValueError('Retained installed frontend proof missing')
        if record.get('architecture') != q.TARGETS[target][0] or record.get('runtime',{}).get('status') != 'PASS' or not re.fullmatch('[0-9a-f]{64}',record.get('executable_sha256','')):
            raise ValueError('Retained native qualification missing')
    selected=[name for name in expected if name.endswith('.deb')]
    if len(selected) != 1: raise ValueError('Expected exactly one retained DEB')
    return stage/selected[0],records[selected[0]]


def install_deb(package, original, q, gate, target, evidence, controller):
    require_hosted_linux(target,q)
    arch=q.TARGETS[target][0]
    expected_deb_arch={'x86_64':'amd64','aarch64':'arm64'}[arch]
    package_name=command(['dpkg-deb','-f',package,'Package'],capture_output=True).stdout.strip()
    version=command(['dpkg-deb','-f',package,'Version'],capture_output=True).stdout.strip()
    deb_arch=command(['dpkg-deb','-f',package,'Architecture'],capture_output=True).stdout.strip()
    if package_name != 'bdobb' or version not in {'3.0.0','3.0.0-1'} or deb_arch != expected_deb_arch:
        raise ValueError('Retained DEB identity/architecture/version mismatch')
    existing=subprocess.run(['dpkg-query','-W','-f=${Status}',package_name],text=True,capture_output=True)
    if existing.returncode == 0 or existing.stdout.strip() or Path('/usr/bin/bdobb').exists() or Path('/usr/bin/bdobb').is_symlink():
        raise ValueError('Pre-existing registered app/executable; refusing installation')
    evidence.mkdir()
    receipt={'status':'INCOMPLETE','method':'native sudo dpkg -i exact retained privacy-reviewed DEB; no dependency repair or rebuild',
             'package':package.name,'sha256':original['sha256'],'source_commit':SOURCE,'source_id':OFFER,'architecture':arch,'deb_architecture':deb_arch,
             'package_version':version,'version_scope':'package metadata only; UI observation recorded separately','app_rebuilt':False}
    installed=False
    with tempfile.TemporaryDirectory(prefix='v3-retained-install-',dir=os.environ['RUNNER_TEMP']) as temp:
        work=Path(temp)
        try:
            installed=True
            command(['sudo','dpkg','-i',package],capture_output=True)
            registered=command(['dpkg-query','-W','-f=${Status}\n${Version}\n${Architecture}\n',package_name],capture_output=True).stdout.splitlines()
            if registered != ['install ok installed',version,expected_deb_arch]: raise ValueError('Registered retained DEB mismatch')
            executable=Path('/usr/bin/bdobb')
            paths=command(['dpkg-query','-L',package_name],capture_output=True).stdout.splitlines()
            if str(executable) not in paths or executable.is_symlink() or not executable.is_file() or sha256(executable) != original['executable_sha256']:
                raise ValueError('Installed retained executable differs from scanned bytes')
            q.require_arch(executable,arch)
            frontend=work/'installed-frontend'
            command(['tauri-dumper','extract',executable,'-o',frontend,'--json'],capture_output=True)
            gate.check_frontend(frontend)
            q.verify_offer(frontend)
            probe=module_from(controller/'.github/scripts/linux_release_probe.py','v3_retained_linux_ui')
            def observe(pid, live_executable, runtime_work, runtime_evidence, native_arch):
                return probe.observe(SimpleNamespace(pid=pid,executable=str(live_executable),sha256=original['executable_sha256'],
                                                     expected_arch=native_arch,evidence_dir=str(runtime_evidence)))
            receipt['registered_status']=registered
            receipt['installed_executable_sha256']=sha256(executable)
            receipt['embedded_defaults']='all six exact empty values verified again from installed executable'
            receipt['embedded_offer']=q.EXPECTED_OFFER
            receipt['runtime']=q.native_runtime(executable,package,work,evidence,arch,ui_observer=observe)
            receipt['runtime']['method']='actual installed DEB executable launched after recorded dpkg installation; installer dialog not exercised'
            receipt['displayed_version_observed']=receipt['runtime'].get('displayed_version_ui',{}).get('displayed_release_observed') is True
            if sha256(package) != original['sha256'] or sha256(executable) != original['executable_sha256']:
                raise ValueError('Retained installer/executable changed during runtime')
        finally:
            if installed:
                command(['sudo','dpkg','--purge',package_name],capture_output=True)
                removed=subprocess.run(['dpkg-query','-W','-f=${Status}',package_name],capture_output=True,text=True)
                if removed.returncode == 0 or Path('/usr/bin/bdobb').exists(): raise ValueError('Retained DEB cleanup failed')
                receipt['cleanup']={'package_absent':True,'installed_executable_absent':True,'method':'sudo dpkg --purge'}
            (evidence/'install-receipt.json').write_text(json.dumps(receipt,indent=2)+'\n',encoding='utf-8',newline='\n')
    receipt['status']='PASS'
    (evidence/'install-receipt.json').write_text(json.dumps(receipt,indent=2)+'\n',encoding='utf-8',newline='\n')
    return receipt


def apply_owned_environment(environment):
    # This worker runs inside its own fresh dbus-run-session/Xvfb. The returned
    # environment intentionally omits the inherited accessibility-disable flag.
    os.environ.pop('NO_AT_BRIDGE',None)
    os.environ.update(environment)


def qualify(args):
    helper=module_from(Path(__file__).with_name('retained_linux.py'),'retained_download_binding')
    spec=helper.load_manifest(args.manifest,args.manifest_sha256,args.target)
    helper.host_guard(args.target);helper.controller_guard(spec,args.controller)
    q=module_from(args.controller/'.github/scripts/v3_qualification.py','retained_runtime')
    require_hosted_linux(args.target,q)
    if q.SOURCE_COMMIT != SOURCE or q.SOURCE_ID != OFFER: raise ValueError('Runtime product binding mismatch')
    for path,wanted in [(args.app,SOURCE),(args.auditor,spec['auditor_commit'])]:
        if command(['git','-C',path,'rev-parse','HEAD'],capture_output=True).stdout.strip() != wanted:
            raise ValueError('Source or auditor checkout mismatch')
        command(['git','-C',path,'diff','--quiet','HEAD','--'],capture_output=True)
    expected={row['name']:{'sha256':row['sha256'],'size':row['size']} for row in spec['selected_assets']}
    origin=read_json(args.evidence/'retained-origin.json')
    for key,wanted in {'manifest_sha256':args.manifest_sha256,'target':args.target,'app_source_commit':SOURCE,'source_offer_id':OFFER,
                       'qualification_controller_commit':spec['qualification_controller_commit'],'auditor_commit':spec['auditor_commit'],
                       'release':spec['release'],'assets':spec['selected_assets'],'original_run_qualification':'FAILED_NOT_REWRITTEN',
                       'status':'EXACT_RETAINED_BYTES_DOWNLOADED_PENDING_RESCAN','qualified':False}.items():
        if type(origin.get(key)) is not type(wanted) or origin.get(key) != wanted: raise ValueError('Retained download provenance mismatch')
    downloaded=args.downloaded.resolve(strict=True)
    if downloaded != Path(os.environ['RUNNER_TEMP']).resolve(strict=True)/('v3-retained-'+args.target) or downloaded.is_symlink() or {p.name for p in downloaded.iterdir()} != set(expected):
        raise ValueError('Unexpected retained input directory')
    for name,pin in expected.items():
        path=downloaded/name
        if path.is_symlink() or not path.is_file() or path.stat().st_size != pin['size'] or sha256(path) != pin['sha256']:
            raise ValueError('Retained input differs from approved bytes')
    stage=args.app/'release-stage'
    if stage.exists() or stage.is_symlink(): raise ValueError('Fresh source unexpectedly contains package stage')
    env=os.environ.copy();env['BDOBB_ARTIFACT_PATHS']=json.dumps([str(downloaded/name) for name in expected])
    command([sys.executable,args.auditor/'scripts/public-release.py','stage'],cwd=args.app,env=env)
    # Only now, after the unchanged package checker has accepted all three exact
    # packages, initialize QA accessibility in this run's isolated display/bus.
    session=module_from(args.controller/'.github/scripts/linux_owned_atspi_session.py','retained_owned_session')
    app_environment=session.prepare_owned_session(args.evidence)
    apply_owned_environment(app_environment)
    q.qualify(args.app,args.target,args.auditor)
    package,record=validate_qualification(stage,expected,q,args.target)
    gate=q.load_release_gate(args.auditor)
    installed=install_deb(package,record,q,gate,args.target,args.evidence/'installed-deb',args.controller)
    shutil.copytree(args.app/'qualification-evidence',args.evidence/'package-qualification')
    for name,pin in expected.items():
        if sha256(stage/name) != pin['sha256']: raise ValueError('Retained package changed after native qualification')
    receipt={'status':'PASS','stage':'post-review same-byte audit, extracted native launch and actual DEB installation',
             'compiled_product_source_commit':SOURCE,'source_offer_id':OFFER,'auditor_commit':spec['auditor_commit'],
             'qualification_controller_commit':spec['qualification_controller_commit'],'approved_manifest_sha256':args.manifest_sha256,
             'app_rebuilt':False,'original_failed_compile_run_not_reclassified':True,'retained_origin':origin,
             'packages':expected,'actual_installed_deb':package.name,'displayed_version_observed':installed['displayed_version_observed']}
    (args.evidence/'retained-qualification.json').write_text(json.dumps(receipt,indent=2)+'\n',encoding='utf-8',newline='\n')
    command(['git','-C',args.app,'diff','--quiet','HEAD','--'],capture_output=True)
    helper.controller_guard(spec,args.controller)
    return receipt


def main(argv=None):
    import argparse
    parser=argparse.ArgumentParser(description=__doc__)
    for name in ['manifest','controller','app','auditor','downloaded','evidence']: parser.add_argument('--'+name,type=Path,required=True)
    parser.add_argument('--manifest-sha256',required=True)
    parser.add_argument('--target',choices=['linux-x64','linux-arm'],required=True)
    try:
        args=parser.parse_args(argv)
        for name in ['manifest','controller','app','auditor','downloaded','evidence']:
            setattr(args,name,getattr(args,name).absolute())
        qualify(args)
    except Exception:
        print(json.dumps({'status':'RETAINED_NATIVE_QUALIFICATION_FAILED','code':'EXACT_RESCAN_OR_NATIVE_CHECK_FAILED'}),file=sys.stderr)
        return 2
    print(json.dumps({'status':'RETAINED_POST_REVIEW_NATIVE_PASS','app_rebuilt':False}))
    return 0


if __name__=='__main__':raise SystemExit(main())
