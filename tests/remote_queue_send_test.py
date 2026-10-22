import importlib.util
import json
import pathlib
import sqlite3
import sys
import tempfile
import unittest
from contextlib import closing, ExitStack
from types import SimpleNamespace
from unittest.mock import patch

server=pathlib.Path(__file__).resolve().parents[1]/'server'
sys.path.insert(0,str(server))
import remote_queue_send as module

THREAD='11111111-2222-4333-8444-555555555555'
TURN='11111111-2222-4333-8444-666666666666'
NEXT='11111111-2222-4333-8444-777777777777'
REQUEST=dict(threadId=THREAD,turnId=TURN,text='异步更新 async 与 VLM。')


class QueueSendTest(unittest.TestCase):
    def test_exact_terminal_success_required_and_inspection_does_not_submit(self):
        with tempfile.TemporaryDirectory() as directory:
            home=pathlib.Path(directory).resolve();path=home/'task.jsonl'
            with closing(sqlite3.connect(home/'state_5.sqlite')) as db:
                db.execute('CREATE TABLE threads(id TEXT,rollout_path TEXT,archived INTEGER)')
                db.execute('INSERT INTO threads VALUES(?,?,0)',(THREAD,str(path)));db.commit()
            def write(events):path.write_text('\n'.join(json.dumps(e) for e in events),encoding='utf8')
            def event(typ,**values):return dict(type='event_msg',payload=dict(type=typ,**values))
            complete=event('task_complete',turn_id=TURN)
            for terminal in [event('task_complete',turn_id=TURN,error=dict(codex_error_info='server_overloaded')),event('turn_aborted'),event('approval_requested')]:
                write([terminal]);self.assertFalse(module.still_completed(home,THREAD,TURN))
            write([complete]);self.assertTrue(module.still_completed(home,THREAD,TURN));self.assertFalse(module.still_completed(home,THREAD,NEXT))
            write([complete,event('task_started',turn_id=NEXT)]);self.assertFalse(module.still_completed(home,THREAD,TURN))
            write([complete,event('task_started',turn_id=NEXT),event('user_message',message=REQUEST['text'])])
            result=module.send_queued(dict(REQUEST,operation='inspect'),home)
            self.assertEqual(result,dict(status='observed',turnId=NEXT))
            write([event('task_started',turn_id=NEXT),event('user_message',message=REQUEST['text'])])
            self.assertEqual(module.send_queued(dict(REQUEST,operation='inspect'),home)['status'],'unknown')

    def invoke_ipc(self,checks=(True,True),result='success'):
        calls=[]
        class FakeIpc:
            def __init__(self,sock):pass
            def request(self,method,params,version,target=None,before_send=None):
                calls.append((method,params,version,target))
                if before_send:before_send()
                if method=='initialize':return dict(resultType='success',result=dict(clientId='queue'))
                if method=='thread-owner-discovery':return dict(resultType='success',handledByClientId='owner')
                return dict(resultType=result,error='ambiguous-error')
        with ExitStack() as stack:
            stack.enter_context(patch.object(module,'still_completed',side_effect=checks))
            stack.enter_context(patch.object(module,'Ipc',FakeIpc))
            stack.enter_context(patch.object(module.os,'getuid',return_value=0,create=True))
            stack.enter_context(patch.object(module.pathlib.Path,'exists',return_value=True))
            stack.enter_context(patch.object(module.pathlib.Path,'stat',return_value=SimpleNamespace(st_mode=module.stat.S_IFSOCK,st_uid=0)))
            stack.enter_context(patch.object(module.socket,'socket'))
            stack.enter_context(patch.object(module.socket,'AF_UNIX',1,create=True))
            fallback=stack.enter_context(patch.object(module,'send_without_window',side_effect=AssertionError('must not duplicate')))
            output=module.send_queued(REQUEST)
            fallback.assert_not_called()
        return output,calls

    def test_ipc_sends_exact_text_to_existing_owner_without_model_overrides(self):
        result,calls=self.invoke_ipc()
        self.assertEqual(result['status'],'sent')
        self.assertEqual(calls[-1],('thread-follower-start-turn',dict(conversationId=THREAD,turnStart=dict(request=dict(threadId=THREAD,input=[dict(type='text',text=REQUEST['text'],text_elements=[])]))),2,'owner'))

    def test_state_change_during_owner_lookup_cancels_send(self):
        result,calls=self.invoke_ipc(checks=(True,False))
        self.assertEqual(result['status'],'stale');self.assertEqual(len(calls),2)

    def test_ambiguous_result_does_not_fallback_and_send_twice(self):
        result,_=self.invoke_ipc(result='error');self.assertEqual(result['status'],'unknown')

    def test_headless_sender_rechecks_completion_and_uses_original_task(self):
        calls=[]
        class Process:
            def terminate(self):pass
            def wait(self,timeout):pass
        class Rpc:
            def __init__(self,process):pass
            def notify(self,method):pass
            def request(self,method,params,timeout,before_send=None):
                calls.append((method,params))
                if before_send:before_send()
                if method=='thread/resume':return dict(result=dict(thread=dict(id=THREAD)))
                if method=='turn/start':return dict(result=dict(turn=dict(id=NEXT)))
                return dict(result={})
        with ExitStack() as stack:
            stack.enter_context(patch.object(module.shutil,'which',return_value='/usr/bin/codex'))
            stack.enter_context(patch.object(module.subprocess,'run',return_value=SimpleNamespace(returncode=0)))
            stack.enter_context(patch.object(module.subprocess,'Popen',return_value=Process()))
            stack.enter_context(patch.object(module,'AppServer',Rpc))
            stack.enter_context(patch.object(module,'still_completed',return_value=True))
            result=module.send_without_window(pathlib.Path('/tmp'),REQUEST)
        self.assertEqual(result,dict(status='sent',turnId=NEXT))
        self.assertEqual(calls[-1],('turn/start',module.input_for(REQUEST)))


if __name__=='__main__':unittest.main()
