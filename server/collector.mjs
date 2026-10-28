import {DatabaseSync} from 'node:sqlite';
import {open, stat} from 'node:fs/promises';
import {join, resolve, relative, isAbsolute,toNamespacedPath} from 'node:path';
import {homedir, hostname} from 'node:os';
import {readNativeState} from './native-read-state.mjs';

export function parseEvents(text, now=Date.now(), seed={}) {
  let state=seed.state??'unknown', lastAt=seed.lastAt??null, parentId=seed.parentId??null, messages=[...(seed.messages??[])], revision=seed.revision??'';
  let lastUserAt=seed.lastUserAt??null;
  let turnId=seed.turnId??null,turnStatus=seed.turnStatus??null,turnError=seed.turnError??null,attentionKind=seed.attentionKind??null,attentionAt=seed.attentionAt??null;
  let attentionCallId=seed.attentionCallId??null,attentionAsync=seed.attentionAsync??false;
  let threadKind=seed.threadKind,metadataSeen=false;
  const advanceRevision=at=>{if(at&&Date.parse(at)>(Date.parse(revision)||0))revision=at;};
  for(const line of text.split('\n')) {
    let e; try{e=JSON.parse(line);}catch{continue;}
    const p=e.payload??{}, at=e.timestamp;
    if((e.type==='event_msg'&&p.type==='user_message')||(e.type==='response_item'&&p.type==='message'&&p.role==='user')){
      if(Date.parse(at)>(Date.parse(lastUserAt)||0)){lastUserAt=at;turnError=null;turnStatus='inProgress';}
      if(attentionKind&&(!attentionAt||Date.parse(at)>=Date.parse(attentionAt))){attentionKind=null;attentionAt=null;state='running';lastAt=at;advanceRevision(at);}
    }
    if(e.type==='session_meta'&&!metadataSeen) {
      metadataSeen=true;
      const spawn=p.source?.subagent?.thread_spawn;
      const internal=!!spawn||['subagent','guardian_review'].includes(p.thread_source)||p.source?.subagent?.other==='guardian';
      parentId=spawn?.parent_thread_id??(internal?p.parent_thread_id:undefined)??p.forked_from_id??p.forked_from_thread_id??null;
      if(p.source!=null||p.thread_source!=null)threadKind=internal?'subagent':'conversation';
    }
    if(e.type==='event_msg') {
      if(['task_started','turn_started'].includes(p.type)) {state='running';lastAt=at;advanceRevision(at);turnId=p.turn_id??p.turnId??null;turnStatus='inProgress';turnError=null;attentionKind=null;attentionAt=null;}
      if(['task_complete','task_completed','turn_completed'].includes(p.type)) {
        turnId=p.turn_id??p.turnId??turnId;turnError=p.error??null;
        turnStatus=turnError?'failed':'completed';state=turnError||attentionKind==='question'?'attention':'completed';lastAt=at;
        if(turnError||attentionKind!=='question'){attentionKind=null;attentionAt=null;}
        if(turnError)advanceRevision(at);
      }
      if(['turn_aborted','task_interrupted'].includes(p.type)) {state='interrupted';lastAt=at;turnStatus='interrupted';turnError=null;attentionKind=null;attentionAt=null;}
      if(['approval_requested','request_user_input'].includes(p.type)) {state='attention';lastAt=at;attentionKind=p.type==='request_user_input'?'question':'approval';attentionAt=at;advanceRevision(at);}
    }
    if(e.type==='response_item'&&p.type==='message'&&p.role==='assistant') {
      const body=(p.content??[]).filter(c=>c.type==='output_text'||c.type==='text').map(c=>c.text).join('\n');
      if(body) {messages.push({at,text:body.slice(0,16000),phase:p.phase==='final_answer'?'final':p.phase??'unknown'});if(at)advanceRevision(at);else if(!revision)revision=body.slice(-80);}
      if(['final','final_answer'].includes(p.phase)&&attentionKind!=='question') {state='completed';lastAt=at;attentionKind=null;attentionAt=null;}
      if(p.phase==='commentary'&&!attentionKind) {state='running';lastAt=at;}
    }
    if(e.type==='response_item'&&['function_call','custom_tool_call'].includes(p.type)&&/(?:^|[.:])request_user_input(?:_async)?$/.test(p.name??'')) {state='attention';lastAt=at;attentionKind='question';attentionAt=at;attentionCallId=p.call_id??null;attentionAsync=p.name.endsWith('_async');advanceRevision(at);}
    if(e.type==='response_item'&&['function_call_output','custom_tool_call_output'].includes(p.type)&&attentionKind==='question'&&attentionCallId&&p.call_id===attentionCallId){
      let output=p.output;try{output=JSON.parse(output);}catch{}
      // Async {accepted:true} only acknowledges displaying the question.
      if(!attentionAsync||(output&&typeof output==='object'&&Object.hasOwn(output,'answers'))){state='running';lastAt=at;attentionKind=null;attentionAt=null;attentionCallId=null;attentionAsync=false;advanceRevision(at);}
    }
    if(e.type==='response_item'&&['function_call','custom_tool_call','reasoning'].includes(p.type)&&!attentionKind) {state='running';lastAt=at;}
    if(state==='running'&&e.type==='event_msg'&&p.type==='token_count')lastAt=at;
  }
  // A stale start is not proof that a process is still alive.
  if(state==='running'&&(!lastAt||now-Date.parse(lastAt)>120000))state='unknown';
  messages=[...new Map(messages.map(m=>[m.at+':'+m.text,m])).values()].sort((a,b)=>Date.parse(a.at)-Date.parse(b.at));
  if(!attentionKind){attentionCallId=null;attentionAsync=false;}
  return {state,lastAt,lastUserAt,parentId,threadKind,turnId,turnStatus,turnError,attentionKind,attentionAt,attentionCallId,attentionAsync,messages:messages.slice(-8),revision};
}

export function createCollector(home=process.env.CODEX_HOME||join(homedir(),'.codex')) {
  const cache=new Map(); let db;
  async function readEvents(path) {
    const rel=relative(toNamespacedPath(resolve(home)),toNamespacedPath(resolve(path)));
    if(rel.startsWith('..')||isAbsolute(rel))return {state:'unknown',messages:[],revision:'',error:'记录路径不在 Codex 目录内'};
    const s=await stat(path), old=cache.get(path);
    if(old?.metadataVersion===2&&old?.mtime===s.mtimeMs&&old?.size===s.size) {
      const value={...old.value};
      if(value.state==='running'&&Date.now()-Date.parse(value.lastAt)>120000)value.state='unknown';
      return value;
    }
    const f=await open(path,'r');
    try {
      let count=Math.min(s.size,768*1024),result;
      while(true){const buffer=Buffer.alloc(count);await f.read(buffer,0,count,s.size-count);result=parseEvents(buffer.toString('utf8'),Date.now(),old&&s.size>=old.size?old.value:{});if(result.messages.length||count===s.size||count>=8*1024*1024)break;count=Math.min(s.size,count*2,8*1024*1024);}
      // Resumed/forked files can contain copied session headers. Only the first
      // complete record describes this file; newer headers belong to history.
      let headSize=Math.min(s.size,128*1024);
      while(true){
        const head=Buffer.alloc(headSize);await f.read(head,0,head.length,0);
        const end=head.indexOf(10);
        if(end>=0||headSize===s.size){
          const metadata=parseEvents(head.subarray(0,end>=0?end:headSize).toString('utf8'));
          if(metadata.threadKind!=null){result.parentId=metadata.parentId;result.threadKind=metadata.threadKind;}
          break;
        }
        if(headSize>=8*1024*1024)break;
        headSize=Math.min(s.size,headSize*2,8*1024*1024);
      }
      cache.set(path,{mtime:s.mtimeMs,size:s.size,metadataVersion:2,value:result}); return result;
    }finally{await f.close();}
  }
  const collect=async()=>{
    db??=new DatabaseSync(join(home,'state_5.sqlite'),{readOnly:true});
    const columns=new Set(db.prepare('PRAGMA table_info(threads)').all().map(c=>c.name));
    const fields=['id','title','cwd','rollout_path','updated_at','name','preview','model','agent_nickname','source','thread_source'].filter(c=>columns.has(c));
    const rows=db.prepare(`SELECT ${fields.join(',')} FROM threads WHERE archived=0 ORDER BY updated_at DESC LIMIT 300`).all();
    const threads=[],native=await readNativeState(home);
    // Bounded file reads avoid opening hundreds of descriptors at once.
    for(let i=0;i<rows.length;i+=12)threads.push(...await Promise.all(rows.slice(i,i+12).map(async r=>{
      let event;try{event=await readEvents(r.rollout_path);}catch{event={state:'unknown',messages:[],revision:'',error:'任务记录暂不可读'};}
      // Database provenance also repairs cached metadata from older collectors.
      let source=r.source;try{source=JSON.parse(source);}catch{}
      const metadata=parseEvents(JSON.stringify({type:'session_meta',payload:{source,thread_source:r.thread_source}}));
      if(metadata.threadKind!=null)event={...event,threadKind:metadata.threadKind,parentId:metadata.parentId??event.parentId};
      return {id:r.id,title:r.name||r.title||'未命名任务',cwd:r.cwd,preview:r.preview??'',updatedAt:r.updated_at*1000,model:r.model??'',...event,
        ...(native?.known.has(r.id)?{nativeUnread:native.unread.has(r.id),nativeReadAt:native.modifiedAt}: {})};
    })));
    return {name:hostname(),platform:process.platform,observedAt:Date.now(),source:'local-records',threads};
  };
  collect.close=()=>{db?.close();db=undefined;};
  return collect;
}
