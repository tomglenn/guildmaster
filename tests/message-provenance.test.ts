import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { test, type TestContext } from 'node:test';
import { Store } from '../src/service/store.ts';
import { QuestService } from '../src/service/quests.ts';
import type { Message, Quest } from '../src/domain/types.ts';

async function fixture(t: TestContext) {
  const dataDir=await mkdtemp(join(tmpdir(),'guildmaster-provenance-'));
  const store=new Store(dataDir); const service=new QuestService({store,dataDir});
  const q:Quest={id:'quest',title:'Investigation',objective:'Investigate the project.',kind:'quest',status:'interrupted',workspaceMode:'none',workspacePath:dataDir,model:'fake/test',tools:['read'],instructions:'',createdAt:0,updatedAt:0,sessionPath:join(dataDir,'session.jsonl'),runCount:0};
  store.save(q);
  t.after(async()=>{await service.close();store.close();await rm(dataDir,{recursive:true,force:true});});
  function legacyMessage(id:string,text:string,createdAt:number) {
    const message:Message={id,questId:q.id,role:'user',text,createdAt};
    store.db.prepare('INSERT INTO messages VALUES (?,?,?)').run(id,q.id,JSON.stringify(message)); return message;
  }
  return {store,service,q,legacyMessage};
}

test('new presentation metadata preserves raw delivery prompts and makes identical human text explicit',async t=>{
  const f=await fixture(t); const prompt='Your delegated work has returned. Internal report payload.';
  const internal=f.service.prepare(f.q,prompt,'delegates:internal',undefined,'Original request',{source:'system'});
  const human=f.service.prepare(f.q,prompt,'human-command');
  const resumedAnswer=f.service.prepare(f.q,'The saved question was: Which color?\nThe user answered: Blue','answer-command',undefined,undefined,{source:'user',displayText:'Blue'});
  const messages=f.service.detail(f.q.id).messages;
  assert.equal(messages.find(message=>message.id===internal.id)?.source,'system');
  assert.equal(messages.find(message=>message.id===human.id)?.source,'user');
  assert.equal(messages.find(message=>message.id===human.id)?.text,prompt);
  assert.equal(messages.find(message=>message.id===resumedAnswer.id)?.displayText,'Blue');
  const run=f.store.runs(f.q.id).at(-1)!;
  assert.equal(run.data.messageId,resumedAnswer.id);
  assert.equal(run.data.messageSource,'user');
  assert.equal(run.data.displayText,'Blue');
  assert.equal(run.data.prompt,resumedAnswer.text);
  assert.equal(f.store.pendingDeliveries(f.q.id).at(-1)?.text,resumedAnswer.text,'Presentation never changes native delivery content.');
});

test('legacy handoff provenance uses saved run and command evidence without hiding human copies',async t=>{
  const f=await fixture(t); const prompt='Your delegated work has returned. Same exact report text.';
  const internal=f.legacyMessage('internal',prompt,10000);
  const human=f.legacyMessage('human',prompt,20000);
  const humanCommandName=f.legacyMessage('human-command-name',prompt,30000);
  f.store.run('internal-run',f.q.id,{prompt,sourcePrompt:'Original human request',commandId:'delegates:generated',queuedAt:10001});
  f.store.run('human-run',f.q.id,{prompt,sourcePrompt:prompt,commandId:'human-copy',queuedAt:20001});
  f.store.saveCommand('human-copy','saved-human-command',{quest:f.q});
  f.store.run('human-prefix-run',f.q.id,{prompt,sourcePrompt:'Different source',commandId:'delegates:human-selected-id',queuedAt:30001});
  f.store.saveCommand('delegates:human-selected-id','saved-human-command',{quest:f.q});
  const before=f.store.messages(f.q.id);
  const shown=f.service.detail(f.q.id).messages;
  assert.equal(shown.find(message=>message.id===internal.id)?.source,'system');
  assert.equal(shown.find(message=>message.id===human.id)?.source,undefined);
  assert.equal(shown.find(message=>message.id===humanCommandName.id)?.source,undefined);
  assert.deepEqual(f.store.messages(f.q.id),before,'Legacy presentation is read-only.');
});

test('legacy resume classification requires the exact resume command fingerprint, not prompt wording',async t=>{
  const f=await fixture(t); const prompt='Resume this quest from its saved conversation. The previous run was interrupted.';
  const resume=f.legacyMessage('actual-resume',prompt,10000);
  const human=f.legacyMessage('copied-resume',prompt,20000);
  for(const [id,commandId,action,time] of [['resume-run','resume-command','resume',10001],['human-run','continue-command','continue',20001]] as const) {
    const payload=action==='resume'?{commandId}:{message:prompt,commandId};
    const fingerprint=createHash('sha256').update(JSON.stringify([`${action}:${f.q.id}`,payload])).digest('hex');
    f.store.saveCommand(commandId,fingerprint,{quest:f.q});
    f.store.run(id,f.q.id,{prompt,sourcePrompt:'Original objective',commandId,queuedAt:time});
  }
  const shown=f.service.detail(f.q.id).messages;
  assert.equal(shown.find(message=>message.id===resume.id)?.source,'system');
  assert.equal(shown.find(message=>message.id===human.id)?.source,undefined);
});

test('ambiguous legacy message associations remain visible',async t=>{
  const f=await fixture(t); const prompt='Your delegated work has returned. An ambiguous repeated message.';
  f.legacyMessage('one',prompt,10000); f.legacyMessage('two',prompt,10001);
  f.store.run('run',f.q.id,{prompt,sourcePrompt:'Original request',commandId:'delegates:generated',queuedAt:10002});
  assert.ok(f.service.detail(f.q.id).messages.every(message=>message.source===undefined));
});
