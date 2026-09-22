"""Passive Codex IPC reader. Never owns tasks or broadcasts read changes."""
import socket, struct, threading, uuid, stat, json, time, pathlib, os

class ReadEvents:
    def __init__(self, home):
        self.home = home
        self.marks = {}
        self.connected = False
        self.lock = threading.Lock()

    def accept(self, message, now):
        p = message.get('params', {})
        if (message.get('type') != 'broadcast' or
            message.get('method') != 'thread-read-state-changed' or
            message.get('version') != 3 or p.get('hostId') != 'local' or
            not isinstance(p.get('hasUnreadTurn'), bool) or
            not isinstance(p.get('conversationId'), str)):
            return
        try: uuid.UUID(p['conversationId'])
        except ValueError: return
        with self.lock:
            self.marks[p['conversationId']] = {
                'nativeUnread': p['hasUnreadTurn'], 'nativeReadAt': now,
                'nativeReadSource': 'vscode-ipc'}

    def snapshot(self):
        with self.lock: return dict(self.marks)

    def start(self):
        threading.Thread(target=self.run, daemon=True).start()
        return self

    def run(self):
        def send(sock, message):
            data = json.dumps(message).encode()
            sock.sendall(struct.pack('<I', len(data)) + data)
        def receive(sock, count):
            chunks = bytearray()
            while len(chunks) < count:
                part = sock.recv(min(65536, count-len(chunks)))
                if not part: raise ConnectionError('closed')
                chunks.extend(part)
            return chunks
        while True:
            try:
                candidates = [self.home/'ipc/ipc.sock', pathlib.Path('/tmp/codex-ipc')/('ipc-%s.sock' % os.getuid())]
                path = next(p for p in candidates if p.exists() and stat.S_ISSOCK(p.stat().st_mode) and p.stat().st_uid == os.getuid())
                with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as sock:
                    sock.settimeout(10)
                    sock.connect(str(path))
                    sock.settimeout(None)
                    request_id = str(uuid.uuid4())
                    send(sock, {'type':'request','requestId':request_id,'sourceClientId':'uninitialized',
                                'method':'initialize','params':{'clientType':'codex-workbench-observer'},'version':0})
                    while True:
                        try: header = receive(sock, 4)
                        except socket.timeout: continue
                        size = struct.unpack('<I', header)[0]
                        if not 0 < size <= 48*1024*1024: raise ValueError('invalid frame')
                        # A partial frame must never be interpreted as a new header.
                        message = json.loads(receive(sock, size))
                        if message.get('requestId') == request_id and message.get('resultType') == 'success':
                            self.connected = True
                        if message.get('type') == 'client-discovery-request':
                            send(sock, {'type':'client-discovery-response','requestId':message['requestId'],'response':{'canHandle':False}})
                        self.accept(message, int(time.time()*1000))
            except Exception:
                pass
            self.connected = False
            time.sleep(3)
