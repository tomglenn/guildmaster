import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent';
import { ModelProgress } from '../src/engine/model-progress.ts';

function fixture(t: TestContext, idleTimeoutMs = 100) {
  t.mock.timers.enable({apis:['setTimeout']});
  const activity:string[]=[]; const timeouts:string[]=[];
  const progress=new ModelProgress({idleTimeoutMs,onActivity:detail=>activity.push(detail),onTimeout:detail=>timeouts.push(detail)});
  t.after(()=>progress.stop());
  // Event payloads irrelevant to the watchdog can be omitted in these focused tests.
  const event=(value:object)=>progress.observe(value as AgentSessionEvent);
  return {progress,event,activity,timeouts,tick:(ms:number)=>t.mock.timers.tick(ms)};
}

test('model silence times out once per active request and stop removes the timer',t=>{
  const f=fixture(t);
  f.tick(1000); assert.equal(f.timeouts.length,0);
  f.event({type:'turn_start'});
  assert.deepEqual(f.activity,['Waiting for model response.']);
  f.tick(99); assert.equal(f.timeouts.length,0);
  f.tick(1); assert.equal(f.timeouts.length,1);
  f.tick(1000); assert.equal(f.timeouts.length,1);
  f.event({type:'message_start',message:{role:'assistant'}});
  f.tick(1000); assert.equal(f.timeouts.length,1,'Late response does not rearm an expired request.');
  f.event({type:'turn_start'});
  f.progress.stop(); f.tick(1000); assert.equal(f.timeouts.length,1);
  f.event({type:'turn_start'}); f.tick(1000); assert.equal(f.timeouts.length,1,'Stop is permanent.');
});

test('all assistant progress refreshes the deadline without exposing thinking text',t=>{
  const f=fixture(t); f.event({type:'turn_start'});
  f.tick(90); f.event({type:'message_start',message:{role:'assistant'}});
  for(const type of ['thinking_delta','thinking_delta','toolcall_delta','text_delta']) {
    f.tick(90);
    f.event({type:'message_update',message:{role:'assistant'},assistantMessageEvent:{type,delta:'PRIVATE_REASONING'}});
    assert.equal(f.timeouts.length,0);
  }
  assert.deepEqual(f.activity,['Waiting for model response.','Model is thinking.']);
  assert.doesNotMatch(JSON.stringify(f.activity),/PRIVATE_REASONING/);
  f.tick(99); assert.equal(f.timeouts.length,0);
  f.tick(1); assert.equal(f.timeouts.length,1);
});

test('tool execution and human question waits do not consume a model deadline',t=>{
  const f=fixture(t); f.event({type:'turn_start'});
  f.event({type:'message_end',message:{role:'assistant'}});
  f.tick(1000); assert.equal(f.timeouts.length,0);
  f.event({type:'turn_start'});
  f.event({type:'tool_execution_start',toolName:'request_user'});
  f.tick(1000); assert.equal(f.timeouts.length,0);
  f.event({type:'tool_execution_end',toolName:'request_user'});
  f.tick(1000); assert.equal(f.timeouts.length,0);
  f.event({type:'turn_start'}); f.tick(100);
  assert.equal(f.timeouts.length,1,'The next request gets its own deadline.');
});

test('retry sleep is visible and paused until the next model turn',t=>{
  const f=fixture(t); f.event({type:'turn_start'}); f.tick(90);
  f.event({type:'auto_retry_start',attempt:1,maxAttempts:3,delayMs:2000,errorMessage:'Provider overloaded\nTry again.'});
  f.tick(5000); assert.equal(f.timeouts.length,0);
  assert.match(f.activity.at(-1)!,/Model retry 1\/3 in 2 seconds\. Provider overloaded Try again\./);
  f.event({type:'turn_start'}); f.tick(100); assert.equal(f.timeouts.length,1);
});

test('compaction and settled agents clear pending request timers',t=>{
  const f=fixture(t); f.event({type:'turn_start'});
  f.event({type:'compaction_start'}); f.tick(1000); assert.equal(f.timeouts.length,0);
  f.event({type:'compaction_end',aborted:false}); f.tick(1000); assert.equal(f.timeouts.length,0);
  f.event({type:'turn_start'}); f.event({type:'agent_end'}); f.tick(1000); assert.equal(f.timeouts.length,0);
  f.event({type:'turn_start'}); f.event({type:'message_update',message:{role:'assistant'},assistantMessageEvent:{type:'thinking_delta'}});
  assert.equal(f.activity.filter(detail=>detail==='Model is thinking.').length,1);
});

test('nested events cannot arm or prolong the parent request deadline',t=>{
  const f=fixture(t);
  f.event({type:'turn_start',parentToolCallId:'nested'}); f.tick(1000); assert.equal(f.timeouts.length,0);
  f.event({type:'turn_start'}); f.tick(90);
  f.event({type:'message_update',parentToolCallId:'nested',message:{role:'assistant'},assistantMessageEvent:{type:'text_delta'}});
  f.tick(10); assert.equal(f.timeouts.length,1);
});
