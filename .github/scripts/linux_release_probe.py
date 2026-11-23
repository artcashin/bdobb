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
GAPS = {'GAP_SYSTEM_PYATSPI_UNAVAILABLE', 'GAP_SESSION_UNAVAILABLE', 'GAP_EXISTING_A11Y_BUS_UNAVAILABLE',
        'GAP_EXISTING_ATSPI_REGISTRY_UNAVAILABLE', 'GAP_OWNED_APPLICATION_UNAVAILABLE', 'GAP_HELP_CONTROL_UNAVAILABLE',
        'GAP_HELP_ACTION_UNAVAILABLE', 'GAP_SOURCE_CONTROL_UNAVAILABLE', 'GAP_SOURCE_RELEASE_TEXT_UNAVAILABLE',
        'GAP_HOVER_OWNERSHIP_UNCONFIRMED', 'GAP_NATIVE_API_UNAVAILABLE', 'GAP_TRAVERSAL_BUDGET',
        'GAP_PROBE_TIMEOUT', 'GAP_PROBE_FAILED', 'GAP_PROBE_OUTPUT_INVALID', 'GAP_OWNED_TOOLTIP_UNAVAILABLE'}
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


def classify_observation(value):
    invalid = base_observation('GAP_PROBE_OUTPUT_INVALID')
    if not isinstance(value, dict): return invalid
    status = value.get('status')
    if status in GAPS | ERRORS and set(value) == {'status'}: return base_observation(status)
    if status != 'AT_SPI_PROBE_COMPLETE' or set(value) != {'status', 'nodes_visited', 'help_cleanup', 'attempt', *FLAGS}: return invalid
    if any(type(value[key]) is not bool for key in FLAGS): return invalid
    if type(value['nodes_visited']) is not int or not 0 <= value['nodes_visited'] <= MAX_NODES or value['help_cleanup'] not in CLEANUPS or value['attempt'] not in GAPS: return invalid
    accessible = value['owned_application'] and value['source_showing'] and value['description_exact']
    displayed = value['owned_application'] and value['source_showing'] and value['hovered_owned_window'] and value['tooltip_showing'] and value['tooltip_exact']
    result = base_observation('OBSERVED_OWNED_TOOLTIP' if displayed else 'OBSERVED_ATSPI_DESCRIPTION' if accessible else value['attempt'])
    result.update(release='3.0.0' if accessible or displayed else None,
                  accessible_release_observed=accessible, displayed_release_observed=displayed,
                  nodes_visited=value['nodes_visited'], help_cleanup=value['help_cleanup'], cursor_restored=value['cursor_restored'], attempt=value['attempt'])
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
    def __init__(self, api, pid):
        self.api, self.pid = api, pid
        self.deadline, self.visited = time.monotonic() + 8, 0

    def budget(self):
        if time.monotonic() >= self.deadline: raise ProbeError('GAP_PROBE_TIMEOUT')
        if self.visited >= MAX_NODES: raise ProbeError('GAP_TRAVERSAL_BUDGET')

    def owned(self, node):
        self.budget()
        return node is not None and node.get_process_id() == self.pid

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


def hover_owned(source, tree, args):
    if not tree.visible(source): raise ProbeError('GAP_HOVER_OWNERSHIP_UNCONFIRMED')
    box = source.queryComponent().getExtents(tree.api.XY_SCREEN)
    if not 0 < box.width <= 20000 or not 0 < box.height <= 20000: raise ProbeError('GAP_HOVER_OWNERSHIP_UNCONFIRMED')
    x, y = box.x + box.width // 2, box.y + box.height // 2
    windows = xdo('search', '--onlyvisible', '--pid', args.pid).splitlines()
    matched = False
    for window in windows[:16]:
        if not re.fullmatch('[0-9]{1,20}', window): raise ProbeError('GAP_HOVER_OWNERSHIP_UNCONFIRMED')
        if xdo('getwindowpid', window).strip() != str(args.pid): continue
        geometry = numeric_fields(xdo('getwindowgeometry', '--shell', window), {'X', 'Y', 'WIDTH', 'HEIGHT'})
        if geometry['X'] <= x < geometry['X'] + geometry['WIDTH'] and geometry['Y'] <= y < geometry['Y'] + geometry['HEIGHT']:
            matched = True
            break
    if not matched: raise ProbeError('GAP_HOVER_OWNERSHIP_UNCONFIRMED')
    saved = numeric_fields(xdo('getmouselocation', '--shell'), {'X', 'Y', 'WINDOW'})
    validate_process(args)
    xdo('mousemove', '--sync', x, y)
    try:
        actual = numeric_fields(xdo('getmouselocation', '--shell'), {'X', 'Y', 'WINDOW'})
        if xdo('getwindowpid', actual['WINDOW']).strip() != str(args.pid): raise ProbeError('GAP_HOVER_OWNERSHIP_UNCONFIRMED')
    except Exception:
        xdo('mousemove', '--sync', saved['X'], saved['Y'])
        raise
    return saved


def invoke_help(help_button, tree, args):
    # This is the sole actionable element. Never query/invoke Source's Action.
    if not tree.visible(help_button) or help_button.name != 'Help' or help_button.getRole() != tree.api.ROLE_PUSH_BUTTON:
        raise ProbeError('GAP_HELP_ACTION_UNAVAILABLE')
    action = help_button.queryAction()
    if not 0 < action.nActions <= 4: raise ProbeError('GAP_HELP_ACTION_UNAVAILABLE')
    for index in range(action.nActions):
        if action.getName(index).lower() in {'click', 'press', 'activate'}:
            validate_process(args)
            if action.doAction(index): return
    raise ProbeError('GAP_HELP_ACTION_UNAVAILABLE')


def worker(args):
    validate_process(args)
    keepalive = existing_accessibility_bus()
    import gi
    gi.require_version('Atspi', '2.0')
    from gi.repository import Atspi
    import pyatspi
    Atspi.set_timeout(300, 800)
    tree = Tree(pyatspi, args.pid)
    desktop = pyatspi.Registry.getDesktop(0)
    applications = tree.children(desktop)
    app = next((node for node in applications if tree.owned(node)), None)
    if app is None: raise ProbeError('GAP_OWNED_APPLICATION_UNAVAILABLE')
    help_button = tree.find(app, lambda node: tree.visible(node) and node.name == 'Help' and node.getRole() == pyatspi.ROLE_PUSH_BUTTON)
    if help_button is None: raise ProbeError('GAP_HELP_CONTROL_UNAVAILABLE')
    result = dict(status='AT_SPI_PROBE_COMPLETE', **{flag: False for flag in FLAGS}, nodes_visited=0, help_cleanup='NOT_OPENED', attempt='GAP_SOURCE_CONTROL_UNAVAILABLE')
    result['owned_application'] = True
    opened, saved = False, None
    try:
        invoke_help(help_button, tree, args)
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
                time.sleep(0.8)
                until = min(tree.deadline, time.monotonic() + 3)
                while time.monotonic() < until:
                    tooltip = tree.find(app, lambda node: tree.visible(node) and node.getRole() == pyatspi.ROLE_TOOL_TIP and node.name == EXPECTED_TEXT)
                    if tooltip is not None:
                        result['tooltip_showing'] = tree.visible(tooltip)
                        result['tooltip_exact'] = tooltip.name == EXPECTED_TEXT
                        break
                    time.sleep(0.3)
            except ProbeError as error:
                if str(error).startswith('ERROR_'): raise
                result['attempt'] = str(error) if str(error) in GAPS else 'GAP_NATIVE_API_UNAVAILABLE'
                # Preserve any already observed exact accessible description;
                # failed hover/traversal cannot promote it to displayed evidence.
    finally:
        if saved is not None:
            try:
                xdo('mousemove', '--sync', saved['X'], saved['Y'])
                result['cursor_restored'] = True
            except Exception: pass
        if opened:
            result['help_cleanup'] = 'HELP_CLOSE_UNAVAILABLE'
            try:
                invoke_help(help_button, tree, args)
                result['help_cleanup'] = 'HELP_TOGGLE_CLOSED'
            except ProbeError as error:
                if str(error).startswith('ERROR_'): raise
            except Exception: pass
    validate_process(args)
    result['nodes_visited'] = tree.visited
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
