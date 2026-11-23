import contextlib
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest import mock
import zipfile

spec = importlib.util.spec_from_file_location('tools', Path(__file__).with_name('windows_scanner_tools.py'))
t = importlib.util.module_from_spec(spec)
spec.loader.exec_module(t)


class ToolTests(unittest.TestCase):
    def test_checksum_mismatch_refuses_execution_boundary(self):
        pin = {'size': 7, 'sha256': hashlib.sha256(b'verified').hexdigest()}
        with self.assertRaises(t.ToolError): t.verify_payload(b'changed', pin)
        with self.assertRaises(t.ToolError): t.verify_payload(b'verified', pin)
        pin['size'] = 8
        t.verify_payload(b'verified', pin)

    def test_relative_windows_archive_members_accept_real_layout_reject_escape(self):
        t.validate_member_names(['7z.exe', 'Lang\\en.txt', '$PLUGINSDIR/INetC.dll', 'tessdata/configs/pdf'])
        for names in [['../escape'], ['C:\\escape'], ['/absolute'], ['dir/file:stream'], ['a', 'A'], ['dir./file'], ['a/../b']]:
            with self.subTest(names=names), self.assertRaises(t.ToolError): t.validate_member_names(names)

    def test_zip_symlinks_and_traversal_are_rejected_before_extraction(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp).resolve()
            archive = root / 'bad.zip'
            for filename, mode in [('../outside', 0), ('link', 0o120777 << 16)]:
                with zipfile.ZipFile(archive, 'w') as writer:
                    entry = zipfile.ZipInfo(filename)
                    entry.external_attr = mode
                    writer.writestr(entry, b'payload')
                with self.assertRaises(t.ToolError): t.extract_zip(archive, root / 'output')
                self.assertFalse((root / 'outside').exists())

    def test_tool_version_parser_never_accepts_wrong_versions_or_emits_raw_output(self):
        self.assertEqual(t.parse_version('tesseract', 'tesseract v5.5.3.20260724\nPRIVATE_OTHER_OUTPUT'), '5.5.3.20260724')
        self.assertEqual(t.parse_version('pdfinfo', 'pdfinfo version 26.09.0\nCopyright public'), '26.09.0')
        self.assertEqual(t.parse_version('7z', '7-Zip 26.06 (x64) : public'), '26.06')
        for name, output in [('tesseract', 'tesseract v5.5.2'), ('pdfinfo', 'pdfinfo version 25.09.0'), ('7z', '7-Zip 24.09 (x64)')]:
            with self.assertRaises(t.ToolError): t.parse_version(name, output)

    def test_strict_output_and_platform_guard(self):
        with tempfile.TemporaryDirectory() as temp:
            runner = Path(temp).resolve()
            out = runner / 'v3-windows-scanner-tools'
            t.prepare_directory(out, runner)
            with self.assertRaises(t.ToolError): t.prepare_directory(out, runner)
            with self.assertRaises(t.ToolError): t.prepare_directory(runner / 'other', runner)
        with mock.patch.dict(os.environ, {'GITHUB_ACTIONS': 'false'}, clear=False):
            with self.assertRaises(t.ToolError): t.require_hosted_windows()

    def test_cli_errors_and_success_emit_only_safe_fixed_fields(self):
        args = ['--app', '/app', '--auditor', '/auditor', '--controller', '/controller', '--outdir', '/out']
        for failure in [False, True]:
            stdout, stderr = io.StringIO(), io.StringIO()
            with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr), mock.patch.object(t, 'install', side_effect=RuntimeError('PRIVATE_EXCEPTION') if failure else None, return_value=None):
                status = t.main(args)
            self.assertNotIn('PRIVATE_EXCEPTION', stdout.getvalue() + stderr.getvalue())
            if failure:
                self.assertNotEqual(status, 0)
                self.assertEqual(json.loads(stderr.getvalue())['status'], 'WINDOWS_SCANNER_TOOLS_FAILED')
            else:
                self.assertEqual(status, 0)
                self.assertEqual(json.loads(stdout.getvalue()), {'status': 'WINDOWS_SCANNER_TOOLS_READY', 'receipt': 'windows-scanner-tools.json'})


if __name__ == '__main__':
    unittest.main()
