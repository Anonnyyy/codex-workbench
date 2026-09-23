import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {projectLocation} from '../src/model.js';

test('HTTP API rejects foreign origins, persists organization and prevents parent cycles',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'workbench-api-')),db=new DatabaseSync(join(dir,'state_5.sqlite'));
 db.exec('CREATE TABLE threads (id TEXT, title TEXT, cwd TEXT, rollout_path TEXT, updated_at INTEGER, archived INTEGER)');
 for(const id of ['a','b']){const path=join(dir,id+'.jsonl');writeFileSync(path,JSON.stringify({type:'response_item',timestamp:new Date().toISOString(),payload:{type:'message',role:'assistant',phase:'final',content:[{type:'output_text',text:'Complete'}]}}));db.prepare('INSERT INTO threads VALUES (?,?,?,?,?,0)').run(id,id,dir,path,Date.now()/1000);}db.close();
 const port=44319,base='http://127.0.0.1:'+port;
 const proc=spawn(process.execPath,['server/hub.mjs'],{env:{...process.env,PORT:String(port),CODEX_HOME:dir,WORKBENCH_DATA:join(dir,'app')},stdio:'ignore'});
 const stopped=new Promise(resolve=>proc.on('exit',resolve));
 const request=(path,data,origin)=>fetch(base+'/api/'+path,{method:'POST',headers:{'Content-Type':'application/json',...(origin?{Origin:origin}:{})},body:JSON.stringify(data)});
 try{
  let state;
  for(let i=0;i<40;i++){try{state=await fetch(base+'/api/state').then(r=>r.json());if(state.threads.length===2)break;}catch{}await new Promise(r=>setTimeout(r,100));}
  assert.equal(state.threads.length,2);
  assert.equal((await request('folders',{name:'forbidden'},'https://external.example')).status,403);
  assert.equal((await request('folders',{name:'Work'})).status,200);
  const projectKey='project:local:'+projectLocation(dir).identity;
  assert.equal((await request('project',{key:projectKey,pinned:true})).status,200);
  state=await fetch(base+'/api/state').then(r=>r.json());assert.equal(state.projectMeta[projectKey].pinned,true);
  assert.equal((await request('project',{key:'missing',pinned:true})).status,400);
  assert.equal((await request('read-before',{before:'invalid'})).status,400);
  const baseline=await request('read-before',{before:'2000-01-01T00:00:00Z'}).then(r=>r.json());assert.equal(baseline.count,0);
  assert.equal((await request('project',{key:projectKey,pinned:false})).status,200);
  state=await fetch(base+'/api/state').then(r=>r.json());assert.equal(state.projectMeta[projectKey].pinned,false);
  state=await fetch(base+'/api/state').then(r=>r.json());const folderId=state.folders[0].id;
  assert.equal((await request('meta',{key:'local:a',folderId,read:true})).status,200);
  assert.equal((await request('meta',{key:'local:a',read:true,revision:'stale'})).status,409);
  assert.equal((await request('meta',{key:'local:b',parentKey:'local:a'})).status,200);
  assert.equal((await request('meta',{key:'local:a',parentKey:'local:b'})).status,400);
  state=await fetch(base+'/api/state').then(r=>r.json());assert.equal(state.meta['local:a'].folderId,folderId);assert.ok(state.meta['local:a'].readRevision);
  assert.equal((await request('meta',{key:'local:a',title:'暂存区代码核对'})).status,200);
  state=await fetch(base+'/api/state').then(r=>r.json());assert.equal(state.meta['local:a'].title,'暂存区代码核对');
  assert.equal((await request('meta',{key:'local:a',title:'x'.repeat(101)})).status,400);
  assert.equal((await request('meta',{key:'local:a',title:null})).status,200);
  assert.equal((await request('folder/delete',{id:folderId})).status,200);
  state=await fetch(base+'/api/state').then(r=>r.json());assert.equal(state.threads.length,2);assert.equal(state.meta['local:a'].folderId,null);
  const freshDb=new DatabaseSync(join(dir,'state_5.sqlite')),path=join(dir,'new.jsonl');
  writeFileSync(path,JSON.stringify({timestamp:new Date().toISOString(),type:'event_msg',payload:{type:'task_started'}}));
  freshDb.prepare('INSERT INTO threads VALUES (?,?,?,?,?,0)').run('new','New live task',dir,path,Date.now()/1000);freshDb.close();
  for(let i=0;i<35;i++){state=await fetch(base+'/api/state').then(r=>r.json());if(state.threads.some(t=>t.id==='new'))break;await new Promise(r=>setTimeout(r,100));}
  assert.equal(state.threads.find(t=>t.id==='new')?.state,'running');
  await request('meta',{key:'local:new',read:false});
  state=await fetch(base+'/api/state').then(r=>r.json());
  assert.equal(state.meta['local:new'].forceUnreadRevision,state.threads.find(t=>t.id==='new').revision);
  assert.equal((await request('meta',{key:'local:b',read:false,revision:'stale'})).status,409);
  const result=await request('read-completed',{}).then(r=>r.json());assert.equal(result.ok,true);
  state=await fetch(base+'/api/state').then(r=>r.json());assert.equal(state.meta['local:new'].forceUnread,true);
  assert.equal(state.meta['local:b'].readRevision,state.threads.find(t=>t.id==='b').revision);
  assert.equal((await fetch(base+'/api/health').then(r=>r.json())).ok,true);
 }finally{proc.kill();await stopped;rmSync(dir,{recursive:true});}
});
