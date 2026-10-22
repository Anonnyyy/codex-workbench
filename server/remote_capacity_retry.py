"""Retry the original capacity turn via its UI owner or matching background runtime."""
import json
import base64
import hashlib
import os
import pathlib
import select
import shutil
import socket
import sqlite3
import stat
import struct
import subprocess
import sys
import time
import uuid
from contextlib import closing


def is_capacity(error):
    if not isinstance(error, dict):
        return False
    code = error.get('codex_error_info', error.get('codexErrorInfo'))
    return code in ('server_overloaded', 'serverOverloaded') or 'selected model is at capacity' in str(error.get('message', '')).lower()


def still_failed(home, thread_id, turn_id):
    with closing(sqlite3.connect((home / 'state_5.sqlite').as_uri() + '?mode=ro', uri=True)) as db:
        row = db.execute('SELECT rollout_path FROM threads WHERE id=? AND archived=0', (thread_id,)).fetchone()
    if not row:
        return False
    path = pathlib.Path(row[0]).resolve()
    if home not in path.parents:
        return False
    latest = None
    with path.open('rb') as f:
        f.seek(0, 2)
        f.seek(max(0, f.tell() - 2 * 1024 * 1024))
        for line in f:
            try:
                event = json.loads(line)
            except (ValueError, UnicodeDecodeError):
                continue
            p = event.get('payload') or {}
            kind, typ = event.get('type'), p.get('type')
            if kind == 'event_msg':
                if typ in ('task_complete', 'task_completed', 'turn_completed'):
                    latest = p
                elif typ in ('task_started', 'turn_started', 'user_message', 'turn_aborted', 'task_interrupted', 'approval_requested', 'request_user_input'):
                    latest = None
            if kind == 'response_item' and (typ in ('function_call', 'custom_tool_call', 'reasoning') or (typ == 'message' and p.get('role') in ('user', 'assistant'))):
                latest = None
    return latest is not None and latest.get('turn_id', latest.get('turnId')) == turn_id and is_capacity(latest.get('error'))


class Ipc:
    def __init__(self, sock):
        self.sock = sock
        self.client_id = 'uninitialized'

    def send(self, value):
        data = json.dumps(value).encode('utf-8')
        self.sock.sendall(struct.pack('<I', len(data)) + data)

    def receive(self, count):
        data = bytearray()
        while len(data) < count:
            part = self.sock.recv(min(65536, count - len(data)))
            if not part:
                raise ConnectionError('IPC closed')
            data.extend(part)
        return data

    def request(self, method, params, version, target=None, before_send=None):
        request_id = str(uuid.uuid4())
        value = dict(type='request', requestId=request_id, sourceClientId=self.client_id,
                     method=method, params=params, version=version, timeoutMs=10000)
        if target:
            value['targetClientId'] = target
        if before_send:
            before_send()
        self.send(value)
        deadline = time.monotonic() + 12
        while True:
            self.sock.settimeout(max(0.1, deadline - time.monotonic()))
            if time.monotonic() >= deadline:
                raise TimeoutError('IPC response timeout')
            size = struct.unpack('<I', self.receive(4))[0]
            if not 0 < size <= 48 * 1024 * 1024:
                raise ValueError('Invalid IPC frame')
            message = json.loads(self.receive(size))
            if message.get('type') == 'client-discovery-request':
                self.send(dict(type='client-discovery-response', requestId=message['requestId'], response={'canHandle': False}))
            if message.get('type') == 'response' and message.get('requestId') == request_id:
                return message


class ProxySocket:
    """Keep compatibility with callers using Codex's byte-for-byte stdio proxy."""
    def __init__(self, process):
        self.process = process
        self.timeout = 5

    def settimeout(self, timeout):
        self.timeout = timeout

    def sendall(self, data):
        self.process.stdin.write(data)
        self.process.stdin.flush()

    def recv(self, size):
        ready, _, _ = select.select([self.process.stdout], [], [], self.timeout)
        if not ready:
            raise TimeoutError('Codex proxy response timeout')
        return os.read(self.process.stdout.fileno(), size)


class AppServer:
    """JSON-RPC over WebSocket on a private Unix socket (not JSONL)."""
    def __init__(self, sock):
        self.sock = sock if hasattr(sock, 'sendall') else ProxySocket(sock)
        sock = self.sock
        self.pending = bytearray()
        self.deadline = time.monotonic() + 5
        key = base64.b64encode(os.urandom(16)).decode()
        sock.sendall(('GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\n'
                      'Connection: Upgrade\r\nSec-WebSocket-Version: 13\r\n'
                      'Sec-WebSocket-Key: ' + key + '\r\n\r\n').encode())
        while b'\r\n\r\n' not in self.pending:
            self._read()
            if len(self.pending) > 65536:
                raise ValueError('Invalid WebSocket handshake')
        header, _, rest = self.pending.partition(b'\r\n\r\n')
        self.pending = bytearray(rest)
        lines = header.decode('ascii').split('\r\n')
        headers = {k.lower(): v.strip() for k, v in (line.split(':', 1) for line in lines[1:] if ':' in line)}
        accept = base64.b64encode(hashlib.sha1((key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').encode()).digest()).decode()
        if ' 101 ' not in lines[0] or headers.get('sec-websocket-accept') != accept:
            raise ValueError('Codex WebSocket handshake rejected')

    def _read(self):
        remaining = self.deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError('Codex app-server response timeout')
        self.sock.settimeout(remaining)
        chunk = self.sock.recv(65536)
        if not chunk:
            raise ConnectionError('Codex app-server disconnected')
        self.pending.extend(chunk)

    def _take(self, size):
        while len(self.pending) < size:
            self._read()
        data = bytes(self.pending[:size])
        del self.pending[:size]
        return data

    def _send(self, payload, opcode=1):
        mask = os.urandom(4)
        size = len(payload)
        header = bytes([0x80 | opcode])
        header += bytes([0x80 | size]) if size < 126 else bytes([0x80 | 126]) + struct.pack('!H', size) if size < 65536 else bytes([0x80 | 127]) + struct.pack('!Q', size)
        self.sock.sendall(header + mask + bytes(value ^ mask[i % 4] for i, value in enumerate(payload)))

    def _message(self):
        result = bytearray()
        while True:
            first, second = self._take(2)
            opcode, size = first & 15, second & 127
            if first & 0x70 or second & 0x80:
                raise ValueError('Unexpected WebSocket frame')
            if size == 126:
                size = struct.unpack('!H', self._take(2))[0]
            elif size == 127:
                size = struct.unpack('!Q', self._take(8))[0]
            if size + len(result) > 4 * 1024 * 1024:
                raise ValueError('Codex response too large')
            payload = self._take(size)
            if opcode == 8:
                raise ConnectionError('Codex WebSocket closed')
            if opcode == 9:
                self._send(payload, 10)
                continue
            if opcode == 10:
                continue
            if opcode not in (0, 1):
                raise ValueError('Unexpected WebSocket message')
            result.extend(payload)
            if first & 0x80:
                return json.loads(result)

    def request(self, method, params, timeout, before_send=None):
        request_id = str(uuid.uuid4())
        data = json.dumps(dict(id=request_id, method=method, params=params)).encode()
        self.deadline = time.monotonic() + timeout
        self.sock.settimeout(timeout)
        if before_send:
            before_send()
        self._send(data)
        while True:
            message = self._message()
            if str(message.get('id')) == request_id:
                return message

    def notify(self, method):
        self._send(json.dumps(dict(method=method)).encode())


def thread_runtime(home, thread_id):
    with closing(sqlite3.connect((home / 'state_5.sqlite').as_uri() + '?mode=ro', uri=True)) as db:
        row = db.execute('SELECT rollout_path FROM threads WHERE id=? AND archived=0', (thread_id,)).fetchone()
    if not row:
        raise ValueError('Unknown task')
    path = pathlib.Path(row[0]).resolve()
    if home not in path.parents:
        raise ValueError('Invalid rollout path')
    metadata, context = {}, {}
    with path.open('rb') as f:
        for _ in range(16):
            line = f.readline(1024 * 1024)
            if not line:
                break
            try:
                event = json.loads(line)
            except (ValueError, UnicodeDecodeError):
                continue
            if event.get('type') == 'session_meta':
                metadata = event.get('payload') or {}
                break
        f.seek(0, 2)
        f.seek(max(0, f.tell() - 4 * 1024 * 1024))
        for line in f:
            try:
                event = json.loads(line)
            except (ValueError, UnicodeDecodeError):
                continue
            if event.get('type') == 'turn_context':
                context = event.get('payload') or {}
    return metadata, context


def matching_binary(home, version):
    # Prefer a complete installed CLI package when its version matches the IDE.
    system = shutil.which('codex')
    candidates = [pathlib.Path(system)] if system else []
    for directory in ['.vscode-server/extensions', '.vscode/extensions']:
        candidates.extend(sorted((home.parent / directory).glob('openai.chatgpt-*/bin/*/codex'), key=lambda p: p.stat().st_mtime, reverse=True))
    candidates += [home.parent / '.local/bin/codex']
    for path in dict.fromkeys(candidates):
        if not path.is_file() or not os.access(path, os.X_OK):
            continue
        try:
            result = subprocess.run([str(path), '--version'], capture_output=True, text=True, timeout=2)
            if result.returncode == 0 and result.stdout.strip() == 'codex-cli ' + version:
                return str(path)
        except (OSError, subprocess.TimeoutExpired):
            pass
    raise ValueError('No matching Codex runtime')


def runtime_environment(home, binary):
    """Carry over the same user's Codex network settings, absent in plain SSH."""
    env = os.environ.copy()
    env['CODEX_HOME'] = str(home)
    keys = ('HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','NO_PROXY','http_proxy','https_proxy',
            'all_proxy','no_proxy','SSL_CERT_FILE','SSL_CERT_DIR','CODEX_INTERNAL_ORIGINATOR_OVERRIDE')
    version = subprocess.run([binary, '--version'], capture_output=True, text=True, timeout=2).stdout.strip()
    candidates = []
    for proc in pathlib.Path('/proc').iterdir():
        if not proc.name.isdigit():
            continue
        try:
            if proc.stat().st_uid != os.getuid():
                continue
            args = proc.joinpath('cmdline').read_bytes().split(b'\0')
            if b'app-server' not in args or pathlib.Path(os.fsdecode(args[0])).name != 'codex':
                continue
            values = dict(item.split(b'=', 1) for item in proc.joinpath('environ').read_bytes().split(b'\0') if b'=' in item)
            if pathlib.Path(os.fsdecode(values.get(b'CODEX_HOME', os.fsencode(home)))).resolve() != home:
                continue
            inherited = {key: os.fsdecode(values[os.fsencode(key)]) for key in keys if os.fsencode(key) in values}
            if not inherited:
                continue
            actual = subprocess.run([os.fsdecode(args[0]), '--version'], capture_output=True, text=True, timeout=2)
            if actual.returncode or actual.stdout.strip() != version:
                continue
            score = sum(key.upper() in ('HTTP_PROXY','HTTPS_PROXY','ALL_PROXY') for key in inherited)
            candidates.append((score, inherited))
        except (OSError, ValueError, subprocess.TimeoutExpired):
            continue
    if candidates:
        env.update(max(candidates, key=lambda item: item[0])[1])
    return env


def background_connection(home, binary):
    import fcntl
    directory = home / 'workbench-retry'
    directory.mkdir(mode=0o700, exist_ok=True)
    if directory.is_symlink() or directory.stat().st_uid != os.getuid():
        raise ValueError('Invalid runtime directory')
    name = 'server-' + hashlib.sha256(binary.encode()).hexdigest()[:12]
    path = directory / (name + '.sock')

    def connect():
        info = path.stat()
        if not stat.S_ISSOCK(info.st_mode) or info.st_uid != os.getuid():
            raise ValueError('Invalid runtime socket')
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            sock.settimeout(2)
            sock.connect(str(path))
            return sock
        except Exception:
            sock.close()
            raise

    with (directory / (name + '.lock')).open('a+b') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        try:
            return connect()
        except (FileNotFoundError, ConnectionRefusedError):
            pass
        # A private listener survives this short SSH request and keeps the turn running.
        with (directory / (name + '.log')).open('ab') as log:
            process = subprocess.Popen([binary, 'app-server', '--listen', 'unix://' + str(path)],
                stdin=subprocess.DEVNULL, stdout=log, stderr=log, start_new_session=True, close_fds=True,
                env=runtime_environment(home, binary))
        for _ in range(50):
            try:
                return connect()
            except (FileNotFoundError, ConnectionRefusedError):
                if process.poll() is not None:
                    break
                time.sleep(0.1)
        raise ConnectionError('Codex background listener unavailable')


def sandbox_params(value):
    """Rollout policies use snake/kebab case; app-server v2 uses camel case."""
    def camel(text, separator):
        first, *rest = text.split(separator)
        return first + ''.join(part[:1].upper() + part[1:] for part in rest)
    if isinstance(value, dict):
        return {camel(key, '_'): camel(item, '-') if key == 'type' and isinstance(item, str) else sandbox_params(item)
                for key, item in value.items()}
    if isinstance(value, list):
        return [sandbox_params(item) for item in value]
    return value


def retry_without_window(home, thread_id, turn_id):
    """Resume the same task when its Codex window has no IPC owner."""
    attempted = False
    try:
        metadata, context = thread_runtime(home, thread_id)
        if context.get('turn_id') != turn_id or not metadata.get('cli_version'):
            return dict(status='stale', message='任务设置已变化，取消重试')
        binary = matching_binary(home, metadata['cli_version'])
        with background_connection(home, binary) as sock:
            rpc = AppServer(sock)
            initialized = rpc.request('initialize', dict(clientInfo=dict(name='codex-workbench',
                title='Codex Workbench', version='0.1.0'), capabilities=None), 4)
            if 'error' in initialized:
                return dict(status='unavailable', message='远端 Codex 通信版本不兼容')
            rpc.notify('initialized')
            params = dict(threadId=thread_id, excludeTurns=True)
            for field, key in [('model','model'),('cwd','cwd'),('approvalPolicy','approval_policy')]:
                if context.get(key) is not None:
                    params[field] = context[key]
            sandbox = context.get('sandbox_policy') or {}
            if sandbox.get('type') in ('read-only','workspace-write','danger-full-access'):
                params['sandbox'] = sandbox['type']
            resumed = rpc.request('thread/resume', params, 15)
            if 'error' in resumed or resumed.get('result', {}).get('thread', {}).get('id') != thread_id:
                return dict(status='unavailable', message='远端 Codex 无法恢复原任务')
            if not still_failed(home, thread_id, turn_id):
                return dict(status='stale', message='任务已发生变化，取消重试')

            def mark_attempted():
                nonlocal attempted
                attempted = True

            turn = dict(threadId=thread_id, input=[], turnTrigger='capacity_retry_automatic')
            if context.get('effort') is not None:
                turn['effort'] = context['effort']
            if sandbox:
                turn['sandboxPolicy'] = sandbox_params(sandbox)
            response = rpc.request('turn/start', turn, 10, before_send=mark_attempted)
            if response.get('result', {}).get('turn', {}).get('id'):
                return dict(status='sent', message='已在原任务触发重试')
            if response.get('error', {}).get('code') in (-32600, -32602):
                return dict(status='unavailable', message='Codex 拒绝重试参数，等待后台更新')
            return dict(status='unknown', message='重试回执未确认，等待任务状态更新')
    except Exception:
        return dict(status='unknown' if attempted else 'unavailable',
                    message='重试回执未确认，等待任务状态更新' if attempted else '远端 Codex 后台暂不可用')


def retry(request, home=None):
    home = (home or pathlib.Path(os.environ.get('CODEX_HOME', pathlib.Path.home() / '.codex'))).resolve()
    thread_id, turn_id = request['threadId'], request['turnId']
    uuid.UUID(thread_id)
    uuid.UUID(turn_id)
    if not still_failed(home, thread_id, turn_id):
        return dict(status='stale', message='任务已发生变化，取消重试')
    attempted = False
    try:
        candidates = [home / 'ipc/ipc.sock', pathlib.Path('/tmp/codex-ipc') / ('ipc-%s.sock' % os.getuid())]
        path = next(p for p in candidates if p.exists() and stat.S_ISSOCK(p.stat().st_mode) and p.stat().st_uid == os.getuid())
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as sock:
            sock.settimeout(10)
            sock.connect(str(path))
            ipc = Ipc(sock)
            response = ipc.request('initialize', {'clientType': 'codex-workbench-retry'}, 0)
            if response.get('resultType') != 'success':
                return dict(status='unavailable', message='Codex 通信版本不兼容')
            ipc.client_id = response['result']['clientId']
            owner = ipc.request('thread-owner-discovery', {'hostId': 'local', 'conversationId': thread_id}, 1)
            if owner.get('resultType') != 'success' or not owner.get('handledByClientId'):
                return retry_without_window(home, thread_id, turn_id)
            # Recheck after discovery, immediately before requesting the same
            # empty turn used by Codex's capacity Retry button. Settings inherit.
            if not still_failed(home, thread_id, turn_id):
                return dict(status='stale', message='任务已发生变化，取消重试')

            def mark_attempted():
                nonlocal attempted
                attempted = True

            response = ipc.request('thread-follower-start-turn', {
                'conversationId': thread_id,
                'turnStart': {'request': {'threadId': thread_id, 'input': [], 'turnTrigger': 'capacity_retry_automatic'}}
            }, 2, owner['handledByClientId'], before_send=mark_attempted)
            if response.get('resultType') == 'success':
                return dict(status='sent', message='已触发原任务重试')
            if response.get('error') in ('no-client-found', 'version-mismatch'):
                return retry_without_window(home, thread_id, turn_id)
            return dict(status='unknown', message='重试未获确认，等待任务状态更新')
    except StopIteration:
        return retry_without_window(home, thread_id, turn_id)
    except Exception:
        return dict(status='unknown' if attempted else 'unavailable',
                    message='重试回执未确认，等待任务状态更新' if attempted else 'Codex 重试通道暂不可用')


if __name__ == '__main__':
    try:
        print(json.dumps(retry(json.load(sys.stdin)), ensure_ascii=False))
    except Exception:
        print(json.dumps(dict(status='unavailable', message='重试请求无效'), ensure_ascii=False))
