import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {createSystemNotifier,closeSystemNotifications,systemNotificationsEnabled,setSystemNotificationsEnabled} from '../src/systemNotifications.js';

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
  await update(snapshot([task(),task('remote:b',{deviceId:'remote'})]));
  const a=completed('local:a',{cwd:'C:\\Users\\demo\\Projects\\论文修改\\'}),b=task('remote:b',{deviceId:'remote',deviceName:'5090',cwd:'/data/projects/grail/',state:'attention',attentionKind:'question'});
  await update(snapshot([a,b]));
  assert.equal(r.calls.length,2);assert.equal(r.calls[1].data.notice,'question');
  assert.equal(r.calls[0].title,'Codex 工作台 · 本机');
  assert.equal(r.calls[0].body,'文件夹：论文修改\nTask · 已完成');
  assert.equal(r.calls[1].title,'Codex 工作台 · 5090');
  assert.equal(r.calls[1].body,'文件夹：grail\nTask · 等待你回答');
  assert.ok(r.calls.every(notification=>notification.requireInteraction===false));
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

test('refresh closes legacy sticky banners without reading or replaying their tasks',async()=>{
  const r=registry(),worker=await r.registration(),a=completed();
  await worker.showNotification('old',{tag:'codex-workbench:'+a.key,requireInteraction:true,data:{key:a.key,revision:a.revision}});
  await worker.showNotification('other',{tag:'another-app',requireInteraction:true});
  const current=snapshot([a]),update=createSystemNotifier(r);
  await update(current);await update(current);
  assert.equal(r.items[0].closed,true);assert.equal(r.items[1].closed,false);
  assert.equal(r.calls.length,2);assert.deepEqual(current.meta,{});
});

test('worker upgrade clears only legacy sticky workbench banners',async()=>{
  const r=registry(),worker=await r.registration(),listeners={};let pending,claimed=false;
  for(const [tag,requireInteraction] of [['codex-workbench:old',true],['codex-workbench:new',false],['another-app',true]]){
    await worker.showNotification('test',{tag,requireInteraction});
  }
  const self={registration:worker,addEventListener:(name,fn)=>{listeners[name]=fn;},clients:{claim:async()=>{claimed=true;}}};
  vm.runInNewContext(await readFile(new URL('../public/reminder-worker.js',import.meta.url),'utf8'),{self});
  listeners.activate({waitUntil:p=>{pending=p;}});await pending;
  assert.deepEqual(r.items.map(n=>n.closed),[true,false,false]);assert.equal(claimed,true);
});

test('Windows migration clears all old browser banners, including non-sticky and test notices',async()=>{
  const r=registry(),worker=await r.registration(),listeners={};let pending;
  for(const tag of ['codex-workbench:a','codex-workbench-test','another-app'])await worker.showNotification('test',{tag,requireInteraction:false});
  const self={navigator:{platform:'Win32'},registration:worker,addEventListener:(name,fn)=>{listeners[name]=fn;},clients:{claim:async()=>{}}};
  vm.runInNewContext(await readFile(new URL('../public/reminder-worker.js',import.meta.url),'utf8'),{self});
  listeners.activate({waitUntil:p=>{pending=p;}});await pending;
  assert.deepEqual(r.items.map(n=>n.closed),[true,true,false]);
});

test('one unanswered question does not notify again for commentary or reconnect',async()=>{
  const r=registry(),update=createSystemNotifier(r);
  await update(snapshot([task()]));
  const question=task('local:a',{state:'attention',attentionKind:'question',attentionAt:'q1',revision:'r2'});
  await update(snapshot([question]));
  await update(snapshot([{...question,revision:'r3'}]));
  assert.equal(r.calls.length,1);assert.equal(r.items[0].closed,false);
  r.items[0].close(); // Dismissing a toast must not make commentary repeat it.
  await update(snapshot([{...question,revision:'r4',online:false}]));
  await update(snapshot([{...question,revision:'r4',online:true}]));
  assert.equal(r.calls.length,1);
  await update(snapshot([{...question,attentionAt:'q2',revision:'r5'}]));
  assert.equal(r.calls.length,2);
});

test('resuming work closes an answered question even without a new reply revision',async()=>{
  const r=registry(),update=createSystemNotifier(r);
  await update(snapshot([task()]));
  await update(snapshot([task('local:a',{state:'attention',attentionKind:'question',attentionAt:'q1'})]));
  assert.equal(r.calls.length,1);
  await update(snapshot([task()]));
  assert.equal(r.items[0].closed,true);
});

test('answer received during slow registration suppresses the obsolete question',async()=>{
  const r=registry(),worker=await r.registration();let release,entered,delay=false;
  const ready=new Promise(resolve=>{entered=resolve;});
  const update=createSystemNotifier({registration:async()=>{
    if(delay){entered();await new Promise(resolve=>{release=resolve;});}return worker;
  }});
  await update(snapshot([task()]));delay=true;
  const pending=update(snapshot([task('local:a',{state:'attention',attentionKind:'question',attentionAt:'q1'})]));
  await ready;delay=false;
  const answered=update(snapshot([task()]));release();await Promise.all([pending,answered]);
  assert.equal(r.calls.length,0);
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

test('the app off preference survives reload even when browser permission remains granted',()=>{
  const saved=new Map(),storage={getItem:key=>saved.get(key)??null,setItem:(key,value)=>saved.set(key,value)};
  const page=()=>({Notification:{permission:'granted'},localStorage:storage});
  assert.equal(systemNotificationsEnabled(page()),true);
  setSystemNotificationsEnabled(false,storage);
  assert.equal(systemNotificationsEnabled(page()),false);
  setSystemNotificationsEnabled(true,storage);
  assert.equal(systemNotificationsEnabled(page()),true);
  assert.equal(systemNotificationsEnabled({Notification:{permission:'denied'},localStorage:storage}),false);
});

test('turning reminders off closes task and test notifications without touching unrelated notifications',async()=>{
  const r=registry(),worker=await r.registration();
  for(const tag of ['codex-workbench:local:a','codex-workbench-test','another-app'])await worker.showNotification('test',{tag});
  await closeSystemNotifications(worker);
  assert.deepEqual(r.items.map(n=>n.closed),[true,true,false]);
});

test('turning reminders back on does not replay completions received while off',async()=>{
  let enabled=true;
  const r=registry(),update=createSystemNotifier({...r,enabled:()=>enabled});
  await update(snapshot([task()]));enabled=false;
  await update(snapshot([completed()]));enabled=true;
  await update(snapshot([completed()]));assert.equal(r.calls.length,0);
  await update(snapshot([completed('local:a',{revision:'r3',turnId:'turn2'})]));
  assert.equal(r.calls.length,1);
});

test('disabling while registration is pending cancels the queued notification',async()=>{
  let enabled=true,release,entered;
  const ready=new Promise(resolve=>{entered=resolve;}),r=registry();
  const worker=await r.registration();
  let delay=false;
  const update=createSystemNotifier({enabled:()=>enabled,registration:async()=>{
    if(delay){entered();await new Promise(resolve=>{release=resolve;});}return worker;
  }});
  await update(snapshot([task()]));delay=true;
  const pending=update(snapshot([completed()]));await ready;
  enabled=false;release();await pending;assert.equal(r.calls.length,0);
});

test('disabling while a toast is being created closes it after creation finishes',async()=>{
  let enabled=true,release,entered;
  const ready=new Promise(resolve=>{entered=resolve;}),r=registry(),worker=await r.registration();
  const show=worker.showNotification;
  worker.showNotification=async(...args)=>{entered();await new Promise(resolve=>{release=resolve;});await show(...args);};
  const update=createSystemNotifier({...r,enabled:()=>enabled});
  await update(snapshot([task()]));const pending=update(snapshot([completed()]));await ready;
  enabled=false;await closeSystemNotifications(worker);release();await pending;
  assert.equal(r.calls.length,1);assert.equal(r.items[0].closed,true);
});

test('notification click closes the toast and opens the corresponding task in an existing window',async()=>{
  const listeners={},messages=[];let closed=false,focused=false,pending;
  const client={url:'http://127.0.0.1:24319/',postMessage:m=>messages.push(m),focus:async()=>{focused=true;}};
  const self={location:{origin:'http://127.0.0.1:24319'},addEventListener:(name,fn)=>{listeners[name]=fn;},clients:{matchAll:async()=>[client]}};
  vm.runInNewContext(await readFile(new URL('../public/reminder-worker.js',import.meta.url),'utf8'),{self,URL,encodeURIComponent});
  listeners.notificationclick({notification:{data:{key:'local:a'},close:()=>{closed=true;}},waitUntil:p=>{pending=p;}});
  await pending;assert.equal(closed,true);assert.equal(focused,true);assert.deepEqual(JSON.parse(JSON.stringify(messages)),[{type:'open-reminder',key:'local:a'}]);
});
