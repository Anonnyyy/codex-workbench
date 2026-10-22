import test from 'node:test';
import assert from 'node:assert/strict';
import {vscodeReadSnapshot,createVscodeReadTracker} from '../server/vscode-read-state.mjs';
import {unread} from '../src/model.js';
const revision='2026-09-22T10:20:25.476Z',at=Date.parse(revision)+100;
const snapshot=(ids=[],time=at,activity=null)=>vscodeReadSnapshot({'persisted-atom-state':{
 'unread-thread-ids-by-host-v1':{local:ids},
 'thread-reference-capability:camera':true,
 ...(activity==null?{}:{'thread-user-activity-times-v1':{'["local","camera"]':activity}}),
}},time);
const task=(extra={})=>({id:'camera',key:'local:camera',deviceId:'local',state:'completed',revision,...extra});

test('VS Code known tasks bootstrap read; unknown schemas and tasks remain unknown',()=>{
 assert.equal(vscodeReadSnapshot({},at),null);
 const threads=[task(),task({id:'unknown',key:'5090:unknown'})];createVscodeReadTracker()(snapshot(),threads);
 assert.equal(unread(threads[0],{}),false);assert.equal(unread(threads[1],{}),true);
 assert.equal(unread(threads[0],{[threads[0].key]:{forceUnread:true}}),true);
});
test('unrelated SQLite writes do not mark future replies read; actual native transition does',()=>{
 const track=createVscodeReadTracker();track(snapshot(),[task()]);
 const next=task({revision:new Date(at+1000).toISOString()});
 track(snapshot([],at+2000),[next]);assert.equal(unread(next,{}),true);
 track(snapshot(['camera'],at+2100),[next]);track(snapshot([],at+2200),[next]);assert.equal(unread(next,{}),false);
});
test('viewing a thread already open after a new reply clears that reply only',()=>{
 const track=createVscodeReadTracker();track(snapshot(),[task()]);
 const next=task({revision:new Date(at+1000).toISOString()});
 track(snapshot([],at+2000,at-100),[next]);assert.equal(unread(next,{}),true);
 track(snapshot([],at+3000,at+2500),[next]);assert.equal(unread(next,{}),false);
 const later=task({revision:new Date(at+4000).toISOString()});
 track(snapshot([],at+5000,at+2500),[later]);assert.equal(unread(later,{}),true);
});
test('running, ambiguous duplicate IDs and stale read snapshots never clear unread',()=>{
 for(const threads of [[task({state:'running'})],[task(),task({key:'other:camera',deviceId:'other'})],[task({key:'5090:camera',deviceId:'5090'})]]){
  createVscodeReadTracker()(snapshot(),threads);assert.ok(threads.every(t=>unread(t,{})));
 }
 const t=task();createVscodeReadTracker()(snapshot([],at-1000),[t]);assert.equal(unread(t,{}),true);
});
test('native receipt persists for only its exact reply; manual unread wins',()=>{
 const t=task(),meta={[t.key]:{nativeReadRevision:revision}};
 assert.equal(unread(t,meta),false);assert.equal(unread({...t,revision:'new'},meta),true);
 meta[t.key].forceUnread=true;assert.equal(unread(t,meta),true);
});

test('the shared VS Code UI matches known SSH task UUIDs and rejects duplicated IDs',()=>{
 const remote=task({deviceId:'5090',key:'5090:camera'});
 const track=createVscodeReadTracker({sharedUi:true});
 track(snapshot(),[remote]);assert.equal(unread(remote,{}),false);
 const next=task({deviceId:'5090',key:'5090:camera',revision:new Date(at+1000).toISOString()});
 track(snapshot([],at+2000),[next]);assert.equal(unread(next,{}),true);
 track(snapshot(['camera'],at+2100),[next]);track(snapshot([],at+2200),[next]);assert.equal(unread(next,{}),false);
 const duplicate=[task(),task({deviceId:'5090',key:'5090:camera'})];
 createVscodeReadTracker({sharedUi:true})(snapshot(),duplicate);
 assert.ok(duplicate.every(t=>unread(t,{})));
});

test('manual unread applies to one reply and cannot hide a later native read receipt',()=>{
 const old=task(),next=task({revision:new Date(at+1000).toISOString()});
 const meta={[old.key]:{forceUnread:true,forceUnreadRevision:old.revision,nativeReadRevision:old.revision}};
 assert.equal(unread(old,meta),true);
 assert.equal(unread(next,meta),true); // A new unseen reply still needs attention.
 meta[old.key].nativeReadRevision=next.revision;
 assert.equal(unread(next,meta),false); // Reading that reply clears its badge.
 assert.equal(unread(task({state:'running',revision:new Date(at+2000).toISOString()}),meta),true);
});
