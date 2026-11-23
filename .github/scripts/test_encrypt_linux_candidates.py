import contextlib
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest import mock

spec = importlib.util.spec_from_file_location('qa', Path(__file__).with_name('encrypt_linux_candidates.py'))
qa = importlib.util.module_from_spec(spec)
spec.loader.exec_module(qa)


class RetentionTests(unittest.TestCase):
    def test_dependency_metadata_is_allowlisted_and_contains_no_command_output(self):
        rows = qa.parse_dependency_rows('libgtk-3-0:amd64\t3.24.33-1ubuntu2.2\tamd64\ntilix-common\t1.9.4-2build1\tall\n')
        self.assertEqual(rows[0], {'package': 'libgtk-3-0:amd64', 'version': '3.24.33-1ubuntu2.2', 'architecture': 'amd64'})
        with self.assertRaises(qa.RetentionError):
            qa.parse_dependency_rows('unrelated\t1\tall\n')
        with self.assertRaises(qa.RetentionError):
            qa.parse_dependency_rows('libgtk-3-0\twrong value with spaces\tamd64\n')

    def test_official_age_binary_sizes_match_independently_fetched_release_receipt(self):
        self.assertEqual(qa.AGE['amd64']['binary_size'], 6977014)
        self.assertEqual(qa.AGE['arm64']['binary_size'], 6540637)

    def fixture(self, root):
        bundle = root / 'bundle'
        names = [('appimage', 'BDOBB_3.0.0_amd64.AppImage'), ('deb', 'BDOBB_3.0.0_amd64.deb'), ('rpm', 'BDOBB-3.0.0-1.x86_64.rpm')]
        for index, (directory, name) in enumerate(names):
            (bundle / directory).mkdir(parents=True)
            (bundle / directory / name).write_bytes(('synthetic package ' + str(index)).encode())
        return bundle, names

    def test_exact_three_and_extra_or_ambiguous_packages_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            bundle, names = self.fixture(root)
            selected = qa.select_candidates(bundle, 'linux-x64')
            self.assertEqual({p.name for p in selected}, {name for _, name in names})
            extra = bundle / 'deb/OTHER.deb'
            extra.write_bytes(b'extra')
            with self.assertRaises(qa.RetentionError): qa.select_candidates(bundle, 'linux-x64')
            extra.unlink()
            duplicate = bundle / 'duplicate'
            duplicate.mkdir()
            (duplicate / names[0][1]).write_bytes(b'ambiguous')
            with self.assertRaises(qa.RetentionError): qa.select_candidates(bundle, 'linux-x64')

    def test_symlink_and_special_candidate_rejected_before_open(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            bundle, names = self.fixture(root)
            candidate = bundle / names[0][0] / names[0][1]
            candidate.unlink()
            candidate.symlink_to(bundle / names[1][0] / names[1][1])
            with self.assertRaises(qa.RetentionError): qa.select_candidates(bundle, 'linux-x64')
            candidate.unlink()
            if hasattr(os, 'mkfifo'):
                os.mkfifo(candidate)
                with self.assertRaises(qa.RetentionError): qa.select_candidates(bundle, 'linux-x64')

    def test_snapshot_tar_has_only_three_fixed_regular_names_and_changed_source_blocks(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            bundle, names = self.fixture(root)
            selected = qa.select_candidates(bundle, 'linux-x64')
            snapshot = root / 'snapshot'
            records = qa.snapshot_candidates(selected, snapshot)
            stream = io.BytesIO()
            qa.write_tar(stream, snapshot, records)
            stream.seek(0)
            with tarfile.open(fileobj=stream, mode='r:') as archive:
                self.assertEqual(set(archive.getnames()), {name for _, name in names})
                for member in archive.getmembers():
                    self.assertTrue(member.isfile())
                    self.assertEqual((member.uid, member.gid, member.mtime), (0, 0, 0))
                    self.assertEqual(archive.extractfile(member).read(), (snapshot / member.name).read_bytes())
            qa.verify_candidates(selected, records)
            selected[0].write_bytes(b'changed after snapshot')
            with self.assertRaises(qa.RetentionError): qa.verify_candidates(selected, records)

    def test_snapshot_extras_are_rejected_before_tar_streaming(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            bundle, _ = self.fixture(root)
            snapshot = root / 'snapshot'
            records = qa.snapshot_candidates(qa.select_candidates(bundle, 'linux-x64'), snapshot)
            (snapshot / 'unapproved.txt').write_bytes(b'must not enter archive')
            with self.assertRaises(qa.RetentionError): qa.write_tar(io.BytesIO(), snapshot, records)

    def test_arm_target_selects_only_its_original_names(self):
        with tempfile.TemporaryDirectory() as temporary:
            bundle = Path(temporary).resolve() / 'bundle'
            for directory, name in [('appimage', 'BDOBB_3.0.0_aarch64.AppImage'), ('deb', 'BDOBB_3.0.0_arm64.deb'), ('rpm', 'BDOBB-3.0.0-1.aarch64.rpm')]:
                (bundle / directory).mkdir(parents=True)
                (bundle / directory / name).write_bytes(b'synthetic ARM package')
            self.assertEqual(len(qa.select_candidates(bundle, 'linux-arm')), 3)
            with self.assertRaises(qa.RetentionError): qa.select_candidates(bundle, 'linux-x64')

    def test_output_directory_is_fresh_exact_runner_temp_child(self):
        with tempfile.TemporaryDirectory() as temporary:
            runner_temp = Path(temporary).resolve()
            expected = runner_temp / 'v3-encrypted-qa-linux-x64'
            qa.prepare_output(expected, runner_temp, 'linux-x64')
            self.assertEqual(list(expected.iterdir()), [])
            with self.assertRaises(qa.RetentionError): qa.prepare_output(expected, runner_temp, 'linux-x64')
            with self.assertRaises(qa.RetentionError): qa.prepare_output(runner_temp / 'other', runner_temp, 'linux-x64')

    def test_manifest_contains_hashes_and_explicit_blocked_claim_only(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            ciphertext = root / 'qa-blocked-v3-linux-x64.tar.age'
            ciphertext.write_bytes(b'age-encryption.org/v1\nsynthetic ciphertext fixture only')
            records = [{'filename': 'BDOBB_3.0.0_amd64.deb', 'size': 5, 'sha256': 'a' * 64}]
            receipt = qa.make_receipt('linux-x64', records, ciphertext, 'b' * 40, 'package-scan')
            self.assertEqual(receipt['qualification_state'], 'FAILED/BLOCKED')
            self.assertEqual(receipt['ciphertext']['sha256'], hashlib.sha256(ciphertext.read_bytes()).hexdigest())
            self.assertEqual(receipt['recipient_fingerprint_sha256'], '7f16b8c7475f4c819356d22e4fb3d35407aa6ce18176d59013ad9d0a39b50448')
            encoded = json.dumps(receipt)
            self.assertNotIn('synthetic ciphertext fixture', encoded)
            self.assertNotIn('AGE-SECRET-KEY', encoded)
            self.assertEqual(set(receipt), {'schema', 'purpose', 'qualification_state', 'failure_stage', 'target', 'source_commit', 'source_offer_id', 'auditor_commit', 'controller_commit', 'recipient_fingerprint_sha256', 'recipient_type', 'age', 'packages', 'ciphertext', 'retention_days', 'build_metadata'})

    def test_unreviewed_recipient_and_local_execution_rejected(self):
        with self.assertRaises(qa.RetentionError): qa.require_recipient('age1' + 'q' * 58)
        with mock.patch.dict(os.environ, {'GITHUB_ACTIONS': 'false'}, clear=False):
            with self.assertRaises(qa.RetentionError): qa.require_hosted_linux('linux-x64')

    def test_single_recipient_pipe_protocol_without_executing_crypto(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            bundle, _ = self.fixture(root)
            records = qa.snapshot_candidates(qa.select_candidates(bundle, 'linux-x64'), root / 'snapshot')
            output = root / 'cipher.partial'
            output.write_bytes(b'age-encryption.org/v1\nsynthetic protocol fixture; not encryption')
            class Capture(io.BytesIO):
                def close(self): pass
            sink = Capture()
            process = mock.Mock(stdin=sink)
            process.wait.return_value = 0
            process.poll.return_value = 0
            with mock.patch.object(qa.subprocess, 'Popen', return_value=process) as start:
                qa.encrypt_stream(root / 'age', qa.RECIPIENT, root / 'snapshot', records, output)
            self.assertEqual(start.call_args.args[0], [str(root / 'age'), '-r', qa.RECIPIENT, '-o', str(output)])
            self.assertEqual(start.call_args.kwargs['stdout'], qa.subprocess.DEVNULL)
            self.assertEqual(start.call_args.kwargs['stderr'], qa.subprocess.DEVNULL)
            sink.seek(0)
            with tarfile.open(fileobj=sink, mode='r:') as archive:
                self.assertEqual(set(archive.getnames()), {row['filename'] for row in records})

    def test_cli_never_prints_exception_details_or_invalid_recipient(self):
        secret = 'never-print-this-credential'
        common = ['--target', 'linux-x64', '--app', '/app', '--auditor', '/auditor', '--controller', '/controller', '--outdir', '/out', '--failure-stage', 'package-scan', '--qualification-outcome', 'failure']
        for argv in [['--unexpected', secret], common + ['--recipient', secret], common + ['--recipient', qa.RECIPIENT]]:
            output, error = io.StringIO(), io.StringIO()
            with contextlib.redirect_stdout(output), contextlib.redirect_stderr(error), mock.patch.object(qa, 'retain', side_effect=RuntimeError(secret)):
                status = qa.main(argv)
            self.assertNotEqual(status, 0)
            self.assertNotIn(secret, output.getvalue() + error.getvalue())
            self.assertEqual(output.getvalue(), '')
            self.assertEqual(json.loads(error.getvalue())['status'], 'QA_RETENTION_FAILED')


if __name__ == '__main__':
    unittest.main()
