import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {createSystemNotifier} from '../src/systemNotifications.js';

const task=(key='local:a',extra={})=>({key,id:key,deviceId:'local',online:true,title:'Task',revision:'r1',turnId:'turn1',state:'running',turnStatus:'inProgress',...extra});
const completed=(key='local:a',extra={})=>task(key,{state:'completed',turnStatus:'completed',revision:'r2',...extra});
const snapshot=(threads,meta={})=>({threads,meta,devices:[{id:'local',online:true}],capacityRetries:{}});
function registry(){
  const items=[],calls=[];
  const worker={getNotifications:async()=>items.filter(n=>!n.closed),showNotification:async(title,options)=>{
    calls.push({title,...options});
    const item={...options,closed:false,close(){this.closed=true;}};items.push(item);
  }};
  return {items,calls,registration:async()=>worker};
}

test('completion and questions use one system notification per reply and read closes only that reply',async()=>{
  const r=registry(),update=createSystemNotifier(r);
  await update(snapshot([task(),task('local:b')]));
  const a=completed(),b=task('local:b',{state:'attention',attentionKind:'question'});
  await update(snapshot([a,b]));
  assert.equal(r.calls.length,2);assert.equal(r.calls[1].data.notice,'question');
  await update(snapshot([a,b]));assert.equal(r.calls.length,2);
  await update(snapshot([a,b],{[a.key]:{readRevision:a.revision}}));
  assert.equal(r.items[0].closed,true);assert.equal(r.items[1].closed,false);
  const later=completed(a.key,{revision:'r3',turnId:'turn2'});
  await update(snapshot([later,b],{[a.key]:{readRevision:a.revision}}));
  assert.equal(r.calls.length,3);assert.equal(r.calls[2].data.revision,'r3');
});

test('a new page reconciles retained notifications without replaying historical completions',async()=>{
  const r=registry(),a=completed();
  const old=createSystemNotifier(r);await old(snapshot([task()]));await old(snapshot([a]));
  const refreshed=createSystemNotifier(r);
  await refreshed(snapshot([a],{[a.key]:{readRevision:a.revision}}));
  assert.equal(r.items[0].closed,true);assert.equal(r.calls.length,1);
});

test('capacity errors and denied notification permission never produce notifications',async()=>{
  const r=registry(),update=createSystemNotifier(r);
  await update(snapshot([task()]));
  await update(snapshot([completed('local:a',{turnStatus:'failed',turnError:{codex_error_info:'server_overloaded'}})]));
  assert.equal(r.calls.length,0);
  let touched=false;
  const disabled=createSystemNotifier({enabled:()=>false,registration:async()=>{touched=true;throw Error('must not register');}});
  await disabled(snapshot([task()]));await disabled(snapshot([completed()]));assert.equal(touched,false);
});

test('notification click closes the toast and opens the corresponding task in an existing window',async()=>{
  const listeners={},messages=[];let closed=false,focused=false,pending;
  const client={url:'http://127.0.0.1:24319/',postMessage:m=>messages.push(m),focus:async()=>{focused=true;}};
  const self={location:{origin:'http://127.0.0.1:24319'},addEventListener:(name,fn)=>{listeners[name]=fn;},clients:{matchAll:async()=>[client]}};
  vm.runInNewContext(await readFile(new URL('../public/reminder-worker.js',import.meta.url),'utf8'),{self,URL,encodeURIComponent});
  listeners.notificationclick({notification:{data:{key:'local:a'},close:()=>{closed=true;}},waitUntil:p=>{pending=p;}});
  await pending;assert.equal(closed,true);assert.equal(focused,true);assert.deepEqual(JSON.parse(JSON.stringify(messages)),[{type:'open-reminder',key:'local:a'}]);
});
