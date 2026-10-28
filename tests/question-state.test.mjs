import test from 'node:test';
import assert from 'node:assert/strict';
import {parseEvents} from '../server/collector.mjs';
const now=Date.now();
const event=(payload,offset)=>JSON.stringify({type:'response_item',timestamp:new Date(now+offset).toISOString(),payload});

test('synchronous question answers clear attention and remain cleared on tail replay',()=>{
  const question=event({type:'function_call',name:'functions.request_user_input',call_id:'q'},0);
  const unrelated=event({type:'function_call_output',call_id:'other',output:'{}'},1);
  const answer=event({type:'function_call_output',call_id:'q',output:JSON.stringify({answers:{choice:{answers:['yes']}}})},2);
  const waiting=parseEvents(question+'\n'+unrelated,now+2);
  assert.equal(waiting.attentionKind,'question');
  const answered=parseEvents(answer,now+2,waiting);
  assert.equal(answered.attentionKind,null);assert.equal(answered.state,'running');
  const replay=parseEvents([question,unrelated,answer].join('\n'),now+2,answered);
  assert.equal(replay.attentionKind,null);assert.equal(replay.attentionCallId,null);
});

test('async display acknowledgement keeps question open until an answer arrives',()=>{
  const question=event({type:'function_call',name:'request_user_input_async',call_id:'q'},0);
  const accepted=event({type:'function_call_output',call_id:'q',output:'{"accepted":true}'},1);
  const waiting=parseEvents(question+'\n'+accepted,now+2);
  assert.equal(waiting.attentionKind,'question');
  const answer=event({type:'custom_tool_call_output',call_id:'q',output:'{"answers":{}}'},2);
  assert.equal(parseEvents(answer,now+2,waiting).attentionKind,null);
});
