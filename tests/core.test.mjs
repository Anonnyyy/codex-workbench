import test from 'node:test';
import assert from 'node:assert/strict';
import {parseEvents,createCollector} from '../server/collector.mjs';
import {unread,unreadTone,unreadSummary,treeRows,parentOf,projectLocation,groupProjects,markReadBefore,markCompletedRead,recentConversations} from '../src/model.js';
import {nativeReadSnapshot} from '../server/native-read-state.mjs';
import {createStore} from '../server/store.mjs';
import {mkdtempSync,rmSync,writeFileSync,appendFileSync,statSync,utimesSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {tmpdir} from 'node:os';
import {join,toNamespacedPath} from 'node:path';
const now=Date.now(),at=new Date(now).toISOString();
test('completed-only read cleanup preserves running and interrupted unread and organization',()=>{
 const threads=['completed','running','interrupted','attention'].map(state=>({key:state,state,online:true,revision:'r1'}));
 const meta={completed:{folderId:'f',forceUnread:true},running:{forceUnread:true}};
 assert.equal(markCompletedRead(threads,meta),1);assert.equal(unread(threads[0],meta),false);assert.equal(meta.completed.folderId,'f');
 for(const t of threads.slice(1))assert.equal(unread(t,meta),true);
 assert.equal(unread({...threads[0],revision:'r2'},meta),true);
});
test('native read state requires explicit host mapping and never overrides manual unread or running',()=>{
 const snapshot=nativeReadSnapshot({'electron-thread-read-state-v1':{version:1,unreadByIdentity:{account:{'local:home':['unseen']}},legacyMigration:{identityKey:'account',adoptedHostIds:{local:'local:home'}}},'projectless-thread-ids':['seen','unseen']},now);
 assert.ok(snapshot.known.has('seen'));assert.equal(snapshot.unread.has('seen'),false);
 const t={key:'seen',revision:new Date(now-1000).toISOString(),state:'completed',nativeUnread:false,nativeReadAt:now};
 assert.equal(unread(t,{}),false);assert.equal(unread(t,{seen:{forceUnread:true}}),true);
 assert.equal(unread({...t,state:'running'},{}),true);assert.equal(unread({...t,nativeReadAt:now-2000},{}),true);
 assert.equal(nativeReadSnapshot({},now),null);
});
test('historical read baseline preserves today, organization, and unread on later replies',()=>{
 const before=Date.parse('2026-09-22T00:00:00+08:00'),old='2026-09-21T15:00:00Z',today='2026-09-21T16:00:00Z';
 const threads=[{key:'old',revision:old,updatedAt:Date.parse(old)},{key:'today',revision:today,updatedAt:before},{key:'updated',revision:old,updatedAt:before+1},{key:'unknown'}];
 const meta={old:{folderId:'keep',parentKey:'parent',forceUnread:true},today:{forceUnread:true}};
 assert.equal(markReadBefore(threads,meta,before),1);
 assert.equal(unread(threads[0],meta),false);assert.equal(meta.old.folderId,'keep');assert.equal(meta.old.parentKey,'parent');
 assert.equal(unread(threads[1],meta),true);assert.equal(unread(threads[2],meta),true);assert.equal(meta.unknown,undefined);
 assert.equal(unread({...threads[0],revision:today},meta),true);
 const grouped=groupProjects(threads.slice(0,3).map(t=>({...t,deviceId:'local',cwd:'/project'})),[],meta);
 assert.equal(grouped[0].projects[0].unread,2);
});
const msg=(phase,text='hello')=>({timestamp:at,type:'response_item',payload:{type:'message',role:'assistant',phase,content:[{type:'output_text',text}]}});
const serialize=items=>items.map(x=>JSON.stringify(x)).join('\n');
test('recent timeline orders all devices by invocation, not ongoing assistant output',()=>{
 const items=[{key:'remote:older',lastUserAt:'2026-09-22T01:00:00Z',lastAt:'2026-09-22T09:00:00Z'},
  {key:'local:newer',lastUserAt:'2026-09-22T02:00:00Z'},{key:'remote:legacy',updatedAt:Date.parse('2026-09-22T03:00:00Z')},{key:'unknown'}];
 assert.deepEqual(recentConversations(items).map(t=>t.key),['remote:legacy','local:newer','remote:older','unknown']);
 assert.equal(items[0].key,'remote:older');
});
test('invocation timestamp survives tail caching and is not moved by assistant progress',()=>{
 const userAt='2026-09-22T01:00:00Z';
 const initial=parseEvents(serialize([{type:'event_msg',timestamp:userAt,payload:{type:'user_message',message:'hi'}},msg('commentary')]),now);
 assert.equal(initial.lastUserAt,userAt);
 assert.equal(parseEvents(serialize([msg('final')]),now,initial).lastUserAt,userAt);
 const next=parseEvents(serialize([{type:'response_item',timestamp:'2026-09-22T02:00:00Z',payload:{type:'message',role:'user'}},
 {type:'event_msg',timestamp:userAt,payload:{type:'user_message'}}]),now,initial);
 assert.equal(next.lastUserAt,'2026-09-22T02:00:00Z');
});
test('completed turn is not mistaken for generating; partial trailing records tolerated',()=>{
 assert.equal(parseEvents(serialize([msg('commentary'),msg('final')])+'\n{"broken',now).state,'completed');
 assert.equal(parseEvents(serialize([msg('commentary')]),now).state,'running');
 assert.equal(parseEvents(serialize([msg('commentary')]),now+121000).state,'unknown');
 assert.equal(parseEvents(serialize([msg('final_answer')]),now).state,'completed');
 assert.equal(parseEvents(serialize([msg('final_answer')]),now).messages[0].phase,'final');
});
test('tool work following final means a new active turn; stale work cannot claim active',()=>{
 const work={timestamp:at,type:'response_item',payload:{type:'custom_tool_call'}};
 assert.equal(parseEvents(serialize([msg('final'),work]),now).state,'running');
 assert.equal(parseEvents(serialize([work]),now+121000).state,'unknown');
});
test('large tool results do not erase prior messages or unread revision',()=>{
 const initial=parseEvents(serialize([msg('commentary')]),now);
 const next=parseEvents(serialize([{timestamp:at,type:'response_item',payload:{type:'custom_tool_call'}}]),now,initial);
 assert.equal(next.messages.length,1);assert.equal(next.revision,initial.revision);
 assert.equal(parseEvents(serialize([msg('commentary')]),now,initial).messages.length,1);
});
test('read state is independent of running state and new progress becomes unread',()=>{
 const t={key:'a',state:'running',revision:'r1'};const meta={a:{readRevision:'r1'}};
 assert.equal(unread(t,meta),false);assert.equal(unread({...t,revision:'r2'},meta),true);
 assert.equal(unread(t,{a:{readRevision:'r1',forceUnread:true}}),true);
});
test('unread indicator changes from working red to completed green and clears when read',()=>{
 const running={key:'task',state:'running',revision:'r1'};
 const completed={...running,state:'completed'};
 assert.equal(unreadTone(running,{}),'working');
 assert.equal(unreadTone(completed,{}),'done');
 assert.equal(unreadTone(completed,{task:{readRevision:'r1'}}),null);
 assert.deepEqual(unreadSummary([running,completed],{}),{count:2,tone:'working'});
 assert.deepEqual(unreadSummary([completed],{}),{count:1,tone:'done'});
 assert.deepEqual(unreadSummary([completed],{task:{readRevision:'r1'}}),{count:0,tone:null});
});
test('a new task start and a later confirmation request advance unread revision',()=>{
 const start='2026-10-16T06:55:08.576Z',reply='2026-10-16T06:51:05.967Z',attention='2026-10-16T06:53:21.412Z';
 const started=parseEvents(serialize([{timestamp:start,type:'event_msg',payload:{type:'task_started'}}]),Date.parse(start));
 assert.equal(started.revision,start);
 assert.equal(unread({key:'started',...started},{started:{nativeReadRevision:reply}}),true);
 assert.equal(unread({key:'started',...started},{started:{readRevision:start}}),false);
 const awaiting=parseEvents(serialize([{...msg('final'),timestamp:reply},{timestamp:attention,type:'event_msg',payload:{type:'request_user_input'}}]),Date.parse(attention));
 assert.equal(awaiting.revision,attention);
 assert.equal(unread({key:'awaiting',...awaiting},{awaiting:{nativeReadRevision:reply}}),true);
 assert.equal(unread({key:'awaiting',...awaiting},{awaiting:{readRevision:attention}}),false);
 const copied=parseEvents(serialize([{timestamp:start,type:'event_msg',payload:{type:'task_started'}},{...msg('final'),timestamp:reply}]),Date.parse(start));
 assert.equal(copied.revision,start);
});
test('tree supports manual unlinking, cycles and collapse without disappearing roots',()=>{
 const t=[{key:'a'},{key:'b',parentKey:'a'},{key:'c',parentKey:'b'}];
 assert.deepEqual(treeRows(t,{}).map(t=>t.depth),[0,1,2]);
 assert.deepEqual(treeRows(t,{},new Set(['a'])).map(t=>t.key),['a']);
 assert.equal(parentOf(t[1],{b:{parentKey:null}}),null);
 assert.equal(treeRows([{key:'a',parentKey:'b'},{key:'b',parentKey:'a'}],{}).length,2);
});
test('folder and read metadata persist across store instances',()=>{
 const dir=mkdtempSync(join(tmpdir(),'workbench-test-'));
 try{const s=createStore(dir);s.save({...s.get(),folders:[{id:'f',name:'论文'}],meta:{a:{folderId:'f',readRevision:'r'}}});const r=createStore(dir);assert.equal(r.get().meta.a.readRevision,'r');assert.equal(r.get().folders[0].name,'论文');}finally{rmSync(dir,{recursive:true});}
});
test('growing Windows rollout is reread even when open writer keeps modification time unchanged',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'workbench-growing-')),path=join(dir,'rollout.jsonl');
 const db=new DatabaseSync(join(dir,'state_5.sqlite'));
 db.exec('CREATE TABLE threads (id TEXT, title TEXT, cwd TEXT, rollout_path TEXT, updated_at INTEGER, archived INTEGER)');
 db.prepare('INSERT INTO threads VALUES (?,?,?,?,?,0)').run('test','title',dir,toNamespacedPath(path),now/1000);
 writeFileSync(path,serialize([msg('commentary')]));const stamp=statSync(path).mtime;
 const collect=createCollector(dir);assert.equal((await collect()).threads[0].state,'running');
 appendFileSync(path,'\n'+serialize([msg('final')]));utimesSync(path,stamp,stamp);
 assert.equal((await collect()).threads[0].state,'completed');db.close();collect.close();rmSync(dir,{recursive:true});
});

test('projects normalize Windows prefixes but keep Linux case and device identity',()=>{
 assert.equal(projectLocation('\\\\?\\C:\\Users\\demo\\APP\\').identity,projectLocation('c:/Users/demo/APP').identity);
 const threads=[['a','d1','/code/GRAIL'],['b','d1','/data/GRAIL'],['c','d1','/code/grail'],['d','d2','/code/GRAIL']]
   .map(([key,deviceId,cwd])=>({key,deviceId,deviceName:deviceId,cwd,updatedAt:1}));
 const groups=groupProjects(threads);
 assert.equal(groups.length,2);assert.equal(groups.find(g=>g.id==='d1').projects.length,3);
});
test('live projects sort before newer idle projects; offline stale runs do not pin',()=>{
 const make=(key,cwd,state,updatedAt,online=true)=>({key,cwd,state,updatedAt,online,deviceId:'linux',deviceName:'5090'});
 const groups=groupProjects([make('old','/code/GRAIL','running',1),make('new','/code/GR00T','completed',100),make('off','/code/OASIS','running',200,false)], [{id:'linux',online:true}]);
 assert.equal(groups[0].projects[0].name,'GRAIL');assert.equal(groups[0].projects.find(p=>p.name==='OASIS').priority,0);
 const next=groupProjects([make('old','/code/GRAIL','completed',1),make('new','/code/GR00T','running',100)], [{id:'linux',online:true}]);
 assert.equal(next[0].projects[0].name,'GR00T');
});
test('open process promotes only its deepest project and does not fabricate a running task',()=>{
 const threads=['/home/demo/code','/home/demo/code/GRAIL','/home/demo/code/GR00T'].map((cwd,i)=>({key:String(i),cwd,deviceId:'linux',deviceName:'5090',state:'completed',online:true,updatedAt:1}));
 const [device]=groupProjects(threads,[{id:'linux',online:true,processes:[{cwd:'/home/demo/code/GRAIL'}]}]);
 assert.equal(device.projects[0].name,'GRAIL');assert.equal(device.projects[0].processCount,1);assert.equal(device.projects[0].running,0);
 assert.equal(device.projects.find(p=>p.name==='code').priority,0);
});
test('simultaneously active projects keep stable order while progress timestamps change',()=>{
 const a={key:'a',cwd:'/code/A',state:'running',online:true,deviceId:'d',deviceName:'D',updatedAt:1};
 const b={...a,key:'b',cwd:'/code/B',updatedAt:100};
 const names=threads=>groupProjects(threads)[0].projects.map(p=>p.name);
 assert.deepEqual(names([a,b]),names([{...a,updatedAt:200},b]));
});
