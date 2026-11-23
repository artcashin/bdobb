import importlib.util
from pathlib import Path
import tempfile,unittest,zipfile
from unittest import mock
spec=importlib.util.spec_from_file_location('observe',Path(__file__).with_name('v3_intel_about_only.py'));p=importlib.util.module_from_spec(spec);spec.loader.exec_module(p)
class Controls(unittest.TestCase):
    def test_zip_digest_refuses_changed_original_artifact(self):
        with tempfile.TemporaryDirectory() as d:
            z=Path(d)/'bad.zip';z.write_bytes(b'changed')
            with self.assertRaises(ValueError):p.extract_exact_zip(z,Path(d)/'out')
    def test_zip_rejects_parent_traversal_even_when_digest_binding_is_satisfied(self):
        with tempfile.TemporaryDirectory() as d:
            z=Path(d)/'bad.zip'
            with zipfile.ZipFile(z,'w') as a:a.writestr('../escape','bad')
            with mock.patch.object(p.q,'sha256',return_value=p.ZIP_SHA):
                with self.assertRaises(ValueError):p.extract_exact_zip(z,Path(d)/'out')
            self.assertFalse((Path(d)/'escape').exists())
    def test_exact_pair_original_executable_and_no_build_scope(self):
        self.assertEqual(len(p.PACKAGES),2);self.assertEqual(p.RUN,45123656948);self.assertEqual(p.ARTIFACT,14795826748)
        source=Path(p.__file__).read_text();self.assertNotIn('tauri build',source);self.assertNotIn('cargo install',source);self.assertIn("platform.machine()!='x86_64'",source)
    def test_swift_keeps_single_deadline_budget_owner_and_no_permission_prompt(self):
        s=Path(__file__).with_name('mac_about_probe.swift').read_text();self.assertEqual(s.count('deadline = ProcessInfo.processInfo.systemUptime + 10.0'),1);self.assertIn('private let maximumNodes = 256',s);self.assertEqual(s.count('guard try pollOwned(executable'),2);self.assertIn('guard processPath(targetPID) == executable',s);self.assertNotIn('AXIsProcessTrustedWithOptions',s)
    def test_workflow_uploads_only_explicit_safe_receipts(self):
        w=Path(__file__).parents[1]/'workflows/v3-intel-about-only.yml';s=w.read_text();self.assertIn('runs-on: macos-15-intel',s);self.assertIn('actions: read',s);self.assertNotIn('contents: write',s);self.assertNotIn('tauri build',s);self.assertNotIn('release-stage/',s);self.assertIn('safe-receipts/intel-about.json',s);self.assertIn('safe-receipts/SHA256SUMS',s);self.assertIn("steps.outbound.outcome == 'success'",s)
if __name__=='__main__':unittest.main()
