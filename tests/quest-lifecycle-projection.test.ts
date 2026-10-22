import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/service/store.ts';
import { QuestService } from '../src/service/quests.ts';
import type { Quest } from '../src/domain/types.ts';

function fixture(t: any) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(),'gm-projection-')));
  const store = new Store(dir);
  const service = new QuestService({store,dataDir:dir,defaultWorkspace:dir});
  service.schedule = () => {};
  t.after(async () => { await service.close(); store.close(); rmSync(dir,{recursive:true,force:true}); });
  function quest(id = 'q', extra: Partial<Quest> = {}) {
    const q: Quest = {id,title:id,objective:'work',kind:'quest',status:'awaiting_review',workspaceMode:'none',workspacePath:dir,model:'',tools:[],instructions:'',createdAt:1,updatedAt:1,sessionPath:join(dir,id),runCount:2,result:'current result',...extra};
    store.save(q); return q;
  }
  return {dir,store,service,quest};
}

test('every lifecycle acknowledgement and saved replay carries authoritative post-transaction inbox', async t => {
  const {store,service,quest} = fixture(t); quest();
  async function action(name: Parameters<QuestService['action']>[1], input: Parameters<QuestService['action']>[2], included: boolean) {
    const response = await service.action('q',name,input);
    assert.deepEqual(response.quest.inbox,service.detail('q').quest.inbox);
    assert.equal(response.quest.inbox?.included,included);
    assert.deepEqual(store.command(input.commandId)?.response,response);
    assert.deepEqual(await service.action('q',name,input),response);
    return response.quest;
  }
  await action('accept',{commandId:'accept-only'},true);
  await action('archive',{commandId:'archive'},false);
  await action('restore',{commandId:'restore'},true);
  await action('restore',{commandId:'restore-noop'},true);
  let closed = await action('close',{commandId:'close'},false);
  await action('reopen',{commandId:'undo',expectedRunCount:2,expectedClosedAt:closed.closedAt},true);
  const q = store.get('q')!; q.status = 'awaiting_review'; store.save(q);
  closed = await action('accept-close',{commandId:'accept-close',expectedRunCount:2},false);
  await action('reopen',{commandId:'undo-accept',expectedRunCount:2,expectedClosedAt:closed.closedAt},true);
});

test('board uses one aggregate pending-question reader instead of one requests query per family member', t => {
  const {store,service,quest} = fixture(t);
  for (let i=0;i<30;i++) {
    quest(`q${i}`); quest(`child${i}`,{kind:'delegate',parentQuestId:`q${i}`,status:'completed'});
    store.request({id:`request${i}`,questId:`child${i}`,runId:'old',question:'?',status:'pending',createdAt:i+1});
  }
  const summary = store.pendingRequestSummary.bind(store); let reads = 0;
  store.pendingRequestSummary = () => { reads++; return summary(); };
  store.requests = () => { throw new Error('N+1 requests reader'); };
  const board = service.board(); assert.equal(reads,1); assert.equal(board.quests.length,30);
  for (const q of board.quests) { assert.equal(q.inbox?.pendingQuestions,1); assert.equal(q.inbox?.label,'Agent needs input'); }
});

test('attention ordering uses persisted status transitions, not creation time or unrelated activity', async t => {
  const {store,service,quest} = fixture(t); let now = 100;
  t.mock.method(Date,'now',() => now);
  quest('q',{status:'running',activeRunId:'run'});
  const q = store.get('q')!; now = 200; q.status = 'awaiting_review'; delete q.activeRunId; store.save(q);
  assert.equal(service.detail('q').quest.inbox?.since,200);
  now = 300; q.contextUsage = {tokens:1,contextWindow:100,percent:1,updatedAt:300}; store.save(q);
  assert.equal(service.board().quests[0].inbox?.since,200);
  const restored = new QuestService({store,dataDir:service.dataDir,defaultWorkspace:service.defaultWorkspace});
  assert.equal(restored.board().quests[0].inbox?.since,200);
  await restored.close();
  now = 400; q.status = 'failed'; store.save(q); assert.equal(service.detail('q').quest.inbox?.since,400);
  now = 500; q.error = 'more context'; store.save(q); assert.equal(service.detail('q').quest.inbox?.since,400);
});

test('accept-close awaits every final family worker exit before committing its projected response', async t => {
  const {store,service,quest} = fixture(t); quest(); quest('child',{kind:'delegate',parentQuestId:'q',status:'completed'});
  let release!: () => void; const exited = new Promise<void>(resolve => {release=resolve;});
  const settled: string[] = [];
  service.settleWorker = async id => { settled.push(id); if (id === 'child') await exited; };
  const accepting = service.action('q','accept-close',{commandId:'accept',expectedRunCount:2});
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(settled.sort(),['child','q']); assert.equal(store.get('q')?.closedAt,undefined); assert.equal(store.command('accept'),undefined);
  release(); const response = await accepting; assert.equal(response.quest.inbox?.included,false);
});

test('accept-close rejects changed delegate generations after awaiting final worker exit', async t => {
  const {store,service,quest} = fixture(t); quest(); quest('child',{kind:'delegate',parentQuestId:'q',status:'completed'});
  service.settleWorker = async id => { if (id === 'child') { const child = store.get(id)!; child.result = 'late changed report'; store.save(child); } };
  await assert.rejects(service.action('q','accept-close',{commandId:'accept',expectedRunCount:2}),/result changed/);
  assert.equal(store.get('q')?.acceptance,undefined); assert.equal(store.get('q')?.closedAt,undefined);
});

test('accept-close never cancels or settles active family work while rejecting acceptance', async t => {
  const {store,service,quest} = fixture(t); quest(); quest('child',{kind:'delegate',parentQuestId:'q',status:'running',activeRunId:'child-run'});
  service.settleWorker = async () => { assert.fail('active family must not be settled by acceptance'); };
  await assert.rejects(service.action('q','accept-close',{commandId:'accept',expectedRunCount:2}),/unfinished family/);
  assert.equal(store.get('child')?.activeRunId,'child-run');
});

test('Guildmaster legacy cancellation stops its turn without lifecycle-closing the conversation', async t => {
  const {store,service,quest} = fixture(t); quest('gm',{kind:'guildmaster',status:'queued',activeRunId:'run'});
  const stopped = (await service.action('gm','cancel',{commandId:'stop'})).quest;
  assert.equal(stopped.closedAt,undefined); assert.equal(stopped.status,'cancelled'); assert.equal(stopped.activeRunId,undefined);
  await service.continue('gm',{commandId:'next-turn',message:'continue conversation'});
  assert.equal(store.get('gm')?.status,'queued'); assert.equal(store.get('gm')?.runCount,3);
});
