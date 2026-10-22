"""Send one queued user message only after the exact preceding turn completed."""
import json
import os
import pathlib
import shutil
import socket
import sqlite3
import stat
import subprocess
import sys
import uuid
from contextlib import closing
from remote_capacity_retry import Ipc, AppServer


def task_state(home, thread_id, expected_turn, text=None):
    with closing(sqlite3.connect((home/'state_5.sqlite').as_uri()+'?mode=ro', uri=True)) as db:
        row=db.execute('SELECT rollout_path FROM threads WHERE id=? AND archived=0', (thread_id,)).fetchone()
    if not row:
        return None, None
    path=pathlib.Path(row[0]).resolve()
    if home not in path.parents:
        return None, None
    terminal=None
    current_turn=None
    anchored=False
    observed=None
    with path.open('rb') as stream:
        stream.seek(0, 2)
        stream.seek(max(0, stream.tell()-2*1024*1024))
        for line in stream:
            try:
                event=json.loads(line)
            except (ValueError, UnicodeDecodeError):
                continue
            p=event.get('payload') or {}
            kind, typ=event.get('type'), p.get('type')
            if kind=='event_msg':
                if typ in ('task_complete','task_completed','turn_completed'):
                    terminal=p
                    if p.get('turn_id',p.get('turnId'))==expected_turn:
                        anchored=True
                elif typ in ('task_started','turn_started'):
                    current_turn=p.get('turn_id',p.get('turnId'))
                    terminal=None
                elif typ in ('user_message','turn_aborted','task_interrupted','approval_requested','request_user_input'):
                    terminal=None
            is_user=(kind=='event_msg' and typ=='user_message') or (kind=='response_item' and typ=='message' and p.get('role')=='user')
            if is_user:
                body=p.get('message') if typ=='user_message' else '\n'.join(c.get('text','') for c in p.get('content',[]) if c.get('type') in ('text','input_text'))
                if anchored and text is not None and body==text and current_turn and current_turn!=expected_turn:
                    observed=current_turn
                terminal=None
            if kind=='response_item' and (typ in ('function_call','custom_tool_call','reasoning') or (typ=='message' and p.get('role')=='assistant')):
                terminal=None
    return terminal, observed


def still_completed(home, thread_id, turn_id):
    terminal,_=task_state(home,thread_id,turn_id)
    return terminal is not None and terminal.get('turn_id',terminal.get('turnId'))==turn_id and not terminal.get('error')


def input_for(request):
    return dict(threadId=request['threadId'],input=[dict(type='text',text=request['text'],text_elements=[])])


def send_without_window(home, request):
    binary=shutil.which('codex')
    if not binary:
        return dict(status='unavailable',message='等待原任务的 Codex 窗口打开')
    attempted=False
    try:
        started=subprocess.run([binary,'app-server','daemon','start'],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=6)
        if started.returncode:
            return dict(status='unavailable',message='Codex 后台暂不可用')
        process=subprocess.Popen([binary,'app-server','proxy'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,bufsize=0)
        try:
            rpc=AppServer(process)
            initialized=rpc.request('initialize',dict(clientInfo=dict(name='codex-workbench-queue',title='Codex Workbench',version='0.1.0'),capabilities=None),4)
            if 'error' in initialized:
                return dict(status='unavailable',message='Codex 通信版本不兼容')
            rpc.notify('initialized')
            resumed=rpc.request('thread/resume',dict(threadId=request['threadId'],excludeTurns=True),5)
            if resumed.get('result',{}).get('thread',{}).get('id')!=request['threadId']:
                return dict(status='unavailable',message='无法恢复原任务')
            if not still_completed(home,request['threadId'],request['turnId']):
                return dict(status='stale',message='原任务状态已变化，继续等待正常完成')
            def mark_attempted():
                nonlocal attempted
                attempted=True
            response=rpc.request('turn/start',input_for(request),7,before_send=mark_attempted)
            turn_id=response.get('result',{}).get('turn',{}).get('id')
            return dict(status='sent',turnId=turn_id) if turn_id else dict(status='unknown')
        finally:
            process.terminate()
            try:
                process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                process.kill()
    except Exception:
        return dict(status='unknown' if attempted else 'unavailable')


def send_queued(request, home=None):
    home=(home or pathlib.Path(os.environ.get('CODEX_HOME',pathlib.Path.home()/'.codex'))).resolve()
    thread_id,turn_id=request['threadId'],request['turnId']
    uuid.UUID(thread_id);uuid.UUID(turn_id)
    if not isinstance(request.get('text'),str) or not request['text'].strip() or len(request['text'])>8000:
        raise ValueError('Invalid message')
    if request.get('operation')=='inspect':
        _,observed=task_state(home,thread_id,turn_id,request['text'])
        return dict(status='observed',turnId=observed) if observed else dict(status='unknown')
    if not still_completed(home,thread_id,turn_id):
        return dict(status='stale',message='原任务尚未正常完成')
    attempted=False
    try:
        candidates=[home/'ipc/ipc.sock',pathlib.Path('/tmp/codex-ipc')/('ipc-%s.sock'%os.getuid())]
        path=next(p for p in candidates if p.exists() and stat.S_ISSOCK(p.stat().st_mode) and p.stat().st_uid==os.getuid())
        with socket.socket(socket.AF_UNIX,socket.SOCK_STREAM) as sock:
            sock.settimeout(10);sock.connect(str(path));ipc=Ipc(sock)
            initialized=ipc.request('initialize',dict(clientType='codex-workbench-queue'),0)
            if initialized.get('resultType')!='success':
                return dict(status='unavailable',message='Codex 通信版本不兼容')
            ipc.client_id=initialized['result']['clientId']
            owner=ipc.request('thread-owner-discovery',dict(hostId='local',conversationId=thread_id),1)
            if owner.get('resultType')!='success' or not owner.get('handledByClientId'):
                return send_without_window(home,request)
            if not still_completed(home,thread_id,turn_id):
                return dict(status='stale',message='原任务状态已变化，继续等待正常完成')
            def mark_attempted():
                nonlocal attempted
                attempted=True
            response=ipc.request('thread-follower-start-turn',dict(conversationId=thread_id,turnStart=dict(request=input_for(request))),2,owner['handledByClientId'],before_send=mark_attempted)
            if response.get('resultType')=='success':
                return dict(status='sent')
            if response.get('error') in ('no-client-found','version-mismatch'):
                return send_without_window(home,request)
            return dict(status='unknown')
    except StopIteration:
        return send_without_window(home,request)
    except Exception:
        return dict(status='unknown' if attempted else 'unavailable')


if __name__=='__main__':
    try:
        print(json.dumps(send_queued(json.load(sys.stdin)),ensure_ascii=False))
    except Exception:
        print(json.dumps(dict(status='unavailable',message='无法检查原任务状态'),ensure_ascii=False))
