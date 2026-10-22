import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createStore} from '../server/store.mjs';
import {parseEvents} from '../server/collector.mjs';
import {createCapacityRecovery} from '../server/capacity-recovery.mjs';
import {isCapacityError,taskNotification,capacityRetryCount} from '../src/capacityRetry.js';

const error={message:'Selected model is at capacity. Please try a different model.',codex_error_info:'server_overloaded'};
const event=(type,payload,at=100000)=>JSON.stringify({type,timestamp:new Date(at).toISOString(),payload});
const failed={key:'d:t',id:'t',deviceId:'d',online:true,threadKind:'conversation',state:'attention',turnStatus:'failed',turnId:'turn-1',turnError:error,lastAt:new Date(100000).toISOString()};
function setup(send=async()=>({status:'sent'})){
  let state={devices:[{id:'d',type:'ssh',autoRetryCapacity:true,capacityRetrySince:0}]},time=100000;
  const store={get:()=>state,save:s=>{state=s;}};
  const engine=createCapacityRecovery({store,send,now:()=>time});
  return {engine,store,advance:ms=>{time+=ms;}};
}

test('real capacity task_complete is a failure; quotes and transient stream errors do not trigger retry',()=>{
  const text=[event('event_msg',{type:'task_started',turn_id:'turn-1'},99000),event('event_msg',{type:'task_complete',turn_id:'turn-1',last_agent_message:null,error})].join('\n');
  const parsed=parseEvents(text,100000);
  assert.equal(parsed.state,'attention');assert.equal(parsed.turnStatus,'failed');assert.equal(parsed.turnId,'turn-1');assert.ok(isCapacityError(parsed.turnError));
  const quote=parseEvents(event('response_item',{type:'message',role:'assistant',phase:'final',content:[{type:'output_text',text:error.message}]}));
  assert.equal(quote.turnError,null);
  const transient=parseEvents(event('event_msg',{type:'stream_error',error}));assert.equal(transient.turnError,null);
  const resumed=parseEvents(event('event_msg',{type:'task_started',turn_id:'turn-2'},110000),110000,parsed);
  assert.equal(resumed.turnError,null);assert.equal(resumed.turnStatus,'inProgress');
  const success=parseEvents(event('event_msg',{type:'task_complete',turn_id:'turn-2',error:null},120000),120000,resumed);
  assert.equal(success.turnStatus,'completed');assert.equal(success.state,'completed');
});

test('only normal completion notifies on enabled devices, including final text before terminal failure',()=>{
  const d={autoRetryCapacity:true};
  for(const task of [failed,{...failed,state:'completed'},{state:'completed',turnStatus:'inProgress'},{state:'interrupted',turnStatus:'interrupted'}])assert.equal(taskNotification(task,d),null);
  assert.equal(taskNotification({state:'attention',turnStatus:'inProgress'},d),'attention');
  assert.equal(taskNotification({state:'completed',turnStatus:'completed',turnError:null},d),'completed');
  assert.equal(taskNotification({state:'attention'},{}),'attention');
  assert.equal(taskNotification({state:'completed'},{type:'ssh'},false),null);
  assert.equal(taskNotification({state:'completed'},{type:'local'},false),'completed');
});

test('a question or approval notifies while automatic capacity retry is enabled',()=>{
  const d={type:'ssh',autoRetryCapacity:true};
  const question=parseEvents([event('event_msg',{type:'task_started',turn_id:'turn-1'},100000),event('event_msg',{type:'request_user_input'},101000)].join('\n'),101000);
  assert.equal(question.state,'attention');
  assert.equal(question.attentionKind,'question');
  assert.equal(taskNotification(question,d),'question');
  const approval=parseEvents([event('event_msg',{type:'task_started',turn_id:'turn-1'},100000),event('event_msg',{type:'approval_requested'},101000)].join('\n'),101000);
  assert.equal(taskNotification(approval,d),'attention');
  const answered=parseEvents(event('event_msg',{type:'user_message'},102000),102000,question);
  assert.equal(answered.attentionKind,null);
  assert.equal(taskNotification(answered,d),null);
  const replayed=parseEvents([event('event_msg',{type:'request_user_input'},101000),event('event_msg',{type:'user_message'},102000),event('event_msg',{type:'token_count'},103000)].join('\n'),103000,answered);
  assert.equal(replayed.attentionKind,null);
  assert.equal(taskNotification(replayed,d),null);
  const asyncQuestion=parseEvents([event('response_item',{type:'function_call',name:'functions.request_user_input_async'},101000),event('event_msg',{type:'task_complete',error:null},102000)].join('\n'),102000);
  assert.equal(asyncQuestion.attentionKind,'question');
  assert.equal(taskNotification(asyncQuestion,d),'question');
});

test('dispatches immediately, reserves before sending, and survives restart without duplicates',async()=>{
  const sends=[];const x=setup(async(t,r)=>{assert.equal(x.store.get().capacityRetries[t.key].status,'sending');sends.push(r);return {status:'sent'};});
  await x.engine.tick([failed]);assert.equal(sends.length,1);
  await Promise.all([x.engine.tick([failed]),x.engine.tick([failed])]);assert.equal(sends.length,1);
  x.advance(999999);await x.engine.tick([failed]);assert.equal(sends.length,1);
  const restarted=createCapacityRecovery({store:x.store,send:async()=>{throw Error('must not resend');},now:()=>2000000});
  await restarted.tick([failed]);assert.equal(x.store.get().capacityRetries[failed.key].status,'sent');
  await x.engine.tick([{...failed,turnId:'turn-2'}]);assert.equal(sends.length,2);
  await x.engine.tick([{...failed,turnId:'turn-3',turnStatus:'completed',turnError:null,state:'completed'}]);assert.equal(x.store.get().capacityRetries[failed.key].status,'completed');
  assert.equal(capacityRetryCount(x.store.get().capacityRetries[failed.key]),2);
  assert.deepEqual(x.store.get().capacityRetries[failed.key].history.map(h=>h.status),['sent','sent']);
});

test('offline, disabled, old, running, interrupted, manual input, other failures and subagents never dispatch',async()=>{
  let calls=0;const x=setup(async()=>{calls++;return {status:'sent'};});
  const variants=[{online:false},{threadKind:'subagent'},{turnStatus:'inProgress'},{turnStatus:'interrupted'},{turnError:{message:'rate limit'}},{lastUserAt:new Date(110000).toISOString()}];
  for(const patch of variants){await x.engine.tick([{...failed,...patch}]);x.advance(200000);await x.engine.tick([{...failed,...patch}]);}
  x.store.get().devices[0].capacityRetrySince=100001;await x.engine.tick([failed]);
  x.store.get().devices[0].autoRetryCapacity=false;await x.engine.tick([failed]);assert.equal(calls,0);
});

test('each new capacity failure retries immediately even after many attempts',async()=>{
  let calls=0;const x=setup(async()=>{calls++;return {status:'sent'};});
  x.store.get().capacityRetries={'d:t':{failedTurnId:'old',attempts:50,totalAttempts:50,status:'sent',history:[]}};
  await x.engine.tick([failed]);assert.equal(calls,1);
  const latest={...failed,turnId:'turn-2'};
  await x.engine.tick([latest]);assert.equal(calls,2);
});

test('unavailable owner is retried next snapshot; uncertain delivery and disabled retry never resend',async()=>{
  let calls=0;const x=setup(async()=>{calls++;return {status:calls===1?'unavailable':'unknown'};});
  await x.engine.tick([failed]);assert.equal(calls,1);
  await x.engine.tick([failed]);assert.equal(calls,2);
  x.advance(200000);await x.engine.tick([failed]);assert.equal(calls,2);
  assert.equal(capacityRetryCount(x.store.get().capacityRetries[failed.key]),2);
  assert.deepEqual(x.store.get().capacityRetries[failed.key].history.map(h=>h.status),['unavailable','unknown']);
  x.store.get().devices[0].autoRetryCapacity=false;await x.engine.tick([{...failed,turnId:'turn-2'}]);x.advance(200000);await x.engine.tick([{...failed,turnId:'turn-2'}]);assert.equal(calls,2);
});

test('old unavailable backoff is cancelled immediately after restarting',async()=>{
  let calls=0;const x=setup(async()=>{calls++;return {status:'sent'};});
  x.store.get().capacityRetries={'d:t':{failedTurnId:failed.turnId,failedAt:100000,attempts:5,totalAttempts:5,status:'unavailable',nextAt:220000,history:[]}};
  await x.engine.tick([failed]);assert.equal(calls,1);
  assert.equal(x.store.get().capacityRetries[failed.key].status,'sent');
});

test('a slow owner cannot block other failed tasks or cause duplicate concurrent sends',async()=>{
  let release;const blocked=new Promise(resolve=>{release=resolve;});const calls=[];
  const x=setup(async t=>{calls.push(t.key);if(t.key===failed.key)await blocked;return {status:'sent'};});
  const other={...failed,key:'d:other',id:'other'};
  const first=x.engine.tick([failed,other]);
  try{
    assert.deepEqual(calls,['d:t','d:other']);
    await x.engine.tick([failed,other]);assert.equal(calls.length,2);
    assert.equal(x.store.get().capacityRetries[other.key].status,'sent');
  }finally{release();await first;}
  assert.equal(x.store.get().capacityRetries[failed.key].status,'sent');
});

test('counts survive completion, disk reload and later recovery; recent history is bounded without resetting totals',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'capacity-counts-'));
  try{
    let store=createStore(directory),time=100000;
    store.save({...store.get(),devices:[{id:'d',type:'ssh',autoRetryCapacity:true,capacityRetrySince:0}]});
    const makeEngine=()=>createCapacityRecovery({store,send:async()=>({status:'sent',message:'已触发原任务重试'}),now:()=>time});
    let engine=makeEngine();
    await engine.tick([failed]);time+=15000;await engine.tick([failed]);
    await engine.tick([{...failed,turnStatus:'completed',turnError:null,state:'completed'}]);
    store=createStore(directory);engine=makeEngine();
    assert.equal(store.get().capacityRetries[failed.key].attempts,0);
    assert.equal(capacityRetryCount(store.get().capacityRetries[failed.key]),1);
    assert.equal(store.get().capacityRetries[failed.key].history[0].status,'sent');
    for(let n=2;n<=24;n++){
      const task={...failed,turnId:'turn-'+n};
      await engine.tick([task]);time+=120000;await engine.tick([task]);
    }
    store=createStore(directory);
    const record=store.get().capacityRetries[failed.key];
    assert.equal(capacityRetryCount(record),24);assert.equal(record.history.length,20);
    assert.equal(record.history[0].number,5);assert.equal(record.history.at(-1).number,24);
    store.get().devices[0].autoRetryCapacity=false;engine=makeEngine();
    await engine.tick([{...failed,turnStatus:'completed',turnError:null}]);
    assert.equal(capacityRetryCount(store.get().capacityRetries[failed.key]),24);
    assert.equal(store.get().capacityRetries[failed.key].status,'completed');
  }finally{rmSync(directory,{recursive:true,force:true});}
});

test('upgrades legacy counters once without inventing missing attempt outcomes',()=>{
  let state={devices:[],capacityRetries:{'d:t':{attempts:3,attemptedAt:100000,failedTurnId:'turn-1',status:'sent',message:'已触发原任务重试'}}};
  const store={get:()=>state,save:s=>{state=s;}};
  createCapacityRecovery({store,send:async()=>{throw Error('must not send');}});
  assert.equal(capacityRetryCount(state.capacityRetries['d:t']),3);
  assert.equal(state.capacityRetries['d:t'].history.length,1);
  assert.equal(state.capacityRetries['d:t'].history[0].number,3);
  createCapacityRecovery({store,send:async()=>{throw Error('must not send');}});
  assert.equal(state.capacityRetries['d:t'].history.length,1);
});
