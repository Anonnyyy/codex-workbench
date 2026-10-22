import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createReadEventTracker,observeVscodeReads} from '../server/vscode-read-events.mjs';
import {readUpdates} from '../server/live-read-sync.mjs';

const id='11111111-2222-4333-8444-555555555555',revision='2026-10-22T07:55:00.000Z',at=Date.parse(revision)+1000;
const task=extra=>({id,key:'5090:'+id,deviceId:'5090',online:true,state:'completed',revision,...extra});
const event=extra=>({type:'broadcast',method:'thread-read-state-changed',version:3,params:{hostId:'local',conversationId:id,hasUnreadTurn:false},...extra});

test('local UI receipts clear SSH replies only for the observed revision and unique UUID',()=>{
 const track=createReadEventTracker();track.accept(event(),at);
 const t=task();track.apply([t]);assert.equal(t.nativeUnread,false);assert.equal(t.nativeReadSource,'vscode-ui-ipc');
 const later=task({revision:new Date(at+1).toISOString()});track.apply([later]);assert.equal(later.nativeUnread,undefined);
 const storage=task({nativeUnread:false,nativeReadAt:at+500,nativeReadSource:'vscode-storage'});
 track.accept(event({params:{hostId:'local',conversationId:id,hasUnreadTurn:true}}),at+100);
 track.apply([storage]);assert.equal(storage.nativeUnread,true); // An unrelated DB write cannot beat an explicit event.
 track.accept(event(),at+200);
 const duplicated=[task(),task({key:'local:'+id,deviceId:'local'})];track.apply(duplicated);assert.ok(duplicated.every(t=>t.nativeUnread===undefined));
 track.accept(event({version:2}),at+2);assert.equal(readUpdates({threads:[t],meta:{}}).length,1);
 assert.equal(readUpdates({threads:[t],meta:{[t.key]:{forceUnread:true,forceUnreadRevision:revision}}}).length,0);
 assert.equal(readUpdates({threads:[t],meta:{[t.key]:{readRevision:revision}}}).length,0);
});

test('observer handles fragmented frames and never claims task ownership',async()=>{
 const path=process.platform==='win32'?`\\\\.\\pipe\\workbench-test-${process.pid}`:join(tmpdir(),`workbench-test-${process.pid}.sock`);
 const server=net.createServer();await new Promise(resolve=>server.listen(path,resolve));
 const received=[];let peer;
 server.on('connection',socket=>{peer=socket;let buffer=Buffer.alloc(0);
   const send=message=>{const data=Buffer.from(JSON.stringify(message)),frame=Buffer.alloc(data.length+4);frame.writeUInt32LE(data.length);data.copy(frame,4);socket.write(frame.subarray(0,2));setTimeout(()=>socket.write(frame.subarray(2)),5);};
   socket.on('data',part=>{buffer=Buffer.concat([buffer,part]);while(buffer.length>=4&&buffer.length>=buffer.readUInt32LE()+4){const size=buffer.readUInt32LE(),m=JSON.parse(buffer.subarray(4,size+4));buffer=buffer.subarray(size+4);received.push(m);
     if(m.method==='initialize')send({type:'response',requestId:m.requestId,resultType:'success'});
   }});
   setTimeout(()=>send({type:'client-discovery-request',requestId:'discovery'}),30);
   setTimeout(()=>send(event()),60);
 });
 const observer=observeVscodeReads({socketPath:path});
 try{
   const t=task();for(let i=0;i<100;i++){observer.apply([t]);if(t.nativeUnread===false&&received.length===2)break;await new Promise(r=>setTimeout(r,10));}
   assert.equal(observer.connected,true);assert.equal(t.nativeUnread,false);
   assert.deepEqual(received.map(m=>m.method??m.type),['initialize','client-discovery-response']);
   assert.deepEqual(received[1].response,{canHandle:false});
 }finally{observer.close();peer?.destroy();await new Promise(resolve=>server.close(resolve));}
});
