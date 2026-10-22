import test from 'node:test';
import assert from 'node:assert/strict';
import {conversationTasks,unread,groupProjects,recentConversations} from '../src/model.js';
import {parseEvents} from '../server/collector.mjs';

const root={key:'d:root',deviceId:'d',title:'Plan',cwd:'/project',revision:'root-r1',state:'completed',messages:[]};
const child=(key,extra={})=>({...root,key:'d:'+key,parentKey:root.key,title:key,threadKind:'subagent',revision:key+'-r1',...extra});
const legacyTitle='# Context from my IDE setup:\n\n## My request:\n[$ralplan](/skills/ralplan/SKILL.md) plan';

test('internal planning tasks share one conversation; unread and timeline use the main reply',()=>{
  const children=[child('planner'),child('critic',{parentKey:'d:planner'})];
  const fork=child('manual',{threadKind:'conversation',parentKey:'d:critic'});
  const visible=conversationTasks([root,...children,fork]);
  assert.deepEqual(visible.map(t=>t.key),[root.key,fork.key]);
  assert.equal(visible[0].internalTasks.length,2);
  assert.equal(visible[1].parentKey,root.key);
  const meta={[root.key]:{readRevision:root.revision},[fork.key]:{readRevision:fork.revision}};
  assert.equal(visible.filter(t=>unread(t,meta)).length,0);
  assert.equal(groupProjects(visible,[],meta)[0].projects[0].unread,0);
  assert.equal(recentConversations(visible).length,2);
  assert.equal(unread({...visible[0],revision:'root-r2'},meta),true);
  assert.equal(root.internalTasks,undefined);
});

test('old snapshots group repeated ralplan IDE child prompts, preserving explicit forks and unrelated tasks',()=>{
  const a=child('a',{threadKind:undefined,title:legacyTitle}),b=child('b',{threadKind:undefined,title:legacyTitle});
  const fork=child('fork',{threadKind:'conversation',title:legacyTitle});
  const standalone={...a,key:'d:standalone',parentKey:null};
  const ordinary=child('ordinary',{threadKind:undefined,title:'User fork'});
  const visible=conversationTasks([root,a,b,fork,standalone,ordinary]);
  assert.deepEqual(visible.map(t=>t.key),[root.key,fork.key,standalone.key,ordinary.key]);
  assert.equal(visible[0].internalTasks.length,2);
  assert.equal(conversationTasks([root,a]).length,2);
});

test('orphans, cross-device links and cycles stay accessible',()=>{
  const orphan=child('orphan',{parentKey:'missing'}),other=child('other',{deviceId:'other'});
  const a=child('a',{parentKey:'d:b'}),b=child('b',{parentKey:'d:a'});
  assert.equal(conversationTasks([root,orphan,other,a,b]).length,5);
});

test('session metadata distinguishes spawned agents from genuine forks, including cached tails',()=>{
  const meta=payload=>JSON.stringify({type:'session_meta',payload});
  const agent=parseEvents(meta({forked_from_id:'history',source:{subagent:{thread_spawn:{parent_thread_id:'owner'}}}}));
  assert.equal(agent.parentId,'owner');assert.equal(agent.threadKind,'subagent');
  const fork=parseEvents(meta({forked_from_id:'owner',source:'vscode'}));
  assert.equal(fork.parentId,'owner');assert.equal(fork.threadKind,'conversation');
  assert.equal(parseEvents('',Date.now(),agent).threadKind,'subagent');
  assert.equal(parseEvents(meta({source:{subagent:'compact'}})).threadKind,'conversation');
});
