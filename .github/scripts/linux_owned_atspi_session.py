"""Initialize AT-SPI only inside an explicitly owned ephemeral QA session."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import socket
import stat
import struct
import subprocess
import sys
from urllib.parse import unquote


class SessionError(Exception):
    """Fixed code only; no bus addresses, environment, or native output."""


def require_owned_host():
    expected = {'GITHUB_ACTIONS': 'true', 'RUNNER_ENVIRONMENT': 'github-hosted', 'RUNNER_OS': 'Linux', 'V3_OWNED_QA_SESSION': '1'}
    if platform.system() != 'Linux' or platform.machine() not in {'x86_64', 'aarch64'} or any(os.environ.get(k) != v for k, v in expected.items()):
        raise SessionError('OWNED_HOSTED_LINUX_SESSION_REQUIRED')
    if not re.fullmatch(r'(?:unix)?:[0-9]{1,5}(?:\.[0-9]{1,3})?', os.environ.get('DISPLAY', '')):
        raise SessionError('LOCAL_XVFB_DISPLAY_REQUIRED')


def parse_unix_address(address):
    if not isinstance(address, str) or len(address) > 1024:
        raise SessionError('LOCAL_UNIX_BUS_REQUIRED')
    match = re.fullmatch(r'unix:(path|abstract)=([^;,\r\n]+)(?:,guid=[0-9a-f]{32})?', address)
    if not match or re.search(r'%(?![0-9a-fA-F]{2})', match[2]): raise SessionError('LOCAL_UNIX_BUS_REQUIRED')
    value = unquote(match[2], encoding='utf-8', errors='strict')
    if not value or any(ord(c) < 32 for c in value) or (match[1] == 'path' and not value.startswith('/')):
        raise SessionError('LOCAL_UNIX_BUS_REQUIRED')
    return value if match[1] == 'path' else '\0' + value


def validate_peer(pid, uid, runner_uid):
    if type(pid) is not int or pid <= 0 or type(uid) is not int or uid != runner_uid:
        raise SessionError('BUS_DAEMON_OWNER_MISMATCH')


def peer_credentials(address):
    endpoint = parse_unix_address(address)
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
        connection.settimeout(2)
        connection.connect(endpoint)
        pid, uid, _gid = struct.unpack('3i', connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize('3i')))
    validate_peer(pid, uid, os.getuid())
    return pid, uid


def process_parent(pid):
    data = (Path('/proc') / str(pid) / 'stat').read_text(encoding='ascii')
    return int(data[data.rfind(')') + 2:].split()[1])


def classify_session_scope(*, daemon_exe, launcher_exe, launcher_pid, ancestors):
    if daemon_exe != 'dbus-daemon' or launcher_exe != 'dbus-run-session' or launcher_pid not in ancestors:
        raise SessionError('FRESH_DBUS_RUN_SESSION_REQUIRED')


def validate_fresh_session_daemon(pid):
    daemon = Path('/proc') / str(pid)
    launcher_pid = process_parent(pid)
    launcher = Path('/proc') / str(launcher_pid)
    if daemon.stat().st_uid != os.getuid() or launcher.stat().st_uid != os.getuid():
        raise SessionError('BUS_DAEMON_OWNER_MISMATCH')
    ancestors, current = set(), os.getpid()
    for _ in range(64):
        if current <= 1 or current in ancestors: break
        ancestors.add(current)
        current = process_parent(current)
    classify_session_scope(daemon_exe=(daemon / 'exe').resolve(strict=True).name,
        launcher_exe=(launcher / 'exe').resolve(strict=True).name, launcher_pid=launcher_pid, ancestors=ancestors)


def safe_receipt(session_guid, a11y_guid, session_uid, a11y_uid, launcher_uid, registry_uid):
    if any(not isinstance(guid, str) or not re.fullmatch('[0-9a-f]{32}', guid) for guid in [session_guid, a11y_guid]):
        raise SessionError('BUS_GUID_INVALID')
    if session_guid == a11y_guid or any(type(uid) is not int or uid < 0 for uid in [session_uid, a11y_uid, launcher_uid, registry_uid]):
        raise SessionError('BUS_IDENTITY_INVALID')
    return dict(schema=1, status='OWNED_ATSPI_SESSION_READY', scope='owned ephemeral dbus-run-session and Xvfb only',
        session_bus_guid_sha256=hashlib.sha256(session_guid.encode('ascii')).hexdigest(),
        accessibility_bus_guid_sha256=hashlib.sha256(a11y_guid.encode('ascii')).hexdigest(),
        session_daemon_uid=session_uid, accessibility_daemon_uid=a11y_uid, launcher_uid=launcher_uid, registry_uid=registry_uid,
        activation=['owned session org.a11y.Bus.GetAddress', 'owned accessibility org.freedesktop.DBus.Peer.Ping'],
        app_environment_scope='AT_SPI_BUS_ADDRESS binding and removal of NO_AT_BRIDGE in app/worker environment only',
        qualification_claim='NONE; actual installed process and displayed source-offer UI remain separately required')


def make_app_environment(original, address):
    parse_unix_address(address)
    result = dict(original)
    result['AT_SPI_BUS_ADDRESS'] = address
    result.pop('NO_AT_BRIDGE', None)
    return result


def activate_owned_session():
    require_owned_host()
    session_address = os.environ.get('DBUS_SESSION_BUS_ADDRESS', '')
    session_pid, session_uid = peer_credentials(session_address)
    validate_fresh_session_daemon(session_pid)
    # All host/marker/local-socket/UID/fresh-ancestor guards precede GI and the
    # first activatable D-Bus method. No global bus API/cache is used.
    import gi
    gi.require_version('Gio', '2.0')
    from gi.repository import Gio, GLib
    flags = Gio.DBusConnectionFlags.AUTHENTICATION_CLIENT | Gio.DBusConnectionFlags.MESSAGE_BUS_CONNECTION
    session = Gio.DBusConnection.new_for_address_sync(session_address, flags, None, None)
    def call(bus, destination, path, interface, method, parameters=None, activate=False):
        mode = Gio.DBusCallFlags.NONE if activate else Gio.DBusCallFlags.NO_AUTO_START
        return bus.call_sync(destination, path, interface, method, parameters, None, mode, 3000, None).unpack()
    def owner_uid(bus, name):
        value = call(bus, 'org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus',
                     'GetConnectionUnixUser', GLib.Variant('(s)', (name,)))[0]
        if type(value) is not int or value != os.getuid(): raise SessionError('SERVICE_OWNER_MISMATCH')
        return value
    # Explicit root-authorized activation, only on the verified fresh QA bus.
    address = call(session, 'org.a11y.Bus', '/org/a11y/bus', 'org.a11y.Bus', 'GetAddress', activate=True)[0]
    launcher_uid = owner_uid(session, 'org.a11y.Bus')
    _a11y_pid, a11y_uid = peer_credentials(address)
    accessibility = Gio.DBusConnection.new_for_address_sync(address, flags, None, None)
    call(accessibility, 'org.a11y.atspi.Registry', '/org/a11y/atspi/registry', 'org.freedesktop.DBus.Peer', 'Ping', activate=True)
    registry_uid = owner_uid(accessibility, 'org.a11y.atspi.Registry')
    # Bind only this QA worker. No D-Bus activation-environment update or
    # gsettings/dconf/toolkit preference write is performed.
    os.environ['AT_SPI_BUS_ADDRESS'] = address
    os.environ.pop('NO_AT_BRIDGE', None)
    final_pid, final_uid = peer_credentials(session_address)
    if (final_pid, final_uid) != (session_pid, session_uid): raise SessionError('SESSION_DAEMON_CHANGED')
    validate_fresh_session_daemon(final_pid)
    session_guid, a11y_guid = session.get_guid(), accessibility.get_guid()
    safe_receipt(session_guid, a11y_guid, session_uid, a11y_uid, launcher_uid, registry_uid)
    return dict(address=address, session_guid=session_guid, a11y_guid=a11y_guid,
                session_uid=session_uid, a11y_uid=a11y_uid, launcher_uid=launcher_uid, registry_uid=registry_uid)


def validate_evidence(evidence_path):
    evidence = Path(evidence_path).absolute()
    if evidence.is_symlink() or not evidence.is_dir(): raise SessionError('EVIDENCE_PATH_INVALID')
    evidence = evidence.resolve(strict=True)
    roots = [Path(os.environ[name]).resolve(strict=True) for name in ['RUNNER_TEMP', 'GITHUB_WORKSPACE']]
    if evidence in roots or not any(evidence.is_relative_to(root) for root in roots): raise SessionError('EVIDENCE_PATH_INVALID')
    output = evidence / 'linux-owned-atspi-session.json'
    if output.exists() or output.is_symlink(): raise SessionError('EVIDENCE_ALREADY_EXISTS')
    return output


def prepare_owned_session(evidence_path):
    """Return app environment; private addresses never enter stdout or receipt."""
    require_owned_host()
    # Guard in parent too; the distro-Python worker repeats before activation.
    session_pid, _uid = peer_credentials(os.environ.get('DBUS_SESSION_BUS_ADDRESS', ''))
    validate_fresh_session_daemon(session_pid)
    output = validate_evidence(evidence_path)
    read_fd, write_fd = os.pipe()
    try:
        result = subprocess.run(['/usr/bin/python3', '-I', str(Path(__file__).resolve()), '--worker', '--result-fd', str(write_fd)],
                                pass_fds=(write_fd,), capture_output=True, timeout=20)
        os.close(write_fd)
        write_fd = None
        with os.fdopen(read_fd, 'rb') as stream:
            read_fd = None
            data = stream.read(4097)
        if result.returncode or len(data) > 4096: raise SessionError('OWNED_ATSPI_SETUP_FAILED')
        value = json.loads(data)
        keys = {'address', 'session_guid', 'a11y_guid', 'session_uid', 'a11y_uid', 'launcher_uid', 'registry_uid'}
        if not isinstance(value, dict) or set(value) != keys: raise SessionError('WORKER_OUTPUT_INVALID')
        if any(type(value[name]) is not int or value[name] != os.getuid() for name in ['session_uid', 'a11y_uid', 'launcher_uid', 'registry_uid']):
            raise SessionError('WORKER_OWNER_MISMATCH')
        environment = make_app_environment(os.environ, value['address'])
        receipt = safe_receipt(value['session_guid'], value['a11y_guid'], value['session_uid'], value['a11y_uid'], value['launcher_uid'], value['registry_uid'])
        with output.open('x', encoding='utf-8') as stream: stream.write(json.dumps(receipt, indent=2) + '\n')
        output.chmod(0o600)
        return environment
    finally:
        if write_fd is not None: os.close(write_fd)
        if read_fd is not None: os.close(read_fd)


class SafeParser(argparse.ArgumentParser):
    def error(self, _message): raise SessionError('INVALID_ARGUMENTS')


def main(argv=None):
    try:
        parser = SafeParser(description=__doc__, add_help=False)
        parser.add_argument('--evidence-dir')
        parser.add_argument('--worker', action='store_true')
        parser.add_argument('--result-fd', type=int)
        args = parser.parse_args(argv)
        if args.worker:
            if args.result_fd is None or args.result_fd < 3 or not stat.S_ISFIFO(os.fstat(args.result_fd).st_mode):
                raise SessionError('PRIVATE_RESULT_PIPE_REQUIRED')
            value = activate_owned_session()
            data = json.dumps(value).encode('utf-8')
            if len(data) > 4096: raise SessionError('WORKER_OUTPUT_INVALID')
            with os.fdopen(args.result_fd, 'wb') as pipe: pipe.write(data)
        else:
            if not args.evidence_dir or args.result_fd is not None: raise SessionError('INVALID_ARGUMENTS')
            prepare_owned_session(args.evidence_dir)
            print(json.dumps({'status': 'OWNED_ATSPI_SESSION_READY', 'receipt': 'linux-owned-atspi-session.json'}))
        return 0
    except Exception as error:
        code = str(error) if isinstance(error, SessionError) and re.fullmatch('[A-Z_]+', str(error)) else 'OWNED_ATSPI_SETUP_FAILED'
        print(json.dumps({'status': 'OWNED_ATSPI_SESSION_FAILED', 'code': code}), file=sys.stderr)
        return 1


if __name__ == '__main__': raise SystemExit(main())
