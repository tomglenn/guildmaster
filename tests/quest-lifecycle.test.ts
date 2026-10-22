import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/service/store.ts';
import { QuestService } from '../src/service/quests.ts';
import type { Quest } from '../src/domain/types.ts';

function fixture(t: any) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(),'gm-lifecycle-')));
  const store = new Store(dir);
  const service = new QuestService({store,dataDir:dir,defaultWorkspace:dir});
  // Keep intentionally queued fixtures from launching real engines.
  service.schedule = () => {};
  t.after(async () => { await service.close(); store.close(); rmSync(dir,{recursive:true,force:true}); });
  function quest(id = 'q', extra: Partial<Quest> = {}) {
    const q: Quest = {id,title:id,objective:'work',kind:'quest',status:'awaiting_review',workspaceMode:'none',workspacePath:dir,model:'',tools:[],instructions:'',createdAt:1,updatedAt:1,sessionPath:join(dir,id),runCount:2,result:'current result',...extra};
    store.save(q); return q;
  }
  return {dir,store,service,quest};
}

test('accept-close commits acceptance, closure, event and command atomically and replays exactly', async t => {
  const {store,service,quest} = fixture(t); quest();
  const input = {commandId:'accept',expectedRunCount:2};
  const first = await service.action('q','accept-close',input);
  assert.equal(first.quest.closeReason,'accepted');
  assert.equal(first.quest.acceptance?.result,'current result');
  assert.equal(first.quest.acceptance?.runCount,2);
  assert.equal(first.quest.archivedAt,undefined);
  assert.deepEqual(await service.action('q','accept-close',input),first);
  assert.equal(store.events('q').filter(e => e.type === 'accepted_closed').length,1);
  await assert.rejects(service.action('q','close',{commandId:'accept'}),/different request/);
});

test('close then reopen permits accepting the same saved result without another run', async t => {
  const {store,service,quest} = fixture(t);
  quest();
  let closed = await service.action('q','close',{commandId:'accidental-close',expectedRunCount:2});
  await service.action('q','reopen',{commandId:'reopen',expectedRunCount:2,expectedClosedAt:closed.quest.closedAt});
  let accepted = await service.action('q','accept-close',{commandId:'accept-saved',expectedRunCount:2});
  assert.equal(accepted.quest.status,'accepted');
  assert.equal(accepted.quest.acceptance?.result,'current result');
  // Reopening an already accepted result must offer the same action too.
  await service.action('q','reopen',{commandId:'reopen-accepted',expectedRunCount:2,expectedClosedAt:accepted.quest.closedAt});
  accepted = await service.action('q','accept-close',{commandId:'reaccept-saved',expectedRunCount:2});
  assert.equal(accepted.quest.closeReason,'accepted');
  assert.equal(store.get('q')?.runCount,2);
  assert.equal(store.get('q')?.activeRunId,undefined);
  assert.equal(service.live.size,0);
});

test('reopening cannot accept a stale result from a previous run', async t => {
  const {service,quest} = fixture(t);
  quest('q',{status:'accepted',reopenedAt:5,runCount:3,acceptance:{acceptedAt:1,runCount:2,result:'current result'}});
  await assert.rejects(service.action('q','accept-close',{commandId:'stale-result',expectedRunCount:3}),/current saved result/);
  quest('failed',{status:'failed',reopenedAt:5});
  await assert.rejects(service.action('failed','accept-close',{commandId:'failed-result',expectedRunCount:2}),/current saved result/);
});

test('transaction failure rolls back family, questions, deliveries, events and idempotency key', async t => {
  const {store,service,quest} = fixture(t); quest('q',{status:'running',activeRunId:'run'});
  quest('child',{kind:'delegate',parentQuestId:'q',status:'queued',activeRunId:'child-run'});
  store.request({id:'question',questId:'child',runId:'child-run',question:'Approve?',status:'pending',createdAt:2});
  store.saveDelivery({id:'delivery',questId:'q',commandId:'old',kind:'prompt',text:'do it',createdAt:1});
  const save = store.saveCommand.bind(store);
  store.saveCommand = () => { throw new Error('injected failure'); };
  await assert.rejects(service.action('q','close',{commandId:'close',confirmCancel:true}),/injected failure/);
  assert.equal(store.get('q')?.activeRunId,'run'); assert.equal(store.get('q')?.closedAt,undefined);
  assert.equal(store.get('child')?.status,'queued'); assert.equal(store.getRequest('question')?.status,'pending');
  assert.equal(store.pendingDeliveries('q').length,1); assert.equal(store.events('q').length,0); assert.equal(store.command('close'),undefined);
  store.saveCommand = save;
  await service.action('q','close',{commandId:'close',confirmCancel:true});
  assert.equal(store.getRequest('question')?.status,'dismissed');
});

test('accept-close rollback leaves acceptance and closure unrecorded', async t => {
  const {store,service,quest} = fixture(t); quest();
  store.saveCommand = () => { throw new Error('rollback'); };
  await assert.rejects(service.action('q','accept-close',{commandId:'accept',expectedRunCount:2}),/rollback/);
  assert.equal(store.get('q')?.status,'awaiting_review'); assert.equal(store.get('q')?.acceptance,undefined);
  assert.equal(store.get('q')?.closedAt,undefined); assert.equal(store.events('q').length,0);
});

test('accept-close rechecks result generation and family after worker-exit awaits', async t => {
  const {store,service,quest} = fixture(t); quest();
  service.settleWorker = async () => { const q = store.get('q')!; q.result = 'new result'; store.save(q); };
  await assert.rejects(service.action('q','accept-close',{commandId:'race',expectedRunCount:2}),/result changed/);
  assert.equal(store.command('race'),undefined);
  service.settleWorker = async () => { quest('child',{kind:'delegate',parentQuestId:'q',status:'queued',activeRunId:'child-run'}); };
  await assert.rejects(service.action('q','accept-close',{commandId:'family-race',expectedRunCount:2}),/family changed/);
  assert.equal(store.get('q')?.closedAt,undefined);
});

test('accept-close requires current run generation and rejects unanswered family questions', async t => {
  const {store,service,quest} = fixture(t); quest(); quest('child',{kind:'delegate',parentQuestId:'q',status:'completed'});
  await assert.rejects(service.action('q','accept-close',{commandId:'missing'}),/expectedRunCount/);
  await assert.rejects(service.action('q','accept-close',{commandId:'stale',expectedRunCount:1}),/result changed/);
  store.request({id:'question',questId:'child',runId:'old',question:'Approve?',status:'pending',createdAt:2});
  await assert.rejects(service.action('q','accept-close',{commandId:'pending',expectedRunCount:2}),/unfinished family/);
});

test('close requires explicit confirmation, dismisses questions without answers, fences runs and preserves unsuccessful history', async t => {
  const {store,service,quest} = fixture(t);
  quest('q',{status:'interrupted',error:'original failure'});
  quest('child',{kind:'delegate',parentQuestId:'q',status:'queued',activeRunId:'child-run'});
  quest('failed',{kind:'delegate',parentQuestId:'q',status:'failed',error:'failed historically'});
  for (const id of ['q','child']) store.request({id:`question-${id}`,questId:id,runId:'old',question:'Approve?',status:'pending',createdAt:2});
  await assert.rejects(service.action('q','close',{commandId:'no'}),/confirmCancel/);
  await service.action('q','close',{commandId:'yes',confirmCancel:true});
  assert.equal(store.get('q')?.status,'interrupted'); assert.equal(store.get('q')?.error,'original failure');
  assert.equal(store.get('child')?.status,'cancelled'); assert.equal(store.get('child')?.activeRunId,undefined);
  assert.equal(store.get('failed')?.status,'failed');
  for (const id of ['q','child']) { const r = store.getRequest(`question-${id}`)!; assert.equal(r.status,'dismissed'); assert.equal(r.answer,undefined); }
  await assert.rejects(service.answer('question-q',{answer:'yes',commandId:'answer'}),/already has a response/);
  assert.equal(service.board().quests[0].inbox?.included,false);
});

test('closed runs ignore late completion, requests, deliveries and tool events', async t => {
  const {store,service,quest} = fixture(t); quest('q',{status:'queued',activeRunId:'run'});
  await service.action('q','close',{commandId:'close',confirmCancel:true});
  for (const event of [{type:'done',result:'late'},{type:'request',id:'late',question:'late?'},{type:'tool_start',toolCallId:'late',tool:'write',detail:'late'}]) service.workerEvent('q','run',event);
  assert.equal(store.get('q')?.result,'current result'); assert.equal(store.requests('q').length,0); assert.equal(store.toolCalls('q').length,0);
});

test('reopen guards closure and generation, clears retention and starts no work or delivery replay', async t => {
  const {store,service,quest} = fixture(t); quest();
  const closed = (await service.action('q','accept-close',{commandId:'accept',expectedRunCount:2})).quest;
  const archived = store.get('q')!; archived.archivedAt = 1; store.save(archived);
  await assert.rejects(service.action('q','reopen',{commandId:'stale',expectedRunCount:2,expectedClosedAt:0}),/closure changed/);
  await assert.rejects(service.action('q','reopen',{commandId:'run',expectedRunCount:1,expectedClosedAt:closed.closedAt}),/result changed/);
  const input = {commandId:'undo',expectedRunCount:2,expectedClosedAt:closed.closedAt};
  const reopened = (await service.action('q','reopen',input)).quest;
  assert.equal(reopened.closedAt,undefined); assert.equal(reopened.archivedAt,undefined); assert.equal(reopened.activeRunId,undefined);
  assert.equal(reopened.runCount,2); assert.ok(reopened.acceptance); assert.equal(store.pendingDeliveries('q').length,0);
  assert.equal(service.detail('q').quest.inbox?.label,'Reopened');
  assert.deepEqual((await service.action('q','reopen',input)).quest,reopened);
  await service.continue('q',{commandId:'followup',message:'new feedback'});
  assert.equal(store.get('q')?.reopenedAt,undefined); assert.equal(store.get('q')?.runCount,3);
  assert.equal(store.get('q')?.acceptance?.runCount,2);
});

test('follow-up cannot implicitly reopen a closed quest', async t => {
  const {service,quest} = fixture(t); quest(); await service.action('q','close',{commandId:'close'});
  await assert.rejects(service.continue('q',{commandId:'feedback',message:'new feedback'}),/Reopen/);
});

test('legacy accept stays open, cancel closes implicitly, archive enrolls retention and restore reopens', async t => {
  const {store,service,quest} = fixture(t); quest();
  await service.action('q','accept',{commandId:'legacy-accept'}); assert.equal(store.get('q')?.closedAt,undefined);
  await service.action('q','archive',{commandId:'archive'}); assert.ok(store.get('q')?.archivedAt); assert.ok(store.get('q')?.closedAt);
  await service.action('q','restore',{commandId:'restore'}); assert.equal(store.get('q')?.closedAt,undefined); assert.equal(store.get('q')?.archivedAt,undefined);
  quest('cancel',{status:'queued',activeRunId:'run'}); await service.action('cancel','cancel',{commandId:'legacy-cancel'});
  assert.ok(store.get('cancel')?.closedAt);
});

test('versioned migration closes only safe legacy outcomes without inventing acceptance or retention', t => {
  const dir = mkdtempSync(join(tmpdir(),'gm-migrate-')); let store = new Store(dir);
  const base: Quest = {id:'accepted',title:'accepted',objective:'work',kind:'quest',status:'accepted',workspaceMode:'none',workspacePath:dir,model:'',tools:[],instructions:'',createdAt:1,updatedAt:2,sessionPath:'',runCount:1};
  store.save(base); store.save({...base,id:'cancelled',status:'cancelled'}); store.save({...base,id:'pending'}); store.save({...base,id:'active'});
  store.save({...base,id:'child',parentQuestId:'active',kind:'delegate',status:'queued',activeRunId:'run'});
  store.save({...base,id:'archived',archivedAt:123});
  store.request({id:'question',questId:'pending',runId:'old',question:'?',status:'pending',createdAt:2});
  store.db.prepare('DELETE FROM application_settings WHERE key=?').run('questLifecycleV1');
  store.close(); store = new Store(dir);
  for (const id of ['accepted','cancelled']) { assert.ok(store.get(id)?.closedAt); assert.equal(store.get(id)?.archivedAt,undefined); assert.equal(store.get(id)?.acceptance,undefined); }
  assert.equal(store.get('pending')?.closedAt,undefined); assert.equal(store.get('active')?.closedAt,undefined); assert.equal(store.get('archived')?.closedAt,123);
  const q = store.get('accepted')!; delete q.closedAt; q.reopenedAt = 99; store.save(q);
  store.save({...base,id:'accepted-after-upgrade'}); store.close(); store = new Store(dir);
  assert.equal(store.get('accepted')?.closedAt,undefined); assert.equal(store.get('accepted-after-upgrade')?.closedAt,undefined);
  store.close(); rmSync(dir,{recursive:true,force:true});
});

test('authoritative family inbox includes questions regardless of status with stable ordering keys and counts', t => {
  const {store,service,quest} = fixture(t); quest('q',{status:'accepted'}); quest('child',{kind:'delegate',parentQuestId:'q',status:'completed'});
  store.request({id:'question',questId:'child',runId:'old',question:'?',status:'pending',createdAt:3});
  const first = service.board().quests[0].inbox!;
  assert.equal(first.included,true); assert.equal(first.group,'input'); assert.equal(first.pendingQuestions,1); assert.equal(first.since,3);
  assert.equal(first.label,'Agent needs input');
  const child = store.get('child')!; child.result = 'different'; store.save(child);
  assert.deepEqual(service.detail('q').quest.inbox,first);
  quest('working',{status:'queued',activeRunId:'run',createdAt:4});
  assert.equal(service.detail('working').quest.inbox?.group,'working'); assert.equal(service.detail('working').quest.inbox?.active,1);
});
