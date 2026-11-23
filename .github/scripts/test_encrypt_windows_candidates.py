import contextlib
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import stat
import tarfile
import tempfile
import types
import unittest
from unittest.mock import patch

spec=importlib.util.spec_from_file_location('windows_retention',Path(__file__).with_name('encrypt_windows_candidates.py'))
s=importlib.util.module_from_spec(spec);spec.loader.exec_module(s)


class Tests(unittest.TestCase):
    def candidates(self,root):
        for directory,name in s.TARGETS['windows']['files'].items():
            p=root/directory/name;p.parent.mkdir(parents=True);p.write_bytes((directory+' exact candidate').encode())
        return s.select_candidates(root,'windows')

    def test_only_two_exact_original_installer_outputs_are_eligible(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp).resolve();selected=self.candidates(root)
            self.assertEqual({p.name for p in selected},set(s.TARGETS['windows']['files'].values()))
            (root/'extra.exe').write_bytes(b'not allowed')
            with self.assertRaises(s.RetentionError):s.select_candidates(root,'windows')
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp).resolve();selected=self.candidates(root)
            duplicate=root/'other'/selected[0].name;duplicate.parent.mkdir();duplicate.write_bytes(b'duplicate')
            with self.assertRaises(s.RetentionError):s.select_candidates(root,'windows')

    def test_source_links_hardlinks_and_windows_reparse_points_rejected(self):
        info=types.SimpleNamespace(st_mode=stat.S_IFLNK|0o777,st_size=1,st_nlink=1,st_file_attributes=0)
        with self.assertRaises(s.RetentionError):s.regular_file(types.SimpleNamespace(lstat=lambda:info))
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp).resolve();selected=self.candidates(root)
            os.link(selected[0],root/'alias')
            with self.assertRaises(s.RetentionError):s.select_candidates(root,'windows')
        info=types.SimpleNamespace(st_mode=stat.S_IFREG|0o600,st_size=1,st_nlink=1,st_file_attributes=1024)
        with self.assertRaises(s.RetentionError):s.regular_file(types.SimpleNamespace(lstat=lambda:info))

    def test_exact_snapshot_tar_and_original_after_snapshot_mutation(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp).resolve();bundle=root/'bundle';bundle.mkdir();selected=self.candidates(bundle)
            snapshot=root/'snapshot';records=s.snapshot_candidates(selected,snapshot)
            payload=io.BytesIO();s.write_tar(payload,snapshot,records)
            with tarfile.open(fileobj=io.BytesIO(payload.getvalue()),mode='r:') as archive:
                self.assertEqual({m.name for m in archive},set(s.TARGETS['windows']['files'].values()))
                self.assertTrue(all(m.isfile() and m.uid==m.gid==m.mtime==0 for m in archive))
            selected[0].write_bytes(b'changed')
            with self.assertRaises(s.RetentionError):s.verify_candidates(selected,records)

    def test_snapshot_extra_cannot_cross_encryption_boundary(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp).resolve();bundle=root/'bundle';bundle.mkdir();selected=self.candidates(bundle)
            snapshot=root/'snapshot';records=s.snapshot_candidates(selected,snapshot);(snapshot/'extra').write_bytes(b'private')
            with self.assertRaises(s.RetentionError):s.write_tar(io.BytesIO(),snapshot,records)

    def test_single_exact_fresh_public_recipient_and_host_guard(self):
        s.require_recipient(s.RECIPIENT)
        self.assertEqual(hashlib.sha256(s.RECIPIENT.encode()).hexdigest(),s.RECIPIENT_FINGERPRINT)
        with self.assertRaises(s.RetentionError):s.require_recipient('age1UNREVIEWED')
        with patch.dict(os.environ,{'GITHUB_ACTIONS':'false'}):
            with self.assertRaises(s.RetentionError):s.require_hosted_windows('windows')

    def test_tar_is_piped_to_one_recipient_without_identity_or_plaintext_tar(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp).resolve();bundle=root/'bundle';bundle.mkdir();selected=self.candidates(bundle)
            snapshot=root/'snapshot';records=s.snapshot_candidates(selected,snapshot);output=root/'candidate.age'
            capture={}
            class Pipe(io.BytesIO):
                def close(self):capture['tar']=self.getvalue();super().close()
            class Process:
                def __init__(self,args,**kwargs):
                    capture['args']=args;capture['kwargs']=kwargs;self.stdin=Pipe();output.write_bytes(b'age-encryption.org/v1\n'+b'encrypted placeholder')
                def wait(self,timeout):return 0
                def poll(self):return 0
                def kill(self):raise AssertionError('Unexpected kill')
            with patch.object(s.subprocess,'Popen',Process):s.encrypt_stream(root/'age.exe',s.RECIPIENT,snapshot,records,output)
            self.assertEqual(capture['args'],[str(root/'age.exe'),'-r',s.RECIPIENT,'-o',str(output)])
            self.assertNotIn('-i',capture['args'])
            with tarfile.open(fileobj=io.BytesIO(capture['tar'])) as archive:self.assertEqual(len(archive.getmembers()),2)
            self.assertFalse(any(root.glob('*.tar')))

    def test_output_directory_fresh_exact_and_receipt_never_claims_qualification(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp).resolve();out=root/'v3-encrypted-qa-windows';s.prepare_output(out,root,'windows')
            with self.assertRaises(s.RetentionError):s.prepare_output(out,root,'windows')
            with self.assertRaises(s.RetentionError):s.prepare_output(root/'other',root,'windows')
            cipher=out/'qa-blocked-v3-windows.tar.age';cipher.write_bytes(b'cipher')
            records=[{'filename':name,'sha256':'a'*64,'size':1} for name in s.TARGETS['windows']['files'].values()]
            receipt=s.make_receipt('windows',records,cipher,'b'*40,'package-scan')
            self.assertEqual(receipt['qualification_state'],'FAILED/BLOCKED')
            self.assertEqual(receipt['retention_days'],1)
            self.assertEqual(receipt['recipient_fingerprint_sha256'],s.RECIPIENT_FINGERPRINT)
            self.assertNotIn('PRIVATE_KEY',json.dumps(receipt))

    def test_cli_never_outputs_arguments_exception_or_recipient_inputs(self):
        out=io.StringIO();err=io.StringIO()
        with contextlib.redirect_stdout(out),contextlib.redirect_stderr(err):
            self.assertNotEqual(s.main(['--target','windows','--recipient','PRIVATE_VALUE']),0)
        self.assertNotIn('PRIVATE_VALUE',out.getvalue()+err.getvalue())
        self.assertEqual(json.loads(err.getvalue())['status'],'QA_RETENTION_FAILED')


if __name__=='__main__':unittest.main()
