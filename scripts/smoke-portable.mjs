import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtempSync,writeFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
const root=resolve(process.argv[2]),dir=mkdtempSync(join(tmpdir(),'workbench-portable-smoke-'));
const runtime=join(root,'runtime',process.platform==='win32'?'node.exe':'node');
assert.ok(existsSync(runtime));assert.equal(existsSync(join(root,'.workbench')),false,'Archive must not include user data');
const db=new DatabaseSync(join(dir,'state_5.sqlite')),rollout=join(dir,'sample.jsonl');
writeFileSync(rollout,JSON.stringify({timestamp:new Date().toISOString(),type:'response_item',payload:{type:'message',role:'assistant',phase:'final',content:[{type:'output_text',text:'Portable release test'}]}}));
db.exec('CREATE TABLE threads (id TEXT, title TEXT, cwd TEXT, rollout_path TEXT, updated_at INTEGER, archived INTEGER)');
db.prepare('INSERT INTO threads VALUES (?,?,?,?,?,0)').run('release-test','Release test',dir,rollout,Date.now()/1000);db.close();
const port=44321,url=`http://127.0.0.1:${port}`;
const child=spawn(runtime,['server/hub.mjs'],{cwd:root,env:{...process.env,PORT:String(port),CODEX_HOME:dir,WORKBENCH_DATA:join(dir,'settings')},stdio:['ignore','pipe','pipe']});
const stopped=once(child,'exit');let log='';child.stderr.on('data',b=>log+=b);
try{
 let state;for(let i=0;i<80;i++){try{state=await fetch(url+'/api/state').then(r=>r.json());if(state.threads.length===1)break;}catch{}await new Promise(r=>setTimeout(r,100));}
 assert.equal(state?.threads?.length,1,log);assert.equal(state.threads[0].title,'Release test');
 assert.equal((await fetch(url+'/api/health').then(r=>r.json())).ok,true);
 assert.match(await fetch(url).then(r=>r.text()),/Codex/);
 assert.equal((await fetch(url+'/workbench.svg')).status,200);
 const post=await fetch(url+'/api/meta',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({key:'local:release-test',read:true})});assert.equal(post.status,200);
 console.log('PASS: bundled runtime, production dependencies, isolated data, UI assets, API and read-state persistence');
}finally{child.kill();await stopped;rmSync(dir,{recursive:true,force:true});}
