import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/service/store.ts';
import { QuestService } from '../src/service/quests.ts';
import type { Quest } from '../src/domain/types.ts';

function fixture(t: any) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(),'gm-preparation-')));
  const store = new Store(dir);
  const service = new QuestService({store,dataDir:dir,defaultWorkspace:dir});
  service.schedule = () => {};
  t.after(async () => { await service.close(); store.close(); rmSync(dir,{recursive:true,force:true}); });
  const q: Quest = {id:'q',title:'q',objective:'work',kind:'quest',status:'running',activeRunId:'run',workspaceMode:'none',workspacePath:dir,model:'',tools:[],instructions:'',createdAt:1,updatedAt:1,sessionPath:'',runCount:1};
  store.save(q);
  return {dir,store,service};
}

test('familyPreparing covers pending setup and closure fences delegate commit before storage deletion', async t => {
  const {store,service} = fixture(t);
  const pending = service.createDelegate('q',{objective:'child',commandId:'delegate'},'run');
  const rejected = assert.rejects(pending,/no longer active|reopen|preparation stopped/i);
  assert.equal(service.familyPreparing('q'),true);
  await service.action('q','close',{commandId:'close',confirmCancel:true});
  await rejected;
  assert.equal(store.children('q').length,0); assert.equal(store.command('delegate'),undefined);
  assert.equal(service.familyPreparing('q'),false);
  await assert.rejects(service.createDelegate('q',{objective:'late',commandId:'late'}),/reopen/i);
});

test('closure revision advances even in same clock tick; old Undo cannot reopen newer closure', async t => {
  const {service} = fixture(t);
  const first = (await service.action('q','close',{commandId:'first',confirmCancel:true})).quest;
  await service.action('q','reopen',{commandId:'reopen',expectedRunCount:1,expectedClosedAt:first.closedAt});
  const second = (await service.action('q','close',{commandId:'second'})).quest;
  assert.ok(second.closedAt! > first.closedAt!);
  await assert.rejects(service.action('q','reopen',{commandId:'old-undo',expectedRunCount:1,expectedClosedAt:first.closedAt}),/closure changed/);
});

test('closed queued family stays fenced across service restart without replay', async t => {
  const {dir,store,service} = fixture(t);
  const parent = store.get('q')!;
  store.save({...parent,id:'child',kind:'delegate',parentQuestId:'q',status:'queued',activeRunId:'child-run'});
  store.saveDelivery({id:'delivery',questId:'child',commandId:'old',kind:'prompt',text:'do not replay',createdAt:1});
  await service.action('q','close',{commandId:'close',confirmCancel:true});
  await service.close();
  const restarted = new QuestService({store,dataDir:dir,defaultWorkspace:dir});
  restarted.schedule();
  assert.equal(restarted.live.size,0); assert.equal(store.pendingDeliveries('child').length,0);
  assert.equal(store.get('child')?.activeRunId,undefined); assert.equal(restarted.detail('q').quest.inbox?.included,false);
  await restarted.close();
});
