import test from 'node:test';
import assert from 'node:assert/strict';
import {reconnectSsh} from '../server/ssh-reconnect.mjs';
function setup(){
  const sessions=[],timers=new Map(),statuses=[];
  const link=reconnectSsh(lifecycle=>{
    const session={...lifecycle,closed:false,sends:0,close(){this.closed=true;},sendQueuedMessage(){this.sends++;return {status:'sent'};},inspectQueuedMessage(){},retryCapacity(){}};
    sessions.push(session);return session;
  },message=>statuses.push(message),{
    setTimer(fn,delay){const timer={fn,delay};timers.set(timer,timer);return timer;},
    clearTimer(timer){timers.delete(timer);},
  });
  const next=()=>{const timer=[...timers.values()][0];assert.ok(timer);timers.delete(timer);timer.fn();return timer.delay;};
  return {link,sessions,timers,statuses,next};
}
test('transient disconnects reconnect with bounded backoff without replaying messages',()=>{
  const x=setup();x.link.sendQueuedMessage({});
  x.sessions[0].disconnected('reset');assert.equal(x.next(),2000);
  assert.equal(x.sessions[1].sends,0);
  x.sessions[1].disconnected('reset');assert.equal(x.next(),4000);
  x.sessions[2].healthy();x.sessions[2].disconnected('reset');assert.equal(x.next(),2000);
  for(let i=0;i<8;i++){x.sessions.at(-1).disconnected('reset');assert.ok(x.next()<=30000);}
  assert.equal(x.sessions[0].sends,1);x.link.close();
});
test('authentication or host identity failures stop reconnection',()=>{
  const x=setup();x.sessions[0].disconnected('identity mismatch',false);
  assert.equal(x.timers.size,0);assert.deepEqual(x.statuses,['identity mismatch']);x.link.close();
});
test('explicit close cancels reconnect and stale callbacks cannot reopen a connection',()=>{
  const x=setup();x.sessions[0].disconnected('reset');const pending=[...x.timers.values()][0];
  x.link.close();assert.equal(x.timers.size,0);assert.equal(x.sessions[0].closed,true);
  pending.fn();x.sessions[0].disconnected('late close');assert.equal(x.sessions.length,1);assert.equal(x.timers.size,0);
});
