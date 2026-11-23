import importlib.util
import json
import os
from pathlib import Path
import struct
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('linux_probe', Path(__file__).with_name('linux_release_probe.py'))
p = importlib.util.module_from_spec(spec)
spec.loader.exec_module(p)


class ProbeTests(unittest.TestCase):
    def evidence(self):
        return dict(status='AT_SPI_PROBE_COMPLETE', owned_application=True, source_showing=True,
                    description_exact=False, hovered_owned_window=True, tooltip_showing=True, tooltip_exact=True,
                    nodes_visited=14, help_cleanup='HELP_TOGGLE_CLOSED', cursor_restored=True, attempt='GAP_OWNED_TOOLTIP_UNAVAILABLE',
                    help_diagnostics=dict(exact_help_candidates=[dict(role_code=43, owned=True, visible=True)], candidates_truncated=False,
                                          matched_help_role_code=43, foreign_nodes_skipped=0, nodes_visited=14))

    def test_only_owned_showing_hovered_exact_tooltip_proves_display(self):
        self.assertEqual(p.classify_observation(self.evidence())['status'], 'OBSERVED_OWNED_TOOLTIP')
        for required in ['owned_application', 'source_showing', 'hovered_owned_window', 'tooltip_showing', 'tooltip_exact']:
            value = self.evidence()
            value[required] = False
            self.assertFalse(p.classify_observation(value)['displayed_release_observed'])

    def test_exact_description_remains_accessibility_evidence(self):
        value = self.evidence()
        value.update(description_exact=True, tooltip_exact=False)
        result = p.classify_observation(value)
        self.assertEqual(result['status'], 'OBSERVED_ATSPI_DESCRIPTION')
        self.assertTrue(result['accessible_release_observed'])
        self.assertFalse(result['displayed_release_observed'])
        self.assertEqual(result['native_about'], 'NOT_OBSERVED')

    def test_metadata_arbitrary_text_and_malformed_worker_output_never_prove_ui(self):
        for value in [dict(version='3.0.0'), dict(self.evidence(), unexpected='PRIVATE_UI_TEXT'),
                      dict(self.evidence(), nodes_visited=257), dict(self.evidence(), tooltip_exact=1), None]:
            result = p.classify_observation(value)
            self.assertEqual(result['status'], 'GAP_PROBE_OUTPUT_INVALID')
            self.assertNotIn('PRIVATE_UI_TEXT', json.dumps(result))

    def test_unavailable_native_apis_remain_explicit_gaps(self):
        result = p.classify_observation(dict(status='GAP_EXISTING_ATSPI_REGISTRY_UNAVAILABLE'))
        self.assertEqual(result['status'], 'GAP_EXISTING_ATSPI_REGISTRY_UNAVAILABLE')
        self.assertFalse(result['displayed_release_observed'])
        self.assertIsNone(result['release'])

    def test_host_guard_requires_exact_native_linux_target(self):
        env = dict(GITHUB_ACTIONS='true', RUNNER_ENVIRONMENT='github-hosted', RUNNER_OS='Linux')
        with patch.dict(os.environ, env), patch.object(p.platform, 'system', return_value='Linux'), patch.object(p.platform, 'machine', return_value='x86_64'):
            p.require_host('x86_64')
            with self.assertRaises(p.ProbeError): p.require_host('aarch64')
        with patch.dict(os.environ, dict(env, GITHUB_ACTIONS='false')):
            with self.assertRaises(p.ProbeError): p.require_host('x86_64')

    def test_elf_architecture_and_hash_are_independently_required(self):
        with tempfile.TemporaryDirectory() as temporary:
            binary = Path(temporary) / 'bdobb'
            data = bytearray(64)
            data[:6] = b'\x7fELF\x02\x01'
            struct.pack_into('<H', data, 18, 62)
            binary.write_bytes(data)
            sha = p.file_hash(binary)
            p.validate_executable(binary, sha, 'x86_64')
            with self.assertRaises(p.ProbeError): p.validate_executable(binary, sha, 'aarch64')
            with self.assertRaises(p.ProbeError): p.validate_executable(binary, '0' * 64, 'x86_64')
            link = binary.with_name('alias')
            link.symlink_to(binary)
            with self.assertRaises((p.ProbeError, OSError)): p.validate_executable(link, sha, 'x86_64')

    def test_bus_discovery_rejects_network_and_multiple_addresses(self):
        self.assertEqual(p.local_bus_address('unix:path=/tmp/existing-bus'), 'unix:path=/tmp/existing-bus')
        p.local_bus_address('unix:abstract=existing,guid=' + 'a' * 32)
        for address in ['tcp:host=example.com,port=1', 'unix:path=/tmp/one;unix:path=/tmp/two', '', 'unix:path=/tmp/bus\n']:
            with self.assertRaises(p.ProbeError): p.local_bus_address(address)
        p.local_display(':99')
        p.local_display('unix:99.0')
        for display in ['remote.example:0', 'localhost:0', '', ':99\n']:
            with self.assertRaises(p.ProbeError): p.local_display(display)

    def test_hashing_works_without_python311_file_digest(self):
        with tempfile.TemporaryDirectory() as temporary:
            file = Path(temporary) / 'file'
            file.write_bytes(b'exact executable bytes')
            with patch.object(p.hashlib, 'file_digest', side_effect=AssertionError('System Python 3.10 has no file_digest'), create=True):
                self.assertEqual(p.file_hash(file), p.hashlib.sha256(file.read_bytes()).hexdigest())

    def test_cli_does_not_expose_exceptions(self):
        import contextlib
        import io
        error = io.StringIO()
        with contextlib.redirect_stderr(error), patch.object(p, 'observe', side_effect=RuntimeError('PRIVATE_DETAIL')):
            status = p.main(['--pid', '1', '--executable', '/usr/bin/bdobb', '--sha256', 'a' * 64,
                             '--expected-arch', 'x86_64', '--evidence-dir', '/tmp/evidence'])
        self.assertNotEqual(status, 0)
        self.assertNotIn('PRIVATE_DETAIL', error.getvalue())


class HelpRoleTests(unittest.TestCase):
    def node(self, role, name='Help', visible=True, owned=True, action='click'):
        calls = []
        pattern = SimpleNamespace(nActions=1, getName=lambda index: action, doAction=lambda index: calls.append(index) or True)
        node = SimpleNamespace(name=name, getRole=lambda: role, queryAction=lambda: pattern)
        api = SimpleNamespace(ROLE_PUSH_BUTTON=43, ROLE_PUSH_BUTTON_MENU=129)
        tree = SimpleNamespace(api=api, visible=lambda candidate: visible and owned)
        return node, tree, calls

    def test_real_invoke_path_accepts_optional_menu_button_role(self):
        node, tree, calls = self.node(129)
        with patch.object(p, 'validate_process'):
            role = p.invoke_help(node, tree, SimpleNamespace())
        self.assertEqual(calls, [0])
        self.assertEqual(role, 129)

    def test_missing_optional_constant_has_no_numeric_fallback(self):
        node, tree, calls = self.node(129)
        del tree.api.ROLE_PUSH_BUTTON_MENU
        with patch.object(p, 'validate_process'):
            with self.assertRaises(p.ProbeError): p.invoke_help(node, tree, SimpleNamespace())
        self.assertEqual(calls, [])

    def test_supported_role_never_bypasses_name_visibility_ownership_or_action_allowlist(self):
        for change in [dict(name='Source Code…'), dict(visible=False), dict(owned=False), dict(action='open'), dict(role=99)]:
            values = dict(role=129)
            values.update(change)
            node, tree, calls = self.node(**values)
            with patch.object(p, 'validate_process'):
                with self.assertRaises(p.ProbeError): p.invoke_help(node, tree, SimpleNamespace())
            self.assertEqual(calls, [])

    def test_find_and_invoke_share_exact_optional_role_policy_and_filtered_diagnostics(self):
        api = SimpleNamespace(ROLE_PUSH_BUTTON=43, ROLE_PUSH_BUTTON_MENU=129, STATE_SHOWING=1, STATE_VISIBLE=2)
        class Node:
            def __init__(self, name, role, pid=7, children=()):
                self.name, self.role, self.pid, self.children = name, role, pid, children
            def get_process_id(self): return self.pid
            def getRole(self): return self.role
            def getState(self): return SimpleNamespace(contains=lambda state: True)
            @property
            def childCount(self): return len(self.children)
            def getChildAtIndex(self, index): return self.children[index]
        class Foreign(Node):
            @property
            def name(self): raise AssertionError('Foreign names must never be read')
            @name.setter
            def name(self, value): pass
        menu = Node('Help', 129)
        root = Node('Unrecorded arbitrary UI title', 1, children=[Foreign('PRIVATE', 1, pid=8), Node('Help', 99), menu])
        tree = p.Tree(api, 7)
        found = tree.find(root, lambda node: p.is_help_candidate(node, tree))
        self.assertIs(found, menu)
        diagnostic = tree.help_diagnostics()
        self.assertEqual(diagnostic['exact_help_candidates'], [dict(role_code=99, owned=True, visible=True), dict(role_code=129, owned=True, visible=True)])
        self.assertEqual(diagnostic['foreign_nodes_skipped'], 1)
        self.assertNotIn('PRIVATE', json.dumps(diagnostic))
        self.assertNotIn('arbitrary UI title', json.dumps(diagnostic))

    def test_role_diagnostics_cannot_promote_a_gap_or_leak_unapproved_fields(self):
        value = ProbeTests().evidence()
        value.update(description_exact=False, tooltip_exact=False, attempt='GAP_HELP_CONTROL_UNAVAILABLE')
        self.assertFalse(p.classify_observation(value)['displayed_release_observed'])
        value['help_diagnostics']['arbitrary_text'] = 'PRIVATE_VALUE'
        result = p.classify_observation(value)
        self.assertEqual(result['status'], 'GAP_PROBE_OUTPUT_INVALID')
        self.assertNotIn('PRIVATE_VALUE', json.dumps(result))
        value = ProbeTests().evidence()
        value['help_diagnostics']['matched_help_role_code'] = None
        self.assertEqual(p.classify_observation(value)['status'], 'GAP_PROBE_OUTPUT_INVALID')


if __name__ == '__main__':
    unittest.main()
