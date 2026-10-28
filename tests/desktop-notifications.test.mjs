import test from 'node:test';
import assert from 'node:assert/strict';
import {createDesktopController,createDesktopApi} from '../server/desktop-notifications.mjs';
import {usesDesktopNotifications,desktopNotificationUrl,desktopNotificationsRequest} from '../src/desktopNotifications.js';

const task=(key='local:a',extra={})=>({key,id:key,deviceId:'local',online:true,title:'Task',cwd:'C:/Work/robot',revision:'r1',turnId:'turn1',state:'running',turnStatus:'inProgress',...extra});
const done=(key,extra={})=>task(key,{state:'completed',turnStatus:'completed',revision:'r2',...extra});
const state=(threads,meta={})=>({threads,devices:[{id:'local',online:true}],meta,capacityRetries:{}});

test('desktop dismissal does not mark read or repeat, and old card clicks cannot dismiss a newer reply',async()=>{
  const opened=[],controller=createDesktopController({enabled:true,open:key=>opened.push(key)});
  const a=done(),snapshot=state([a]);
  await controller.update(state([task()]));await controller.update(snapshot);
  const old=controller.items()[0];assert.ok(old.body.includes('robot'));
  controller.handle({action:'dismiss',id:old.id});
  await controller.update(snapshot);assert.equal(controller.items().length,0);assert.deepEqual(snapshot.meta,{});
  await controller.update(state([done(undefined,{revision:'r3',turnId:'turn2'})]));
  const next=controller.items()[0];
  controller.handle({action:'open',id:old.id});assert.equal(controller.items().length,1);assert.deepEqual(opened,[]);
  controller.handle({action:'open',id:next.id});assert.deepEqual(opened,['local:a']);assert.equal(controller.items().length,0);
});

test('desktop cards disappear on read or answer; the same question is not replayed',async()=>{
  const controller=createDesktopController({enabled:true});
  await controller.update(state([task(),task('local:b')]));
  const question=task('local:b',{state:'attention',attentionKind:'question',attentionAt:'q1',revision:'r2'});
  await controller.update(state([done(),question]));assert.equal(controller.items().length,2);
  await controller.update(state([done(),{...question,revision:'r3'}]));assert.equal(controller.items().length,2);
  await controller.update(state([done(),question],{'local:a':{readRevision:'r2'}}));assert.equal(controller.items().length,1);
  await controller.update(state([done(),task('local:b')],{'local:a':{readRevision:'r2'}}));assert.equal(controller.items().length,0);
});

test('turning desktop reminders off clears all cards and does not replay activity on re-enable',async()=>{
  const controller=createDesktopController({enabled:true});
  await controller.update(state([task()]));await controller.update(state([done()]));
  await controller.test();assert.equal(controller.items().length,2);
  controller.setEnabled(false);assert.equal(controller.items().length,0);
  await controller.update(state([done(undefined,{revision:'r3',turnId:'turn2'})]));
  controller.setEnabled(true);await controller.update(state([done(undefined,{revision:'r3',turnId:'turn2'})]));
  assert.equal(controller.items().length,0);
});

test('desktop API permits the workbench, rejects foreign origins and invalid settings',async()=>{
  const controller=createDesktopController(),saved=[];
  const server=createDesktopApi({controller,hubPort:45319,persist:value=>saved.push(value),status:()=>({ready:true})});
  await new Promise(resolve=>server.listen(45320,'127.0.0.1',resolve));
  const request=(path,body,origin='http://127.0.0.1:45319',type='application/json')=>fetch('http://127.0.0.1:45320'+path,{method:'POST',headers:{Origin:origin,'Content-Type':type},body:JSON.stringify(body)});
  try{
    const health=await fetch('http://127.0.0.1:45320/health',{headers:{Origin:'http://127.0.0.1:45319'}});
    assert.equal(health.headers.get('access-control-allow-origin'),'http://127.0.0.1:45319');
    assert.equal((await health.json()).service,'codex-desktop-notifications');
    assert.equal((await request('/settings',{enabled:true},'https://external.example')).status,403);
    assert.equal((await request('/settings',{enabled:true},'null')).status,403);
    assert.equal((await request('/settings',{enabled:true},undefined,'text/plain')).status,415);
    assert.equal((await request('/settings',{enabled:'yes'})).status,400);
    assert.equal((await request('/settings',{enabled:true})).status,200);assert.equal(controller.enabled,true);
    assert.equal((await request('/test',{})).status,200);assert.equal(controller.items().length,1);
    assert.equal((await request('/settings',{enabled:false})).status,200);assert.equal(controller.items().length,0);
    assert.deepEqual(saved,[true,false]);
  }finally{await new Promise(resolve=>server.close(resolve));}
});

test('Windows loopback pages select desktop reminders without asking for browser permission',async()=>{
  assert.equal(usesDesktopNotifications({navigator:{platform:'Win32'},location:{hostname:'127.0.0.1'}}),true);
  assert.equal(usesDesktopNotifications({navigator:{platform:'Linux x86_64'},location:{hostname:'localhost'}}),false);
  assert.equal(usesDesktopNotifications({navigator:{platform:'Win32'},location:{hostname:'example.com'}}),false);
  assert.equal(desktopNotificationUrl({port:'24319'}),'http://127.0.0.1:24320');
  assert.equal(desktopNotificationUrl({port:'5173'}),'http://127.0.0.1:24320');
  await assert.rejects(desktopNotificationsRequest('/health',undefined,{location:{port:'24319'},fetch:async()=>({ok:true,json:async()=>({service:'another-app'})})}),/重新运行/);
});
