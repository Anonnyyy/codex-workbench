import test from 'node:test';
import assert from 'node:assert/strict';
import {Writable} from 'node:stream';
import {once} from 'node:events';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createEventFeed} from '../server/event-feed.mjs';
import {resolveWorkspaces} from '../server/vscode-workspaces.mjs';
import {groupProjects,projectIsActive} from '../src/model.js';

test('live view removes a closed pinned project on next snapshot, retaining its history',()=>{
 const thread={id:'task',key:'remote:task',deviceId:'remote',deviceName:'5090',cwd:'/work/FUTURE_EMER',state:'running',online:true,updatedAt:Date.now()};
 const device={id:'remote',name:'5090',online:true,processes:[{cwd:'/work/FUTURE_EMER',cwdSource:'vscode-workspace'}]};
 const opened=groupProjects([thread],[device])[0];assert.equal(projectIsActive(opened.projects[0],opened),true);
 const closed=groupProjects([thread],[{...device,processes:[]}])[0];
 assert.equal(closed.projects[0].running,1); // Stale transcript is not process evidence.
 closed.projects[0].pinned=true;
 assert.equal(projectIsActive(closed.projects[0],closed),false);assert.equal(closed.projects[0].threads.length,1);
 const reopened=groupProjects([thread],[device])[0];assert.equal(projectIsActive(reopened.projects[0],reopened),true);
});

test('sleeping SSE clients keep at most one snapshot and receive latest after resuming',async()=>{
 let version=0,release;const received=[];
 const res=new Writable({highWaterMark:16,write(chunk,encoding,done){received.push(String(chunk));release=done;}});
 const feed=createEventFeed(()=>({version,content:'x'.repeat(32768)}));feed.add(res);
 for(version=1;version<=2000;version++){feed.broadcast();feed.heartbeat();}
 assert.equal(received.length,1);assert.ok(feed.stats().pendingBytes<33000);
 const drained=once(res,'drain');release();await drained;
 feed.broadcast();assert.equal(received.length,2);assert.ok(received[1].includes('"version":2001'));
 release();res.destroy();await once(res,'close');assert.equal(feed.stats().clients,0);
});

test('Remote-SSH workspace metadata matches the live process and correct host',async()=>{
 const base=mkdtempSync(join(tmpdir(),'workbench-workspace-')),id='a'.repeat(32);
 try{
  mkdirSync(join(base,id));writeFileSync(join(base,id,'workspace.json'),JSON.stringify({folder:'vscode-remote://ssh-remote%2B5090/home/demo/code/FUTURE_EMER'}));
  const process={pid:123,cwd:'/home/demo',workspaceId:id},d={id:'remote',name:'5090',host:'192.0.2.10',online:true};
  const resolved=await resolveWorkspaces(d,[process],base);
  assert.equal(resolved[0].cwd,'/home/demo/code/FUTURE_EMER');assert.equal(resolved[0].processCwd,'/home/demo');
  const groups=groupProjects([],[{...d,processes:resolved}]);
  assert.equal(groups[0].projects[0].name,'FUTURE_EMER');assert.equal(groups[0].projects[0].processCount,1);
  assert.equal(groups[0].projects[0].threads.length,0);assert.equal(groups[0].projects[0].running,0);
  assert.equal(groupProjects([],[{...d,processes:resolved}],{},{includeOpenProjects:false}).length,0);
  assert.equal(groupProjects([],[{...d,online:false,processes:resolved}]).length,0);
  const other=await resolveWorkspaces({name:'other',host:'192.0.2.1'},[process],base);assert.equal(other[0].cwd,'/home/demo');
  const invalid=await resolveWorkspaces(d,[{...process,workspaceId:'../outside'}],base);assert.equal(invalid[0].cwd,'/home/demo');
 }finally{rmSync(base,{recursive:true});}
});
