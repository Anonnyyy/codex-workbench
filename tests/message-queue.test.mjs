import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {changeMessageQueue,createMessageQueue} from '../server/message-queue.mjs';
import {createStore} from '../server/store.mjs';
import {taskNotification} from '../src/capacityRetry.js';

const task={key:'d:t',id:'t',deviceId:'d',online:true,state:'running',turnStatus:'inProgress',turnId:'original',threadKind:'conversation'};
const completed={...task,state:'completed',turnStatus:'completed',turnError:null};
function setup(send=async()=>({status:'sent'}),inspect=async()=>({status:'unknown'})){
  let state={devices:[{id:'d',type:'ssh'}]},time=1000;
  const store={get:()=>state,save:next=>{state=next;}};
  const engine=createMessageQueue({store,send,inspect,now:()=>time});
  const add=text=>{const id=randomUUID();changeMessageQueue(store,task,{operation:'add',id,text},time);return id;};
  return {store,engine,add,advance:ms=>{time+=ms;},get queue(){return state.messageQueues[task.key];}};
}

test('three-message limit, idempotent add, text validation, editing and order are enforced',()=>{
  const x=setup(),first=x.add('第一条'),second=x.add('第二条');x.add('第三条');
  changeMessageQueue(x.store,task,{operation:'add',id:first,text:'第一条'});
  assert.equal(x.queue.items.length,3);
  assert.throws(()=>x.add('第四条'),/最多缓存/);
  assert.throws(()=>changeMessageQueue(x.store,task,{operation:'edit',id:first,text:' '}),/字符/);
  assert.throws(()=>changeMessageQueue(x.store,task,{operation:'edit',id:first,text:'x'.repeat(8001)}),/字符/);
  changeMessageQueue(x.store,task,{operation:'edit',id:second,text:'修改第二条'});
  changeMessageQueue(x.store,task,{operation:'move',id:second,direction:-1});
  assert.equal(x.queue.items[0].text,'修改第二条');
  changeMessageQueue(x.store,task,{operation:'remove',id:first});assert.equal(x.queue.items.length,2);
});

test('sends in order only after normal completion, and waits through capacity failures and retries',async()=>{
  const sent=[],x=setup(async(t,r)=>{assert.equal(x.queue.items[0].status,'sending');sent.push(r);return {status:'sent'};});
  x.add('one');x.add('two');x.add('three');
  for(const t of [task,{...completed,turnStatus:'inProgress'},{...completed,turnStatus:'failed',turnError:{codex_error_info:'server_overloaded'}},{...completed,online:false},{...completed,state:'attention'},{...completed,turnStatus:'interrupted'}])await x.engine.tick([t]);
  assert.equal(sent.length,0);
  await Promise.all([x.engine.tick([completed]),x.engine.tick([completed])]);assert.deepEqual(sent.map(r=>r.text),['one']);
  await x.engine.tick([completed]);assert.equal(sent.length,1);
  await x.engine.tick([{...task,turnId:'one'}]);
  await x.engine.tick([{...task,turnId:'one',state:'attention',turnStatus:'failed',turnError:{message:'at capacity'}}]);assert.equal(sent.length,1);
  await x.engine.tick([{...task,turnId:'one-retry'}]);assert.equal(sent.length,1);
  await x.engine.tick([{...completed,turnId:'one-retry'}]);assert.deepEqual(sent.map(r=>r.text),['one','two']);
  await x.engine.tick([{...completed,turnId:'two'}]);assert.deepEqual(sent.map(r=>r.text),['one','two','three']);
  await x.engine.tick([{...completed,turnId:'three'}]);assert.equal(x.queue.items.length,0);
  assert.deepEqual(x.queue.history.map(i=>i.text),['one','two','three']);
});

test('pause stops dispatch, edits cannot race a reserved send, and unavailable delivery can retry',async()=>{
  let release,calls=0;
  const x=setup(async()=>{calls++;return calls===1?{status:'unavailable'}:new Promise(resolve=>{release=resolve;});});
  const id=x.add('message');
  changeMessageQueue(x.store,task,{operation:'pause',paused:true});await x.engine.tick([completed]);assert.equal(calls,0);
  changeMessageQueue(x.store,task,{operation:'pause',paused:false});await x.engine.tick([completed]);assert.equal(x.queue.items[0].status,'queued');
  await x.engine.tick([completed]);assert.equal(calls,1);
  x.advance(15000);const flight=x.engine.tick([completed]);
  assert.throws(()=>changeMessageQueue(x.store,task,{operation:'remove',id}),/不能修改/);
  release({status:'sent'});await flight;assert.equal(x.queue.items[0].status,'sent');
});

test('uncertain delivery is inspected without resending and blocks later messages until normal completion',async()=>{
  let calls=0,observed=false;
  const x=setup(async()=>{calls++;return {status:'unknown'};},async()=>observed?{status:'observed',turnId:'first'}:{status:'unknown'});
  x.add('first');x.add('second');await x.engine.tick([completed]);assert.equal(calls,1);
  x.advance(5000);await x.engine.tick([{...completed,turnId:'first'}]);assert.equal(calls,1);assert.equal(x.queue.items.length,2);
  observed=true;x.advance(30000);await x.engine.tick([{...task,turnId:'first'}]);assert.equal(x.queue.items[0].status,'running');assert.equal(calls,1);
  await x.engine.tick([{...completed,turnId:'first'}]);assert.equal(calls,2);assert.equal(x.queue.history.length,1);
});

test('disk restart preserves order and does not resend a reserved message',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'workbench-queue-'));
  try{
    const initial=createStore(dir);initial.save({...initial.get(),devices:[{id:'d',type:'ssh'}]});
    const id=randomUUID();changeMessageQueue(initial,task,{operation:'add',id,text:'persisted'});
    const state=structuredClone(initial.get());Object.assign(state.messageQueues[task.key].items[0],{status:'sending',afterTurnId:'original'});initial.save(state);
    const restarted=createStore(dir);let sends=0;
    const engine=createMessageQueue({store:restarted,send:async()=>{sends++;},inspect:async()=>({status:'unknown'})});
    await engine.tick([completed]);assert.equal(sends,0);assert.equal(restarted.get().messageQueues[task.key].items[0].text,'persisted');
    assert.equal(restarted.get().messageQueues[task.key].items[0].status,'uncertain');
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test('completion notification waits until the queue is empty',()=>{
  assert.equal(taskNotification(completed,{autoRetryCapacity:true},true,{items:[{status:'queued'}],paused:false}),null);
  assert.equal(taskNotification(completed,{autoRetryCapacity:true},true,{items:[],paused:false}),'completed');
});
