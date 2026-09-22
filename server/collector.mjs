import {DatabaseSync} from 'node:sqlite';
import {open, stat} from 'node:fs/promises';
import {join, resolve, relative, isAbsolute,toNamespacedPath} from 'node:path';
import {homedir, hostname} from 'node:os';
import {readNativeState} from './native-read-state.mjs';

export function parseEvents(text, now=Date.now(), seed={}) {
  let state=seed.state??'unknown', lastAt=seed.lastAt??null, parentId=seed.parentId??null, messages=[...(seed.messages??[])], revision=seed.revision??'';
  let lastUserAt=seed.lastUserAt??null;
  for(const line of text.split('\n')) {
    let e; try{e=JSON.parse(line);}catch{continue;}
    const p=e.payload??{}, at=e.timestamp;
    if((e.type==='event_msg'&&p.type==='user_message')||(e.type==='response_item'&&p.type==='message'&&p.role==='user')){if(Date.parse(at)>(Date.parse(lastUserAt)||0))lastUserAt=at;}
    if(e.type==='session_meta') parentId=p.forked_from_id??p.forked_from_thread_id??p.source?.subagent?.thread_spawn?.parent_thread_id??null;
    if(e.type==='event_msg') {
      if(['task_started','turn_started'].includes(p.type)) {state='running';lastAt=at;}
      if(['task_complete','task_completed','turn_completed'].includes(p.type)) {state='completed';lastAt=at;}
      if(['turn_aborted','task_interrupted'].includes(p.type)) {state='interrupted';lastAt=at;}
      if(['approval_requested','request_user_input'].includes(p.type)) {state='attention';lastAt=at;}
    }
    if(e.type==='response_item'&&p.type==='message'&&p.role==='assistant') {
      const body=(p.content??[]).filter(c=>c.type==='output_text'||c.type==='text').map(c=>c.text).join('\n');
      if(body) {messages.push({at,text:body.slice(0,16000),phase:p.phase==='final_answer'?'final':p.phase??'unknown'});revision=at??body.slice(-80);}
      if(['final','final_answer'].includes(p.phase)) {state='completed';lastAt=at;}
      if(p.phase==='commentary') {state='running';lastAt=at;}
    }
    if(e.type==='response_item'&&['function_call','custom_tool_call','reasoning'].includes(p.type)) {state='running';lastAt=at;}
    if(state==='running'&&e.type==='event_msg'&&p.type==='token_count')lastAt=at;
  }
  // A stale start is not proof that a process is still alive.
  if(state==='running'&&(!lastAt||now-Date.parse(lastAt)>120000))state='unknown';
  messages=[...new Map(messages.map(m=>[m.at+':'+m.text,m])).values()].sort((a,b)=>Date.parse(a.at)-Date.parse(b.at));
  return {state,lastAt,lastUserAt,parentId,messages:messages.slice(-8),revision};
}

export function createCollector(home=process.env.CODEX_HOME||join(homedir(),'.codex')) {
  const cache=new Map(); let db;
  async function readEvents(path) {
    const rel=relative(toNamespacedPath(resolve(home)),toNamespacedPath(resolve(path)));
    if(rel.startsWith('..')||isAbsolute(rel))return {state:'unknown',messages:[],revision:'',error:'记录路径不在 Codex 目录内'};
    const s=await stat(path), old=cache.get(path);
    if(old?.mtime===s.mtimeMs&&old?.size===s.size) {
      const value={...old.value};
      if(value.state==='running'&&Date.now()-Date.parse(value.lastAt)>120000)value.state='unknown';
      return value;
    }
    const f=await open(path,'r');
    try {
      let count=Math.min(s.size,768*1024),result;
      while(true){const buffer=Buffer.alloc(count);await f.read(buffer,0,count,s.size-count);result=parseEvents(buffer.toString('utf8'),Date.now(),old&&s.size>=old.size?old.value:{});if(result.messages.length||count===s.size||count>=8*1024*1024)break;count=Math.min(s.size,count*2,8*1024*1024);}
      if(!result.parentId&&s.size>count){const head=Buffer.alloc(Math.min(s.size,128*1024));await f.read(head,0,head.length,0);result.parentId=parseEvents(head.toString('utf8')).parentId;}
      cache.set(path,{mtime:s.mtimeMs,size:s.size,value:result}); return result;
    }finally{await f.close();}
  }
  const collect=async()=>{
    db??=new DatabaseSync(join(home,'state_5.sqlite'),{readOnly:true});
    const columns=new Set(db.prepare('PRAGMA table_info(threads)').all().map(c=>c.name));
    const fields=['id','title','cwd','rollout_path','updated_at','name','preview','model','agent_nickname'].filter(c=>columns.has(c));
    const rows=db.prepare(`SELECT ${fields.join(',')} FROM threads WHERE archived=0 ORDER BY updated_at DESC LIMIT 300`).all();
    const threads=[],native=await readNativeState(home);
    // Bounded file reads avoid opening hundreds of descriptors at once.
    for(let i=0;i<rows.length;i+=12)threads.push(...await Promise.all(rows.slice(i,i+12).map(async r=>{
      let event;try{event=await readEvents(r.rollout_path);}catch{event={state:'unknown',messages:[],revision:'',error:'任务记录暂不可读'};}
      return {id:r.id,title:r.name||r.title||'未命名任务',cwd:r.cwd,preview:r.preview??'',updatedAt:r.updated_at*1000,model:r.model??'',...event,
        ...(native?.known.has(r.id)?{nativeUnread:native.unread.has(r.id),nativeReadAt:native.modifiedAt}: {})};
    })));
    return {name:hostname(),platform:process.platform,observedAt:Date.now(),source:'local-records',threads};
  };
  collect.close=()=>{db?.close();db=undefined;};
  return collect;
}
