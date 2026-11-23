import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import subprocess
import types
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('supplement', Path(__file__).with_name('install_supplement.py'))
s = importlib.util.module_from_spec(spec)
spec.loader.exec_module(s)


class ValidationTest(unittest.TestCase):
    def test_supplement_runtime_is_bound_to_owned_current_controller(self):
        head = 'f' * 40
        with patch.dict(s.os.environ, {'GITHUB_SHA': head}), patch.object(s, 'command', return_value=types.SimpleNamespace(stdout=head + '\n')):
            current = s.load_supplement_runtime()
            self.assertEqual(current.SOURCE_COMMIT, s.SOURCE)
            self.assertEqual(current.SOURCE_ID, s.OFFER)
        with patch.dict(s.os.environ, {'GITHUB_SHA': head}), patch.object(s, 'command', return_value=types.SimpleNamespace(stdout='0' * 40 + '\n')):
            with self.assertRaises(ValueError):
                s.load_supplement_runtime()
        with patch.dict(s.os.environ, {'GITHUB_SHA': head}), patch.object(s, 'command', side_effect=[types.SimpleNamespace(stdout=head + '\n'), subprocess.CalledProcessError(1, 'git')]):
            with self.assertRaises(subprocess.CalledProcessError):
                s.load_supplement_runtime()
        with patch.dict(s.os.environ, {'GITHUB_SHA': 'not-a-sha'}):
            with self.assertRaises(ValueError):
                s.load_supplement_runtime()

    def test_wrong_run_or_failed_target_job_refuses_artifacts(self):
        run = {'id': 45082804450, 'run_attempt': 1, 'head_sha': '205d83afce56d13dfdc8d91ec3e311c977b33bd4',
               'repository': {'full_name': 'artcashin/bdobb'}, 'event': 'workflow_dispatch',
               'path': '.github/workflows/release.yml', 'status': 'completed', 'conclusion': 'failure'}
        jobs = {'jobs': [{'id': 123, 'name': 'V3 linux-x64 native qualification', 'status': 'completed', 'conclusion': 'success'}]}
        artifacts = {'artifacts': [{'id': 456, 'name': 'qualified-v3-linux-x64', 'expired': False, 'workflow_run': {'id': 45082804450, 'head_sha': run['head_sha']}}]}
        # Another target may fail: only this exact successful native job is required.
        receipt = s.validate_run(run, 'linux-x64', jobs, artifacts)
        self.assertEqual((receipt['id'], receipt['artifact_id']), (45082804450, 456))
        for key, value in [('id', 1), ('run_attempt', 2), ('head_sha', 'f' * 40), ('event', 'push'), ('path', 'evil.yml'), ('repository', {'full_name': 'other/bdobb'})]:
            with self.subTest(key=key), self.assertRaises(ValueError):
                s.validate_run(dict(run, **{key: value}), 'linux-x64', jobs, artifacts)
        for bad_jobs in [{'jobs': []}, {'jobs': [dict(jobs['jobs'][0], conclusion='failure')]}, {'jobs': jobs['jobs'] * 2}]:
            with self.assertRaises(ValueError):
                s.validate_run(run, 'linux-x64', bad_jobs, artifacts)
        for bad_artifacts in [{'artifacts': []}, {'artifacts': [dict(artifacts['artifacts'][0], expired=True)]}, {'artifacts': artifacts['artifacts'] * 2}]:
            with self.assertRaises(ValueError):
                s.validate_run(run, 'linux-x64', jobs, bad_artifacts)

    def artifact(self, root):
        stage = root / 'release-stage'
        stage.mkdir()
        evidence = root / 'qualification-evidence'
        evidence.mkdir()
        name = 'BDOBB_3.0.0_amd64.deb'
        package = stage / name
        package.write_bytes(b'exact package')
        digest = hashlib.sha256(b'exact package').hexdigest()
        offer = {'sourceId': '19c760a782e0ab84152ee990e8f9014f7e677f448bc58d6a3e548d8f485f1c6b'}
        q = types.SimpleNamespace(expected_names=lambda target: [name], TARGETS={'linux-x64': ('x86_64', [name])}, EXPECTED_OFFER=offer)
        record = {'sha256': digest, 'source_commit': 'de25611461ad0559ce237c4f59b812decd91dec1', 'source_id': offer['sourceId'], 'embedded_offer': offer,
                  'embedded_defaults': 'all six exact empty values verified by app checker', 'architecture': 'x86_64', 'executable_sha256': 'a' * 64, 'runtime': {'status': 'PASS'}}
        (stage / 'qualification.json').write_text(json.dumps({name: record}))
        (stage / 'scan.json').write_text(json.dumps({name: {'sha256': digest}}))
        (stage / 'SHA256SUMS').write_text(f'{digest}  {name}\n')
        (evidence / 'build-identity.json').write_text(json.dumps({'source_commit': record['source_commit'], 'source_id': offer['sourceId'], 'controller_commit': '205d83afce56d13dfdc8d91ec3e311c977b33bd4', 'target': 'x86_64-unknown-linux-gnu'}))
        return package, q

    def test_corrupted_package_refuses_installation(self):
        with tempfile.TemporaryDirectory() as temp:
            package, q = self.artifact(Path(temp))
            self.assertEqual(s.validate_artifact(Path(temp), 'linux-x64', q)[0], package)
            package.write_bytes(b'changed package')
            with self.assertRaises(ValueError):
                s.validate_artifact(Path(temp), 'linux-x64', q)

    def test_missing_scan_or_bad_checksum_or_wrong_offer_refuses_installation(self):
        mutations = [('scan.json', '{}'), ('SHA256SUMS', '0' * 64 + '  BDOBB_3.0.0_amd64.deb\n'), ('qualification.json', None), ('build-identity.json', None)]
        for filename, content in mutations:
            with self.subTest(file=filename), tempfile.TemporaryDirectory() as temp:
                root = Path(temp)
                package, q = self.artifact(root)
                path = (root / 'qualification-evidence' if filename == 'build-identity.json' else package.parent) / filename
                if filename == 'qualification.json':
                    obj = json.loads(path.read_text())
                    obj[package.name]['embedded_offer'] = {}
                    content = json.dumps(obj)
                elif filename == 'build-identity.json':
                    obj = json.loads(path.read_text())
                    obj['controller_commit'] = '0' * 40
                    content = json.dumps(obj)
                path.write_text(content)
                with self.assertRaises(ValueError):
                    s.validate_artifact(root, 'linux-x64', q)


if __name__ == '__main__':
    unittest.main()
