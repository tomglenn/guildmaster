import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import type { Quest } from '../src/domain/types.ts';
import { Store } from '../src/service/store.ts';
import { QuestService } from '../src/service/quests.ts';

async function fixture(t: TestContext) {
  const dataDir = await mkdtemp(join(tmpdir(), 'guildmaster-live-'));
  let store = new Store(dataDir);
  let service = new QuestService({ store, dataDir });
  t.after(async () => { await service.close(); store.close(); await rm(dataDir, {recursive:true,force:true}); });
  function agent(id: string, parentQuestId?: string) {
    const q: Quest = { id, parentQuestId, kind: parentQuestId ? 'delegate' : 'quest', title:id, objective:'Inspect files.', status:'running',
      workspaceMode:'none', workspacePath:dataDir, model:'fake/test', tools:['read'], instructions:'', createdAt:Date.now(), updatedAt:Date.now(),
      sessionPath:join(dataDir,id,'session.jsonl'), runCount:1, activeRunId:`run-${id}` };
    store.save(q); store.run(q.activeRunId!,id,{status:'running',prompt:q.objective}); return q;
  }
  return { service:()=>service, store:()=>store, agent,
    restart:async()=>{ await service.close(); store.close(); store=new Store(dataDir); service=new QuestService({store,dataDir}); } };
}

test('live snapshots survive reconnect and reconcile into exactly one saved assistant message', async t => {
  const f=await fixture(t); const q=f.agent('lead'); const events:any[]=[];
  f.service().on('live',event=>events.push(event));
  const emit=(event:object)=>f.service().workerEvent(q.id,q.activeRunId!,event);
  emit({type:'message_start',messageId:'assistant-one'});
  emit({type:'delta',messageId:'assistant-one',text:'Reading '});
  emit({type:'delta',messageId:'assistant-one',text:'the files.'});
  assert.deepEqual(f.service().detail(q.id).live,{runId:q.activeRunId,messageId:'assistant-one',text:'Reading the files.'});
  assert.equal(f.service().detail(q.id).messages.length,0,'Partial text is not a saved message.');
  emit({type:'message',messageId:'assistant-one',role:'assistant',text:'Reading the files.'});
  emit({type:'message',messageId:'assistant-one',role:'assistant',text:'Reading the files.'});
  assert.equal(f.service().detail(q.id).live,undefined);
  assert.equal(f.service().detail(q.id).messages.length,1);
  assert.equal(f.service().detail(q.id).messages[0].id,'assistant-one');
  assert.deepEqual(events.at(-1),{questId:q.id,live:null});
  emit({type:'message_start',messageId:'assistant-two'});
  emit({type:'delta',messageId:'assistant-two',text:'Finished.'});
  f.service().workerEvent(q.id,'stale-run',{type:'delta',messageId:'bad',text:'STALE'});
  assert.equal(f.service().detail(q.id).live?.text,'Finished.');
  emit({type:'message',messageId:'assistant-two',role:'assistant',text:'Finished.'});
  emit({type:'complete',text:'Finished.'});
  assert.equal(f.service().detail(q.id).messages.length,2,'Completion does not duplicate the final saved message.');
  assert.equal(f.service().detail(q.id).live,undefined);
});

test('legacy deltas receive a stable message ID and empty assistant turns clear live state', async t=>{
  const f=await fixture(t); const q=f.agent('legacy');
  f.service().workerEvent(q.id,q.activeRunId!,{type:'delta',text:'Legacy text'});
  const id=f.service().detail(q.id).live?.messageId;
  f.service().workerEvent(q.id,q.activeRunId!,{type:'message',role:'assistant',text:'Legacy text'});
  assert.equal(f.service().detail(q.id).messages[0].id,id);
  f.service().workerEvent(q.id,q.activeRunId!,{type:'message_start',messageId:'tool-only-turn'});
  f.service().workerEvent(q.id,q.activeRunId!,{type:'message',messageId:'tool-only-turn',role:'assistant',text:''});
  assert.equal(f.service().detail(q.id).messages.length,1);
  assert.equal(f.service().detail(q.id).live,undefined);
});

test('tool lifecycles and bounded output persist; unfinished tools become interrupted after restart',async t=>{
  const f=await fixture(t); const q=f.agent('tools');
  const emit=(event:object)=>f.service().workerEvent(q.id,q.activeRunId!,event);
  emit({type:'tool_start',toolCallId:'read-one',tool:'read',detail:'src/app.ts'});
  assert.equal(f.service().detail(q.id).toolCalls[0].status,'running');
  emit({type:'tool_end',toolCallId:'read-one',tool:'read',output:'x'.repeat(25000),isError:false});
  emit({type:'tool_start',toolCallId:'read-one',tool:'read',detail:'Late duplicate start'});
  emit({type:'tool_start',toolCallId:'read-bad',tool:'read',detail:'missing.ts'});
  emit({type:'tool_end',toolCallId:'read-bad',tool:'read',output:'File does not exist.',isError:true});
  emit({type:'tool_start',toolCallId:'read-pending',tool:'read',detail:'large-file.ts'});
  emit({type:'delta',messageId:'partial-lost-on-crash',text:'Still working'});
  const before=f.service().detail(q.id).toolCalls;
  assert.equal(before[0].id,`${q.activeRunId}:read-one`);
  assert.equal(before[0].status,'completed');
  assert.equal(before[0].detail,'src/app.ts');
  assert.equal(before[0].output?.length,20000);
  assert.equal(before[1].status,'failed');
  await f.restart();
  const after=f.service().detail(q.id);
  assert.equal(after.live,undefined,'Partial streaming text is deliberately not crash-durable.');
  assert.equal(after.quest.status,'interrupted');
  assert.deepEqual(after.toolCalls.slice(0,2),before.slice(0,2));
  assert.equal(after.toolCalls[2].status,'interrupted');
  assert.ok(after.toolCalls[2].endedAt);
  const resumed={...after.quest,status:'running' as const,activeRunId:'resumed-run',runCount:2}; f.store().save(resumed);
  f.service().workerEvent(q.id,'resumed-run',{type:'tool_start',toolCallId:'read-one',tool:'read',detail:'new-file.ts'});
  assert.equal(f.service().detail(q.id).toolCalls.length,4,'Repeated native call IDs in another run remain distinct.');
});

test('failure and parent cancellation end child tool spinners and clear every live buffer',async t=>{
  const f=await fixture(t); const parent=f.agent('parent'); const child=f.agent('child',parent.id);
  const liveEvents:any[]=[]; f.service().on('live',event=>liveEvents.push(event));
  for(const q of [parent,child]) {
    f.service().workerEvent(q.id,q.activeRunId!,{type:'delta',messageId:`text-${q.id}`,text:'Working'});
    f.service().workerEvent(q.id,q.activeRunId!,{type:'tool_start',toolCallId:'active-tool',tool:'read',detail:'src/main.ts'});
  }
  await f.service().action(parent.id,'cancel',{commandId:'cancel-party'});
  for(const q of [parent,child]) {
    const detail=f.service().detail(q.id);
    assert.equal(detail.live,undefined); assert.equal(detail.toolCalls[0].status,'interrupted');
    assert.ok(liveEvents.some(event=>event.questId===q.id&&event.live===null));
  }
  const failed=f.agent('failed');
  f.service().workerEvent(failed.id,failed.activeRunId!,{type:'tool_start',toolCallId:'active-tool',tool:'read',detail:'src/main.ts'});
  f.service().workerEvent(failed.id,failed.activeRunId!,{type:'error',error:'Worker transport failed.'});
  assert.equal(f.service().detail(failed.id).toolCalls[0].status,'interrupted');
});

test('tool transitions reach the HTTP event stream individually, including completion and run fencing', async t => {
  const {createApp}=await import('../src/service/server.ts');
  const dataDir=await mkdtemp(join(tmpdir(),'guildmaster-tool-stream-'));
  const app=createApp({dataDir,port:0,models:[]});
  t.after(async()=>{await app.close();await rm(dataDir,{recursive:true,force:true});});
  const {url,token}=await app.listen();
  const q:Quest={instructions:'',id:'streamed',kind:'delegate',parentQuestId:'parent',title:'Inspect example',objective:'Read an example',status:'running',workspaceMode:'none',workspacePath:dataDir,model:'fake/test',tools:['read'],createdAt:1,updatedAt:1,sessionPath:join(dataDir,'session.jsonl'),runCount:1,activeRunId:'r'};
  app.store.save(q);
  const abort=new AbortController();t.after(()=>abort.abort());
  const response=await fetch(url+'/api/events',{headers:{Authorization:'Bearer '+token},signal:abort.signal});
  const reader=response.body!.getReader();let pending='';
  async function nextTool() {
    const deadline=Date.now()+3000;
    while(Date.now()<deadline) {
      const end=pending.indexOf('\n\n');
      if(end>=0){const event=pending.slice(0,end);pending=pending.slice(end+2);if(event.startsWith('event: tool\n'))return JSON.parse(event.split('\ndata: ')[1]);continue;}
      const result=await Promise.race([reader.read(),new Promise<never>((_,reject)=>{const timer=setTimeout(()=>reject(Error('Tool event timed out')),3000);timer.unref();})]);
      if(result.done)throw Error('Event stream closed');pending+=new TextDecoder().decode(result.value);
    }
    throw Error('Tool event timed out');
  }
  app.service.workerEvent(q.id,'r',{type:'tool_start',toolCallId:'one',tool:'read',detail:'one.ts'});
  const start=await nextTool();assert.equal(start.questId,q.id);assert.equal(start.call.status,'running');assert.equal(start.call.detail,'one.ts');
  app.service.workerEvent(q.id,'stale',{type:'tool_end',toolCallId:'one',tool:'read',output:'stale',isError:false});
  app.service.workerEvent(q.id,'r',{type:'tool_end',toolCallId:'one',tool:'read',output:'read output',isError:false});
  const end=await nextTool();assert.equal(end.call.id,start.call.id);assert.equal(end.call.status,'completed');assert.equal(end.call.output,'read output');
  assert.deepEqual(app.store.toolCalls(q.id),[end.call]);
  abort.abort();await reader.cancel().catch(()=>{});
});
