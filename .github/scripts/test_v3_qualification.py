import importlib.util, io, json, struct, tempfile, unittest
from pathlib import Path
P = Path(__file__).with_name('v3_qualification.py')
spec = importlib.util.spec_from_file_location('qualification', P)
q = importlib.util.module_from_spec(spec)
spec.loader.exec_module(q)
control_spec = importlib.util.spec_from_file_location('controls', Path(__file__).with_name('run_auditor_controls.py'))
controls = importlib.util.module_from_spec(control_spec)
control_spec.loader.exec_module(controls)


def probe(test_id, fail=False):
    class Probe(unittest.TestCase):
        def id(self):
            return test_id

        def runTest(self):
            if fail:
                self.fail('Unomitted control failure must remain a failure')
    return Probe('runTest')


class ControlHarnessTest(unittest.TestCase):
    def test_windows_omissions_do_not_suppress_other_failures(self):
        suite = unittest.TestSuite([probe(name) for name in controls.WINDOWS_OMISSIONS])
        suite.addTest(probe('ordinary.native.control', fail=True))
        result = unittest.TextTestRunner(stream=io.StringIO()).run(controls.scoped_suite(suite, 'Windows'))
        self.assertEqual(len(result.skipped), 11)
        self.assertEqual(len(result.failures), 1)
        self.assertFalse(result.wasSuccessful())

    def test_posix_retains_every_control(self):
        suite = unittest.TestSuite([probe(name) for name in controls.WINDOWS_OMISSIONS])
        result = unittest.TextTestRunner(stream=io.StringIO()).run(controls.scoped_suite(suite, 'Linux'))
        self.assertEqual(result.testsRun, 11)
        self.assertEqual(result.skipped, [])

    def test_unknown_auditor_omission_cannot_silently_match_nothing(self):
        with self.assertRaises(ValueError):
            controls.scoped_suite(unittest.TestSuite([probe('unrelated')]), 'Windows')

class QualificationTest(unittest.TestCase):

    def test_msi_path_member_launches_only_as_identical_exe_copy(self):
        with tempfile.TemporaryDirectory() as directory:
            work = Path(directory)
            unpacked = work / 'unpacked'
            unpacked.mkdir()
            payload = unpacked / 'Path'
            payload.write_bytes(b'exact executable bytes')
            binary, member = q.locate_executable(unpacked, Path('BDOBB.msi'), work)
            self.assertEqual(member, 'Path')
            self.assertEqual(binary.name, 'bdobb.exe')
            self.assertEqual(binary.read_bytes(), payload.read_bytes())
            with self.assertRaises(ValueError):
                q.locate_executable(unpacked, Path('BDOBB.exe'), work)

    def test_twelve_original_names(self):
        names = [n for t in q.TARGETS for n in q.expected_names(t)]
        self.assertEqual(len(names), 12)
        self.assertEqual(set(names), {
            'BDOBB-3.0.0-1.aarch64.rpm', 'BDOBB-3.0.0-1.x86_64.rpm',
            'BDOBB_3.0.0_aarch64.AppImage', 'BDOBB_3.0.0_aarch64.dmg',
            'BDOBB_3.0.0_amd64.AppImage', 'BDOBB_3.0.0_amd64.deb',
            'BDOBB_3.0.0_arm64.deb', 'BDOBB_3.0.0_x64-setup.exe',
            'BDOBB_3.0.0_x64.dmg', 'BDOBB_3.0.0_x64_en-US.msi',
            'BDOBB_aarch64.app.tar.gz', 'BDOBB_x64.app.tar.gz',
        })

    def test_macos_and_windows_architecture_headers(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'native'
            header = bytearray(64)
            header[:4] = b'\xcf\xfa\xed\xfe'
            struct.pack_into('<I', header, 4, 0x100000C)
            path.write_bytes(header)
            self.assertEqual(q.binary_arch(path), 'aarch64')
            header[:2] = b'MZ'
            struct.pack_into('<I', header, 60, 64)
            path.write_bytes(header + b'PE\0\0' + struct.pack('<H', 0x8664))
            self.assertEqual(q.binary_arch(path), 'x86_64')

    def test_native_architecture(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / 'elf'
            data = bytearray(64)
            data[:6] = b'\x7fELF\x02\x01'
            struct.pack_into('<H', data, 18, 183)
            p.write_bytes(data)
            self.assertEqual(q.binary_arch(p), 'aarch64')
            with self.assertRaises(ValueError):
                q.require_arch(p, 'x86_64')

    def test_missing_or_extra_package_blocks(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            names = q.expected_names('mac-intel')
            for n in names:
                (root / n).write_bytes(b'package')
            q.require_packages(root, names)
            (root / names[0]).unlink()
            with self.assertRaises(ValueError):
                q.require_packages(root, names)
            (root / names[0]).write_bytes(b'package')
            (root / 'BDOBB_other.dmg').write_bytes(b'x')
            with self.assertRaises(ValueError):
                q.require_packages(root, names)

    def test_embedded_offer_requires_runtime_javascript(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            (root / 'assets').mkdir()
            text = json.dumps(q.EXPECTED_OFFER)
            (root / 'assets/main.js.map').write_text(text)
            with self.assertRaises(ValueError):
                q.verify_offer(root)
            (root / 'assets/main.js').write_text(text)
            q.verify_offer(root)
            (root / 'assets/main.js').write_text(text.replace(q.SOURCE_ID, 'f' * 64))
            with self.assertRaises(ValueError):
                q.verify_offer(root)

    def test_nonempty_or_missing_runtime_backend_blocks(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            with self.assertRaises(ValueError):
                q.verify_empty_profile(root)
            (root / 'backends.json').write_text('[]')
            q.verify_empty_profile(root)
            (root / 'workspace.json').write_text('{"connections":[{"id":"unexpected"}]}')
            with self.assertRaises(ValueError):
                q.verify_empty_profile(root)
            (root / 'workspace.json').unlink()
            (root / 'backends.json').write_text('[{"name":"unexpected"}]')
            with self.assertRaises(ValueError):
                q.verify_empty_profile(root)

    def test_changed_checksum_blocks_aggregation(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            records = {}
            for t in q.TARGETS:
                out = root / t
                out.mkdir()
                manifest = {}
                for n in q.expected_names(t):
                    p = out / n
                    p.write_bytes(n.encode())
                    manifest[n] = {'sha256': q.sha256(p), 'runtime': {'status': 'PASS'}, 'source_commit': q.SOURCE_COMMIT, 'source_id': q.SOURCE_ID}
                (out / 'qualification.json').write_text(json.dumps(manifest))
            result = q.aggregate(root)
            self.assertEqual(len(result), 12)
            p = root / 'mac-intel' / q.expected_names('mac-intel')[0]
            p.write_bytes(b'changed')
            with self.assertRaises(ValueError):
                q.aggregate(root)
if __name__ == '__main__':
    unittest.main()
