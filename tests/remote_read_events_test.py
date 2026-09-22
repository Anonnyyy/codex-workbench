"""Run after remote_read_events.py via exec; fake socket never touches Codex."""
import tempfile

event_id = '11111111-2222-4333-8444-555555555555'
def event(unread=False, **changes):
    result = {'type':'broadcast','method':'thread-read-state-changed','version':3,
              'params':{'hostId':'local','conversationId':event_id,'hasUnreadTurn':unread}}
    result.update(changes)
    return result

reader = ReadEvents(pathlib.Path('/unused'))
reader.accept(event(), 123)
assert reader.snapshot()[event_id]['nativeUnread'] is False
reader.accept(event(True), 124)
assert reader.snapshot()[event_id]['nativeUnread'] is True
reader.accept(event(False, version=2), 125)
assert reader.snapshot()[event_id]['nativeReadAt'] == 124
bad = event(); bad['params']['hostId'] = 'other-host'
reader.accept(bad, 126)
assert reader.snapshot()[event_id]['nativeReadAt'] == 124

with tempfile.TemporaryDirectory(prefix='workbench-ipc-test-') as directory:
    root = pathlib.Path(directory)
    (root/'ipc').mkdir()
    path = root/'ipc/ipc.sock'
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as server:
        server.bind(str(path)); server.listen(); server.settimeout(5)
        reader = ReadEvents(root).start()
        client, _ = server.accept()
        with client:
            client.settimeout(5)
            def receive(count):
                value = b''
                while len(value)<count: value += client.recv(count-len(value))
                return value
            def read(): return json.loads(receive(struct.unpack('<I',receive(4))[0]))
            def send(value):
                data = json.dumps(value).encode(); frame = struct.pack('<I',len(data))+data
                # Exercise fragmented headers and bodies.
                for i in range(0,len(frame),3): client.sendall(frame[i:i+3])
            init = read(); assert init['method']=='initialize'
            send({'type':'response','requestId':init['requestId'],'resultType':'success','result':{'clientId':'test'}})
            send({'type':'client-discovery-request','requestId':'discovery','request':{'method':'thread-owner-discovery'}})
            reply = read()
            assert reply == {'type':'client-discovery-response','requestId':'discovery','response':{'canHandle':False}}
            send(event())
            deadline = time.time()+3
            while event_id not in reader.snapshot() and time.time()<deadline: time.sleep(.01)
            assert reader.connected
            assert reader.snapshot()[event_id]['nativeUnread'] is False
            # Only initialize and the explicit negative discovery reply were sent.
            client.settimeout(.1)
            try:
                assert not client.recv(1), 'observer unexpectedly wrote to the router'
            except socket.timeout: pass
print('PASS: event validation, fragmented IPC frames, passive discovery, native read receipt')
