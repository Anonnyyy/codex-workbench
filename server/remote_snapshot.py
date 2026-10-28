"""Read-only SSH collector; executed from stdin-sized source, no remote installation."""
import os, sys, json, sqlite3, time, platform, pathlib, datetime, re

home = pathlib.Path(os.environ.get('CODEX_HOME', pathlib.Path.home() / '.codex')).resolve()
cache = {}
read_events = ReadEvents(home).start()

def workspace_id(process):
    # Codex inherits the extension host's log descriptor. Its lock record gives
    # the exact workspace ID even when Remote-SSH starts Codex in the home dir.
    try:
        for fd in (process/'fd').iterdir():
            try:
                target=pathlib.Path(os.readlink(fd))
                if target.name!='remoteexthost.log': continue
                with target.open() as f: head=f.read(16384)
                match=re.search(r'/workspaceStorage/([a-f0-9]{32})(?:-\d+)?/vscode\.lock',head)
                if match: return match.group(1)
            except OSError: pass
    except OSError: pass
    return None
def millis(stamp):
    try: return datetime.datetime.fromisoformat(stamp.replace('Z', '+00:00')).timestamp() * 1000
    except Exception: return 0

def events(path):
    resolved = pathlib.Path(path).resolve()
    if home not in resolved.parents: raise ValueError('outside Codex home')
    info = resolved.stat()
    old = cache.get(str(resolved))
    if old and old[0] == (info.st_mtime_ns, info.st_size):
        value = dict(old[1])
        if value['state'] == 'running' and time.time()*1000-millis(value['lastAt'])>120000: value['state']='unknown'
        return value
    with resolved.open('rb') as f:
        first = f.readline(8*1024*1024)
        f.seek(max(0, info.st_size-786432)); text = f.read().decode('utf-8', 'replace')
    seed = old[1] if old and info.st_size>=old[0][1] else {}
    state, last, revision, parent, messages = seed.get('state','unknown'), seed.get('lastAt'), seed.get('revision',''), seed.get('parentId'), list(seed.get('messages',[]))
    last_user=seed.get('lastUserAt')
    turn_id,turn_status,turn_error=seed.get('turnId'),seed.get('turnStatus'),seed.get('turnError')
    attention_kind,attention_at=seed.get('attentionKind'),seed.get('attentionAt')
    attention_call_id,attention_async=seed.get('attentionCallId'),seed.get('attentionAsync',False)
    thread_kind=seed.get('threadKind')
    try:
        p = json.loads(first).get('payload', {})
        source=p.get('source')
        subagent=source.get('subagent') if isinstance(source,dict) else None
        spawn=subagent.get('thread_spawn') if isinstance(subagent,dict) else None
        internal = isinstance(spawn,dict) or p.get('thread_source') in ('subagent','guardian_review') or (isinstance(subagent,dict) and subagent.get('other')=='guardian')
        parent = (spawn.get('parent_thread_id') if isinstance(spawn,dict) else None) or (p.get('parent_thread_id') if internal else None) or p.get('forked_from_id') or p.get('forked_from_thread_id')
        if source is not None or p.get('thread_source') is not None: thread_kind='subagent' if internal else 'conversation'
    except Exception: pass
    for line in text.splitlines():
        try: event = json.loads(line)
        except Exception: continue
        p, at = event.get('payload') or {}, event.get('timestamp')
        kind, typ = event.get('type'), p.get('type')
        if (kind=='event_msg' and typ=='user_message') or (kind=='response_item' and typ=='message' and p.get('role')=='user'):
            if millis(at)>millis(last_user):
                last_user,turn_status,turn_error=at,'inProgress',None
            if attention_kind and (not attention_at or millis(at)>=millis(attention_at)):
                state,last,attention_kind,attention_at='running',at,None,None
                if millis(at)>millis(revision): revision=at
        if kind=='event_msg':
            if typ in ('task_started','turn_started'):
                state,last='running',at
                turn_id,turn_status,turn_error,attention_kind,attention_at=p.get('turn_id',p.get('turnId')),'inProgress',None,None,None
                if millis(at)>millis(revision): revision=at
            if typ in ('task_complete','task_completed','turn_completed'):
                turn_id,turn_error=p.get('turn_id',p.get('turnId',turn_id)),p.get('error')
                turn_status='failed' if turn_error else 'completed'
                state,last='attention' if turn_error or attention_kind=='question' else 'completed',at
                if turn_error or attention_kind!='question': attention_kind,attention_at=None,None
                if turn_error and millis(at)>millis(revision): revision=at
            if typ in ('turn_aborted','task_interrupted'):
                state,last,turn_status,turn_error,attention_kind,attention_at='interrupted',at,'interrupted',None,None,None
            if typ in ('approval_requested','request_user_input'):
                state,last,attention_kind,attention_at='attention',at,'question' if typ=='request_user_input' else 'approval',at
                if millis(at)>millis(revision): revision=at
            if state=='running' and typ=='token_count': last=at
        if kind=='response_item' and typ=='message' and p.get('role')=='assistant':
            body='\n'.join(c.get('text','') for c in p.get('content',[]) if c.get('type') in ('text','output_text'))
            if body:
                messages.append({'at':at,'text':body[:16000],'phase':'final' if p.get('phase')=='final_answer' else p.get('phase','unknown')})
                if millis(at)>millis(revision): revision=at
                elif not revision: revision=body[-80:]
            if p.get('phase') in ('final','final_answer') and attention_kind!='question': state,last,attention_kind,attention_at='completed',at,None,None
            if p.get('phase')=='commentary' and not attention_kind: state,last='running',at
        if kind=='response_item' and typ in ('function_call','custom_tool_call') and (p.get('name') or '').rsplit('.',1)[-1].rsplit(':',1)[-1] in ('request_user_input','request_user_input_async'):
            state,last,attention_kind,attention_at='attention',at,'question',at
            attention_call_id,attention_async=p.get('call_id'),p.get('name','').endswith('_async')
            if millis(at)>millis(revision): revision=at
        if kind=='response_item' and typ in ('function_call_output','custom_tool_call_output') and attention_kind=='question' and attention_call_id and p.get('call_id')==attention_call_id:
            output=p.get('output')
            try: output=json.loads(output)
            except (ValueError,TypeError): pass
            if not attention_async or (isinstance(output,dict) and 'answers' in output):
                state,last,attention_kind,attention_at,attention_call_id,attention_async='running',at,None,None,None,False
                if millis(at)>millis(revision): revision=at
        if kind=='response_item' and typ in ('function_call','custom_tool_call','reasoning') and not attention_kind: state,last='running',at
    if state=='running' and time.time()*1000-millis(last)>120000: state='unknown'
    messages=list({(m['at'],m['text']):m for m in messages}.values())
    messages.sort(key=lambda m: m['at'] or '')
    if not attention_kind: attention_call_id,attention_async=None,False
    value={'state':state,'lastAt':last,'lastUserAt':last_user,'parentId':parent,'turnId':turn_id,'turnStatus':turn_status,'turnError':turn_error,'attentionKind':attention_kind,'attentionAt':attention_at,'attentionCallId':attention_call_id,'attentionAsync':attention_async,'messages':messages[-8:],'revision':revision}
    if thread_kind is not None: value['threadKind']=thread_kind
    cache[str(resolved)]=((info.st_mtime_ns,info.st_size),value)
    return value

def snapshot():
    db=sqlite3.connect((home/'state_5.sqlite').as_uri()+'?mode=ro',uri=True,timeout=2)
    db.row_factory=sqlite3.Row
    cols={r[1] for r in db.execute('pragma table_info(threads)')}
    fields=[c for c in ('id','title','cwd','rollout_path','updated_at','name','preview','model','source','thread_source') if c in cols]
    rows=db.execute('select '+','.join(fields)+' from threads where archived=0 order by updated_at desc limit 300').fetchall()
    db.close(); threads=[]
    read_marks = read_events.snapshot()
    for row in rows:
        r=dict(row)
        try: e=events(r['rollout_path'])
        except Exception: e={'state':'unknown','messages':[],'revision':'','error':'Task record unavailable'}
        source=r.get('source')
        try: source=json.loads(source)
        except (ValueError,TypeError): pass
        subagent=source.get('subagent') if isinstance(source,dict) else None
        spawn=subagent.get('thread_spawn') if isinstance(subagent,dict) else None
        if source is not None or r.get('thread_source') is not None:
            internal=isinstance(spawn,dict) or r.get('thread_source') in ('subagent','guardian_review') or (isinstance(subagent,dict) and subagent.get('other')=='guardian')
            e=dict(e,threadKind='subagent' if internal else 'conversation')
            if isinstance(spawn,dict) and spawn.get('parent_thread_id'): e['parentId']=spawn['parent_thread_id']
        threads.append(dict(id=r['id'],title=r.get('name') or r['title'] or 'Untitled',cwd=r['cwd'],preview=r.get('preview') or '',updatedAt=r['updated_at']*1000,model=r.get('model') or '',**e,**read_marks.get(r['id'],{})))
    processes=[]
    if sys.platform=='linux':
        for p in pathlib.Path('/proc').iterdir():
            if not p.name.isdigit(): continue
            try:
                cmd=(p/'cmdline').read_bytes().split(b'\x00')
                executable=pathlib.Path(cmd[0].decode()).name
                if executable=='codex' or executable=='codex.exe':
                    try: process_cwd=os.readlink(p/'cwd')
                    except OSError: process_cwd=None
                    if p.stat().st_uid!=os.getuid(): continue
                    processes.append({'pid':int(p.name),'kind':'app-server' if b'app-server' in cmd else 'cli','cwd':process_cwd,'workspaceId':workspace_id(p)})
            except Exception: pass
    return {'name':platform.node(),'platform':sys.platform,'observedAt':int(time.time()*1000),'source':'ssh-records','readSyncConnected':read_events.connected,'processes':processes,'threads':threads}

while True:
    try: print(json.dumps(snapshot(),ensure_ascii=False),flush=True)
    except Exception as e: print(json.dumps({'error':str(e)}),flush=True)
    time.sleep(3)
