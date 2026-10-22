import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,appendFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createCollector,parseEvents} from '../server/collector.mjs';
import {conversationTasks,unread} from '../src/model.js';

const record=payload=>JSON.stringify({type:'session_meta',payload});
const reply=(text='done')=>JSON.stringify({type:'response_item',timestamp:new Date().toISOString(),payload:{type:'message',role:'assistant',phase:'final',content:[{type:'output_text',text}]}});

test('guardian reviews belong to their task, including nested reviewers',()=>{
  for(const source of [{subagent:{other:'guardian'}},undefined]){
    const parsed=parseEvents(record({source,thread_source:'guardian_review',parent_thread_id:'owner'}));
    assert.equal(parsed.threadKind,'subagent');
    assert.equal(parsed.parentId,'owner');
    const root={id:'owner',key:'d:owner',deviceId:'d',revision:'read',state:'completed'};
    const review={...parsed,key:'d:review',deviceId:'d',parentKey:'d:'+parsed.parentId,revision:'review'};
    const visible=conversationTasks([root,review]);
    assert.equal(visible.length,1);
    assert.equal(visible[0].internalTasks.length,1);
    assert.equal(unread(visible[0],{'d:owner':{readRevision:'read'}}),false);
  }
});

test('inherited session headers cannot replace a child session identity',()=>{
  const own=record({source:{subagent:{thread_spawn:{parent_thread_id:'owner'}}}});
  const inherited=record({source:'vscode',forked_from_id:'grandparent'});
  const parsed=parseEvents(own+'\n'+inherited);
  assert.equal(parsed.threadKind,'subagent');
  assert.equal(parsed.parentId,'owner');
});

test('collector reads large first metadata records and keeps grouping after cache updates',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'workbench-metadata-'));
  const db=new DatabaseSync(join(dir,'state_5.sqlite')),collect=createCollector(dir);
  try{
    db.exec('CREATE TABLE threads (id TEXT, title TEXT, cwd TEXT, rollout_path TEXT, updated_at INTEGER, archived INTEGER, source TEXT, thread_source TEXT)');
    for(const [id,source,threadSource] of [
      ['agent',{subagent:{thread_spawn:{parent_thread_id:'owner'}}},'subagent'],
      ['review',{subagent:{other:'guardian'}},'guardian_review'],
      ['fork','vscode','user'],
    ]){
      const path=join(dir,id+'.jsonl');
      db.prepare('INSERT INTO threads VALUES (?,?,?,?,?,0,?,?)').run(id,id,dir,path,1,JSON.stringify(source),threadSource);
      // Real resumed sessions carry a large first header and copied parent headers.
      const own=record({id,source,thread_source:threadSource,parent_thread_id:id==='fork'?undefined:'owner',forked_from_id:'history',padding:'x'.repeat(160000)});
      await writeFile(path,[own,record({source:'vscode'}),JSON.stringify({type:'tool_result',payload:{text:'x'.repeat(900000)}}),reply()].join('\n'));
    }
    const check=threads=>{
      for(const t of threads){
        assert.equal(t.threadKind,t.id==='fork'?'conversation':'subagent',t.id);
        assert.equal(t.parentId,t.id==='fork'?'history':'owner',t.id);
      }
    };
    check((await collect()).threads);
    check((await collect()).threads);
    await appendFile(join(dir,'agent.jsonl'),'\n'+record({source:'vscode'})+'\n'+reply('new'));
    check((await collect()).threads);
  }finally{collect.close();db.close();await rm(dir,{recursive:true,force:true});}
});
