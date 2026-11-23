import hashlib
import importlib.util
import json
import os
from pathlib import Path
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('owned_session', Path(__file__).with_name('linux_owned_atspi_session.py'))
p = importlib.util.module_from_spec(spec)
spec.loader.exec_module(p)


class OwnedSessionTests(unittest.TestCase):
    def test_host_marker_architecture_and_display_are_mandatory(self):
        env = dict(GITHUB_ACTIONS='true', RUNNER_ENVIRONMENT='github-hosted', RUNNER_OS='Linux', V3_OWNED_QA_SESSION='1', DISPLAY=':99')
        with patch.dict(os.environ, env), patch.object(p.platform, 'system', return_value='Linux'), patch.object(p.platform, 'machine', return_value='aarch64'):
            p.require_owned_host()
            for key in env:
                with patch.dict(os.environ, {key: 'invalid'}):
                    with self.assertRaises(p.SessionError): p.require_owned_host()
        with patch.dict(os.environ, env), patch.object(p.platform, 'system', return_value='Darwin'):
            with self.assertRaises(p.SessionError): p.require_owned_host()

    def test_only_single_local_unix_addresses_can_be_connected(self):
        self.assertEqual(p.parse_unix_address('unix:path=/tmp/qa-bus,guid=' + 'a' * 32), '/tmp/qa-bus')
        self.assertEqual(p.parse_unix_address('unix:abstract=qa-bus'), '\x00qa-bus')
        for address in ['tcp:host=example.com,port=1', 'unix:path=/tmp/one;unix:path=/tmp/two', 'unix:path=/tmp/a%00b', 'unix:path=relative', '', 'unix:path=/tmp/bus\n']:
            with self.assertRaises(p.SessionError): p.parse_unix_address(address)

    def test_peer_uid_and_pid_must_belong_to_runner(self):
        p.validate_peer(123, 1001, 1001)
        for pid, actual, expected in [(0, 1001, 1001), (123, 0, 1001), (123, 1002, 1001)]:
            with self.assertRaises(p.SessionError): p.validate_peer(pid, actual, expected)

    def test_fresh_session_daemon_parent_must_be_our_dbus_run_session_ancestor(self):
        p.classify_session_scope(daemon_exe='dbus-daemon', launcher_exe='dbus-run-session', launcher_pid=77, ancestors={77, 88})
        for changes in [dict(daemon_exe='other'), dict(launcher_exe='systemd'), dict(launcher_pid=55)]:
            args = dict(daemon_exe='dbus-daemon', launcher_exe='dbus-run-session', launcher_pid=77, ancestors={77, 88})
            args.update(changes)
            with self.assertRaises(p.SessionError): p.classify_session_scope(**args)

    def test_receipt_has_hashes_and_uids_but_no_addresses_or_environment(self):
        record = p.safe_receipt('a' * 32, 'b' * 32, 1001, 1001, 1001, 1001)
        self.assertEqual(record['session_bus_guid_sha256'], hashlib.sha256(('a' * 32).encode()).hexdigest())
        self.assertEqual(record['scope'], 'owned ephemeral dbus-run-session and Xvfb only')
        self.assertNotIn('unix:', json.dumps(record))
        self.assertEqual(set(record), {'schema', 'status', 'scope', 'session_bus_guid_sha256', 'accessibility_bus_guid_sha256',
            'session_daemon_uid', 'accessibility_daemon_uid', 'launcher_uid', 'registry_uid', 'activation', 'app_environment_scope', 'qualification_claim'})
        for bad_guid in ['not-a-guid', 'a' * 32 + '\n']:
            with self.assertRaises(p.SessionError): p.safe_receipt(bad_guid, 'b' * 32, 1001, 1001, 1001, 1001)

    def test_app_environment_copy_changes_only_two_accessibility_keys(self):
        original = dict(PATH='/existing', NO_AT_BRIDGE='1', DBUS_SESSION_BUS_ADDRESS='unix:path=/tmp/session', OTHER='private')
        result = p.make_app_environment(original, 'unix:path=/tmp/qa-a11y')
        self.assertEqual(original['NO_AT_BRIDGE'], '1')
        self.assertNotIn('AT_SPI_BUS_ADDRESS', original)
        self.assertNotIn('NO_AT_BRIDGE', result)
        self.assertEqual(result['AT_SPI_BUS_ADDRESS'], 'unix:path=/tmp/qa-a11y')
        self.assertEqual({key: value for key, value in result.items() if key != 'AT_SPI_BUS_ADDRESS'}, {key: value for key, value in original.items() if key != 'NO_AT_BRIDGE'})

    def test_cli_never_prints_environment_or_exception_details(self):
        import contextlib
        import io
        stdout, stderr = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr), patch.object(p, 'prepare_owned_session', side_effect=RuntimeError('PRIVATE_ADDRESS_OR_ENV')):
            status = p.main(['--evidence-dir', '/tmp/evidence'])
        self.assertNotEqual(status, 0)
        self.assertEqual(stdout.getvalue(), '')
        self.assertNotIn('PRIVATE_ADDRESS_OR_ENV', stderr.getvalue())


if __name__ == '__main__': unittest.main()
