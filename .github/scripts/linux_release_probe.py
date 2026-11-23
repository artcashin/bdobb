"""Bounded installed-Linux source-offer UI observer; never enables accessibility."""
import argparse
from collections import deque
import ctypes
import ctypes.util
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import platform
import re
import stat
import struct
import subprocess
import sys
import time

SOURCE = 'de25611461ad0559ce237c4f59b812decd91dec1'
OFFER = '19c760a782e0ab84152ee990e8f9014f7e677f448bc58d6a3e548d8f485f1c6b'
EXPECTED_TEXT = 'Download the corresponding source for v3.0.0 (GNU AGPL v3).'
MAX_NODES = 256
MAX_HELP_CANDIDATES = 8
MAX_FOREIGN_SKIPS = MAX_NODES * 33
MAX_FOREIGN_PROCESSES = 8
MAX_ANCESTRY_DEPTH = 16
GAPS = {'GAP_SYSTEM_PYATSPI_UNAVAILABLE', 'GAP_SESSION_UNAVAILABLE', 'GAP_EXISTING_A11Y_BUS_UNAVAILABLE',
        'GAP_EXISTING_ATSPI_REGISTRY_UNAVAILABLE', 'GAP_OWNED_APPLICATION_UNAVAILABLE', 'GAP_HELP_CONTROL_UNAVAILABLE',
        'GAP_HELP_ACTION_UNAVAILABLE', 'GAP_SOURCE_CONTROL_UNAVAILABLE', 'GAP_SOURCE_RELEASE_TEXT_UNAVAILABLE',
        'GAP_HOVER_OWNERSHIP_UNCONFIRMED', 'GAP_NATIVE_API_UNAVAILABLE', 'GAP_TRAVERSAL_BUDGET',
        'GAP_PROBE_TIMEOUT', 'GAP_PROBE_FAILED', 'GAP_PROBE_OUTPUT_INVALID', 'GAP_OWNED_TOOLTIP_UNAVAILABLE',
        'GAP_WEBKIT_PID_UNRESOLVED', 'GAP_WEBKIT_PROC_UNAVAILABLE', 'GAP_WEBKIT_UID_MISMATCH',
        'GAP_WEBKIT_PID_NAMESPACE_MISMATCH', 'GAP_WEBKIT_EXECUTABLE_UNAPPROVED', 'GAP_WEBKIT_NATIVE_ARCH_MISMATCH',
        'GAP_WEBKIT_NOT_OWNED_DESCENDANT', 'GAP_WEBKIT_ANCESTRY_BUDGET', 'GAP_WEBKIT_PROCESS_CHANGED',
        'GAP_WEBKIT_PROOF_CONTEXT_UNAVAILABLE'}
ERRORS = {'ERROR_HOST_GUARD', 'ERROR_PROCESS_IDENTITY', 'ERROR_EXECUTABLE_SHA', 'ERROR_NATIVE_ARCHITECTURE',
          'ERROR_INSTALLED_PATH_REQUIRED', 'ERROR_EVIDENCE_PATH', 'ERROR_ARGUMENTS'}
FLAGS = ('owned_application', 'source_showing', 'description_exact', 'hovered_owned_window',
         'tooltip_showing', 'tooltip_exact', 'cursor_restored')
CLEANUPS = {'NOT_OPENED', 'HELP_TOGGLE_CLOSED', 'HELP_CLOSE_UNAVAILABLE'}


class ProbeError(Exception):
    """Static status code only."""


def base_observation(status):
    return dict(status=status, release=None, accessible_release_observed=False, displayed_release_observed=False,
                native_about='NOT_OBSERVED', scope='Frontend source-offer release text; does not establish native About version')


HOVER_STAGES = {'NOT_ATTEMPTED','COMPONENT_BOUNDS','MAIN_WINDOW_GEOMETRY','SAVE_POINTER','MOVE_POINTER','POINTER_MAIN_PID','FINAL_POINTER_MAIN_PID','FINAL_HELP_CENTER','CLICKED'}


def empty_hover_diagnostics():
    return dict(stage='NOT_ATTEMPTED', component_bounds=None, main_windows_count=0, main_window_geometry_matched=False,
                matched_main_window_id=None, pointer_window_id=None, pointer_pid_available=None, pointer_main_pid_matches=None, pointer_matches_help_center=None, pointer_moved=False, cursor_restored=False, native_pointer_window_id=None, native_cursor_matches=None, native_hit_proven=None, recentered=False)


def valid_hover_diagnostics(value):
    if not isinstance(value, dict) or set(value) != set(empty_hover_diagnostics()): return False
    if value['stage'] not in HOVER_STAGES or type(value['main_windows_count']) is not int or not 0 <= value['main_windows_count'] <= 16: return False
    box = value['component_bounds']
    if box is not None and (not isinstance(box,list) or len(box) != 4 or any(type(n) is not int or not -(2**31) <= n < 2**31 for n in box)): return False
    if any(type(value[k]) is not bool for k in ['main_window_geometry_matched','pointer_moved','cursor_restored','recentered']): return False
    if any(value[k] is not None and (type(value[k]) is not int or not 0 <= value[k] < 2**63) for k in ['matched_main_window_id','pointer_window_id','native_pointer_window_id']): return False
    return all(value[k] is None or type(value[k]) is bool for k in ['pointer_pid_available','pointer_main_pid_matches','pointer_matches_help_center','native_cursor_matches','native_hit_proven'])


def valid_help_actions(rows):
    if not isinstance(rows, list) or len(rows) > 2: return False
    for row in rows:
        if not isinstance(row, dict) or set(row) != {'count', 'known_names', 'unknown_names', 'returned', 'method', 'pointer_restored', 'hover'}: return False
        if not valid_hover_diagnostics(row['hover']): return False
        if row['count'] is not None and (type(row['count']) is not int or not 0 <= row['count'] <= 4): return False
        if not isinstance(row['known_names'], list) or len(row['known_names']) > 3 or any(name not in {'click','press','activate'} for name in row['known_names']): return False
        if type(row['unknown_names']) is not bool or type(row['pointer_restored']) is not bool: return False
        if row['returned'] is not None and type(row['returned']) is not bool: return False
        if row['method'] not in {'NOT_OPENED','AT_SPI_ACTION','OWNED_POINTER_CLICK'}: return False
    return True


def valid_help_diagnostics(value):
    if not isinstance(value, dict) or set(value) != {'exact_help_candidates', 'candidates_truncated', 'matched_help_role_code', 'foreign_nodes_skipped', 'nodes_visited', 'foreign_processes', 'foreign_processes_truncated', 'help_actions'}:
        return False
    if not valid_help_actions(value['help_actions']): return False
    if not valid_foreign_diagnostics(value['foreign_processes']) or type(value['foreign_processes_truncated']) is not bool: return False
    if type(value['candidates_truncated']) is not bool or type(value['nodes_visited']) is not int or not 0 <= value['nodes_visited'] <= MAX_NODES:
        return False
    if type(value['foreign_nodes_skipped']) is not int or not 0 <= value['foreign_nodes_skipped'] <= MAX_FOREIGN_SKIPS:
        return False
    matched = value['matched_help_role_code']
    if matched is not None and (type(matched) is not int or not 0 <= matched <= 4096): return False
    rows = value['exact_help_candidates']
    if not isinstance(rows, list) or len(rows) > MAX_HELP_CANDIDATES: return False
    for row in rows:
        if not isinstance(row, dict) or set(row) != {'role_code', 'owned', 'visible'} or type(row['role_code']) is not int or not 0 <= row['role_code'] <= 4096:
            return False
        if row['owned'] is not True or type(row['visible']) is not bool: return False
    return matched is None or value['candidates_truncated'] or any(row['role_code'] == matched and row['visible'] for row in rows)


def classify_observation(value):
    invalid = base_observation('GAP_PROBE_OUTPUT_INVALID')
    if not isinstance(value, dict): return invalid
    status = value.get('status')
    if status in GAPS | ERRORS and set(value) == {'status'}: return base_observation(status)
    if status != 'AT_SPI_PROBE_COMPLETE' or set(value) != {'status', 'nodes_visited', 'help_cleanup', 'attempt', 'help_diagnostics', *FLAGS}: return invalid
    if any(type(value[key]) is not bool for key in FLAGS): return invalid
    if type(value['nodes_visited']) is not int or not 0 <= value['nodes_visited'] <= MAX_NODES or value['help_cleanup'] not in CLEANUPS or value['attempt'] not in GAPS: return invalid
    if not valid_help_diagnostics(value['help_diagnostics']) or value['help_diagnostics']['nodes_visited'] != value['nodes_visited']: return invalid
    accessible = value['owned_application'] and value['source_showing'] and value['description_exact']
    displayed = value['owned_application'] and value['source_showing'] and value['hovered_owned_window'] and value['tooltip_showing'] and value['tooltip_exact']
    if (accessible or displayed) and value['help_diagnostics']['matched_help_role_code'] is None: return invalid
    result = base_observation('OBSERVED_OWNED_TOOLTIP' if displayed else 'OBSERVED_ATSPI_DESCRIPTION' if accessible else value['attempt'])
    result.update(release='3.0.0' if accessible or displayed else None,
                  accessible_release_observed=accessible, displayed_release_observed=displayed,
                  nodes_visited=value['nodes_visited'], help_cleanup=value['help_cleanup'], cursor_restored=value['cursor_restored'], attempt=value['attempt'],
                  help_diagnostics=value['help_diagnostics'])
    return result


def require_host(expected_arch):
    if expected_arch not in {'x86_64', 'aarch64'} or platform.system() != 'Linux' or platform.machine() != expected_arch or any(
        os.environ.get(key) != value for key, value in {'GITHUB_ACTIONS': 'true', 'RUNNER_ENVIRONMENT': 'github-hosted', 'RUNNER_OS': 'Linux'}.items()):
        raise ProbeError('ERROR_HOST_GUARD')


def file_hash(path):
    with os.fdopen(os.open(path, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0)), 'rb') as stream:
        if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode): raise ProbeError('ERROR_PROCESS_IDENTITY')
        # Ubuntu 22.04's system Python is 3.10; file_digest requires 3.11.
        digest = hashlib.sha256()
        for chunk in iter(lambda: stream.read(1024 * 1024), b''): digest.update(chunk)
        return digest.hexdigest()


def validate_executable(path, sha, arch):
    if path.is_symlink() or not re.fullmatch('[0-9a-f]{64}', sha) or file_hash(path) != sha: raise ProbeError('ERROR_EXECUTABLE_SHA')
    with path.open('rb') as stream: header = stream.read(64)
    if len(header) != 64 or header[:6] != b'\x7fELF\x02\x01' or struct.unpack_from('<H', header, 18)[0] != {'x86_64': 62, 'aarch64': 183}[arch]:
        raise ProbeError('ERROR_NATIVE_ARCHITECTURE')


def validate_process(args):
    require_host(args.expected_arch)
    executable = Path(args.executable).absolute()
    if executable != Path('/usr/bin/bdobb'): raise ProbeError('ERROR_INSTALLED_PATH_REQUIRED')
    validate_executable(executable, args.sha256, args.expected_arch)
    proc = Path('/proc') / str(args.pid)
    if args.pid <= 0 or proc.stat().st_uid != os.getuid() or (proc / 'exe').resolve(strict=True) != executable:
        raise ProbeError('ERROR_PROCESS_IDENTITY')
    actual = read_executable_record(proc / 'exe', proc_magic=True)
    expected = read_executable_record(executable)
    if (actual['exe_dev'], actual['exe_ino']) != (expected['exe_dev'], expected['exe_ino']):
        raise ProbeError('ERROR_PROCESS_IDENTITY')


def valid_pid(pid):
    return type(pid) is int and 0 < pid < 2 ** 31


def foreign_diagnostic(pid):
    return dict(pid=pid if type(pid) is int and 0 <= pid < 2 ** 31 else 0, role_code=None,
                pid_valid=valid_pid(pid), status='GAP_WEBKIT_PID_UNRESOLVED', proc_uid=None, failed_ancestor_uid=None,
                same_uid=None, namespace_matches=None, known_system_webkit=False, native_arch_matches=None,
                main_ancestor_verified=False, ancestry_depth=0)


def valid_foreign_diagnostics(rows):
    if not isinstance(rows, list) or len(rows) > MAX_FOREIGN_PROCESSES: return False
    expected = set(foreign_diagnostic(0))
    for row in rows:
        if not isinstance(row, dict) or set(row) != expected: return False
        if type(row['pid']) is not int or not 0 <= row['pid'] < 2 ** 31 or type(row['pid_valid']) is not bool: return False
        if row['role_code'] is not None and (type(row['role_code']) is not int or not 0 <= row['role_code'] <= 4096): return False
        if row['status'] not in GAPS | {'PROVEN_OWNED_WEBKIT_DESCENDANT'}: return False
        if any(row[key] is not None and (type(row[key]) is not int or not 0 <= row[key] < 2 ** 32) for key in ['proc_uid', 'failed_ancestor_uid']): return False
        if any(row[key] is not None and type(row[key]) is not bool for key in ['same_uid', 'namespace_matches', 'native_arch_matches']): return False
        if any(type(row[key]) is not bool for key in ['known_system_webkit', 'main_ancestor_verified']): return False
        if type(row['ancestry_depth']) is not int or not 0 <= row['ancestry_depth'] <= MAX_ANCESTRY_DEPTH: return False
        if row['status'] == 'PROVEN_OWNED_WEBKIT_DESCENDANT' and (not row['pid_valid'] or row['proc_uid'] is None or row['failed_ancestor_uid'] is not None or row['namespace_matches'] is None or
            not all(row[key] is True for key in ['same_uid', 'known_system_webkit', 'native_arch_matches', 'main_ancestor_verified'])): return False
    return True


def current_pid_namespace():
    return os.readlink('/proc/self/ns/pid')


def read_executable_record(path, *, proc_magic=False):
    # /proc/PID/exe is a kernel magic link. Open that object directly; resolving
    # its reported pathname can inspect a different mount-namespace object.
    flags = os.O_RDONLY | (0 if proc_magic else getattr(os, 'O_NOFOLLOW', 0))
    with os.fdopen(os.open(path, flags), 'rb') as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode): raise ValueError('nonregular executable')
        header = stream.read(64)
    machine = None
    if len(header) == 64 and header[:6] == b'\x7fELF\x02\x01': machine = struct.unpack_from('<H', header, 18)[0]
    return dict(exe_uid=info.st_uid, exe_mode=stat.S_IMODE(info.st_mode), exe_dev=info.st_dev, exe_ino=info.st_ino, machine=machine)


def read_process_record(pid):
    if not valid_pid(pid): raise ValueError('invalid pid')
    root = Path('/proc') / str(pid)
    uid = root.stat().st_uid
    value = dict(pid=pid, uid=uid, ppid=0, start_time=0, exe=None, namespace=None, exe_uid=None, exe_mode=0, exe_dev=None, exe_ino=None, machine=None)
    if uid != os.getuid(): return value
    # The comm field is discarded; only bounded numeric PPid/start-time fields
    # are used. No argv, environment, process names, or UI text is retained.
    raw = (root / 'stat').read_text(encoding='utf-8')
    fields = raw[raw.rfind(')') + 2:].split()
    value.update(ppid=int(fields[1]), start_time=int(fields[19]), exe=(root / 'exe').resolve(strict=True),
                 namespace=os.readlink(root / 'ns/pid'))
    value.update(read_executable_record(root / 'exe', proc_magic=True))
    return value


def process_token(record):
    return tuple(record[key] for key in ['pid', 'uid', 'ppid', 'start_time', 'exe', 'namespace', 'exe_uid', 'exe_mode', 'exe_dev', 'exe_ino', 'machine'])


def prove_webkit_owner(pid, args):
    diagnostic = foreign_diagnostic(pid)
    proof = dict(allowed=False, diagnostic=diagnostic, identities=[])
    if not valid_pid(pid): return proof
    validate_process(args)  # Main PID/path/native architecture/SHA before proof.
    try:
        leaf = read_process_record(pid)
        diagnostic.update(proc_uid=leaf['uid'], same_uid=leaf['uid'] == os.getuid())
        if not diagnostic['same_uid']:
            diagnostic.update(status='GAP_WEBKIT_UID_MISMATCH', failed_ancestor_uid=leaf['uid'])
            return proof
        namespace = current_pid_namespace()
        diagnostic['namespace_matches'] = leaf['namespace'] == namespace
        triple = {'aarch64': 'aarch64-linux-gnu', 'x86_64': 'x86_64-linux-gnu'}[args.expected_arch]
        expected_executable = Path('/usr/lib') / triple / 'webkit2gtk-4.1/WebKitWebProcess'
        trusted = read_executable_record(expected_executable)
        diagnostic['known_system_webkit'] = (leaf['exe'] == expected_executable and leaf['exe_uid'] == 0 and leaf['exe_mode'] & 0o022 == 0
            and trusted['exe_uid'] == 0 and trusted['exe_mode'] & 0o022 == 0
            and (leaf['exe_dev'], leaf['exe_ino']) == (trusted['exe_dev'], trusted['exe_ino']))
        diagnostic['native_arch_matches'] = leaf['machine'] == {'aarch64': 183, 'x86_64': 62}[args.expected_arch]
        if not diagnostic['known_system_webkit']:
            diagnostic['status'] = 'GAP_WEBKIT_EXECUTABLE_UNAPPROVED'; return proof
        if not diagnostic['native_arch_matches']:
            diagnostic['status'] = 'GAP_WEBKIT_NATIVE_ARCH_MISMATCH'; return proof
        current, seen = leaf, set()
        for depth in range(MAX_ANCESTRY_DEPTH + 1):
            diagnostic['ancestry_depth'] = depth
            if current['pid'] in seen:
                diagnostic['status'] = 'GAP_WEBKIT_NOT_OWNED_DESCENDANT'; return proof
            seen.add(current['pid'])
            if current['uid'] != os.getuid():
                diagnostic.update(status='GAP_WEBKIT_UID_MISMATCH', same_uid=False, failed_ancestor_uid=current['uid']); return proof
            # Sandbox namespaces can differ even for a proven host PID. This
            # is diagnostic only; host /proc identity and exact ancestry decide.
            if current['namespace'] != namespace: diagnostic['namespace_matches'] = False
            proof['identities'].append(process_token(current))
            if current['pid'] == args.pid:
                if current['exe'] != Path(args.executable):
                    raise ProbeError('ERROR_PROCESS_IDENTITY')
                validate_process(args)  # SHA/path and all chain UIDs rechecked.
                for identity in proof['identities']:
                    if process_token(read_process_record(identity[0])) != identity:
                        diagnostic['status'] = 'GAP_WEBKIT_PROCESS_CHANGED'; return proof
                diagnostic.update(status='PROVEN_OWNED_WEBKIT_DESCENDANT', main_ancestor_verified=True)
                proof['allowed'] = True
                return proof
            if not valid_pid(current['ppid']) or current['ppid'] == 1:
                diagnostic['status'] = 'GAP_WEBKIT_NOT_OWNED_DESCENDANT'; return proof
            if depth == MAX_ANCESTRY_DEPTH:
                diagnostic['status'] = 'GAP_WEBKIT_ANCESTRY_BUDGET'; return proof
            current = read_process_record(current['ppid'])
    except ProbeError: raise
    except (OSError, ValueError, KeyError, IndexError, TypeError):
        diagnostic['status'] = 'GAP_WEBKIT_PROC_UNAVAILABLE'
    return proof


def cached_webkit_identity_matches(proof):
    try:
        return proof['allowed'] and all(process_token(read_process_record(identity[0])) == identity for identity in proof['identities'])
    except (OSError, ValueError, KeyError, IndexError, TypeError): return False


def local_bus_address(address):
    if not isinstance(address, str) or len(address) > 4096 or not re.fullmatch(r'unix:(?:path=/[^;,\r\n]+|abstract=[^;,\r\n]+)(?:,guid=[0-9a-f]{32})?', address):
        raise ProbeError('GAP_EXISTING_A11Y_BUS_UNAVAILABLE')
    return address


def local_display(display):
    if not isinstance(display, str) or not re.fullmatch(r'(?:unix)?:[0-9]{1,5}(?:\.[0-9]{1,3})?', display):
        raise ProbeError('GAP_SESSION_UNAVAILABLE')
    return display


def existing_x11_bus_address():
    """Read AT_SPI_BUS with XGetWindowProperty; never call a bus launcher."""
    library = ctypes.util.find_library('X11')
    if not library: raise ProbeError('GAP_EXISTING_A11Y_BUS_UNAVAILABLE')
    x11 = ctypes.CDLL(library)
    display_type, atom_type = ctypes.c_void_p, ctypes.c_ulong
    x11.XOpenDisplay.argtypes, x11.XOpenDisplay.restype = [ctypes.c_char_p], display_type
    x11.XDefaultRootWindow.argtypes, x11.XDefaultRootWindow.restype = [display_type], ctypes.c_ulong
    x11.XInternAtom.argtypes, x11.XInternAtom.restype = [display_type, ctypes.c_char_p, ctypes.c_int], atom_type
    x11.XGetWindowProperty.argtypes = [display_type, ctypes.c_ulong, atom_type, ctypes.c_long, ctypes.c_long, ctypes.c_int, atom_type,
        ctypes.POINTER(atom_type), ctypes.POINTER(ctypes.c_int), ctypes.POINTER(ctypes.c_ulong), ctypes.POINTER(ctypes.c_ulong), ctypes.POINTER(ctypes.POINTER(ctypes.c_ubyte))]
    x11.XGetWindowProperty.restype = ctypes.c_int
    x11.XFree.argtypes, x11.XFree.restype = [ctypes.c_void_p], ctypes.c_int
    x11.XCloseDisplay.argtypes, x11.XCloseDisplay.restype = [display_type], ctypes.c_int
    display = x11.XOpenDisplay(None)
    if not display: raise ProbeError('GAP_EXISTING_A11Y_BUS_UNAVAILABLE')
    data = ctypes.POINTER(ctypes.c_ubyte)()
    try:
        atom = x11.XInternAtom(display, b'AT_SPI_BUS', True)
        if not atom: raise ProbeError('GAP_EXISTING_A11Y_BUS_UNAVAILABLE')
        kind, encoding = atom_type(), ctypes.c_int()
        count, remaining = ctypes.c_ulong(), ctypes.c_ulong()
        status = x11.XGetWindowProperty(display, x11.XDefaultRootWindow(display), atom, 0, 1024, False, 31,
            ctypes.byref(kind), ctypes.byref(encoding), ctypes.byref(count), ctypes.byref(remaining), ctypes.byref(data))
        if status or kind.value != 31 or encoding.value != 8 or not 0 < count.value <= 4096 or remaining.value:
            raise ProbeError('GAP_EXISTING_A11Y_BUS_UNAVAILABLE')
        return local_bus_address(ctypes.string_at(data, count.value).decode('ascii'))
    finally:
        if data: x11.XFree(data)
        x11.XCloseDisplay(display)


def existing_accessibility_bus():
    """Read existing bus ownership only; no launcher GetAddress or property writes."""
    if not os.environ.get('DBUS_SESSION_BUS_ADDRESS') or not os.environ.get('DISPLAY'): raise ProbeError('GAP_SESSION_UNAVAILABLE')
    local_display(os.environ['DISPLAY'])
    local_bus_address(os.environ['DBUS_SESSION_BUS_ADDRESS'])
    address = local_bus_address(os.environ['AT_SPI_BUS_ADDRESS']) if os.environ.get('AT_SPI_BUS_ADDRESS') else existing_x11_bus_address()
    import gi
    gi.require_version('Gio', '2.0')
    from gi.repository import Gio, GLib
    connection = Gio.bus_get_sync(Gio.BusType.SESSION, None)
    def call(bus, destination, path, interface, method, parameters):
        return bus.call_sync(destination, path, interface, method, parameters, None, Gio.DBusCallFlags.NO_AUTO_START, 800, None).unpack()
    def has_owner(bus, name):
        return call(bus, 'org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus', 'NameHasOwner', GLib.Variant('(s)', (name,)))[0] is True
    if not has_owner(connection, 'org.a11y.Bus'): raise ProbeError('GAP_EXISTING_A11Y_BUS_UNAVAILABLE')
    accessibility = Gio.DBusConnection.new_for_address_sync(address,
        Gio.DBusConnectionFlags.AUTHENTICATION_CLIENT | Gio.DBusConnectionFlags.MESSAGE_BUS_CONNECTION, None, None)
    if not has_owner(accessibility, 'org.a11y.atspi.Registry'): raise ProbeError('GAP_EXISTING_ATSPI_REGISTRY_UNAVAILABLE')
    # Client-only binding to a verified existing local socket. This does not
    # enable a toolkit or accessibility service and prevents discovery fallback.
    os.environ['AT_SPI_BUS_ADDRESS'] = address
    # Keep the read-only connections alive while AT-SPI queries that same bus.
    return connection, accessibility


class Tree:
    def __init__(self, api, pid, args=None):
        self.api, self.pid = api, pid
        self.args, self.foreign_processes, self.foreign_processes_truncated = args, {}, False
        self.deadline, self.visited = time.monotonic() + 8, 0
        self.foreign_skipped, self.help_candidates, self.help_actions = 0, [], []
        self.help_candidates_truncated, self.matched_help_role_code = False, None

    def help_diagnostics(self):
        return dict(exact_help_candidates=list(self.help_candidates), candidates_truncated=self.help_candidates_truncated,
                    matched_help_role_code=self.matched_help_role_code, foreign_nodes_skipped=self.foreign_skipped, nodes_visited=self.visited,
                    foreign_processes=[dict(proof['diagnostic']) for proof in self.foreign_processes.values()], foreign_processes_truncated=self.foreign_processes_truncated, help_actions=list(self.help_actions))

    def record_help(self, role, visible):
        row = dict(role_code=role, owned=True, visible=visible)
        if len(self.help_candidates) < MAX_HELP_CANDIDATES: self.help_candidates.append(row)
        else: self.help_candidates_truncated = True

    def budget(self):
        if time.monotonic() >= self.deadline: raise ProbeError('GAP_PROBE_TIMEOUT')
        if self.visited >= MAX_NODES: raise ProbeError('GAP_TRAVERSAL_BUDGET')

    def owned(self, node):
        self.budget()
        if node is None: return False
        pid = node.get_process_id()
        if type(pid) is int and pid == self.pid: return True
        key = pid if type(pid) is int else None
        if key not in self.foreign_processes:
            if len(self.foreign_processes) >= MAX_FOREIGN_PROCESSES:
                self.foreign_processes_truncated = True
                return False
            if self.args is None:
                proof = dict(allowed=False, diagnostic=foreign_diagnostic(pid), identities=[])
                proof['diagnostic']['status'] = 'GAP_WEBKIT_PROOF_CONTEXT_UNAVAILABLE'
            else: proof = prove_webkit_owner(pid, self.args)
            try: proof['diagnostic']['role_code'] = role_code(node.getRole())
            except Exception: pass  # Numeric role only; no foreign text is read.
            self.foreign_processes[key] = proof
        proof = self.foreign_processes[key]
        if proof['allowed']:
            if cached_webkit_identity_matches(proof): return True
            proof['allowed'] = False
            proof['diagnostic'].update(status='GAP_WEBKIT_PROCESS_CHANGED', main_ancestor_verified=False)
        if self.foreign_skipped >= MAX_FOREIGN_SKIPS: raise ProbeError('GAP_TRAVERSAL_BUDGET')
        self.foreign_skipped += 1
        return False

    def recheck_owner(self, node, args):
        pid = node.get_process_id()
        if type(pid) is int and pid == self.pid:
            validate_process(args); return
        proof = prove_webkit_owner(pid, args)
        key = pid if type(pid) is int else None
        if key in self.foreign_processes:
            proof['diagnostic']['role_code'] = self.foreign_processes[key]['diagnostic']['role_code']
            self.foreign_processes[key] = proof
        if not proof['allowed']: raise ProbeError(proof['diagnostic']['status'])

    def visible(self, node):
        if not self.owned(node): return False
        states = node.getState()
        return states.contains(self.api.STATE_SHOWING) and states.contains(self.api.STATE_VISIBLE)

    def children(self, node):
        self.budget()
        count = node.childCount
        if not 0 <= count <= 32: raise ProbeError('GAP_TRAVERSAL_BUDGET')
        return [node.getChildAtIndex(index) for index in range(count)]

    def find(self, root, predicate):
        queue = deque([root])
        seen = set()
        while queue:
            self.budget()
            node = queue.popleft()
            if not self.owned(node): continue
            # pyatspi's accessible wrapper is hashable by its DBus object identity.
            if node in seen: continue
            seen.add(node)
            self.visited += 1
            if predicate(node): return node
            queue.extend(self.children(node))
            if len(queue) > MAX_NODES: raise ProbeError('GAP_TRAVERSAL_BUDGET')
        return None


def xdo(*arguments):
    result = subprocess.run(['/usr/bin/xdotool', *map(str, arguments)], capture_output=True, text=True, timeout=1)
    if result.returncode: raise ProbeError('GAP_HOVER_OWNERSHIP_UNCONFIRMED')
    return result.stdout


def numeric_fields(text, required):
    values = {}
    for line in text.splitlines():
        if '=' not in line: continue
        key, value = line.split('=', 1)
        if key in required:
            if not re.fullmatch('-?[0-9]{1,10}', value): raise ProbeError('GAP_HOVER_OWNERSHIP_UNCONFIRMED')
            values[key] = int(value)
    if set(values) != set(required): raise ProbeError('GAP_HOVER_OWNERSHIP_UNCONFIRMED')
    return values


def owned_component_center(node, tree, diagnostic=None):
    if not tree.visible(node): raise ProbeError('GAP_HOVER_OWNERSHIP_UNCONFIRMED')
    box = node.queryComponent().getExtents(tree.api.XY_SCREEN)
    if diagnostic is not None:
        values = [int(box.x),int(box.y),int(box.width),int(box.height)]
        diagnostic['component_bounds'] = values if all(-(2**31) <= n < 2**31 for n in values) else None
    if not 0 < box.width <= 20000 or not 0 < box.height <= 20000: raise ProbeError('GAP_HOVER_OWNERSHIP_UNCONFIRMED')
    return box.x + box.width // 2, box.y + box.height // 2


def hover_owned(source, tree, args, *, diagnostic=None):
    if diagnostic is None: diagnostic = empty_hover_diagnostics()
    diagnostic['stage'] = 'COMPONENT_BOUNDS'
    x, y = owned_component_center(source, tree, diagnostic)
    diagnostic['stage'] = 'MAIN_WINDOW_GEOMETRY'
    windows = xdo('search', '--onlyvisible', '--pid', args.pid).splitlines()
    diagnostic['main_windows_count'] = min(len(windows),16)
    matched = False
    for window in windows[:16]:
        if not re.fullmatch('[0-9]{1,20}', window): raise ProbeError('GAP_HOVER_OWNERSHIP_UNCONFIRMED')
        if xdo('getwindowpid', window).strip() != str(args.pid): continue
        geometry = numeric_fields(xdo('getwindowgeometry', '--shell', window), {'X', 'Y', 'WIDTH', 'HEIGHT'})
        if geometry['X'] <= x < geometry['X'] + geometry['WIDTH'] and geometry['Y'] <= y < geometry['Y'] + geometry['HEIGHT']:
            matched = True
            diagnostic.update(main_window_geometry_matched=True, matched_main_window_id=int(window))
            break
    if not matched: raise ProbeError('GAP_HOVER_OWNERSHIP_UNCONFIRMED')
    diagnostic['stage'] = 'SAVE_POINTER'
    saved = numeric_fields(xdo('getmouselocation', '--shell'), {'X', 'Y', 'WINDOW'})
    validate_process(args)
    tree.recheck_owner(source, args)
    diagnostic['stage'] = 'MOVE_POINTER'
    xdo('mousemove', '--sync', x, y)
    diagnostic['pointer_moved'] = True
    try:
        actual = numeric_fields(xdo('getmouselocation', '--shell'), {'X', 'Y', 'WINDOW'})
        diagnostic['stage'] = 'POINTER_MAIN_PID'
        check_pointer_main_pid(actual, args, diagnostic)
    except Exception:
        xdo('mousemove', '--sync', saved['X'], saved['Y'])
        diagnostic['cursor_restored'] = True
        raise
    return saved


def native_x11_pointer():
    # Read the actual root child directly; xdotool's client-window lookup may
    # report zero without a window manager. No zero-ID ownership is inferred.
    local_display(os.environ.get('DISPLAY',''))
    xlib = ctypes.CDLL(ctypes.util.find_library('X11') or 'libX11.so.6')
    xlib.XOpenDisplay.argtypes, xlib.XOpenDisplay.restype = [ctypes.c_char_p], ctypes.c_void_p
    xlib.XDefaultRootWindow.argtypes, xlib.XDefaultRootWindow.restype = [ctypes.c_void_p], ctypes.c_ulong
    xlib.XQueryPointer.argtypes = [ctypes.c_void_p,ctypes.c_ulong,ctypes.POINTER(ctypes.c_ulong),ctypes.POINTER(ctypes.c_ulong),
        ctypes.POINTER(ctypes.c_int),ctypes.POINTER(ctypes.c_int),ctypes.POINTER(ctypes.c_int),ctypes.POINTER(ctypes.c_int),ctypes.POINTER(ctypes.c_uint)]
    xlib.XQueryPointer.restype = ctypes.c_int
    xlib.XCloseDisplay.argtypes, xlib.XCloseDisplay.restype = [ctypes.c_void_p], ctypes.c_int
    display = xlib.XOpenDisplay(None)
    if not display: raise ProbeError('GAP_HOVER_OWNERSHIP_UNCONFIRMED')
    try:
        root = xlib.XDefaultRootWindow(display)
        returned,child = ctypes.c_ulong(),ctypes.c_ulong()
        x,y,wx,wy,mask = ctypes.c_int(),ctypes.c_int(),ctypes.c_int(),ctypes.c_int(),ctypes.c_uint()
        if not root or not xlib.XQueryPointer(display,root,ctypes.byref(returned),ctypes.byref(child),ctypes.byref(x),ctypes.byref(y),ctypes.byref(wx),ctypes.byref(wy),ctypes.byref(mask)) or returned.value != root:
            raise ProbeError('GAP_HOVER_OWNERSHIP_UNCONFIRMED')
        return dict(X=x.value,Y=y.value,WINDOW=child.value,ROOT=root)
    finally: xlib.XCloseDisplay(display)


def check_pointer_main_pid(actual, args, diagnostic):
    diagnostic.update(pointer_window_id=actual['WINDOW'],pointer_pid_available=False,pointer_main_pid_matches=None,native_pointer_window_id=None,native_cursor_matches=None,native_hit_proven=None)
    if actual['WINDOW'] == 0:
        diagnostic.update(native_pointer_window_id=None,native_cursor_matches=None,native_hit_proven=False)
        native = native_x11_pointer()
        diagnostic['native_pointer_window_id'] = native['WINDOW']
        diagnostic['native_cursor_matches'] = (native['X'],native['Y']) == (actual['X'],actual['Y'])
        # Exact equality to the already verified containing main window is
        # required; foreign/root/unknown windows remain blocked. No tree waiver.
        if native['WINDOW'] in (0,native['ROOT']) or not diagnostic['main_window_geometry_matched'] or not diagnostic['matched_main_window_id'] or native['WINDOW'] != diagnostic['matched_main_window_id'] or not diagnostic['native_cursor_matches']:
            raise ProbeError('GAP_HOVER_OWNERSHIP_UNCONFIRMED')
        if xdo('getwindowpid',native['WINDOW']).strip() != str(args.pid): raise ProbeError('GAP_HOVER_OWNERSHIP_UNCONFIRMED')
        diagnostic['native_hit_proven'] = True
        return
    under_pid = xdo('getwindowpid', actual['WINDOW']).strip()
    diagnostic['pointer_pid_available'] = bool(re.fullmatch('[0-9]{1,10}',under_pid))
    diagnostic['pointer_main_pid_matches'] = under_pid == str(args.pid)
    if not diagnostic['pointer_main_pid_matches']: raise ProbeError('GAP_HOVER_OWNERSHIP_UNCONFIRMED')


def role_code(value):
    code = int(value)
    if not 0 <= code <= 4096: raise ProbeError('GAP_NATIVE_API_UNAVAILABLE')
    return code


def allowed_help_roles(api):
    roles = {role_code(api.ROLE_PUSH_BUTTON)}
    # Native WebKit Help aria-haspopup=menu was observed as COMBO_BOX in
    # retained ARM run45098712565. Use exported enums, never numeric fallback.
    for name in ('ROLE_PUSH_BUTTON_MENU', 'ROLE_COMBO_BOX'):
        optional = getattr(api, name, None)
        if optional is not None: roles.add(role_code(optional))
    return roles


def is_help_candidate(node, tree):
    # Ownership is checked before name/role reads; only exact Help candidates
    # contribute filtered numeric diagnostics. Unknown roles are never invoked.
    if not tree.owned(node) or node.name != 'Help': return False
    code, visible = role_code(node.getRole()), tree.visible(node)
    tree.record_help(code, visible)
    return visible and code in allowed_help_roles(tree.api)


def checked_help_role(help_button, tree):
    if not tree.visible(help_button) or help_button.name != 'Help':
        raise ProbeError('GAP_HELP_ACTION_UNAVAILABLE')
    code = role_code(help_button.getRole())
    if code not in allowed_help_roles(tree.api): raise ProbeError('GAP_HELP_ACTION_UNAVAILABLE')
    return code


def invoke_help(help_button, tree, args):
    # The only actionable element is exact owned visible Help. Source is never invoked.
    code = checked_help_role(help_button, tree)
    if not hasattr(tree, 'help_actions'): tree.help_actions = []
    if len(tree.help_actions) >= 2: raise ProbeError('GAP_TRAVERSAL_BUDGET')
    row = dict(count=None, known_names=[], unknown_names=False, returned=None, method='NOT_OPENED', pointer_restored=False, hover=empty_hover_diagnostics())
    tree.help_actions.append(row)
    try:
        action = help_button.queryAction()
        raw_count = action.nActions
        if isinstance(raw_count, bool): raise ProbeError('GAP_HELP_ACTION_UNAVAILABLE')
        count = int(raw_count)
        if not 0 <= count <= 4: raise ProbeError('GAP_HELP_ACTION_UNAVAILABLE')
        row['count'] = count
        names = [action.getName(index).lower() for index in range(count)]
        row['known_names'] = sorted(set(names) & {'click','press','activate'})
        row['unknown_names'] = any(name not in {'click','press','activate'} for name in names)
    except Exception:
        raise ProbeError('GAP_HELP_ACTION_UNAVAILABLE') from None
    for index,name in enumerate(names):
        if name in {'click','press','activate'}:
            validate_process(args)
            tree.recheck_owner(help_button, args)
            try: returned = bool(action.doAction(index))
            except Exception: raise ProbeError('GAP_HELP_ACTION_UNAVAILABLE') from None
            row['returned'] = returned
            if returned:
                row['method'] = 'AT_SPI_ACTION'
                return code
    raise ProbeError('GAP_HELP_ACTION_UNAVAILABLE')


def activate_help(help_button, tree, args):
    code = checked_help_role(help_button, tree)
    try: return invoke_help(help_button, tree, args)
    except ProbeError as error:
        if str(error) != 'GAP_HELP_ACTION_UNAVAILABLE': raise
    if os.environ.get('V3_OWNED_QA_SESSION') != '1': raise ProbeError('GAP_HELP_ACTION_UNAVAILABLE')
    # Only this exact Help control may be clicked, in the own ephemeral Xvfb.
    # hover_owned derives actual accessible bounds and verifies main-window PID.
    try: saved = hover_owned(help_button, tree, args, diagnostic=tree.help_actions[-1]['hover'])
    except Exception:
        tree.help_actions[-1]['pointer_restored'] = tree.help_actions[-1]['hover']['cursor_restored']
        raise
    try:
        # Product CSS animates rail width for 120ms. Let the own hover settle
        # before deriving the one new center; all live guards still follow.
        time.sleep(0.2)
        checked_help_role(help_button, tree)
        validate_process(args)
        tree.recheck_owner(help_button, args)
        actual = numeric_fields(xdo('getmouselocation','--shell'), {'X','Y','WINDOW'})
        hover = tree.help_actions[-1]['hover']
        hover['stage'] = 'FINAL_POINTER_MAIN_PID'
        check_pointer_main_pid(actual, args, hover)
        # A pointer/control move within this app must not redirect the click.
        checked_help_role(help_button, tree)
        hover['stage'] = 'FINAL_HELP_CENTER'
        center = owned_component_center(help_button, tree, hover)
        if (actual['X'],actual['Y']) != center:
            box = hover['component_bounds']
            # Hover can expand the same Help element. Recenter once only while
            # the current cursor still lies inside its fresh exact bounds.
            if box is None or not (box[0] <= actual['X'] < box[0]+box[2] and box[1] <= actual['Y'] < box[1]+box[3]):
                hover['pointer_matches_help_center'] = False
                raise ProbeError('GAP_HOVER_OWNERSHIP_UNCONFIRMED')
            xdo('mousemove','--sync',*center)
            hover['recentered'] = True
            validate_process(args)
            tree.recheck_owner(help_button, args)
            actual = numeric_fields(xdo('getmouselocation','--shell'), {'X','Y','WINDOW'})
            hover['stage'] = 'FINAL_POINTER_MAIN_PID'
            check_pointer_main_pid(actual,args,hover)
            checked_help_role(help_button,tree)
            hover['stage'] = 'FINAL_HELP_CENTER'
            center = owned_component_center(help_button,tree,hover)
        hover['pointer_matches_help_center'] = (actual['X'],actual['Y']) == center
        if not hover['pointer_matches_help_center']: raise ProbeError('GAP_HOVER_OWNERSHIP_UNCONFIRMED')
        xdo('click','1')
        hover['stage'] = 'CLICKED'
        tree.help_actions[-1]['method'] = 'OWNED_POINTER_CLICK'
        return code
    finally:
        xdo('mousemove','--sync',saved['X'],saved['Y'])
        tree.help_actions[-1]['pointer_restored'] = True


def tooltip_positive_visible(node, tree):
    if not tree.visible(node): return False
    try: owned_component_center(node,tree)
    except ProbeError as error:
        if str(error).startswith('ERROR_') or str(error) == 'GAP_TRAVERSAL_BUDGET': raise
        return False
    return True


def tooltip_witness(container, rendered, tree, args):
    if not tooltip_positive_visible(container,tree) or container.getRole() != tree.api.ROLE_TOOL_TIP: return False
    if not tooltip_positive_visible(rendered,tree) or rendered.name != EXPECTED_TEXT: return False
    if rendered != container:
        roles={getattr(tree.api,name,None)for name in ['ROLE_LABEL','ROLE_TEXT']}
        roles.discard(None)
        if rendered.getRole() not in roles: return False
        parent=rendered.parent
        seen=set()
        for _ in range(16):
            if parent is None or parent in seen or not tree.owned(parent): return False
            if parent == container: break
            seen.add(parent);parent=parent.parent
        else: return False
    tree.recheck_owner(container,args)
    if rendered != container: tree.recheck_owner(rendered,args)
    # Re-read visibility, actual rendered name and positive bounds after proof.
    return tooltip_positive_visible(container,tree) and tooltip_positive_visible(rendered,tree) and rendered.name == EXPECTED_TEXT


def tooltip_after_hover(app, tree, args):
    # One native hover settle and one app traversal, rather than full-tree
    # polling exhausting the unchanged 256-node/8-second budget.
    time.sleep(0.8)
    found=[]
    def candidate(node):
        if node.getRole() != tree.api.ROLE_TOOL_TIP or not tooltip_positive_visible(node,tree): return False
        if node.name == EXPECTED_TEXT: rendered=node
        else:
            roles={getattr(tree.api,name,None)for name in ['ROLE_LABEL','ROLE_TEXT']};roles.discard(None)
            rendered=tree.find(node,lambda child: child.getRole() in roles and tooltip_positive_visible(child,tree) and child.name == EXPECTED_TEXT)
        if rendered is not None and tooltip_witness(node,rendered,tree,args):
            found.append((node,rendered));return True
        return False
    tree.find(app,candidate)
    return found[0]if found else None


def worker(args):
    validate_process(args)
    keepalive = existing_accessibility_bus()
    import gi
    gi.require_version('Atspi', '2.0')
    from gi.repository import Atspi
    import pyatspi
    Atspi.set_timeout(300, 800)
    tree = Tree(pyatspi, args.pid, args)
    desktop = pyatspi.Registry.getDesktop(0)
    applications = tree.children(desktop)
    # The application root must be the exact launched main PID. The WebKit
    # exception applies only inside that application's tree, never desktop apps.
    app = next((node for node in applications if node is not None and type(node.get_process_id()) is int and node.get_process_id() == args.pid), None)
    if app is None: raise ProbeError('GAP_OWNED_APPLICATION_UNAVAILABLE')
    result = dict(status='AT_SPI_PROBE_COMPLETE', **{flag: False for flag in FLAGS}, nodes_visited=0, help_cleanup='NOT_OPENED', attempt='GAP_HELP_CONTROL_UNAVAILABLE')
    result['owned_application'] = True
    try:
        help_button = tree.find(app, lambda node: is_help_candidate(node, tree))
    except ProbeError as error:
        if str(error) not in GAPS: raise
        result['attempt'] = str(error)
        help_button = None
    if help_button is None:
        if result['attempt'] == 'GAP_HELP_CONTROL_UNAVAILABLE':
            rejected = [proof['diagnostic']['status'] for proof in tree.foreign_processes.values() if not proof['allowed']]
            if rejected: result['attempt'] = rejected[0]
        validate_process(args)
        result['nodes_visited'], result['help_diagnostics'] = tree.visited, tree.help_diagnostics()
        return result
    result['attempt'] = 'GAP_SOURCE_CONTROL_UNAVAILABLE'
    opened, saved = False, None
    try:
        tree.matched_help_role_code = activate_help(help_button, tree, args)
        opened = True
        source = None
        until = min(tree.deadline, time.monotonic() + 2)
        while source is None and time.monotonic() < until:
            source = tree.find(app, lambda node: tree.visible(node) and node.name in {'Source Code…', 'Source Code...'})
            if source is None: time.sleep(0.25)
        if source is not None:
            result['attempt'] = 'GAP_SOURCE_RELEASE_TEXT_UNAVAILABLE'
            result['source_showing'] = tree.visible(source)
            result['description_exact'] = source.description == EXPECTED_TEXT
            try:
                saved = hover_owned(source, tree, args)
                result['hovered_owned_window'] = True
                result['attempt'] = 'GAP_OWNED_TOOLTIP_UNAVAILABLE'
                witness = tooltip_after_hover(app,tree,args)
                if witness is not None:
                    container,rendered = witness
                    if tooltip_witness(container,rendered,tree,args):
                        result['tooltip_showing'] = True
                        result['tooltip_exact'] = rendered.name == EXPECTED_TEXT
            except ProbeError as error:
                if str(error).startswith('ERROR_'): raise
                result['attempt'] = str(error) if str(error) in GAPS else 'GAP_NATIVE_API_UNAVAILABLE'
                # Preserve any already observed exact accessible description;
                # failed hover/traversal cannot promote it to displayed evidence.
    except ProbeError as error:
        if str(error) not in GAPS: raise
        result['attempt'] = str(error)
    finally:
        if saved is not None:
            try:
                xdo('mousemove', '--sync', saved['X'], saved['Y'])
                result['cursor_restored'] = True
            except Exception: pass
        if opened:
            result['help_cleanup'] = 'HELP_CLOSE_UNAVAILABLE'
            try:
                activate_help(help_button, tree, args)
                result['help_cleanup'] = 'HELP_TOGGLE_CLOSED'
            except ProbeError as error:
                if str(error).startswith('ERROR_'): raise
            except Exception: pass
    validate_process(args)
    result['nodes_visited'] = tree.visited
    result['help_diagnostics'] = tree.help_diagnostics()
    return result


def observe(args):
    validate_process(args)
    evidence = Path(args.evidence_dir).absolute()
    if evidence.is_symlink() or not evidence.is_dir(): raise ProbeError('ERROR_EVIDENCE_PATH')
    roots = [Path(os.environ[key]).resolve(strict=True) for key in ['RUNNER_TEMP', 'GITHUB_WORKSPACE']]
    evidence = evidence.resolve(strict=True)
    if evidence in roots or not any(evidence.is_relative_to(root) for root in roots): raise ProbeError('ERROR_EVIDENCE_PATH')
    output = evidence / 'linux-source-release-ui.json'
    if output.exists() or output.is_symlink(): raise ProbeError('ERROR_EVIDENCE_PATH')
    result = None
    if not Path('/usr/bin/python3').is_file(): result = base_observation('GAP_SYSTEM_PYATSPI_UNAVAILABLE')
    if result is None:
        try:
            available = subprocess.run(['/usr/bin/python3', '-I', '-c', 'import importlib.util; raise SystemExit(0 if importlib.util.find_spec("pyatspi") else 1)'],
                                       capture_output=True, timeout=3)
            if available.returncode: result = base_observation('GAP_SYSTEM_PYATSPI_UNAVAILABLE')
        except subprocess.TimeoutExpired: result = base_observation('GAP_SYSTEM_PYATSPI_UNAVAILABLE')
    if result is None:
        try:
            observed = subprocess.run(['/usr/bin/python3', '-I', str(Path(__file__).resolve()), '--worker', '--pid', str(args.pid),
                '--executable', args.executable, '--sha256', args.sha256, '--expected-arch', args.expected_arch, '--evidence-dir', str(evidence)],
                capture_output=True, timeout=15)
            if len(observed.stdout) > 8192: result = base_observation('GAP_PROBE_OUTPUT_INVALID')
            else: result = classify_observation(json.loads(observed.stdout))
            if observed.returncode not in {0, 2}: result = base_observation('GAP_PROBE_FAILED')
        except subprocess.TimeoutExpired: result = base_observation('GAP_PROBE_TIMEOUT')
        except (ValueError, UnicodeError): result = base_observation('GAP_PROBE_OUTPUT_INVALID')
    validate_process(args)
    receipt = dict(schema=1, source_commit=SOURCE, source_offer_id=OFFER, pid=args.pid, executable_sha256=args.sha256,
                   native_architecture=args.expected_arch, method='Existing AT-SPI owned Help/source-offer observation; no accessibility enablement',
                   maximum_nodes=MAX_NODES, worker_timeout_seconds=15, **result)
    with output.open('x', encoding='utf-8') as stream: stream.write(json.dumps(receipt, indent=2) + '\n')
    output.chmod(0o600)
    return receipt


class SafeParser(argparse.ArgumentParser):
    def error(self, _message): raise ProbeError('ERROR_ARGUMENTS')


def main(argv=None):
    try:
        parser = SafeParser(description=__doc__, add_help=False)
        parser.add_argument('--worker', action='store_true')
        parser.add_argument('--pid', type=int, required=True)
        for name in ['executable', 'sha256', 'evidence-dir']: parser.add_argument('--' + name, required=True)
        parser.add_argument('--expected-arch', choices=['x86_64', 'aarch64'], required=True)
        args = parser.parse_args(argv)
        if args.worker:
            try: record = worker(args)
            except ProbeError as error: record = {'status': str(error) if str(error) in GAPS | ERRORS else 'GAP_NATIVE_API_UNAVAILABLE'}
            except Exception: record = {'status': 'GAP_NATIVE_API_UNAVAILABLE'}
            print(json.dumps(record))
        else:
            record = observe(args)
            print(json.dumps({'status': record['status'], 'receipt': 'linux-source-release-ui.json'}))
        return 2 if record['status'].startswith('ERROR_') else 0
    except Exception as error:
        code = str(error) if isinstance(error, ProbeError) and str(error) in GAPS | ERRORS else 'ERROR_PROBE_OPERATION_FAILED'
        print(json.dumps({'status': 'ERROR_LINUX_RELEASE_PROBE', 'code': code}), file=sys.stderr)
        return 2


if __name__ == '__main__':
    raise SystemExit(main())
