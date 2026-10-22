import importlib.util
import json
import pathlib
import sqlite3
import tempfile
import unittest
from contextlib import closing, nullcontext
from unittest.mock import patch
from types import SimpleNamespace
from contextlib import ExitStack

source = pathlib.Path(__file__).resolve().parents[1] / 'server/remote_capacity_retry.py'
spec = importlib.util.spec_from_file_location('capacity_retry', source)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
ERROR = dict(message='Selected model is at capacity. Please try a different model.', codex_error_info='server_overloaded')


class CapacityRetryTest(unittest.TestCase):
    def test_closed_window_retries_original_thread_with_original_settings(self):
        calls=[]
        thread='11111111-2222-4333-8444-555555555555'
        turn='11111111-2222-4333-8444-666666666666'
        context=dict(turn_id=turn,model='original-model',cwd='/original/project',effort='high',approval_policy='on-request',sandbox_policy={'type':'workspace-write','writable_roots':['/original/project'],'network_access':False})
        class FakeAppServer:
            def __init__(self, process): pass
            def request(self, method, params, timeout, before_send=None):
                calls.append((method, params))
                if before_send: before_send()
                if method=='initialize': return dict(result={})
                if method=='thread/resume': return dict(result=dict(thread=dict(id=thread)))
                return dict(result=dict(turn=dict(id='new-turn')))
            def notify(self, method): calls.append(method)
        with ExitStack() as stack:
            stack.enter_context(patch.object(module,'thread_runtime',return_value=({'cli_version':'0.162'},context)))
            stack.enter_context(patch.object(module,'matching_binary',return_value='/matching/codex'))
            stack.enter_context(patch.object(module,'background_connection',return_value=nullcontext(object())))
            stack.enter_context(patch.object(module,'AppServer',FakeAppServer))
            stack.enter_context(patch.object(module,'still_failed',return_value=True))
            result=module.retry_without_window(pathlib.Path('/tmp/codex'),thread,turn)
        self.assertEqual(result['status'],'sent')
        self.assertIn(('thread/resume',dict(threadId=thread,excludeTurns=True,model='original-model',cwd='/original/project',approvalPolicy='on-request',sandbox='workspace-write')),calls)
        self.assertIn(('turn/start',dict(threadId=thread,input=[],turnTrigger='capacity_retry_automatic',effort='high',sandboxPolicy={'type':'workspaceWrite','writableRoots':['/original/project'],'networkAccess':False})),calls)

    def test_sandbox_wire_format_preserves_access_and_paths(self):
        self.assertEqual(module.sandbox_params({'type':'danger-full-access'}), {'type':'dangerFullAccess'})
        self.assertEqual(module.sandbox_params({'type':'workspace-write','writable_roots':['/my-project'],'read_only_access':{'type':'full-access'},'network_access':False}),
                         {'type':'workspaceWrite','writableRoots':['/my-project'],'readOnlyAccess':{'type':'fullAccess'},'networkAccess':False})

    def test_closed_window_rechecks_failure_before_dispatch(self):
        sent=[]
        class FakeAppServer:
            def __init__(self, process): pass
            def request(self, method, params, timeout, before_send=None):
                if method=='initialize': return dict(result={})
                if method=='thread/resume': return dict(result=dict(thread=dict(id='thread')))
                sent.append(method)
                return dict(error={})
            def notify(self, method): pass
        with ExitStack() as stack:
            stack.enter_context(patch.object(module,'thread_runtime',return_value=({'cli_version':'0.162'},{'turn_id':'old-turn'})))
            stack.enter_context(patch.object(module,'matching_binary',return_value='/matching/codex'))
            stack.enter_context(patch.object(module,'background_connection',return_value=nullcontext(object())))
            stack.enter_context(patch.object(module,'AppServer',FakeAppServer))
            stack.enter_context(patch.object(module,'still_failed',return_value=False))
            result=module.retry_without_window(pathlib.Path('/tmp/codex'),'thread','old-turn')
        self.assertEqual(result['status'],'stale')
        self.assertEqual(sent,[])

    def test_websocket_handshake_masking_fragmentation_and_ping(self):
        import base64,hashlib,struct
        class Socket:
            def __init__(self): self.data=b'';self.pongs=[]
            def sendall(self,data):
                if data.startswith(b'GET '):
                    key=data.split(b'Sec-WebSocket-Key: ')[1].split(b'\r\n')[0]
                    accept=base64.b64encode(hashlib.sha1(key+b'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest())
                    self.data=b'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: '+accept+b'\r\n\r\n'
                    return
                assert data[1]&128, 'Client frames must be masked'
                size=data[1]&127;offset=2
                if size==126: size=struct.unpack('!H',data[2:4])[0];offset=4
                mask=data[offset:offset+4];payload=bytes(v^mask[i%4] for i,v in enumerate(data[offset+4:]))
                if data[0]&15==10:self.pongs.append(payload);return
                request=json.loads(payload)
                response=json.dumps(dict(id=request['id'],result={'value':'x'*200})).encode()
                first,last=response[:100],response[100:]
                self.data=b'\x01'+bytes([len(first)])+first+b'\x89\x01p'+b'\x80\x7e'+struct.pack('!H',len(last))+last
            def settimeout(self,_): pass
            def recv(self,n):
                chunk,self.data=self.data[:min(3,n)],self.data[min(3,n):]
                return chunk
        sock=Socket();rpc=module.AppServer(sock)
        self.assertEqual(rpc.request('initialize',{'padding':'x'*200},3)['result']['value'],'x'*200)
        self.assertEqual(sock.pongs,[b'p'])

    def test_retry_uses_original_owner_empty_turn_and_preserves_settings(self):
        calls=[]
        class FakeIpc:
            def __init__(self, sock): pass
            def request(self, method, params, version, target=None, before_send=None):
                calls.append((method,params,version,target))
                if before_send: before_send()
                if method=='initialize': return dict(resultType='success',result=dict(clientId='observer'))
                if method=='thread-owner-discovery': return dict(resultType='success',handledByClientId='original-owner')
                return dict(resultType='success')
        thread='11111111-2222-4333-8444-555555555555'
        turn='11111111-2222-4333-8444-666666666666'
        with ExitStack() as stack:
            stack.enter_context(patch.object(module,'still_failed',return_value=True))
            stack.enter_context(patch.object(module,'Ipc',FakeIpc))
            stack.enter_context(patch.object(module.os,'getuid',return_value=0,create=True))
            stack.enter_context(patch.object(module.pathlib.Path,'exists',return_value=True))
            stack.enter_context(patch.object(module.pathlib.Path,'stat',return_value=SimpleNamespace(st_mode=module.stat.S_IFSOCK,st_uid=0)))
            stack.enter_context(patch.object(module.socket,'socket'))
            stack.enter_context(patch.object(module.socket,'AF_UNIX',1,create=True))
            result=module.retry(dict(threadId=thread,turnId=turn))
        self.assertEqual(result['status'],'sent')
        self.assertEqual(calls[-1],('thread-follower-start-turn',dict(conversationId=thread,turnStart=dict(request=dict(threadId=thread,input=[],turnTrigger='capacity_retry_automatic'))),2,'original-owner'))

    def test_remote_guard_rechecks_exact_failed_turn_and_ignores_quoted_errors(self):
        with tempfile.TemporaryDirectory() as directory:
            home = pathlib.Path(directory).resolve()
            path = home / 'task.jsonl'
            with closing(sqlite3.connect(home / 'state_5.sqlite')) as db:
                db.execute('CREATE TABLE threads(id TEXT, rollout_path TEXT, archived INTEGER)')
                db.execute('INSERT INTO threads VALUES(?,?,0)', ('task', str(path)))
                db.commit()
            failure = dict(type='event_msg', payload=dict(type='task_complete', turn_id='turn', error=ERROR))
            path.write_text(json.dumps(failure), encoding='utf8')
            self.assertTrue(module.still_failed(home, 'task', 'turn'))
            self.assertFalse(module.still_failed(home, 'task', 'another-turn'))
            for payload in [dict(type='task_started'), dict(type='user_message'), dict(type='turn_aborted'), dict(type='approval_requested')]:
                path.write_text(json.dumps(failure)+'\n'+json.dumps(dict(type='event_msg', payload=payload)), encoding='utf8')
                self.assertFalse(module.still_failed(home, 'task', 'turn'))
            path.write_text(json.dumps(dict(type='response_item', payload=dict(type='message', role='assistant', content=[dict(type='output_text', text=ERROR['message'])]))), encoding='utf8')
            self.assertFalse(module.still_failed(home, 'task', 'turn'))

    def test_ipc_frame_fragmentation_and_request_version(self):
        import struct
        class Socket:
            def __init__(self): self.data=b'';self.sent=None
            def sendall(self, data):
                self.sent=json.loads(data[4:])
                response=json.dumps(dict(type='response',requestId=self.sent['requestId'],resultType='success',result={})).encode()
                self.data=struct.pack('<I',len(response))+response
            def settimeout(self, _): pass
            def recv(self, size):
                part,self.data=self.data[:min(3,size)],self.data[min(3,size):]
                return part
        sock=Socket();ipc=module.Ipc(sock)
        response=ipc.request('thread-follower-start-turn', {'conversationId':'t'}, 2, 'owner')
        self.assertEqual(response['resultType'],'success')
        self.assertEqual(sock.sent['version'],2)
        self.assertEqual(sock.sent['targetClientId'],'owner')


if __name__ == '__main__': unittest.main()
