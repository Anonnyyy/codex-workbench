import test from 'node:test';
import assert from 'node:assert/strict';
import {treeRows,visibleTreeRows} from '../src/model.js';
import {parseEvents} from '../server/collector.mjs';

const task=(key,state,updatedAt,parentKey=null)=>({key,state,online:true,updatedAt,parentKey});

test('resumed fork promotes its old branch while preserving hierarchy and parent state',()=>{
  const threads=[task('new','completed',100),task('parent','completed',1),task('sibling','completed',2,'parent'),task('resumed','running',101,'parent')];
  const rows=treeRows(threads,{});
  assert.deepEqual(rows.map(t=>t.key),['parent','resumed','sibling','new']);
  assert.deepEqual(rows.map(t=>t.depth),[0,1,1,0]);
  assert.equal(rows[0].state,'completed');
  assert.deepEqual(visibleTreeRows(rows,1).map(t=>t.key),['parent','resumed']);
  assert.equal(threads[0].key,'new');
});

test('row limits retain every live fork and its ancestors across multiple branches',()=>{
  const rows=treeRows([task('p','completed',1),task('q','completed',2),task('a','running',100,'p'),task('b','running',99,'q'),task('idle','completed',98,'p')],{});
  assert.deepEqual(visibleTreeRows(rows,1).map(t=>t.key),['p','a','q','b']);
  assert.equal(visibleTreeRows(rows,0).length,5);
  assert.equal(visibleTreeRows(rows,10).length,5);
});

test('collapsed branches keep a running indicator; offline runs do not gain live priority',()=>{
  const rows=treeRows([task('parent','completed',1),task('fork','running',100,'parent'),task('idle','completed',99)],{},new Set(['parent']));
  assert.equal(rows[0].key,'parent');assert.equal(rows[0].hiddenRunning,1);
  assert.deepEqual(visibleTreeRows(rows,1).map(t=>t.key),['parent']);
  const offline=treeRows([{...task('offline','running',1),online:false},task('new','completed',2)],{});
  assert.equal(offline[0].key,'new');assert.equal(visibleTreeRows(offline,1).length,1);
});

test('latest descendant activity orders completed branches too, including manual parent links',()=>{
  const rows=treeRows([task('new','completed',10),task('old','completed',1),task('fork','completed',20)],{fork:{parentKey:'old'}});
  assert.deepEqual(rows.map(t=>t.key),['old','fork','new']);
});

test('interruption followed by a resumed turn returns to running and eventually completed',()=>{
  const now=Date.now(),event=type=>JSON.stringify({timestamp:new Date(now).toISOString(),type:'event_msg',payload:{type}});
  const stopped=parseEvents(event('turn_aborted'),now);
  assert.equal(stopped.state,'interrupted');
  const resumed=parseEvents(event('task_started'),now,stopped);
  assert.equal(resumed.state,'running');
  assert.equal(parseEvents(event('task_complete'),now,resumed).state,'completed');
});
