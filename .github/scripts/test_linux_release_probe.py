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
                                          matched_help_role_code=43, foreign_nodes_skipped=0, nodes_visited=14, foreign_processes=[], foreign_processes_truncated=False, help_actions=[]))

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
        api = SimpleNamespace(ROLE_PUSH_BUTTON=43, ROLE_PUSH_BUTTON_MENU=129, ROLE_COMBO_BOX=11)
        tree = SimpleNamespace(api=api, visible=lambda candidate: visible and owned, recheck_owner=lambda candidate, args: None)
        return node, tree, calls

    def test_real_invoke_path_accepts_optional_menu_button_role(self):
        node, tree, calls = self.node(129)
        with patch.object(p, 'validate_process'):
            role = p.invoke_help(node, tree, SimpleNamespace())
        self.assertEqual(calls, [0])
        self.assertEqual(role, 129)

    def test_observed_native_combo_box_help_uses_exported_role_and_same_action_guard(self):
        node, tree, calls = self.node(11)
        with patch.object(p, 'validate_process'):
            self.assertEqual(p.invoke_help(node, tree, SimpleNamespace()), 11)
        self.assertEqual(calls, [0])
        del tree.api.ROLE_COMBO_BOX
        with patch.object(p, 'validate_process'):
            with self.assertRaises(p.ProbeError): p.invoke_help(node, tree, SimpleNamespace())
        self.assertEqual(calls, [0])
        for change in [dict(name='Source Code…'), dict(visible=False), dict(owned=False), dict(action='open'), dict(role=99)]:
            values = dict(role=11); values.update(change)
            bad, guarded, invoked = self.node(**values)
            with patch.object(p, 'validate_process'):
                with self.assertRaises(p.ProbeError): p.invoke_help(bad, guarded, SimpleNamespace())
            self.assertEqual(invoked, [])

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


class HelpPointerTests(unittest.TestCase):
    def node(self, **values):
        node, tree, calls = HelpRoleTests().node(11, **values)
        tree.api.XY_SCREEN=0
        node.queryComponent=lambda:SimpleNamespace(getExtents=lambda coordinate:SimpleNamespace(x=0,y=0,width=20,height=22))
        return node, tree, calls

    def test_only_exact_owned_help_can_use_pointer_after_action_unavailable(self):
        node, tree, calls = self.node(action='unrecognized')
        args = SimpleNamespace(pid=7)
        with patch.dict(os.environ, {'V3_OWNED_QA_SESSION':'1'}), patch.object(p, 'validate_process'), \
             patch.object(p, 'hover_owned', return_value=dict(X=4,Y=5,WINDOW=6)) as hover, \
             patch.object(p, 'xdo', side_effect=['X=10\nY=11\nWINDOW=12', '7', '', '']) as xdo:
            self.assertEqual(p.activate_help(node, tree, args), 11)
        self.assertEqual(calls, [])
        hover.assert_called_once_with(node, tree, args)
        self.assertIn(unittest.mock.call('click','1'), xdo.call_args_list)
        self.assertEqual(xdo.call_args_list[-1], unittest.mock.call('mousemove','--sync',4,5))
        self.assertEqual(tree.help_actions[0]['method'],'OWNED_POINTER_CLICK')
        self.assertTrue(tree.help_actions[0]['pointer_restored'])
        self.assertNotIn('unrecognized', json.dumps(tree.help_actions))

    def test_false_known_action_is_recorded_before_owned_pointer_click(self):
        node,tree,_=self.node()
        node.queryAction=lambda:SimpleNamespace(nActions=1,getName=lambda index:'click',doAction=lambda index:False)
        with patch.dict(os.environ,{'V3_OWNED_QA_SESSION':'1'}),patch.object(p,'validate_process'), \
             patch.object(p,'hover_owned',return_value=dict(X=4,Y=5,WINDOW=6)), \
             patch.object(p,'xdo',side_effect=['X=10\nY=11\nWINDOW=12','7','','']):
            self.assertEqual(p.activate_help(node,tree,SimpleNamespace(pid=7)),11)
        self.assertEqual(tree.help_actions[0]['count'],1)
        self.assertEqual(tree.help_actions[0]['known_names'],['click'])
        self.assertIs(tree.help_actions[0]['returned'],False)
        self.assertTrue(p.valid_help_actions(tree.help_actions))

    def test_hover_uses_actual_accessible_bounds_and_both_main_window_pid_checks(self):
        node,tree,_=self.node(action='unrecognized')
        tree.api.XY_SCREEN=0
        node.queryComponent=lambda:SimpleNamespace(getExtents=lambda coordinate:SimpleNamespace(x=100,y=200,width=20,height=10))
        replies=['55','7','X=0\nY=0\nWIDTH=500\nHEIGHT=500','X=4\nY=5\nWINDOW=9','','X=110\nY=205\nWINDOW=55','7']
        with patch.object(p,'validate_process'),patch.object(p,'xdo',side_effect=replies)as xdo:
            self.assertEqual(p.hover_owned(node,tree,SimpleNamespace(pid=7)),dict(X=4,Y=5,WINDOW=9))
        self.assertIn(unittest.mock.call('mousemove','--sync',110,205),xdo.call_args_list)
        self.assertEqual(xdo.call_args_list[-1],unittest.mock.call('getwindowpid',55))

    def test_action_diagnostics_cannot_leak_names_or_promote_display(self):
        value=ProbeTests().evidence();value.update(tooltip_exact=False,description_exact=False)
        row=dict(count=1,known_names=['click'],unknown_names=True,returned=False,method='OWNED_POINTER_CLICK',pointer_restored=True)
        value['help_diagnostics']['help_actions']=[row]
        self.assertFalse(p.classify_observation(value)['displayed_release_observed'])
        row['known_names']=['PRIVATE_ACTION']
        self.assertEqual(p.classify_observation(value)['status'],'GAP_PROBE_OUTPUT_INVALID')
        self.assertNotIn('PRIVATE_ACTION',json.dumps(p.classify_observation(value)))

    def test_pointer_requires_owned_session_and_main_window_under_cursor(self):
        for environment,owner in [({},'7'),({'V3_OWNED_QA_SESSION':'1'},'99')]:
            node, tree, _ = self.node(action='unrecognized')
            with patch.dict(os.environ,environment,clear=True), patch.object(p, 'validate_process'), \
                 patch.object(p, 'hover_owned', return_value=dict(X=4,Y=5,WINDOW=6)), \
                 patch.object(p, 'xdo', side_effect=['X=10\nY=11\nWINDOW=12',owner,'']) as xdo:
                with self.assertRaises(p.ProbeError):p.activate_help(node,tree,SimpleNamespace(pid=7))
            self.assertNotIn(unittest.mock.call('click','1'),xdo.call_args_list)
            if environment:self.assertEqual(xdo.call_args_list[-1],unittest.mock.call('mousemove','--sync',4,5))

    def test_source_hidden_foreign_or_unknown_role_never_uses_pointer(self):
        for change in [dict(name='Source Code…'),dict(visible=False),dict(owned=False),dict(role=99)]:
            values=dict(role=11,action='unrecognized');values.update(change)
            node,tree,_=HelpRoleTests().node(**values)
            with patch.dict(os.environ,{'V3_OWNED_QA_SESSION':'1'}),patch.object(p,'hover_owned')as hover:
                with self.assertRaises(p.ProbeError):p.activate_help(node,tree,SimpleNamespace(pid=7))
            hover.assert_not_called()

    def test_pointer_drift_or_help_control_movement_prevents_click_with_same_window_pid(self):
        for pointer,box in [('X=90\nY=91\nWINDOW=12',(0,0,20,22)),('X=10\nY=11\nWINDOW=12',(100,100,20,22))]:
            node,tree,_=self.node(action='unrecognized')
            node.queryComponent=lambda:SimpleNamespace(getExtents=lambda coordinate:SimpleNamespace(x=box[0],y=box[1],width=box[2],height=box[3]))
            with patch.dict(os.environ,{'V3_OWNED_QA_SESSION':'1'}),patch.object(p,'validate_process'), \
                 patch.object(p,'hover_owned',return_value=dict(X=4,Y=5,WINDOW=6)), \
                 patch.object(p,'xdo',side_effect=lambda *args:pointer if args[0]=='getmouselocation' else '7' if args[0]=='getwindowpid' else '')as xdo:
                with self.assertRaises(p.ProbeError):p.activate_help(node,tree,SimpleNamespace(pid=7))
            self.assertNotIn(unittest.mock.call('click','1'),xdo.call_args_list)
            self.assertEqual(xdo.call_args_list[-1],unittest.mock.call('mousemove','--sync',4,5))

    def test_process_change_before_pointer_click_restores_cursor_without_click(self):
        node,tree,_=self.node(action='unrecognized')
        with patch.dict(os.environ,{'V3_OWNED_QA_SESSION':'1'}),patch.object(p,'validate_process',side_effect=p.ProbeError('ERROR_PROCESS_IDENTITY')), \
             patch.object(p,'hover_owned',return_value=dict(X=4,Y=5,WINDOW=6)),patch.object(p,'xdo')as xdo:
            with self.assertRaises(p.ProbeError):p.activate_help(node,tree,SimpleNamespace(pid=7))
        self.assertNotIn(unittest.mock.call('click','1'),xdo.call_args_list)
        self.assertEqual(xdo.call_args_list[-1],unittest.mock.call('mousemove','--sync',4,5))


class WebKitOwnershipTests(unittest.TestCase):
    def records(self):
        def row(pid, ppid, exe, uid=1001):
            return dict(pid=pid, ppid=ppid, exe=Path(exe), uid=uid, start_time=pid * 10, namespace='pid:[42]',
                        exe_uid=0, exe_mode=0o755, exe_dev=7, exe_ino=pid, machine=183)
        return {10: row(10, 1, '/usr/bin/bdobb'),
                20: row(20, 10, '/usr/bin/bwrap'),
                30: row(30, 20, '/usr/lib/aarch64-linux-gnu/webkit2gtk-4.1/WebKitWebProcess')}

    def proof(self, records, pid=30):
        args = SimpleNamespace(pid=10, expected_arch='aarch64', executable='/usr/bin/bdobb', sha256='a' * 64)
        with patch.object(p, 'validate_process'), patch.object(p.os, 'getuid', return_value=1001), \
             patch.object(p, 'current_pid_namespace', return_value='pid:[42]'), \
             patch.object(p, 'read_executable_record', return_value=dict(exe_uid=0, exe_mode=0o755, exe_dev=7, exe_ino=30, machine=183), create=True), \
             patch.object(p, 'read_process_record', side_effect=lambda process_id: dict(records[process_id])):
            return p.prove_webkit_owner(pid, args)

    def test_known_system_webkit_same_uid_chain_to_exact_app_is_proven(self):
        result = self.proof(self.records())
        self.assertTrue(result['allowed'])
        self.assertEqual(result['diagnostic']['status'], 'PROVEN_OWNED_WEBKIT_DESCENDANT')
        self.assertTrue(result['diagnostic']['main_ancestor_verified'])
        self.assertEqual(result['diagnostic']['ancestry_depth'], 2)

    def test_nonchild_wrong_uid_unknown_executable_never_gain_ownership(self):
        cases = [('GAP_WEBKIT_NOT_OWNED_DESCENDANT', 20, dict(ppid=1)),
                 ('GAP_WEBKIT_UID_MISMATCH', 20, dict(uid=1002)),
                 ('GAP_WEBKIT_EXECUTABLE_UNAPPROVED', 30, dict(exe=Path('/usr/bin/other'))),
                 ('GAP_WEBKIT_EXECUTABLE_UNAPPROVED', 30, dict(exe_uid=1001))]
        for status, pid, changes in cases:
            records = self.records()
            records[pid].update(changes)
            result = self.proof(records)
            self.assertFalse(result['allowed'])
            self.assertEqual(result['diagnostic']['status'], status)

    def test_main_process_same_reported_path_requires_actual_object_identity(self):
        args = SimpleNamespace(pid=10, expected_arch='aarch64', executable='/usr/bin/bdobb', sha256='a' * 64)
        with patch.object(p, 'require_host'), patch.object(p, 'validate_executable'), \
             patch.object(p.os, 'getuid', return_value=1001), \
             patch.object(p.Path, 'stat', return_value=SimpleNamespace(st_uid=1001)), \
             patch.object(p.Path, 'resolve', return_value=Path('/usr/bin/bdobb')):
            for actual in [dict(exe_dev=8, exe_ino=10), dict(exe_dev=7, exe_ino=999)]:
                with patch.object(p, 'read_executable_record', side_effect=[actual, dict(exe_dev=7, exe_ino=10)]):
                    with self.assertRaises(p.ProbeError): p.validate_process(args)
            with patch.object(p, 'read_executable_record', return_value=dict(exe_dev=7, exe_ino=10)):
                p.validate_process(args)

    def test_same_path_uid_arch_but_different_actual_executable_object_is_rejected(self):
        for changes in [dict(exe_dev=8), dict(exe_ino=999)]:
            records = self.records()
            records[30].update(changes)
            result = self.proof(records)
            self.assertFalse(result['allowed'])
            self.assertEqual(result['diagnostic']['status'], 'GAP_WEBKIT_EXECUTABLE_UNAPPROVED')

    def test_proc_magic_link_reader_uses_open_object_identity_and_header(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            data = bytearray(64); data[:6] = b'\x7fELF\x02\x01'; struct.pack_into('<H', data, 18, 183)
            actual = root / 'actual'; actual.write_bytes(data)
            other = root / 'other'; other.write_bytes(data)
            magic = root / 'exe'; magic.symlink_to(actual)
            first = p.read_executable_record(magic, proc_magic=True)
            self.assertEqual(first['exe_ino'], actual.stat().st_ino)
            self.assertEqual(first['exe_dev'], actual.stat().st_dev)
            self.assertEqual(first['machine'], 183)
            magic.unlink(); magic.symlink_to(other)
            second = p.read_executable_record(magic, proc_magic=True)
            self.assertNotEqual(first['exe_ino'], second['exe_ino'])
            with self.assertRaises(OSError): p.read_executable_record(magic)

    def test_sandbox_namespace_difference_is_diagnostic_when_host_pid_ancestry_is_proven(self):
        records = self.records()
        records[30]['namespace'] = 'pid:[99]'
        result = self.proof(records)
        self.assertTrue(result['allowed'])
        self.assertFalse(result['diagnostic']['namespace_matches'])
        self.assertTrue(result['diagnostic']['main_ancestor_verified'])
        self.assertTrue(p.valid_foreign_diagnostics([result['diagnostic']]))

    def test_invalid_or_zero_pid_has_no_family_or_zero_pid_fallback(self):
        for pid in [0, -1, None, True, 2 ** 31]:
            result = self.proof(self.records(), pid)
            self.assertFalse(result['allowed'])
            self.assertEqual(result['diagnostic']['status'], 'GAP_WEBKIT_PID_UNRESOLVED')

    def test_main_identity_failure_is_never_downgraded_to_ownership(self):
        args = SimpleNamespace(pid=10, expected_arch='aarch64')
        with patch.object(p, 'validate_process', side_effect=p.ProbeError('ERROR_EXECUTABLE_SHA')):
            with self.assertRaises(p.ProbeError): p.prove_webkit_owner(30, args)

    def test_tree_can_find_and_invoke_only_proven_webkit_help_and_rejects_changed_identity(self):
        records = self.records()
        args = SimpleNamespace(pid=10, expected_arch='aarch64', executable='/usr/bin/bdobb', sha256='a' * 64)
        api = SimpleNamespace(ROLE_PUSH_BUTTON=43, ROLE_PUSH_BUTTON_MENU=129, STATE_SHOWING=1, STATE_VISIBLE=2)
        calls = []
        action = SimpleNamespace(nActions=1, getName=lambda index: 'click', doAction=lambda index: calls.append(index) or True)
        class Node:
            def __init__(self, pid, name, children=()): self.pid, self.name, self.children = pid, name, children
            def get_process_id(self): return self.pid
            def getRole(self): return 129
            def getState(self): return SimpleNamespace(contains=lambda state: True)
            def queryAction(self): return action
            @property
            def childCount(self): return len(self.children)
            def getChildAtIndex(self, index): return self.children[index]
        help_node = Node(30, 'Help')
        root = Node(10, 'unrecorded application text', [help_node])
        with patch.object(p, 'validate_process'), patch.object(p.os, 'getuid', return_value=1001), \
             patch.object(p, 'current_pid_namespace', return_value='pid:[42]'), \
             patch.object(p, 'read_executable_record', return_value=dict(exe_uid=0, exe_mode=0o755, exe_dev=7, exe_ino=30, machine=183), create=True), \
             patch.object(p, 'read_process_record', side_effect=lambda process_id: dict(records[process_id])):
            tree = p.Tree(api, 10, args)
            self.assertIs(tree.find(root, lambda node: p.is_help_candidate(node, tree)), help_node)
            self.assertEqual(p.invoke_help(help_node, tree, args), 129)
            self.assertEqual(calls, [0])
            diagnostic = tree.help_diagnostics()['foreign_processes'][0]
            self.assertEqual(diagnostic['pid'], 30)
            self.assertEqual(diagnostic['role_code'], 129)
            self.assertEqual(diagnostic['status'], 'PROVEN_OWNED_WEBKIT_DESCENDANT')
            records[30]['start_time'] += 1
            self.assertFalse(tree.owned(help_node))
            self.assertEqual(tree.help_diagnostics()['foreign_processes'][0]['status'], 'GAP_WEBKIT_PROCESS_CHANGED')

    def test_unproven_family_or_zero_pid_node_is_skipped_before_any_name_read(self):
        args = SimpleNamespace(pid=10, expected_arch='aarch64', executable='/usr/bin/bdobb', sha256='a' * 64)
        class Node:
            def get_process_id(self): return 0
            def getRole(self): return 129
            @property
            def name(self): raise AssertionError('Unproven foreign text must never be read')
        tree = p.Tree(SimpleNamespace(), 10, args)
        self.assertFalse(tree.owned(Node()))
        self.assertEqual(tree.help_diagnostics()['foreign_processes'][0]['status'], 'GAP_WEBKIT_PID_UNRESOLVED')

    def test_foreign_diagnostics_are_filtered_and_cannot_promote_display(self):
        value = ProbeTests().evidence()
        diagnostic = self.proof(self.records())['diagnostic']
        value['help_diagnostics']['foreign_processes'] = [diagnostic]
        value.update(tooltip_exact=False, description_exact=False, attempt='GAP_OWNED_TOOLTIP_UNAVAILABLE')
        self.assertFalse(p.classify_observation(value)['displayed_release_observed'])
        diagnostic['argv'] = 'PRIVATE_ARGV'
        result = p.classify_observation(value)
        self.assertEqual(result['status'], 'GAP_PROBE_OUTPUT_INVALID')
        self.assertNotIn('PRIVATE_ARGV', json.dumps(result))


if __name__ == '__main__':
    unittest.main()
